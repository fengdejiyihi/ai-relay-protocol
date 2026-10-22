"""POST /relay 的全部逻辑，与 HTTP 框架无关。

给原始请求体和签名头，得到状态码和响应体。FastAPI、Flask、WSGI 适配只是把它接到路由上。

    relay = RelayHandler(
        secrets=[os.environ["RELAY_SECRET"]],
        manifest="manifest.json",
        actions={"book_slot": book_slot},
    )
    reply = relay.handle(raw_body, headers.get("X-Relay-Signature"))

按规范第 2 节：验签失败回 401；其余协议结果（包括业务失败、信封不合法）一律 200 + 响应体；
处理函数抛出意料外的异常时回 500，Relay 把这一笔当「结果未知」进待核对、不扣费，不会当成明确失败。
"""

from __future__ import annotations

import hashlib
import inspect
import json
import logging
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Union

from .constants import RETRYABLE_ERROR_CODES, RSP_HEADER, RSP_VERSION
from .idempotency import IdempotencyStore, MemoryIdempotencyStore, StoredResponse
from .responses import RelayError, Response, failed, pong
from .signature import Body, verify_signature
from .validation import (
    Issue,
    compile_action_input,
    validate_downstream,
    validate_manifest,
    validate_response,
)

logger = logging.getLogger("ai_relay_sdk")

MaybeAwaitable = Union[Response, Awaitable[Response]]
ActionHandler = Callable[[dict[str, Any], "InvokeContext"], MaybeAwaitable]
EnvelopeHandler = Callable[[dict[str, Any]], MaybeAwaitable]

@dataclass(frozen=True)
class InvokeContext:
    """传给动作处理函数的第二个参数。"""

    envelope: dict[str, Any]
    #: 清单里这个动作的定义。
    action_spec: dict[str, Any]

    @property
    def order_id(self) -> str:
        return self.envelope["order_id"]

    @property
    def action(self) -> str:
        return self.envelope["action"]

    @property
    def idempotency_key(self) -> str:
        return self.envelope["idempotency_key"]

    @property
    def manifest_version(self) -> int:
        return self.envelope["manifest_version"]

    @property
    def user(self) -> dict[str, Any]:
        """``relay_uid``（按供给方派生的假名）、``display_name?``、``supplier_user_ref``（未绑定为 None）。"""
        return self.envelope["user"]

    @property
    def deadline_at(self) -> int | None:
        return self.envelope.get("deadline_at")


