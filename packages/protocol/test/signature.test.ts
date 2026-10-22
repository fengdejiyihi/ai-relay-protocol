import { describe, expect, it } from "vitest";
import { parseSignatureHeader, signBody, verifySignature } from "../src/index.js";

const secret = "whsec_test_0123456789";
const body = JSON.stringify({ type: "ping", rsp: "1.0", issued_at: 1761055200, challenge: "x".repeat(16) });
const t = 1761055200;

describe("签名", () => {
  it("签名后可验证", () => {
    const header = signBody(secret, body, t);
    expect(header).toMatch(/^t=1761055200,v1=[0-9a-f]{64}$/);
    expect(verifySignature({ secrets: [secret], header, body, now: t + 10 })).toEqual({ ok: true, timestamp: t, secretIndex: 0 });
  });

  it("已知向量：与 Python hmac 独立计算一致", () => {
    // python3 -c "import hmac,hashlib;print(hmac.new(b'secret', b'1.{}', hashlib.sha256).hexdigest())"
    expect(signBody("secret", "{}", 1)).toBe("t=1,v1=1122767b193110cfec322b6f199b599edbf608ed087f2d27afb0b97d99523908");
  });

  it("可以直接用原始字节签名和验签，结果与整段解码后的字符串一致", () => {
    const text = JSON.stringify({ input: { name: "张三" } });
    const raw = Buffer.from(text, "utf8");
    expect(signBody(secret, raw, t)).toBe(signBody(secret, text, t));
    // 「张」占 3 个字节，从中间切开再拼回去，字节不变，签名照样通过
    const cut = raw.indexOf(Buffer.from("张", "utf8")) + 1;
    const joined = Buffer.concat([raw.subarray(0, cut), raw.subarray(cut)]);
    expect(verifySignature({ secrets: [secret], header: signBody(secret, text, t), body: joined, now: t })).toMatchObject({ ok: true });
    // 逐块解码会把多字节字符切坏，这正是规范附录 B 要求先拼字节的原因
    const decodedPerChunk = raw.subarray(0, cut).toString("utf8") + raw.subarray(cut).toString("utf8");
    expect(verifySignature({ secrets: [secret], header: signBody(secret, text, t), body: decodedPerChunk, now: t })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("改一个字节就失败", () => {
    const header = signBody(secret, body, t);
    expect(verifySignature({ secrets: [secret], header, body: body.replace("ping", "pong"), now: t })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("超过 5 分钟窗口拒绝", () => {
    const header = signBody(secret, body, t);
    expect(verifySignature({ secrets: [secret], header, body, now: t + 301 })).toEqual({ ok: false, reason: "expired" });
    expect(verifySignature({ secrets: [secret], header, body, now: t - 301 })).toEqual({ ok: false, reason: "expired" });
  });

  it("轮换期新旧 secret 都能验", () => {
    const header = signBody("old_secret", body, t);
    expect(verifySignature({ secrets: ["new_secret", "old_secret"], header, body, now: t })).toEqual({ ok: true, timestamp: t, secretIndex: 1 });
  });

  it("头部格式错误", () => {
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader("t=abc,v1=00")).toBeNull();
    expect(parseSignatureHeader("v1=" + "0".repeat(64))).toBeNull();
    expect(verifySignature({ secrets: [secret], header: "garbage", body, now: t })).toEqual({ ok: false, reason: "malformed" });
  });
});
