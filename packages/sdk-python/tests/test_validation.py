from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_relay_sdk import (
    compile_action_input,
    validate_downstream,
    validate_manifest,
    validate_response,
    validate_upstream,
)
from ai_relay_sdk.validation import load_schema

from .conftest import MANIFEST, envelope, invoke

PROTOCOL_SCHEMAS = Path(__file__).resolve().parents[2] / "protocol" / "schemas"


@pytest.mark.skipif(not PROTOCOL_SCHEMAS.exists(), reason="不在协议仓库里")
@pytest.mark.parametrize("name", ["common", "downstream", "responses", "upstream", "manifest"])
def test_bundled_schemas_match_protocol(name: str) -> None:
    assert load_schema(name) == json.loads((PROTOCOL_SCHEMAS / f"{name}.json").read_text("utf-8")), (
        "运行 python scripts/sync_schemas.py"
    )


def test_tolerant_ignores_unknown_fields_and_minor_versions() -> None:
    env = invoke("book", {"item": "x", "price_cents": 1}, rsp="1.7", trace_id="abc")
    env["user"]["future_field"] = True
    assert validate_downstream(env) == []
    strict = validate_downstream(env, strict=True)
    assert strict and all(i.rule == "schema" for i in strict)


def test_tolerant_still_checks_required_fields_and_types() -> None:
    env = invoke("book", {})
    del env["idempotency_key"]
    env["manifest_version"] = "1"
    paths = {i.path for i in validate_downstream(env)}
    assert "/" in paths or any("idempotency_key" in i.message for i in validate_downstream(env))
    assert "/manifest_version" in paths


def test_major_version_two_is_rejected() -> None:
    assert validate_downstream(envelope("ping", challenge="c" * 16, rsp="2.0"))


def test_unknown_type_is_d_type_1() -> None:
    issues = validate_downstream(envelope("future.thing"))
    assert [i.rule for i in issues] == ["D-TYPE-1"]


def test_non_object_envelope() -> None:
    assert validate_downstream([1, 2])
    assert validate_downstream("x")


def test_response_status_must_match_type() -> None:
    assert validate_response("action.invoke", {"status": "pending"})[0].rule == "R-STATUS-1"
    assert validate_response("task.poll", {"status": "pending"}) == []
    assert validate_response("action.invoke", {"status": "completed", "output": {"data": {}}, "trace": 1}) == []
    assert validate_response("action.invoke", {"status": "completed", "output": {"data": {}}, "trace": 1}, strict=True)
    assert validate_response("action.invoke", {"status": "failed", "error": {"code": "nope"}})


def test_image_part_url_and_base64_are_exclusive() -> None:
    both = {"status": "completed", "output": {"data": {}, "parts": [{"type": "image", "url": "https://x", "base64": "AA", "mime": "image/png"}]}}
    assert validate_response("action.invoke", both)


def test_upstream_strict() -> None:
    event = {"type": "completed", "rsp": "1.0", "order_id": "ord_TEST000000001", "event_id": "e1", "occurred_at": 1761055200, "output": {"data": {}}}
    assert validate_upstream(event, strict=True) == []
    assert validate_upstream({**event, "extra": 1}, strict=True)
    assert validate_upstream({**event, "type": "nope"})


def test_manifest_schema_and_duplicate_names() -> None:
    assert validate_manifest(MANIFEST) == []
    dup = json.loads(json.dumps(MANIFEST))
    dup["actions"].append(dup["actions"][0])
    assert [i.rule for i in validate_manifest(dup)] == ["M-NAME-1"]
    bad = json.loads(json.dumps(MANIFEST))
    bad["endpoint"]["url"] = "http://insecure.example.com"
    assert validate_manifest(bad)


def test_action_input_checks_known_formats() -> None:
    check = compile_action_input({"type": "object", "properties": {"d": {"type": "string", "format": "date"}}})
    assert check({"d": "2026-10-22"}) == []
    assert check({"d": "not a date"})
