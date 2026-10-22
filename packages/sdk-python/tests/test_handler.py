from __future__ import annotations

import asyncio
import json
import threading
from typing import Any

import pytest

from ai_relay_sdk import (
    InvokeContext,
    MemoryIdempotencyStore,
    RelayError,
    RelayHandler,
    SqliteIdempotencyStore,
    accepted,
    completed,
    failed,
    pending,
)

from .conftest import NOW, OLD_SECRET, SECRET, envelope, invoke, signed


class Shop:
    """记录处理函数被调用了几次，用来确认幂等真的没有重复执行。"""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.next: Any = None

    def book(self, data: dict[str, Any], ctx: InvokeContext) -> Any:
        self.calls.append(data)
        if self.next is not None:
            result, self.next = self.next, None
            if isinstance(result, BaseException):
                raise result
            return result
        return completed({"booking_id": f"b_{len(self.calls)}"})

    def lookup(self, data: dict[str, Any], ctx: InvokeContext) -> Any:
        self.calls.append(data)
        return completed({"hits": len(self.calls)})


@pytest.fixture
def shop() -> Shop:
    return Shop()


@pytest.fixture
def relay(manifest: dict[str, Any], shop: Shop) -> RelayHandler:
    return RelayHandler(
        secrets=[SECRET, OLD_SECRET], manifest=manifest, actions={"book": shop.book, "lookup": shop.lookup}, now=lambda: NOW
    )


def send(relay: RelayHandler, body: Any, **kw: Any):
    raw, sig = signed(body, **kw)
    return relay.handle(raw, sig)


BOOK = {"item": "剪发", "price_cents": 6800}


# ---- 验签与基础分发 -----------------------------------------------------------------


def test_ping_echoes_challenge(relay: RelayHandler) -> None:
    reply = send(relay, envelope("ping", challenge="c" * 32))
    assert reply.status_code == 200
    assert reply.body == {"status": "ok", "challenge": "c" * 32, "rsp": "1.0"}
    assert reply.headers["X-Relay-RSP"] == "1.0"


@pytest.mark.parametrize(
    "kw",
    [{"secret": "whsec_wrong"}, {"timestamp": NOW - 301}, {"timestamp": NOW + 301}],
    ids=["wrong-secret", "expired", "future"],
)
def test_bad_signature_is_401(relay: RelayHandler, kw: dict[str, Any]) -> None:
    reply = send(relay, envelope("ping", challenge="c" * 16), **kw)
    assert reply.status_code == 401
    assert reply.body["error"]["code"] == "unauthorized"


def test_missing_signature_and_tampered_body_are_401(relay: RelayHandler) -> None:
    raw, sig = signed(envelope("ping", challenge="x" * 16))
    assert relay.handle(raw, None).status_code == 401
    assert relay.handle(raw.replace(b"xxxx", b"yyyy"), sig).status_code == 401


def test_old_secret_still_accepted_during_rotation(relay: RelayHandler) -> None:
    assert send(relay, envelope("ping", challenge="c" * 16), secret=OLD_SECRET).body["status"] == "ok"


def test_body_as_str_works(relay: RelayHandler) -> None:
    raw, sig = signed(envelope("ping", challenge="中" * 16))
    assert relay.handle(raw.decode("utf-8"), sig).body["challenge"] == "中" * 16


def test_unknown_type_is_not_supported(relay: RelayHandler) -> None:
    reply = send(relay, {"type": "future.thing", "rsp": "1.1", "issued_at": NOW, "extra": 1})
    assert reply.status_code == 200
    assert reply.body["status"] == "failed" and reply.body["error"]["code"] == "not_supported"


def test_known_but_unimplemented_type_is_not_supported(relay: RelayHandler) -> None:
    reply = send(relay, envelope("task.poll", order_id="ord_TEST000000001", task_id="t1"))
    assert reply.body["error"]["code"] == "not_supported"


def test_unknown_fields_and_minor_version_are_ignored(relay: RelayHandler) -> None:
    env = invoke("book", BOOK, rsp="1.4", trace_id="abc")
    env["user"]["new_field"] = 1
    assert send(relay, env).body["status"] == "completed"