@dataclass
class RelayReply:
    status_code: int
    body: dict[str, Any]
    headers: dict[str, str] = field(default_factory=lambda: {"Content-Type": "application/json; charset=utf-8", RSP_HEADER: RSP_VERSION})

    def body_bytes(self) -> bytes:
        return json.dumps(self.body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


@dataclass
class _Call:
    """验签、解析、校验都过了，剩下调用业务函数。同步、异步两条路共用这一个结构。"""

    run: Callable[[], Any]
    finish: Callable[[Any], RelayReply]
    abort: Callable[[BaseException], RelayReply]


def _reply(body: Response, status_code: int = 200) -> RelayReply:
    return RelayReply(status_code, body)


class RelayHandler:
    """供给方端点。

    参数：
        secrets: Relay 后台给的 secret。轮换期内新旧两个都传，新的在前。
        manifest: 清单（dict）或清单 JSON 文件路径。动作的输入按清单里的 ``input`` Schema 校验。
        actions: 动作名 → 处理函数 ``fn(input, ctx) -> 响应``。可以是普通函数或 ``async def``；
            ``async def`` 只能用 :meth:`handle_async`（FastAPI 适配就是）。清单里每个动作都必须有处理函数。
        task_poll / task_cancel / proposal_select / binding_verify: 异步、多方案、账号绑定用的处理函数
            ``fn(envelope) -> 响应``。没给的信封类型回 ``not_supported``。
        idempotency_store: 幂等缓存，默认进程内存。多进程部署换成 :class:`SqliteIdempotencyStore` 或自己的实现。
        check_output: 动作声明了 ``output`` Schema 时校验 ``completed`` 的 ``output.data``，不符只记警告日志（规范第 8 节是「应当」）。
        now: 返回当前 unix 秒的函数，测试用。
    """

    def __init__(
        self,
        *,
        secrets: Sequence[str] | str,
        manifest: Mapping[str, Any] | str | Path,
        actions: Mapping[str, ActionHandler],
        task_poll: EnvelopeHandler | None = None,
        task_cancel: EnvelopeHandler | None = None,
        proposal_select: EnvelopeHandler | None = None,
        binding_verify: EnvelopeHandler | None = None,
        idempotency_store: IdempotencyStore | None = None,
        check_output: bool = True,
        now: Callable[[], float] | None = None,
    ) -> None:
        # 空串、纯空白的 secret 一律丢掉：环境变量没配时不能退化成用空密钥验签。
        self.secrets = [s for s in ([secrets] if isinstance(secrets, str) else secrets) if s and s.strip()]
        if not self.secrets:
            raise ValueError("secrets 至少要有一个非空的 secret")
        loaded: Mapping[str, Any] = (
            json.loads(Path(manifest).read_text("utf-8")) if isinstance(manifest, (str, Path)) else manifest
        )
        issues = validate_manifest(loaded)
        if issues:
            raise ValueError("清单不合法：" + "; ".join(f"{i.path} {i.message}" for i in issues))
        self.manifest = dict(loaded)
        self._specs = {a["name"]: a for a in self.manifest["actions"]}
        missing = [name for name in self._specs if name not in actions]
        extra = [name for name in actions if name not in self._specs]
        if missing:
            raise ValueError(f"清单里的动作没有处理函数：{', '.join(missing)}")
        if extra:
            raise ValueError(f"这些处理函数不在清单里：{', '.join(extra)}")
        self._actions = dict(actions)
        self._inputs = {name: compile_action_input(spec["input"]) for name, spec in self._specs.items()}
        self._outputs = {
            name: compile_action_input(spec["output"]) for name, spec in self._specs.items() if check_output and "output" in spec
        }
        self._envelope_handlers: dict[str, EnvelopeHandler | None] = {
            "task.poll": task_poll,
            "task.cancel": task_cancel,
            "proposal.select": proposal_select,
            "binding.verify": binding_verify,
        }
        self.store: IdempotencyStore = idempotency_store or MemoryIdempotencyStore()
        self._now = now or time.time

    # ---- 对外入口 --------------------------------------------------------------------

    def handle(self, body: Body, signature: str | None) -> RelayReply:
        """同步入口（Flask、WSGI）。处理函数不能是 ``async def``。"""
        step = self._prepare(body, signature)
        if isinstance(step, RelayReply):
            return step
        try:
            result = step.run()
            if inspect.isawaitable(result):
                close = getattr(result, "close", None)
                if close:
                    close()
                raise TypeError("处理函数是 async def，请改用 handle_async（比如 FastAPI 适配）")
        except BaseException as exc:  # noqa: BLE001 —— 任何异常都要放开幂等占用
            return step.abort(exc)
        return step.finish(result)

    async def handle_async(self, body: Body, signature: str | None) -> RelayReply:
        """异步入口（FastAPI、Starlette）。处理函数可以是普通函数，也可以是 ``async def``。"""
        step = self._prepare(body, signature)
        if isinstance(step, RelayReply):
            return step
        try:
            result = step.run()
            if inspect.isawaitable(result):
                result = await result
        except BaseException as exc:  # noqa: BLE001
            return step.abort(exc)
        return step.finish(result)

    # ---- 内部 ------------------------------------------------------------------------

    def _prepare(self, body: Body, signature: str | None) -> RelayReply | _Call:
        verified = verify_signature(self.secrets, signature, body, now=int(self._now()))
        if not verified:
            return _reply(failed("unauthorized", f"签名校验失败：{verified.reason}"), 401)

        try:
            envelope = json.loads(body if isinstance(body, str) else bytes(body).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return _reply(failed("invalid_input", "请求体不是 JSON"))

        # 宽松校验：忽略不认识的字段、接受任何 1.x（规范第 14 节）。
        issues = validate_downstream(envelope)
        if issues:
            if any(i.rule == "D-TYPE-1" for i in issues):
                return _reply(failed("not_supported", issues[0].message))
            return _reply(failed("invalid_input", "不是合法的 RSP 1.0 信封", details=_details(issues)))

        type_ = envelope["type"]
        if type_ == "ping":
            return _reply(pong(envelope["challenge"]))
        if type_ == "action.invoke":
            return self._prepare_invoke(envelope)
        handler = self._envelope_handlers[type_]
        if handler is None:
            return _reply(failed("not_supported", f"这个端点不处理 {type_}"))
        return _Call(
            run=lambda: handler(envelope),
            finish=lambda result: self._finish(type_, result),
            abort=lambda exc: self._abort(type_, exc),
        )

    def _prepare_invoke(self, envelope: dict[str, Any]) -> RelayReply | _Call:
        name = envelope["action"]
        spec = self._specs.get(name)
        if spec is None:
            return _reply(failed("invalid_input", f"没有动作 {name}"))
        issues = self._inputs[name](envelope["input"])
        if issues:
            return _reply(failed("invalid_input", "输入不符合动作的 input Schema", details=_details(issues)))

        ctx = InvokeContext(envelope, spec)
        handler = self._actions[name]
        run = lambda: handler(envelope["input"], ctx)  # noqa: E731

        deadline = envelope.get("deadline_at")
        expired = deadline is not None and deadline < self._now()
        late = lambda: _reply(failed("temporary", "已超过 deadline_at，Relay 不再等待这次结果，未做任何处理"))  # noqa: E731

        key = envelope["idempotency_key"]
        input_hash = hash_input(name, envelope["input"])
        if not self.store.acquire(key):
            return _reply(failed("temporary", "同一个 idempotency_key 正在处理中，请稍后重试"))
        try:
            stored = self.store.get(key)
        except BaseException:
            self.store.release(key)
            raise
        if stored is not None:
            self.store.release(key)
            if stored.action == name and stored.input_hash == input_hash:
                return _reply(stored.response)
            return _reply(failed("invalid_input", "这个 idempotency_key 已用于另一笔不同的请求"))
        # deadline 放在查缓存之后：已有最终结果的键过了 deadline 再重放，仍返回第一次的结果。
        if expired:
            self.store.release(key)
            return late()

        def finish(result: Any) -> RelayReply:
            try:
                reply = self._finish("action.invoke", result, name)
                response = reply.body
                if reply.status_code == 200 and not (
                    response["status"] == "failed" and response["error"]["code"] in RETRYABLE_ERROR_CODES
                ):
                    self.store.save(key, StoredResponse(name, input_hash, response))
                return reply
            finally:
                self.store.release(key)

        def abort(exc: BaseException) -> RelayReply:
            try:
                reply = self._abort("action.invoke", exc)
                if reply.status_code == 200 and reply.body["error"]["code"] not in RETRYABLE_ERROR_CODES:
                    self.store.save(key, StoredResponse(name, input_hash, reply.body))
                return reply
            finally:
                self.store.release(key)

        return _Call(run, finish, abort)

    def _finish(self, type_: str, result: Any, action: str | None = None) -> RelayReply:
        issues = validate_response(type_, result)
        if issues:
            logger.error("%s 的处理函数返回了不合法的响应 %r：%s", type_, result, _details(issues))
            # 结果未知（可能已经执行了副作用），回 500 让 Relay 进待核对，而不是当成明确失败。
            return _reply(failed("permanent", "供给方返回了不合法的响应"), 500)
        check = self._outputs.get(action) if action else None
        if check and result["status"] == "completed":
            problems = check(result["output"]["data"])
            if problems:
                logger.warning("动作 %s 的 output.data 不符合清单里的 output Schema：%s", action, _details(problems))
        return _reply(result)

    def _abort(self, type_: str, exc: BaseException) -> RelayReply:
        if isinstance(exc, RelayError):
            return _reply(exc.to_response())
        if not isinstance(exc, Exception):
            raise exc
        logger.exception("处理 %s 时出错", type_, exc_info=exc)
        return _reply(failed("permanent", "供给方内部错误，结果未知"), 500)


def hash_input(action: str, value: Any) -> str:
    """动作名 + 规范化（键排序）输入的 sha256，用来判断同一个键是不是同一笔请求。"""
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(f"{action}\n{canonical}".encode()).hexdigest()


def _details(issues: list[Issue]) -> list[dict[str, str]]:
    return [i.to_dict() for i in issues]
