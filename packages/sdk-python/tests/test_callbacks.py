from __future__ import annotations

import json
import threading
from collections.abc import Iterator, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from ai_relay_sdk import (
    CallbackDeliveryError,
    CallbackRejected,
    RelayCallbackClient,
    link,
    proposal,
    validate_upstream,
    verify_signature,
)

from .conftest import NOW, SECRET

ORDER = "ord_TEST000000001"


class FakeTransport:
    """按顺序吐出预设的结果（状态码，或要抛出的异常），并记录每次请求。"""

    def __init__(self, *outcomes: Any) -> None:
        self.outcomes = list(outcomes)
        self.requests: list[tuple[str, bytes, dict[str, str]]] = []

    def __call__(self, url: str, body: bytes, headers: Mapping[str, str], timeout: float) -> tuple[int, Mapping[str, str], bytes]:
        self.requests.append((url, body, dict(headers)))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        status, extra = (outcome, {}) if isinstance(outcome, int) else outcome
        return status, extra, json.dumps({"status": "ok"}).encode()


def client(transport: FakeTransport, sleeps: list[float] | None = None, **kw: Any) -> RelayCallbackClient:
    clock = iter(range(NOW, NOW + 1000))
    return RelayCallbackClient(
        SECRET,
        base_url="https://relay.test/",
        transport=transport,
        sleep=(sleeps.append if sleeps is not None else lambda s: None),
        now=lambda: next(clock),
        **kw,
    )


def test_completed_event_is_signed_and_valid() -> None:
    t = FakeTransport(200)
    result = client(t).completed(ORDER, {"url": "https://x"}, [link("https://x", "查看")])
    assert result.ok and result.attempts == 1
    url, body, headers = t.requests[0]
    assert url == f"https://relay.test/v1/callbacks/{ORDER}"
    event = json.loads(body)
    assert validate_upstream(event, strict=True) == []
    assert event["event_id"].startswith("evt_") and event["occurred_at"] == NOW
    assert verify_signature([SECRET], headers["X-Relay-Signature"], body, now=NOW).ok
    assert headers["X-Relay-RSP"] == "1.0"


def test_retries_5xx_and_network_errors_with_same_event_id_and_fresh_signature() -> None:
    t = FakeTransport(502, TimeoutError("timed out"), ConnectionResetError(), 200)
    sleeps: list[float] = []
    result = client(t, sleeps).failed(ORDER, "permanent", "做不了")
    assert result.ok and result.attempts == 4
    assert sleeps == [1, 4, 16]
    bodies = {r[1] for r in t.requests}
    assert len(bodies) == 1  # 同一个 event_id、同一份请求体
    signatures = [r[2]["X-Relay-Signature"] for r in t.requests]
    assert len(set(signatures)) == 4  # 每次重新签名（时间戳不同）


def test_429_honours_retry_after() -> None:
    t = FakeTransport((429, {"Retry-After": "7"}), 200)
    sleeps: list[float] = []
    client(t, sleeps).dispute(ORDER, "用户说没收到")
    assert sleeps == [7]


def test_409_is_returned_not_raised() -> None:
    result = client(FakeTransport(409)).cancel_failed(ORDER, "已经发出")
    assert not result.ok and result.order_terminal


@pytest.mark.parametrize("status", [401, 404, 422])
def test_4xx_is_rejected_without_retry(status: int) -> None:
    t = FakeTransport(status)
    with pytest.raises(CallbackRejected) as info:
        client(t).proposal_withdraw(ORDER, "p1", "名额已满")
    assert info.value.status_code == status and len(t.requests) == 1


def test_gives_up_after_retry_delays_and_keeps_event_for_resend() -> None:
    t = FakeTransport(500, 503, 500)
    with pytest.raises(CallbackDeliveryError) as info:
        client(t, retry_delays=(1, 1)).completed(ORDER, {"a": 1}, event_id="evt_fixed")
    assert info.value.attempts == 3
    assert info.value.event["event_id"] == "evt_fixed"
    # 稍后原样再发：event_id 和 occurred_at 都保留
    t2 = FakeTransport(200)
    again = client(t2).send(info.value.event)
    assert json.loads(t2.requests[0][1]) == info.value.event
    assert again.ok


def test_invalid_event_raises_before_sending() -> None:
    t = FakeTransport()
    with pytest.raises(ValueError):
        client(t).proposal_add(ORDER, {"proposal_id": "p1"})
    with pytest.raises(ValueError):
        client(t).failed(ORDER, "made_up_code")
    assert t.requests == []


def test_proposal_add_builds_valid_event() -> None:
    t = FakeTransport(200)
    client(t).proposal_add(ORDER, proposal("p1", "方案一", {"price": 1}, price_cents=100, eta_days=3))
    event = json.loads(t.requests[0][1])
    assert event["proposal"]["content"] == {"data": {"price": 1}}


# ---- 用标准库起一个假的 Relay，走真实 HTTP -------------------------------------------------


@pytest.fixture
def fake_relay() -> Iterator[tuple[str, list[Any]]]:
    received: list[Any] = []
    statuses = [503, 200]

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            body = self.rfile.read(int(self.headers["Content-Length"]))
            ok = verify_signature([SECRET], self.headers["X-Relay-Signature"], body).ok
            received.append((self.path, json.loads(body), ok))
            status = statuses.pop(0)
            payload = json.dumps({"received": True}).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}", received
    server.shutdown()


def test_real_http_roundtrip_with_retry(fake_relay: tuple[str, list[Any]]) -> None:
    base, received = fake_relay
    result = RelayCallbackClient(SECRET, base_url=base, sleep=lambda s: None).completed(ORDER, {"文章": "好了"})
    assert result.ok and result.attempts == 2 and result.body == {"received": True}
    assert [r[0] for r in received] == [f"/v1/callbacks/{ORDER}"] * 2
    assert all(r[2] for r in received)
    assert received[0][1]["event_id"] == received[1][1]["event_id"]


def test_connection_refused_is_retried_then_raised() -> None:
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    c = RelayCallbackClient(SECRET, base_url=f"http://127.0.0.1:{port}", sleep=lambda s: None, retry_delays=(0,), timeout=2)
    with pytest.raises(CallbackDeliveryError) as info:
        c.completed(ORDER, {})
    assert info.value.attempts == 2 and info.value.status_code is None


def test_blank_secret_is_rejected() -> None:
    for blank in ("", "  "):
        with pytest.raises(ValueError):
            RelayCallbackClient(blank)
