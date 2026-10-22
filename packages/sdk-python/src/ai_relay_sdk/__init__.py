"""AI Relay 供给方 Python SDK：用 RSP 1.0 把你的产品接入 AI Relay。

- :class:`RelayHandler`：``POST /relay`` 端点（验签、按 type 分发、输入校验、幂等）。
- :class:`RelayCallbackClient`：异步动作的签名回调，失败自动退避重发。
- ``ai_relay_sdk.fastapi`` / ``ai_relay_sdk.flask`` / ``ai_relay_sdk.wsgi``：框架适配。
"""

from .callbacks import (
    CallbackDeliveryError,
    CallbackError,
    CallbackRejected,
    CallbackResult,
    RelayCallbackClient,
    new_event_id,
)
from .constants import ERROR_CODES, RETRYABLE_ERROR_CODES, RSP_VERSION, SIGNATURE_HEADER
from .handler import InvokeContext, RelayHandler, RelayReply, hash_input
from .idempotency import (
    IdempotencyStore,
    MemoryIdempotencyStore,
    SqliteIdempotencyStore,
    StoredResponse,
)
from .responses import (
    RelayError,
    accepted,
    bound,
    cancel_failed,
    cancelled,
    completed,
    failed,
    file,
    image,
    json_part,
    link,
    markdown,
    output,
    pending,
    pong,
    proposal,
    proposals,
    selected,
    text,
)
from .signature import VerifyResult, parse_signature_header, sign_body, verify_signature
from .validation import (
    Issue,
    compile_action_input,
    validate_downstream,
    validate_manifest,
    validate_response,
    validate_upstream,
)

__version__ = "0.1.0"

__all__ = [
    "CallbackDeliveryError",
    "CallbackError",
    "CallbackRejected",
    "CallbackResult",
    "ERROR_CODES",
    "IdempotencyStore",
    "InvokeContext",
    "Issue",
    "MemoryIdempotencyStore",
    "RETRYABLE_ERROR_CODES",
    "RSP_VERSION",
    "RelayCallbackClient",
    "RelayError",
    "RelayHandler",
    "RelayReply",
    "SIGNATURE_HEADER",
    "SqliteIdempotencyStore",
    "StoredResponse",
    "VerifyResult",
    "accepted",
    "bound",
    "cancel_failed",
    "cancelled",
    "compile_action_input",
    "completed",
    "failed",
    "file",
    "hash_input",
    "image",
    "json_part",
    "link",
    "markdown",
    "new_event_id",
    "output",
    "parse_signature_header",
    "pending",
    "pong",
    "proposal",
    "proposals",
    "selected",
    "sign_body",
    "text",
    "validate_downstream",
    "validate_manifest",
    "validate_response",
    "validate_upstream",
    "verify_signature",
]
