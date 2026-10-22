import { createHmac, timingSafeEqual } from "node:crypto";
import { LIMITS } from "./constants.js";

/**
 * X-Relay-Signature: t=<unix 秒>,v1=<hex>
 * 签名内容 = `${t}.${原始请求体}`，HMAC-SHA256，密钥为该供给方的 secret。
 * 与 Stripe Webhook 同款。双向通用：Relay → 供给方，供给方回调 → Relay。
 */
export function signBody(secret: string, body: string | Uint8Array, timestamp: number = nowSeconds()): string {
  return `t=${timestamp},v1=${hmacHex(secret, timestamp, body)}`;
}

export type VerifyResult =
  | { ok: true; timestamp: number; secretIndex: number }
  | { ok: false; reason: "malformed" | "expired" | "mismatch" };

export interface VerifyOptions {
  /** 当前有效的 secret；轮换期内新旧两个都传，新的在前。 */
  secrets: readonly string[];
  header: string | null | undefined;
  /**
   * 原始请求体。最好直接传收到的字节（Buffer.concat 拼好的 Buffer）；传字符串时必须是整段字节一次性
   * 按 UTF-8 解码的结果，不能逐块解码（多字节字符会被切坏），也不能先解析再序列化。
   */
  body: string | Uint8Array;
  now?: number;
  toleranceSeconds?: number;
}

export function verifySignature(options: VerifyOptions): VerifyResult {
  const parsed = parseSignatureHeader(options.header);
  if (!parsed) return { ok: false, reason: "malformed" };
  const now = options.now ?? nowSeconds();
  const tolerance = options.toleranceSeconds ?? LIMITS.signatureToleranceSeconds;
  if (Math.abs(now - parsed.timestamp) > tolerance) return { ok: false, reason: "expired" };
  for (const [i, secret] of options.secrets.entries()) {
    const expected = Buffer.from(hmacHex(secret, parsed.timestamp, options.body), "hex");
    for (const candidate of parsed.signatures) {
      const given = Buffer.from(candidate, "hex");
      if (given.length === expected.length && timingSafeEqual(given, expected)) {
        return { ok: true, timestamp: parsed.timestamp, secretIndex: i };
      }
    }
  }
  return { ok: false, reason: "mismatch" };
}

export function parseSignatureHeader(header: string | null | undefined): { timestamp: number; signatures: string[] } | null {
  if (!header) return null;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (!/^\d{1,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/.test(value)) return null;
      signatures.push(value);
    }
  }
  return timestamp !== undefined && signatures.length ? { timestamp, signatures } : null;
}

function hmacHex(secret: string, timestamp: number, body: string | Uint8Array): string {
  const hmac = createHmac("sha256", secret).update(`${timestamp}.`, "utf8");
  return (typeof body === "string" ? hmac.update(body, "utf8") : hmac.update(body)).digest("hex");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
