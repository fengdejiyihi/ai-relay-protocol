"""RSP 1.0 的常量，取值与 @dreamcavy/ai-relay-protocol 的 constants.ts 一致。

改任何一个值都是协议变更，以协议包为准。
"""

from __future__ import annotations

RSP_VERSION = "1.0"

ERROR_CODES = (
    "invalid_input",
    "not_available",
    "unauthorized",
    "rate_limited",
    "temporary",
    "permanent",
    "not_supported",
)

#: Relay 只重试这两类错误；供给方不得把它们写进幂等缓存（规范第 10 节）。
RETRYABLE_ERROR_CODES = ("temporary", "rate_limited")

DOWNSTREAM_TYPES = (
    "ping",
    "action.invoke",
    "task.poll",
    "task.cancel",
    "proposal.select",
    "binding.verify",
)

UPSTREAM_TYPES = (
    "completed",
    "failed",
    "proposal.add",
    "proposal.withdraw",
    "order.dispute",
    "cancel_failed",
)

#: 每种下行信封允许的同步响应 status。
RESPONSE_STATUSES_BY_TYPE = {
    "ping": ("ok", "failed"),
    "action.invoke": ("completed", "failed", "accepted"),
    "task.poll": ("completed", "failed", "pending", "proposals"),
    "task.cancel": ("cancelled", "cancel_failed", "failed"),
    "proposal.select": ("selected", "completed", "failed"),
    "binding.verify": ("bound", "failed"),
}

SIGNATURE_HEADER = "X-Relay-Signature"
RSP_HEADER = "X-Relay-RSP"
ORDER_ID_HEADER = "X-Relay-Order-Id"

#: 签名时间窗（秒）。
SIGNATURE_TOLERANCE_SECONDS = 300

#: Relay 的回调地址前缀，回调发到 {base}/v1/callbacks/{order_id}。
DEFAULT_RELAY_BASE_URL = "https://relay.newbeeai.online"
