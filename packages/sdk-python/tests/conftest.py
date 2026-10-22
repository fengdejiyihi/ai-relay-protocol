from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

from ai_relay_sdk import sign_body

PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE))  # 让测试能 import examples.*

SECRET = "whsec_test_current"
OLD_SECRET = "whsec_test_previous"
NOW = 1_761_055_200


def envelope(type_: str, **fields: Any) -> dict[str, Any]:
    return {"type": type_, "rsp": "1.0", "issued_at": NOW, **fields}


def invoke(action: str, input_: dict[str, Any], order_id: str = "ord_TEST000000001", **extra: Any) -> dict[str, Any]:
    return envelope(
        "action.invoke",
        order_id=order_id,
        action=action,
        manifest_version=1,
        input=input_,
        user={"relay_uid": "u_pair_test0001", "supplier_user_ref": None},
        idempotency_key=order_id,
        **extra,
    )


def signed(body: dict[str, Any] | str | bytes, secret: str = SECRET, timestamp: int = NOW) -> tuple[bytes, str]:
    raw = body if isinstance(body, bytes) else (body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)).encode("utf-8")
    return raw, sign_body(secret, raw, timestamp)


MANIFEST: dict[str, Any] = {
    "rsp": "1.0",
    "supplier": {"name": "测试商家", "description": "单测用", "locale": "zh-CN", "categories": ["测试"], "user_binding": "none"},
    "endpoint": {"url": "https://test.example.com/relay", "auth": "hmac-sha256"},
    "actions": [
        {
            "name": "lookup",
            "title": "查询",
            "input": {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
            "readonly": True,
            "risk": "low",
            "confirm": "never",
            "mode": "sync",
            "billing": "none",
            "fee": 0,
            "amount": "none",
        },
        {
            "name": "book",
            "title": "预订",
            "input": {
                "type": "object",
                "properties": {"item": {"type": "string"}, "price_cents": {"type": "integer", "minimum": 0}},
                "required": ["item", "price_cents"],
                "additionalProperties": False,
            },
            "output": {"type": "object", "properties": {"booking_id": {"type": "string"}}, "required": ["booking_id"]},
            "risk": "medium",
            "confirm": "by_grant",
            "mode": "sync",
            "billing": "on_complete",
            "fee": 100,
            "amount": {"from": "input.price_cents"},
        },
    ],
}


@pytest.fixture
def manifest() -> dict[str, Any]:
    return json.loads(json.dumps(MANIFEST))
