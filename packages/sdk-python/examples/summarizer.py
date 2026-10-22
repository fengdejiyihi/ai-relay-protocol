"""用 SDK 写的 L2 异步供给方：接单回 accepted，后台做完用回调告诉 Relay；也实现 task.poll 和 task.cancel。

    RELAY_SECRET=whsec_… RELAY_BASE_URL=https://relay.example.com python examples/summarizer.py

生产环境的任务状态要放数据库，这里为了简短放在内存里。
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from wsgiref.simple_server import make_server

from ai_relay_sdk import (
    CallbackDeliveryError,
    InvokeContext,
    RelayCallbackClient,
    RelayHandler,
    accepted,
    cancel_failed,
    cancelled,
    completed,
    failed,
    pending,
)
from ai_relay_sdk.wsgi import make_wsgi_app

TASKS: dict[str, dict] = {}  # task_id → {"order_id", "state", "summary"}
_lock = threading.Lock()


def summarize(data: dict, ctx: InvokeContext) -> dict:
    task_id = f"t_{ctx.order_id}"
    with _lock:
        TASKS[task_id] = {"order_id": ctx.order_id, "state": "running", "summary": None}
    threading.Thread(target=_work, args=(task_id, data["text"]), daemon=True).start()
    return accepted(task_id, eta_seconds=5)


def _work(task_id: str, text: str) -> None:
    time.sleep(WORK_SECONDS)
    with _lock:
        task = TASKS[task_id]
        if task["state"] == "cancelled":
            return
        task.update(state="done", summary=text[:50] + ("…" if len(text) > 50 else ""))
    try:
        assert CALLBACKS is not None
        CALLBACKS.completed(task["order_id"], {"summary": task["summary"]})
    except CallbackDeliveryError:
        pass  # 送不到也没关系：Relay 会按 1、2、5、15 分钟用 task.poll 来取


def task_poll(envelope: dict) -> dict:
    task = TASKS.get(envelope["task_id"])
    if task is None or task["state"] == "cancelled":
        return failed("permanent", "任务不存在或已取消")
    return completed({"summary": task["summary"]}) if task["state"] == "done" else pending(eta_seconds=5)


def task_cancel(envelope: dict) -> dict:
    with _lock:
        task = TASKS.get(envelope["task_id"])
        if task is not None and task["state"] == "done":
            return cancel_failed("摘要已经生成")
        if task is not None:
            task["state"] = "cancelled"
    return cancelled()


WORK_SECONDS = float(os.environ.get("WORK_SECONDS", "3"))
CALLBACKS: RelayCallbackClient | None = None


def create_relay(secrets: list[str] | None = None) -> RelayHandler:
    global CALLBACKS
    # 轮换期把新旧 secret 都配上（逗号分隔，新的在前）；回调用新的签。没配会直接报错，不会用空密钥。
    secrets = secrets or os.environ["RELAY_SECRET"].split(",")
    CALLBACKS = RelayCallbackClient(secrets[0], base_url=os.environ.get("RELAY_BASE_URL", "https://relay.newbeeai.online"))
    return RelayHandler(
        secrets=secrets,
        manifest=Path(__file__).with_name("summarizer.manifest.json"),
        actions={"summarize": summarize},
        task_poll=task_poll,
        task_cancel=task_cancel,
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8081"))
    print(f"示例摘要服务：http://127.0.0.1:{port}/relay")
    make_server("127.0.0.1", port, make_wsgi_app(create_relay())).serve_forever()
