"""用 SDK 写的两个示例，按规范逐项走一遍（和 Conformance 的检查项对应）。"""

from __future__ import annotations

import json
import time
from collections.abc import Mapping
from typing import Any

from ai_relay_sdk import (
    validate_manifest,
    validate_response,
    validate_upstream,
    verify_signature,
)

from .conftest import NOW, SECRET, envelope, invoke, signed

ORDER = {"book_id": "b_1001", "price_cents": 2350, "name": "李四", "phone": "13800001234", "address": "北京市海淀区某路 1 号"}


def test_bookshop_l1() -> None:
    from examples import bookshop

    relay = bookshop.create_relay([SECRET])
    relay._now = lambda: NOW  # noqa: SLF001
    assert validate_manifest(relay.manifest) == []

    def call(body: Any) -> Any:
        raw, sig = signed(body)
        reply = relay.handle(raw, sig)
        assert reply.status_code == 200
        return reply.body

    assert call(envelope("ping", challenge="c" * 16))["status"] == "ok"
    found = call(invoke("search_books", {"keyword": "三体"}))
    assert validate_response("action.invoke", found, strict=True) == []
    assert found["output"]["data"]["books"][0]["book_id"] == "b_1001"

    first = call(invoke("order_book", ORDER, order_id="ord_BOOK000000001"))
    assert first["status"] == "completed" and validate_response("action.invoke", first, strict=True) == []
    stock = bookshop.BOOKS["b_1001"]["stock"]
    assert call(invoke("order_book", ORDER, order_id="ord_BOOK000000001")) == first
    assert bookshop.BOOKS["b_1001"]["stock"] == stock  # 重放没有再扣库存

    assert call(invoke("order_book", {**ORDER, "price_cents": 1}, order_id="ord_BOOK000000002"))["error"]["code"] == "invalid_input"
    assert call(invoke("order_book", {**ORDER, "book_id": "b_1002", "price_cents": 2000}, order_id="ord_BOOK000000003"))["error"]["code"] == "not_available"
    assert call({"type": "future.thing", "rsp": "1.0", "issued_at": NOW})["error"]["code"] == "not_supported"
    raw, _ = signed(envelope("ping", challenge="c" * 16))
    assert relay.handle(raw, "t=1,v1=" + "0" * 64).status_code == 401


def test_summarizer_l2(monkeypatch: Any) -> None:
    from examples import summarizer

    sent: list[tuple[str, bytes, dict[str, str]]] = []

    def transport(url: str, body: bytes, headers: Mapping[str, str], timeout: float) -> Any:
        sent.append((url, body, dict(headers)))
        return 200, {}, b"{}"

    monkeypatch.setattr(summarizer, "WORK_SECONDS", 0.01)
    relay = summarizer.create_relay([SECRET])
    monkeypatch.setattr(summarizer.CALLBACKS, "_transport", transport)
    relay._now = lambda: time.time()  # noqa: SLF001

    def call(body: Any) -> Any:
        raw, sig = signed(body, timestamp=int(time.time()))
        return relay.handle(raw, sig).body

    order = "ord_SUMM000000001"
    got = call(invoke("summarize", {"text": "很长的一段文字" * 20}, order_id=order))
    assert got == {"status": "accepted", "task_id": f"t_{order}", "eta_seconds": 5}
    deadline = time.time() + 5
    while not sent and time.time() < deadline:
        time.sleep(0.01)
    url, body, headers = sent[0]
    event = json.loads(body)
    assert url.endswith(f"/v1/callbacks/{order}") and event["type"] == "completed"
    assert validate_upstream(event, strict=True) == []
    assert verify_signature([SECRET], headers["X-Relay-Signature"], body).ok

    polled = call(envelope("task.poll", order_id=order, task_id=f"t_{order}"))
    assert polled["status"] == "completed" and validate_response("task.poll", polled) == []
    assert call(envelope("task.cancel", order_id=order, task_id=f"t_{order}", reason="user_cancelled"))["status"] == "cancel_failed"

    summarizer.TASKS["t_other"] = {"order_id": "ord_SUMM000000002", "state": "running", "summary": None}
    assert call(envelope("task.poll", order_id="ord_SUMM000000002", task_id="t_other"))["status"] == "pending"
    assert call(envelope("task.cancel", order_id="ord_SUMM000000002", task_id="t_other", reason="expired"))["status"] == "cancelled"
    assert call(envelope("proposal.select", order_id=order, task_id="t", proposal_id="p"))["error"]["code"] == "not_supported"