def test_not_json_and_invalid_envelope_are_invalid_input(relay: RelayHandler) -> None:
    assert send(relay, b"{not json").body["error"]["code"] == "invalid_input"
    assert send(relay, b"[1,2]").body["error"]["code"] == "invalid_input"
    bad = invoke("book", BOOK)
    del bad["user"]
    reply = send(relay, bad)
    assert reply.status_code == 200 and reply.body["error"]["code"] == "invalid_input"
    assert reply.body["error"]["details"]


# ---- action.invoke -----------------------------------------------------------------


def test_unknown_action_and_bad_input(relay: RelayHandler, shop: Shop) -> None:
    assert send(relay, invoke("fly", {})).body["error"]["code"] == "invalid_input"
    reply = send(relay, invoke("book", {"item": "x", "price_cents": "6800"}))
    assert reply.body["error"]["code"] == "invalid_input"
    assert reply.body["error"]["details"][0]["path"] == "/price_cents"
    assert send(relay, invoke("book", {**BOOK, "extra": 1}, order_id="ord_TEST000000002")).body["error"]["code"] == "invalid_input"
    assert shop.calls == []


def test_context_exposes_envelope(manifest: dict[str, Any]) -> None:
    seen: list[InvokeContext] = []

    def book(data: dict[str, Any], ctx: InvokeContext) -> Any:
        seen.append(ctx)
        return completed({"booking_id": "b"})

    relay = RelayHandler(secrets=SECRET, manifest=manifest, actions={"book": book, "lookup": book}, now=lambda: NOW)
    send(relay, invoke("book", BOOK, order_id="ord_CTX0000000001", deadline_at=NOW + 10))
    ctx = seen[0]
    assert (ctx.order_id, ctx.action, ctx.idempotency_key, ctx.manifest_version) == ("ord_CTX0000000001", "book", "ord_CTX0000000001", 1)
    assert ctx.user["relay_uid"] == "u_pair_test0001" and ctx.deadline_at == NOW + 10
    assert ctx.action_spec["billing"] == "on_complete"


def test_past_deadline_is_temporary_and_not_executed(relay: RelayHandler, shop: Shop) -> None:
    reply = send(relay, invoke("book", BOOK, deadline_at=NOW - 1))
    assert reply.body["error"]["code"] == "temporary"
    assert shop.calls == []


def test_replay_after_deadline_returns_first_result(relay: RelayHandler, shop: Shop) -> None:
    first = send(relay, invoke("book", BOOK, deadline_at=NOW + 5))
    assert first.body["status"] == "completed"
    replay = send(relay, invoke("book", BOOK, deadline_at=NOW - 1))
    assert replay.body == first.body
    assert len(shop.calls) == 1


def test_past_deadline_releases_the_key(relay: RelayHandler, shop: Shop) -> None:
    send(relay, invoke("book", BOOK, deadline_at=NOW - 1))
    assert send(relay, invoke("book", BOOK)).body["status"] == "completed"
    assert send(relay, invoke("lookup", {"q": "a"}, order_id="ord_TEST000000003", deadline_at=NOW - 1)).body["error"]["code"] == "temporary"


# ---- 幂等 --------------------------------------------------------------------------


def test_replay_returns_first_result_without_reexecuting(relay: RelayHandler, shop: Shop) -> None:
    first = send(relay, invoke("book", BOOK))
    second = send(relay, invoke("book", BOOK))
    assert first.body == second.body == {"status": "completed", "output": {"data": {"booking_id": "b_1"}}}
    assert len(shop.calls) == 1


def test_same_key_different_input_is_rejected(relay: RelayHandler, shop: Shop) -> None:
    send(relay, invoke("book", BOOK))
    reply = send(relay, invoke("book", {**BOOK, "price_cents": 1}))
    assert reply.body["error"]["code"] == "invalid_input"
    assert len(shop.calls) == 1


def test_key_order_in_input_does_not_matter(relay: RelayHandler, shop: Shop) -> None:
    send(relay, invoke("book", {"item": "a", "price_cents": 1}))
    raw = json.dumps(invoke("book", {"price_cents": 1, "item": "a"}))
    assert send(relay, raw).body["status"] == "completed"
    assert len(shop.calls) == 1


