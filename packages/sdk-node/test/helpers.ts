import { signBody } from "@dreamcavy/ai-relay-protocol";

export const SECRET = "whsec_test_new_secret";
export const OLD_SECRET = "whsec_test_old_secret";

let seq = 0;
export function orderId(): string {
  seq += 1;
  return `ord_TEST${String(seq).padStart(10, "0")}`;
}

export function invokeEnvelope(action: string, input: Record<string, unknown>, id = orderId(), extra: Record<string, unknown> = {}) {
  return {
    type: "action.invoke",
    rsp: "1.0",
    issued_at: Math.floor(Date.now() / 1000),
    order_id: id,
    action,
    manifest_version: 1,
    input,
    user: { relay_uid: "u_pair_test01", display_name: "测试用户", supplier_user_ref: null },
    idempotency_key: id,
    ...extra,
  };
}

export function pingEnvelope(challenge = "challenge_0123456789abcdef") {
  return { type: "ping", rsp: "1.0", issued_at: Math.floor(Date.now() / 1000), challenge };
}

export function signed(envelope: unknown, secret = SECRET, timestamp?: number): { body: string; signature: string } {
  const body = JSON.stringify(envelope);
  return { body, signature: signBody(secret, body, timestamp) };
}
