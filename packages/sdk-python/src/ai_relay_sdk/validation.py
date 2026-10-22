"""按协议的 JSON Schema 校验信封、响应、回调事件和清单。

两种口径，与协议包一致（规范第 14 节）：

- 宽松（默认）：忽略不认识的字段，``rsp`` 接受任何 1.x；必填字段、类型和枚举照样严格。
  供给方校验 Relay 发来的信封用这个，Relay 在 1.x 内加字段时已接通的供给方不用改。
- 严格：不允许 Schema 外的字段，``rsp`` 必须是 "1.0"。SDK 自检自己要发出去的响应和回调时用。
"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from dataclasses import dataclass
from functools import cache
from importlib import resources
from typing import Any, Literal

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from .constants import DOWNSTREAM_TYPES, RESPONSE_STATUSES_BY_TYPE, UPSTREAM_TYPES

Flavor = Literal["strict", "tolerant"]

_BASE = "https://relay.newbeeai.online/schemas/rsp/1.0/"
_NAMES = ("common", "downstream", "responses", "upstream", "manifest")


@dataclass(frozen=True)
class Issue:
    #: JSON Pointer，指向出错的位置。
    path: str
    message: str
    #: 规则编号；Schema 层错误为 "schema"。
    rule: str = "schema"

    def to_dict(self) -> dict[str, str]:
        return {"path": self.path, "message": self.message, "rule": self.rule}


def load_schema(name: str) -> dict[str, Any]:
    """读取随包分发的协议 Schema（common、downstream、responses、upstream、manifest）。"""
    text = resources.files("ai_relay_sdk").joinpath("schemas").joinpath(f"{name}.json").read_text("utf-8")
    return json.loads(text)


def _tolerant(node: Any) -> Any:
    if isinstance(node, list):
        return [_tolerant(item) for item in node]
    if not isinstance(node, dict):
        return node
    return {
        key: _tolerant(value)
        for key, value in node.items()
        if not (key in ("additionalProperties", "unevaluatedProperties") and value is False)
    }


@cache
def _registry(flavor: Flavor) -> Registry:
    resources_ = []
    for name in _NAMES:
        schema = load_schema(name)
        if flavor == "tolerant":
            schema = _tolerant(schema)
            if name == "common":
                schema["$defs"]["rsp_version"] = {"type": "string", "pattern": r"^1\.\d+$"}
        resources_.append((_BASE + f"{name}.json", Resource.from_contents(schema, default_specification=DRAFT202012)))
    return Registry().with_resources(resources_)


@cache
def _validator(ref: str, flavor: Flavor) -> Draft202012Validator:
    return Draft202012Validator({"$ref": _BASE + ref}, registry=_registry(flavor))


def _issues(validator: Draft202012Validator, instance: Any) -> list[Issue]:
    errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path))
    return [Issue(_pointer(e.absolute_path), e.message) for e in errors]


def _pointer(path: Any) -> str:
    parts = [str(p).replace("~", "~0").replace("/", "~1") for p in path]
    return "/" + "/".join(parts) if parts else "/"


def _flavor(strict: bool) -> Flavor:
    return "strict" if strict else "tolerant"


def validate_downstream(envelope: Any, *, strict: bool = False) -> list[Issue]:
    """校验 Relay 发来的信封，返回问题列表，空列表表示通过。

    不认识的 ``type`` 返回规则 ``D-TYPE-1``，供给方应回 ``not_supported``；其余问题回 ``invalid_input``。
    """
    type_ = envelope.get("type") if isinstance(envelope, dict) else None
    if isinstance(type_, str) and type_ not in DOWNSTREAM_TYPES:
        return [Issue("/type", f"不认识的信封类型：{type_}，应回 not_supported", "D-TYPE-1")]
    if isinstance(type_, str):
        # 直接按具体类型校验，错误信息比 oneOf 整体失败好读。
        return _issues(_validator(f"downstream.json#/$defs/{type_}", _flavor(strict)), envelope)
    return _issues(_validator("downstream.json", _flavor(strict)), envelope)


def validate_response(type_: str, response: Any, *, strict: bool = False) -> list[Issue]:
    """校验对某类下行信封的同步响应，只接受该类型允许的 status。"""
    allowed = RESPONSE_STATUSES_BY_TYPE.get(type_, ())
    status = response.get("status") if isinstance(response, dict) else None
    if not isinstance(status, str) or status not in allowed:
        return [Issue("/status", f"{type_} 的响应 status 必须是 {' / '.join(allowed)}", "R-STATUS-1")]
    ref = "ping" if status == "ok" else status
    return _issues(_validator(f"responses.json#/$defs/{ref}", _flavor(strict)), response)


def validate_upstream(event: Any, *, strict: bool = False) -> list[Issue]:
    """校验发给 Relay 的回调事件。"""
    type_ = event.get("type") if isinstance(event, dict) else None
    if isinstance(type_, str) and type_ in UPSTREAM_TYPES:
        return _issues(_validator(f"upstream.json#/$defs/{type_}", _flavor(strict)), event)
    return _issues(_validator("upstream.json", _flavor(strict)), event)


def validate_manifest(manifest: Any) -> list[Issue]:
    """按 manifest.json 校验清单结构（严格）。

    规范 4.4 的语义规则（M-RISK-1、M-AMT-2 等）和平台审核策略不在这里，提交清单时 Relay 会查，
    也可以用 Conformance 工具自查。
    """
    issues = _issues(_validator("manifest.json", "strict"), manifest)
    if not issues:
        seen: set[str] = set()
        for i, action in enumerate(manifest["actions"]):
            if action["name"] in seen:
                issues.append(Issue(f"/actions/{i}/name", f"动作名重复：{action['name']}", "M-NAME-1"))
            seen.add(action["name"])
    return issues


def compile_action_input(schema: dict[str, Any]) -> Callable[[Any], list[Issue]]:
    """编译动作的 input（或 output）JSON Schema 2020-12，返回校验函数。

    动作 Schema 由供给方自己写，按原样校验（写了 additionalProperties: false 就拒绝多余字段）。
    能识别的 format（date、email 等）会校验，不认识的 format 忽略。
    """
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(copy.deepcopy(schema), format_checker=Draft202012Validator.FORMAT_CHECKER)
    return lambda instance: _issues(validator, instance)