@pytest.mark.parametrize("code", ["temporary", "rate_limited"])
def test_retryable_failures_are_not_cached(relay: RelayHandler, shop: Shop, code: str) -> None:
    shop.next = failed(code, "稍后再试")
    assert send(relay, invoke("book", BOOK)).body["error"]["code"] == code
    assert send(relay, invoke("book", BOOK)).body["status"] == "completed"
    assert len(shop.calls) == 2


@pytest.mark.parametrize("code", ["not_available", "invalid_input", "permanent"])
def test_final_failures_are_cached(relay: RelayHandler, shop: Shop, code: str) -> None:
    shop.next = RelayError(code, "不行")
    first = send(relay, invoke("book", BOOK))
    assert first.body == {"status": "failed", "error": {"code": code, "message": "不行"}}
    assert send(relay, invoke("book", BOOK)).body == first.body
    assert len(shop.calls) == 1


def test_accepted_is_cached(relay: RelayHandler, shop: Shop) -> None:
    shop.next = accepted("task_1", eta_seconds=30)
    send(relay, invoke("book", BOOK))
    assert send(relay, invoke("book", BOOK)).body == {"status": "accepted", "task_id": "task_1", "eta_seconds": 30}
    assert len(shop.calls) == 1


def test_readonly_actions_are_also_idempotent(relay: RelayHandler, shop: Shop) -> None:
    assert send(relay, invoke("lookup", {"q": "a"})).body["output"]["data"] == {"hits": 1}
    assert send(relay, invoke("lookup", {"q": "a"})).body["output"]["data"] == {"hits": 1}
    assert send(relay, invoke("lookup", {"q": "a"}, order_id="ord_TEST000000002")).body["output"]["data"] == {"hits": 2}


def test_in_flight_duplicate_gets_temporary(manifest: dict[str, Any]) -> None:
    started, release = threading.Event(), threading.Event()
    calls: list[int] = []

    def slow(data: dict[str, Any], ctx: InvokeContext) -> Any:
        calls.append(1)
        started.set()
        release.wait(5)
        return completed({"booking_id": "b"})

    relay = RelayHandler(secrets=SECRET, manifest=manifest, actions={"book": slow, "lookup": slow}, now=lambda: NOW)
    results: list[Any] = []
    worker = threading.Thread(target=lambda: results.append(send(relay, invoke("book", BOOK))))
    worker.start()
    assert started.wait(5)
    concurrent = send(relay, invoke("book", BOOK))
    release.set()
    worker.join(5)
    assert concurrent.body["error"]["code"] == "temporary"
    assert results[0].body["status"] == "completed"
    assert send(relay, invoke("book", BOOK)).body == results[0].body
    assert len(calls) == 1


def test_unexpected_exception_is_500_and_not_cached(relay: RelayHandler, shop: Shop, caplog: pytest.LogCaptureFixture) -> None:
    shop.next = RuntimeError("数据库断了")
    reply = send(relay, invoke("book", BOOK))
    assert reply.status_code == 500
    assert "数据库断了" in caplog.text
    assert send(relay, invoke("book", BOOK)).body["status"] == "completed"


def test_invalid_handler_response_is_500(relay: RelayHandler, shop: Shop) -> None:
    shop.next = {"status": "done"}
    assert send(relay, invoke("book", BOOK)).status_code == 500
    shop.next = pending()  # pending 只能用于 task.poll
    assert send(relay, invoke("book", BOOK)).status_code == 500
    assert send(relay, invoke("book", BOOK)).body["status"] == "completed"


def test_output_schema_mismatch_only_warns(relay: RelayHandler, shop: Shop, caplog: pytest.LogCaptureFixture) -> None:
    shop.next = completed({"wrong": 1})
    assert send(relay, invoke("book", BOOK)).body["status"] == "completed"
    assert "output Schema" in caplog.text


