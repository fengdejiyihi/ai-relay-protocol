import { type DownstreamEnvelope, validateDownstream, verifySignature } from "@dreamcavy/ai-relay-protocol";
import { failed } from "./actions.js";
import type { RelayReply } from "./relay.js";

export type Opened = { ok: true; envelope: DownstreamEnvelope } | { ok: false; reply: RelayReply };

/**
 * 每个供给方端点都一样的前三步：按原始字节验签 → 解析 JSON → 宽松校验信封。
 * 验签失败 401，其余问题 200 + failed（RSP 1.0 第 2 节）；不认识的 type 回 not_supported（D-TYPE-1）。
 */
export function openEnvelope(
  rawBody: Uint8Array | string,
  signature: string | undefined,
  secrets: readonly string[],
  nowMs: number,
): Opened {
  const verified = verifySignature({ secrets, header: signature, body: rawBody, now: Math.floor(nowMs / 1000) });
  if (!verified.ok) return { ok: false, reply: { httpStatus: 401, body: failed("unauthorized", `签名校验失败：${verified.reason}`) } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"));
  } catch {
    return { ok: false, reply: { httpStatus: 200, body: failed("invalid_input", "请求体不是 JSON") } };
  }
  // 供给方用默认的宽松校验：忽略不认识的字段、接受任何 1.x（RSP 1.0 第 14 节）。
  const envelope = validateDownstream(parsed);
  if (!envelope.ok) {
    const unknownType = envelope.errors.find((e) => e.rule === "D-TYPE-1");
    if (unknownType) return { ok: false, reply: { httpStatus: 200, body: failed("not_supported", unknownType.message) } };
    return { ok: false, reply: { httpStatus: 200, body: failed("invalid_input", "不是合法的 RSP 1.0 信封", envelope.errors) } };
  }
  return { ok: true, envelope: envelope.value };
}
