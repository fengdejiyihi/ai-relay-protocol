from __future__ import annotations

import threading
import urllib.error
import urllib.request
from typing import Any
from wsgiref.simple_server import WSGIRequestHandler, make_server

import pytest

from ai_relay_sdk import InvokeContext, RelayHandler, completed
from ai_relay_sdk.wsgi import make_wsgi_app

from .conftest import NOW, SECRET, envelope, invoke, signed

BOOK = {"item": "剪发", "price_cents": 6800}


def make_relay(manifest: dict[str, Any], *, use_async: bool = False) -> RelayHandler:
    def book(data: dict[str, Any], ctx: InvokeContext) -> Any:
        return completed({"booking_id": f"b_{data['item']}"})

    async def abook(data: dict[str, Any], ctx: InvokeContext) -> Any:
        return book(data, ctx)

    fn = abook if use_async else book
    return RelayHandler(secrets=SECRET, manifest=manifest, actions={"book": fn, "lookup": fn}, now=lambda: NOW)


def test_fastapi(manifest: dict[str, Any]) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from ai_relay_sdk.fastapi import relay_router

    app = FastAPI()
    app.include_router(relay_router(make_relay(manifest, use_async=True)))
    http = TestClient(app)
    raw, sig = signed(invoke("book", BOOK))
    res = http.post("/relay", content=raw, headers={"X-Relay-Signature": sig, "Content-Type": "application/json"})
    assert res.status_code == 200
    assert res.json()["output"]["data"] == {"booking_id": "b_剪发"}
    assert res.headers["x-relay-rsp"] == "1.0"
    assert res.headers["content-type"].startswith("application/json")
    assert http.post("/relay", content=raw, headers={"X-Relay-Signature": "t=1,v1=" + "0" * 64}).status_code == 401


def test_flask(manifest: dict[str, Any]) -> None:
    from flask import Flask

    from ai_relay_sdk.flask import register_relay

    app = Flask(__name__)
    register_relay(app, make_relay(manifest), path="/hooks/relay")
    http = app.test_client()
    raw, sig = signed(invoke("book", BOOK))
    res = http.post("/hooks/relay", data=raw, headers={"X-Relay-Signature": sig}, content_type="application/json")
    assert res.status_code == 200
    assert res.get_json()["output"]["data"] == {"booking_id": "b_剪发"}
    assert res.headers["X-Relay-RSP"] == "1.0"
    assert res.headers["Content-Type"].startswith("application/json")
    assert http.post("/hooks/relay", data=raw).status_code == 401


class _Quiet(WSGIRequestHandler):
    def log_message(self, *args: Any) -> None:
        pass


@pytest.fixture
def wsgi_url(manifest: dict[str, Any]):
    server = make_server("127.0.0.1", 0, make_wsgi_app(make_relay(manifest)), handler_class=_Quiet)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def post(url: str, body: bytes, headers: dict[str, str]) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def test_wsgi(wsgi_url: str) -> None:
    raw, sig = signed(envelope("ping", challenge="c" * 16))
    status, body = post(wsgi_url + "/relay", raw, {"X-Relay-Signature": sig})
    assert status == 200 and b'"challenge"' in body
    assert post(wsgi_url + "/relay", raw, {})[0] == 401
    assert post(wsgi_url + "/other", raw, {"X-Relay-Signature": sig})[0] == 404
    with pytest.raises(urllib.error.HTTPError) as info:
        urllib.request.urlopen(wsgi_url + "/relay", timeout=5)
    assert info.value.code == 405
