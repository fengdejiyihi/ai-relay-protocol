"""示例书店的 FastAPI 版本：uvicorn examples.bookshop_fastapi:app（在 packages/sdk-python 目录下）。"""

from fastapi import FastAPI

from ai_relay_sdk.fastapi import relay_router

from .bookshop import create_relay

app = FastAPI()
app.include_router(relay_router(create_relay()))
