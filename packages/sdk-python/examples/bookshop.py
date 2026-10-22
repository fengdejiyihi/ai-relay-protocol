"""用 SDK 写的 L1 供给方：查书 + 买书，约 60 行，只依赖 SDK 和标准库。

    RELAY_SECRET=whsec_… python examples/bookshop.py      # 监听 127.0.0.1:8080/relay

FastAPI、Flask 版本见同目录的 bookshop_fastapi.py、bookshop_flask.py，动作函数是同一套。
"""

from __future__ import annotations

import itertools
import os
import threading
from pathlib import Path
from wsgiref.simple_server import make_server

from ai_relay_sdk import (
    InvokeContext,
    RelayError,
    RelayHandler,
    completed,
    link,
    markdown,
)
from ai_relay_sdk.wsgi import make_wsgi_app

BOOKS = {
    "b_1001": {"title": "三体", "price_cents": 2350, "stock": 5},
    "b_1002": {"title": "活着", "price_cents": 2000, "stock": 0},
    "b_1003": {"title": "百年孤独", "price_cents": 3960, "stock": 2},
}
_lock = threading.Lock()
_order_no = itertools.count(1)


def search_books(data: dict, ctx: InvokeContext) -> dict:
    books = [{"book_id": k, **v} for k, v in BOOKS.items() if data["keyword"] in v["title"]]
    lines = [f"- {b['title']}：¥{b['price_cents'] / 100:.2f}，库存 {b['stock']}" for b in books] or ["没有找到"]
    return completed({"books": books}, [markdown("\n".join(lines))])


def order_book(data: dict, ctx: InvokeContext) -> dict:
    # 不用自己管幂等：同一个 order_id 重发时 SDK 直接返回第一次的结果，不会再进到这里。
    with _lock:
        book = BOOKS.get(data["book_id"])
        if book is None:
            raise RelayError("invalid_input", f"没有这本书：{data['book_id']}")
        if data["price_cents"] != book["price_cents"]:
            raise RelayError("invalid_input", f"价格已变为 {book['price_cents']} 分，请重新确认")
        if book["stock"] <= 0:
            raise RelayError("not_available", f"《{book['title']}》暂时缺货")
        book["stock"] -= 1
        order_no = f"BK{next(_order_no):06d}"
    return completed(
        {"order_no": order_no, "book_id": data["book_id"], "price_cents": book["price_cents"]},
        [
            markdown(f"已为 {data['name']} 下单《{book['title']}》，货到付款 ¥{book['price_cents'] / 100:.2f}。"),
            link(f"https://bookshop.example.com/orders/{order_no}", "查看订单"),
        ],
    )


def create_relay(secrets: list[str] | None = None) -> RelayHandler:
    # 轮换期把新旧 secret 都配上（逗号分隔，新的在前）。
    secrets = secrets or os.environ["RELAY_SECRET"].split(",")
    return RelayHandler(
        secrets=secrets,
        manifest=Path(__file__).with_name("bookshop.manifest.json"),
        actions={"search_books": search_books, "order_book": order_book},
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"示例书店：http://127.0.0.1:{port}/relay")
    make_server("127.0.0.1", port, make_wsgi_app(create_relay())).serve_forever()