def test_sqlite_store_shares_results_across_handlers(manifest: dict[str, Any], shop: Shop, tmp_path: Any) -> None:
    path = str(tmp_path / "idem.db")
    a = RelayHandler(secrets=SECRET, manifest=manifest, actions={"book": shop.book, "lookup": shop.lookup}, idempotency_store=SqliteIdempotencyStore(path), now=lambda: NOW)
    b = RelayHandler(secrets=SECRET, manifest=manifest, actions={"book": shop.book, "lookup": shop.lookup}, idempotency_store=SqliteIdempotencyStore(path), now=lambda: NOW)
    first = send(a, invoke("book", BOOK))
    assert send(b, invoke("book", BOOK)).body == first.body
    assert len(shop.calls) == 1


def test_sqlite_store_lock_and_stale_lease(tmp_path: Any) -> None:
    store = SqliteIdempotencyStore(str(tmp_path / "x.db"), lease_seconds=0.05)
    assert store.acquire("k")
    assert not SqliteIdempotencyStore(str(tmp_path / "x.db"), lease_seconds=60).acquire("k")
    import time

    time.sleep(0.1)
    assert store.acquire("k")  # 占用超时，视为原进程已崩溃
    store.release("k")
    assert store.get("k") is None


def test_memory_store_purges_expired_entries() -> None:
    from ai_relay_sdk import StoredResponse

    store = MemoryIdempotencyStore(ttl_seconds=-1)
    for i in range(1000):
        store.save(f"k{i}", StoredResponse("a", "h", {"status": "completed"}))
    assert len(store._done) == 0  # noqa: SLF001
    assert MemoryIdempotencyStore()._ttl == 8 * 24 * 3600  # noqa: SLF001


def test_memory_store_ttl() -> None:
    from ai_relay_sdk import StoredResponse

    store = MemoryIdempotencyStore(ttl_seconds=0)
    store.save("k", StoredResponse("a", "h", {"status": "completed"}))
    import time

    time.sleep(0.01)
    assert store.get("k") is None


# ---- 其他信封与异步处理函数 ------------------------------------------------------------


def test_envelope_handlers_receive_envelope(manifest: dict[str, Any], shop: Shop) -> None:
    got: list[dict[str, Any]] = []

    def poll(env: dict[str, Any]) -> Any:
        got.append(env)
        return pending(eta_seconds=10)

    relay = RelayHandler(secrets=SECRET, manifest=manifest, actions={"book": shop.book, "lookup": shop.lookup}, task_poll=poll, now=lambda: NOW)
    reply = send(relay, envelope("task.poll", order_id="ord_TEST000000001", task_id="t1"))
    assert reply.body == {"status": "pending", "eta_seconds": 10}
    assert got[0]["task_id"] == "t1"


def test_async_handlers(manifest: dict[str, Any]) -> None:
    async def book(data: dict[str, Any], ctx: InvokeContext) -> Any:
        await asyncio.sleep(0)
        return completed({"booking_id": "async"})

    relay = RelayHandler(secrets=SECRET, manifest=manifest, actions={"book": book, "lookup": book}, now=lambda: NOW)
    raw, sig = signed(invoke("book", BOOK))
    assert asyncio.run(relay.handle_async(raw, sig)).body["output"]["data"] == {"booking_id": "async"}
    # 同步入口不能跑 async def：500，且不缓存、不占住键。
    raw2, sig2 = signed(invoke("book", BOOK, order_id="ord_TEST000000009"))
    assert relay.handle(raw2, sig2).status_code == 500
    assert asyncio.run(relay.handle_async(raw2, sig2)).body["status"] == "completed"


def test_constructor_checks_manifest_and_handlers(manifest: dict[str, Any], shop: Shop) -> None:
    with pytest.raises(ValueError, match="没有处理函数"):
        RelayHandler(secrets=SECRET, manifest=manifest, actions={"book": shop.book})
    with pytest.raises(ValueError, match="不在清单里"):
        RelayHandler(secrets=SECRET, manifest=manifest, actions={"book": shop.book, "lookup": shop.lookup, "x": shop.book})
    with pytest.raises(ValueError, match="清单不合法"):
        RelayHandler(secrets=SECRET, manifest={**manifest, "rsp": "2.0"}, actions={})
    for blank in ([], "", [""], ["  "]):
        with pytest.raises(ValueError, match="secret"):
            RelayHandler(secrets=blank, manifest=manifest, actions={"book": shop.book, "lookup": shop.lookup})
