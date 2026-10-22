"""X-Relay-Signature 的签名与验签，只用标准库。

    X-Relay-Signature: t=<unix 秒>,v1=<hex>
    v1 = HMAC-SHA256(secret, t + "." + 原始请求体)

和 Stripe Webhook 同一算法，双向通用（规范第 3 节）。
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Union

from .constants import SIGNATURE_TOLERANCE_SECONDS

Body = Union[bytes, bytearray, memoryview, str]

_TIMESTAMP = re.compile(r"^\d{1,12}$")
_V1 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    #: 失败原因：malformed（头缺失或格式不对）、expired（超出时间窗）、mismatch（没有一个 secret 对得上）。
    reason: Literal["malformed", "expired", "mismatch"] | None = None
    timestamp: int | None = None
    #: 匹配上的是第几个 secret，0 是新的；轮换期内用旧 secret 签的请求为 1。
    secret_index: int | None = None

    def __bool__(self) -> bool:
        return self.ok


def sign_body(secret: str, body: Body, timestamp: int | None = None) -> str:
    """返回 X-Relay-Signature 头的值。body 必须是要发出去的原始字节（或将按 UTF-8 编码发出的字符串）。"""
    t = int(time.time()) if timestamp is None else int(timestamp)
    return f"t={t},v1={_hmac_hex(secret, t, body)}"


def parse_signature_header(header: str | None) -> tuple[int, list[str]] | None:
    """解析签名头，返回 (时间戳, [v1 签名…])；格式不对返回 None。头部可以带多个 v1（轮换期）。"""
    if not header:
        return None
    timestamp: int | None = None
    signatures: list[str] = []
    for part in header.split(","):
        key, sep, value = part.partition("=")
        if not sep:
            return None
        key, value = key.strip(), value.strip()
        if key == "t":
            if not _TIMESTAMP.match(value):
                return None
            timestamp = int(value)
        elif key == "v1":
            if not _V1.match(value):
                return None
            signatures.append(value)
    if timestamp is None or not signatures:
        return None
    return timestamp, signatures


def verify_signature(
    secrets: Sequence[str],
    header: str | None,
    body: Body,
    *,
    now: int | None = None,
    tolerance_seconds: int = SIGNATURE_TOLERANCE_SECONDS,
) -> VerifyResult:
    """用收到的原始字节验签。

    secrets：当前有效的 secret，轮换期内新旧两个都传，新的在前。
    body：最好直接传收到的 bytes；传 str 时必须是整段字节按 UTF-8 一次性解码的结果，
    不能先解析 JSON 再序列化。
    """
    if isinstance(secrets, str):
        secrets = [secrets]
    parsed = parse_signature_header(header)
    if parsed is None:
        return VerifyResult(False, "malformed")
    timestamp, candidates = parsed
    current = int(time.time()) if now is None else int(now)
    if abs(current - timestamp) > tolerance_seconds:
        return VerifyResult(False, "expired", timestamp)
    for index, secret in enumerate(secrets):
        expected = _hmac_hex(secret, timestamp, body)
        for candidate in candidates:
            if hmac.compare_digest(expected, candidate):
                return VerifyResult(True, None, timestamp, index)
    return VerifyResult(False, "mismatch", timestamp)


def _hmac_hex(secret: str, timestamp: int, body: Body) -> str:
    mac = hmac.new(secret.encode("utf-8"), f"{timestamp}.".encode("ascii"), hashlib.sha256)
    mac.update(body.encode("utf-8") if isinstance(body, str) else bytes(body))
    return mac.hexdigest()
