"""构造同步响应、返回内容块和方案的辅助函数。返回的都是普通 dict，可以直接 JSON 序列化。"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from .constants import ERROR_CODES, RSP_VERSION

Response = dict[str, Any]


class RelayError(Exception):
    """在动作处理函数里抛出，SDK 把它转成 ``{"status": "failed", "error": {...}}``。

    适合在深层业务代码里直接中断，比如 ``raise RelayError("not_available", "这个时段已约满")``。
    ``temporary`` 和 ``rate_limited`` 表示「确认没有执行」，Relay 会用同一个幂等键重试，SDK 不缓存它们。
    """

    def __init__(
        self,
        code: str,
        message: str | None = None,
        *,
        details: Any = None,
        retry_after: int | None = None,
    ) -> None:
        if code not in ERROR_CODES:
            raise ValueError(f"错误码必须是 {', '.join(ERROR_CODES)} 之一，收到 {code!r}")
        super().__init__(message or code)
        self.code = code
        self.message = message
        self.details = details
        self.retry_after = retry_after

    def to_response(self) -> Response:
        return failed(self.code, self.message, details=self.details, retry_after=self.retry_after)


def output(data: Mapping[str, Any], parts: Iterable[Mapping[str, Any]] | None = None) -> dict[str, Any]:
    """``completed`` 的 output、方案的 content：``data`` 给 AI 判断用，``parts`` 给人看（规范第 8 节）。"""
    out: dict[str, Any] = {"data": dict(data)}
    if parts is not None:
        out["parts"] = [dict(p) for p in parts]
    return out


def completed(data: Mapping[str, Any], parts: Iterable[Mapping[str, Any]] | None = None) -> Response:
    return {"status": "completed", "output": output(data, parts)}


def failed(code: str, message: str | None = None, *, details: Any = None, retry_after: int | None = None) -> Response:
    if code not in ERROR_CODES:
        raise ValueError(f"错误码必须是 {', '.join(ERROR_CODES)} 之一，收到 {code!r}")
    error: dict[str, Any] = {"code": code}
    if message is not None:
        error["message"] = message
    if retry_after is not None:
        error["retry_after"] = retry_after
    if details is not None:
        error["details"] = details
    return {"status": "failed", "error": error}


def accepted(task_id: str, eta_seconds: int | None = None) -> Response:
    """异步动作已接单，结果之后通过回调或 ``task.poll`` 给出。"""
    out: Response = {"status": "accepted", "task_id": task_id}
    if eta_seconds is not None:
        out["eta_seconds"] = eta_seconds
    return out


def pending(eta_seconds: int | None = None) -> Response:
    """只用于 ``task.poll``：任务仍在处理。"""
    out: Response = {"status": "pending"}
    if eta_seconds is not None:
        out["eta_seconds"] = eta_seconds
    return out


def proposal(
    proposal_id: str,
    title: str,
    data: Mapping[str, Any],
    parts: Iterable[Mapping[str, Any]] | None = None,
    *,
    price_cents: int | None = None,
    eta_days: int | None = None,
) -> dict[str, Any]:
    """多方案里的一个方案，用于 ``proposals(...)`` 响应和 ``proposal.add`` 回调。"""
    out: dict[str, Any] = {"proposal_id": proposal_id, "title": title, "content": output(data, parts)}
    if price_cents is not None:
        out["price_cents"] = price_cents
    if eta_days is not None:
        out["eta_days"] = eta_days
    return out


def proposals(items: Iterable[Mapping[str, Any]]) -> Response:
    """只用于 ``task.poll``：多方案任务当前全部有效方案。"""
    return {"status": "proposals", "proposals": [dict(p) for p in items]}


def cancelled() -> Response:
    return {"status": "cancelled"}


def cancel_failed(reason: str | None = None) -> Response:
    """已不可撤回（比如文章已发出）。"""
    out: Response = {"status": "cancel_failed"}
    if reason is not None:
        out["reason"] = reason
    return out


def selected() -> Response:
    """``proposal.select`` 已受理，最终结果仍走 ``completed`` 回调。"""
    return {"status": "selected"}


def bound(supplier_user_ref: str, display_name: str | None = None) -> Response:
    """``binding.verify``：绑定码有效，返回用户在本产品的账号标识。"""
    out: Response = {"status": "bound", "supplier_user_ref": supplier_user_ref}
    if display_name is not None:
        out["display_name"] = display_name
    return out


def pong(challenge: str) -> Response:
    return {"status": "ok", "challenge": challenge, "rsp": RSP_VERSION}


# ---- 返回内容块（parts） -------------------------------------------------------------


def text(value: str) -> dict[str, Any]:
    return {"type": "text", "text": value}


def markdown(value: str) -> dict[str, Any]:
    return {"type": "markdown", "text": value}


def image(*, url: str | None = None, base64: str | None = None, mime: str | None = None, alt: str | None = None) -> dict[str, Any]:
    """图片：``url`` 与 ``base64``（配 ``mime``）二选一。"""
    if (url is None) == (base64 is None):
        raise ValueError("image 的 url 与 base64 必须恰好给一个")
    if base64 is not None and mime is None:
        raise ValueError("base64 图片必须给 mime，比如 image/png")
    out: dict[str, Any] = {"type": "image"}
    for key, value in (("url", url), ("base64", base64), ("mime", mime), ("alt", alt)):
        if value is not None:
            out[key] = value
    return out


def file(url: str, name: str, *, mime: str | None = None, size: int | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"type": "file", "url": url, "name": name}
    if mime is not None:
        out["mime"] = mime
    if size is not None:
        out["size"] = size
    return out


def link(url: str, title: str) -> dict[str, Any]:
    return {"type": "link", "url": url, "title": title}


def json_part(value: Any) -> dict[str, Any]:
    return {"type": "json", "value": value}
