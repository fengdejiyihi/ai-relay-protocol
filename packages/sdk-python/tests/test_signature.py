from __future__ import annotations

import pytest

from ai_relay_sdk import parse_signature_header, sign_body, verify_signature

# 规范附录 A 的可复算样例。
APPENDIX_SECRET = "whsec_example_do_not_use"
DOWNSTREAM_BODY = '{"type":"action.invoke","rsp":"1.0","issued_at":1761055200,"order_id":"ord_01JBK7Q2M4X9TZ","action":"book_slot","manifest_version":1,"input":{"slot_id":"s_20261023_1500_haircut","name":"张三","phone":"13800001234"},"user":{"relay_uid":"u_pair_7f3a9c21d4","display_name":"小李","supplier_user_ref":null},"idempotency_key":"ord_01JBK7Q2M4X9TZ"}'
DOWNSTREAM_SIG = "t=1761055200,v1=76d3727085c7031b4df41064e38ced9c187e1518a1eb4590b26b0a78da4f32eb"
CALLBACK_BODY = '{"type":"completed","rsp":"1.0","order_id":"ord_01JBK9P3R5W2YQ","event_id":"evt_7781","occurred_at":1761058800,"output":{"data":{"article_url":"https://mp.example.com/s/abc"},"parts":[{"type":"link","url":"https://mp.example.com/s/abc","title":"查看已发布文章"}]}}'
CALLBACK_SIG = "t=1761058800,v1=60f6a93ae6b300db591e89b25844fe7c8db8c9726f34c82ee0121a16124420da"


def test_appendix_a_vectors() -> None:
    assert sign_body(APPENDIX_SECRET, DOWNSTREAM_BODY, 1761055200) == DOWNSTREAM_SIG
    assert sign_body(APPENDIX_SECRET, CALLBACK_BODY.encode("utf-8"), 1761058800) == CALLBACK_SIG
    assert verify_signature([APPENDIX_SECRET], DOWNSTREAM_SIG, DOWNSTREAM_BODY.encode("utf-8"), now=1761055200).ok


def test_str_and_bytes_body_agree_with_multibyte_characters() -> None:
    body = '{"name":"张三🙂"}'
    assert sign_body("s", body, 1) == sign_body("s", body.encode("utf-8"), 1)
    assert sign_body("s", bytearray(body.encode("utf-8")), 1) == sign_body("s", memoryview(body.encode("utf-8")), 1)


def test_rotation_accepts_old_secret_and_reports_index() -> None:
    header = sign_body("old", b"{}", 100)
    result = verify_signature(["new", "old"], header, b"{}", now=100)
    assert result.ok and result.secret_index == 1


def test_multiple_v1_any_match_passes() -> None:
    good = sign_body("s", b"{}", 100).split(",")[1]
    header = f"t=100,v1={'0' * 64},{good}"
    assert verify_signature(["s"], header, b"{}", now=100).ok


def test_single_secret_string_is_accepted() -> None:
    assert verify_signature("s", sign_body("s", b"x", 5), b"x", now=5).ok


@pytest.mark.parametrize("skew", [301, -301])
def test_outside_five_minute_window_is_expired(skew: int) -> None:
    header = sign_body("s", b"{}", 1000)
    result = verify_signature(["s"], header, b"{}", now=1000 + skew)
    assert not result.ok and result.reason == "expired"


def test_edge_of_window_still_passes() -> None:
    assert verify_signature(["s"], sign_body("s", b"{}", 1000), b"{}", now=1300).ok


@pytest.mark.parametrize(
    "header",
    [None, "", "v1=" + "a" * 64, "t=100", "t=abc,v1=" + "a" * 64, "t=100,v1=XYZ", "t=100,v1=" + "A" * 64, "garbage"],
)
def test_malformed_headers(header: str | None) -> None:
    result = verify_signature(["s"], header, b"{}", now=100)
    assert not result.ok and result.reason == "malformed"


def test_tampered_body_and_wrong_secret_mismatch() -> None:
    header = sign_body("s", b'{"a":1}', 100)
    assert verify_signature(["s"], header, b'{"a":2}', now=100).reason == "mismatch"
    assert verify_signature(["other"], header, b'{"a":1}', now=100).reason == "mismatch"


def test_parse_ignores_unknown_schemes() -> None:
    parsed = parse_signature_header(f"t=1, v0=zzz, v1={'b' * 64}")
    assert parsed == (1, ["b" * 64])
