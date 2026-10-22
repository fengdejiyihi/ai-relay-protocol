"""异步动作的回调客户端（规范第 7 节），只用标准库。

    client = RelayCallbackClient(secret=os.environ["RELAY_SECRET"])
    client.completed("ord_…", {"article_url": "https://…"}, [link("https://…", "查看文章")])

- 每个事件带 ``event_id``，Relay 按 (order_id, type, event_id) 去重，重复发送是安全的。
- 5xx、429、连接失败和超时按退避重发，重发用同一个 ``event_id``，每次重新签名。
- 重发次数用完仍失败时抛 :class:`CallbackDeliveryError`，异常里有完整事件：
  把它存下来稍后原样再发（同一个 ``event_id``），或者等 Relay 用 ``task.poll`` 来取。
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from .constants import DEFAULT_RELAY_BASE_URL, RSP_HEADER, RSP_VERSION, SIGNATURE_HEADER
from .responses import failed as failed_response
from .responses import output
from .signature import sign_body
from .validation import validate_upstream

logger = logging.getLogger("ai_relay_sdk")

#: transport(url, body, headers, timeout) -> (HTTP 状态码, 响应头, 响应体字节)。连接失败、超时抛 OSError。
Transport = Callable[[str, bytes, Mapping[str, str], float], "tuple[int, Mapping[str, str], bytes]"]


@dataclass(frozen=True)
class CallbackResult:
    status_code: int
    #: Relay 的响应体（JSON 解析后；不是 JSON 时为 None）。409 时带订单当前状态。
    body: Any
    #: 实际发出的事件，含 event_id。
    event: dict[str, Any]
    attempts: int

    @property
    def ok(self) -> bool:
        """200：已收下（包括重复事件）。"""
        return self.status_code == 200

    @property
    def order_terminal(self) -> bool:
        """409：订单已是终态，事件只记录不生效。"""
        return self.status_code == 409


class CallbackError(Exception):
    def __init__(self, message: str, *, event: dict[str, Any], status_code: int | None, body: Any, attempts: int) -> None:
        super().__init__(message)
        self.event = event
        self.status_code = status_code
        self.body = body
        self.attempts = attempts


class CallbackRejected(CallbackError):
    """Relay 明确拒绝：401 验签失败、404 订单不存在、422 事件不合法或当前状态不接受。重发也没用。"""


class CallbackDeliveryError(CallbackError):
    """重发次数用完仍没送达（5xx、429、连接失败或超时）。用 ``exc.event`` 原样稍后再发。"""


def urllib_transport(url: str, body: bytes, headers: Mapping[str, str], timeout: float) -> tuple[int, Mapping[str, str], bytes]:
    request = urllib.request.Request(url, data=body, headers=dict(headers), method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 —— 地址由调用方配置
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers.items()), err.read()


class RelayCallbackClient:
    """参数：
    secret: 和接收信封同一个 secret（轮换期用新的）。
    base_url: Relay 地址，回调发到 ``{base_url}/v1/callbacks/{order_id}``。
    timeout: 单次请求超时（秒）。
    retry_delays: 每次重发前等待的秒数，长度就是最多重发次数。429 带 Retry-After 时取两者较大的。
    """

    def __init__(
        self,
        secret: str,
        *,
        base_url: str = DEFAULT_RELAY_BASE_URL,
        timeout: float = 10,
        retry_delays: Sequence[float] = (1, 4, 16, 60, 300),
        transport: Transport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.time,
    ) -> None:
        if not secret or not secret.strip():
            raise ValueError("secret 不能为空")
        self.secret = secret
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retry_delays = tuple(retry_delays)
        self._transport = transport or urllib_transport
        self._sleep = sleep
        self._now = now

    # ---- 六种事件 ----------------------------------------------------------------------

    def completed(
        self, order_id: str, data: Mapping[str, Any], parts: Iterable[Mapping[str, Any]] | None = None, *, event_id: str | None = None
    ) -> CallbackResult:
        """异步任务完成；多方案在交换联系方式后发。"""
        return self.send({"type": "completed", "order_id": order_id, "output": output(data, parts)}, event_id=event_id)

    def failed(
        self, order_id: str, code: str, message: str | None = None, *, details: Any = None, event_id: str | None = None
    ) -> CallbackResult:
        """异步任务失败。"""
        error = failed_response(code, message, details=details)["error"]
        return self.send({"type": "failed", "order_id": order_id, "error": error}, event_id=event_id)

    def proposal_add(self, order_id: str, proposal: Mapping[str, Any], *, event_id: str | None = None) -> CallbackResult:
        """多方案：每来一个方案发一次。``proposal`` 用 :func:`ai_relay_sdk.proposal` 构造。"""
        return self.send({"type": "proposal.add", "order_id": order_id, "proposal": dict(proposal)}, event_id=event_id)

    def proposal_withdraw(
        self, order_id: str, proposal_id: str, reason: str | None = None, *, event_id: str | None = None
    ) -> CallbackResult:
        event: dict[str, Any] = {"type": "proposal.withdraw", "order_id": order_id, "proposal_id": proposal_id}
        if reason is not None:
            event["reason"] = reason
        return self.send(event, event_id=event_id)

    def dispute(self, order_id: str, reason: str, *, event_id: str | None = None) -> CallbackResult:
        """对已计费的订单提出争议，计费后 72 小时内有效。"""
        return self.send({"type": "order.dispute", "order_id": order_id, "reason": reason}, event_id=event_id)

    def cancel_failed(self, order_id: str, reason: str | None = None, *, event_id: str | None = None) -> CallbackResult:
        """收到 task.cancel 时没能当场答复，之后确认已不可撤回。"""
        event: dict[str, Any] = {"type": "cancel_failed", "order_id": order_id}
        if reason is not None:
            event["reason"] = reason
        return self.send(event, event_id=event_id)

    # ---- 发送 --------------------------------------------------------------------------

    def send(self, event: Mapping[str, Any], *, event_id: str | None = None) -> CallbackResult:
        """发送一个事件。缺 ``rsp``、``event_id``、``occurred_at`` 时自动补上；已有的保留（原样重发用）。"""
        full = {"rsp": RSP_VERSION, "occurred_at": int(self._now()), **event}
        if event_id is not None:
            full["event_id"] = event_id
        full.setdefault("event_id", new_event_id())
        issues = validate_upstream(full, strict=True)
        if issues:
            raise ValueError("回调事件不合法：" + "; ".join(f"{i.path} {i.message}" for i in issues))

        body = json.dumps(full, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        url = f"{self.base_url}/v1/callbacks/{quote(full['order_id'], safe='')}"
        attempts = 0
        status: int | None = None
        parsed: Any = None
        while True:
            attempts += 1
            headers = {
                "Content-Type": "application/json; charset=utf-8",
                RSP_HEADER: RSP_VERSION,
                SIGNATURE_HEADER: sign_body(self.secret, body, int(self._now())),
            }
            retry_after: float | None = None
            try:
                status, response_headers, raw = self._transport(url, body, headers, self.timeout)
                parsed = _parse(raw)
            except OSError as err:  # 连接失败、超时（socket.timeout 是 OSError 的子类）
                status, parsed = None, None
                logger.warning("回调 %s 第 %d 次发送失败：%s", full["event_id"], attempts, err)
            else:
                if status in (200, 409):
                    if status == 409:
                        logger.info("订单 %s 已是终态，事件 %s 只记录不生效", full["order_id"], full["event_id"])
                    return CallbackResult(status, parsed, full, attempts)
                if status == 429:
                    retry_after = _retry_after(response_headers)
                elif status < 500:
                    raise CallbackRejected(
                        f"Relay 拒绝了回调（HTTP {status}）", event=full, status_code=status, body=parsed, attempts=attempts
                    )
                logger.warning("回调 %s 第 %d 次发送得到 HTTP %s", full["event_id"], attempts, status)

            if attempts > len(self.retry_delays):
                raise CallbackDeliveryError(
                    f"回调重发 {attempts} 次仍未送达", event=full, status_code=status, body=parsed, attempts=attempts
                )
            delay = self.retry_delays[attempts - 1]
            self._sleep(max(delay, retry_after or 0))


def new_event_id() -> str:
    return f"evt_{uuid.uuid4().hex}"


def _parse(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8")) if raw else None
    except (ValueError, UnicodeDecodeError):
        return None


def _retry_after(headers: Mapping[str, str]) -> float | None:
    """Retry-After 的秒数写法；HTTP 日期写法不认，按默认退避。最多等 60 秒。"""
    value = next((v for k, v in headers.items() if k.lower() == "retry-after"), None)
    if value is None or not str(value).strip().isdigit():
        return None
    return min(float(value), 60.0)
