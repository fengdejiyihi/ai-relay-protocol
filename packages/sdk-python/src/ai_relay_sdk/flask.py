"""Flask 适配。需要 ``pip install "dreamcavy-ai-relay-sdk[flask]"``。

    app = Flask(__name__)
    register_relay(app, relay)                 # 挂到 POST /relay
    # 或者自己定路由：
    app.add_url_rule("/hooks/relay", view_func=relay_view(relay), methods=["POST"])
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from flask import Flask, Response, request

from .constants import SIGNATURE_HEADER
from .handler import RelayHandler


def relay_view(relay: RelayHandler) -> Callable[[], Response]:
    """返回一个 Flask 视图函数。处理函数必须是普通函数（Flask 视图是同步的）。"""

    def view() -> Response:
        # get_data() 拿到的是原始字节；不要用 request.json 再序列化，签名会对不上。
        reply = relay.handle(request.get_data(cache=False), request.headers.get(SIGNATURE_HEADER))
        return Response(reply.body_bytes(), status=reply.status_code, headers=reply.headers)

    view.__name__ = "ai_relay_endpoint"
    return view


def register_relay(app: Flask, relay: RelayHandler, path: str = "/relay", **options: Any) -> None:
    app.add_url_rule(path, endpoint=options.pop("endpoint", "ai_relay"), view_func=relay_view(relay), methods=["POST"], **options)
