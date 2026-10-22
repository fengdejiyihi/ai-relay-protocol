"""不依赖任何框架的 WSGI 应用，标准库 ``wsgiref`` 就能跑，也能挂到 gunicorn、uWSGI 后面。

    from wsgiref.simple_server import make_server
    make_server("127.0.0.1", 8080, make_wsgi_app(relay)).serve_forever()
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from .constants import SIGNATURE_HEADER
from .handler import RelayHandler

_ENVIRON_KEY = "HTTP_" + SIGNATURE_HEADER.upper().replace("-", "_")


def make_wsgi_app(relay: RelayHandler, path: str = "/relay") -> Callable[..., Iterable[bytes]]:
    """``POST {path}`` 交给 relay 处理，其余路径 404、其余方法 405。"""

    def app(environ: dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        if environ.get("PATH_INFO", "") != path:
            start_response("404 Not Found", [("Content-Type", "text/plain")])
            return [b"not found"]
        if environ.get("REQUEST_METHOD") != "POST":
            start_response("405 Method Not Allowed", [("Content-Type", "text/plain"), ("Allow", "POST")])
            return [b"method not allowed"]
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        body = environ["wsgi.input"].read(length) if length > 0 else b""
        reply = relay.handle(body, environ.get(_ENVIRON_KEY))
        payload = reply.body_bytes()
        start_response(f"{reply.status_code} {_REASONS.get(reply.status_code, '')}".strip(), [*reply.headers.items(), ("Content-Length", str(len(payload)))])
        return [payload]

    return app


_REASONS = {200: "OK", 401: "Unauthorized", 500: "Internal Server Error"}
