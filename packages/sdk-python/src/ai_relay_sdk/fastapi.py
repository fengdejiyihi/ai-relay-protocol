"""FastAPI / Starlette 适配。需要 ``pip install "dreamcavy-ai-relay-sdk[fastapi]"``。

    app = FastAPI()
    app.include_router(relay_router(relay))    # 挂到 POST /relay
    # 或者自己定路由：
    app.add_api_route("/hooks/relay", relay_endpoint(relay), methods=["POST"])

处理函数可以是 ``async def``。普通函数会直接在事件循环里执行；里面有阻塞 IO 的话，
在处理函数里自己用 ``await asyncio.to_thread(...)``，或者把它写成 ``async def``。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Request, Response

from .constants import SIGNATURE_HEADER
from .handler import RelayHandler


def relay_endpoint(relay: RelayHandler) -> Callable[[Request], Awaitable[Response]]:
    async def endpoint(request: Request) -> Response:
        # request.body() 是原始字节；不要声明 Pydantic 模型参数，解析再序列化后签名会对不上。
        reply = await relay.handle_async(await request.body(), request.headers.get(SIGNATURE_HEADER))
        return Response(reply.body_bytes(), status_code=reply.status_code, headers=reply.headers)

    return endpoint


def relay_router(relay: RelayHandler, path: str = "/relay", **options: Any) -> APIRouter:
    router = APIRouter()
    router.add_api_route(path, relay_endpoint(relay), methods=["POST"], include_in_schema=options.pop("include_in_schema", False), **options)
    return router
