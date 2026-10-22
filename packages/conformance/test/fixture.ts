import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { validateDownstream, verifySignature } from "@dreamcavy/ai-relay-protocol";

/** 故意写错的地方，每个开关对应一类常见错误。 */
export interface Faults {
  /** 不验签，什么签名都收。 */
  noVerify?: boolean;
  /** 只认第一个 v1=，轮换期带两个签名时验不过。 */
  firstV1Only?: boolean;
  /** 重放时重新执行，结果不同。 */
  notIdempotent?: boolean;
  /** 不认识的 type 直接抛异常，回 500。 */
  unknownType500?: boolean;
  /** 响应里多带 Schema 外的字段。 */
  extraFields?: boolean;
  /** output.data 不符合清单的 output Schema。 */
  badOutput?: boolean;
  /** 用严格 Schema 校验信封，rsp 必须是 "1.0"，未知字段拒绝。 */
  strictEnvelope?: boolean;
  /** 验签失败回 200 + failed，而不是 401。 */
  authFailsWith200?: boolean;
  /** 第一个请求等这么久（毫秒）再响应。 */
  slowFirstMs?: number;
}

export const SECRET = "whsec_fixture_current";
export const OLD_SECRET = "whsec_fixture_previous";

export const MANIFEST = {
  rsp: "1.0",
  supplier: {
    name: "验收夹具花店",
    description: "Conformance 测试用的本地供给方，只在测试里启动。",
    locale: "zh-CN",
    categories: ["鲜花"],
    user_binding: "none",
  },
  endpoint: { url: "https://flowers.example.test/relay", auth: "hmac-sha256" },
  actions: [
    {
      name: "order_bouquet",
      title: "订一束花",
      input: {
        type: "object",
        properties: { flower: { type: "string" }, count: { type: "integer", minimum: 1 } },
        required: ["flower", "count"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { order_no: { type: "string" }, total_cents: { type: "integer" } },
        required: ["order_no", "total_cents"],
      },
      risk: "medium",
      confirm: "by_grant",
      mode: "sync",
      billing: "on_complete",
      fee: 500,
      amount: "none",
    },
  ],
};

export interface Fixture {
  url: string;
  close(): Promise<void>;
}

export async function startFixture(faults: Faults = {}): Promise<Fixture> {
  const done = new Map<string, unknown>();
  let seq = 0;
  let requests = 0;
  const handle = (raw: Buffer, signature: string | undefined): { status: number; body: unknown } => {
    if (!faults.noVerify) {
      const header = faults.firstV1Only && signature ? signature.split(",").slice(0, 2).join(",") : signature;
      const v = verifySignature({ secrets: [SECRET, OLD_SECRET], header, body: raw });
      if (!v.ok) {
        const body = { status: "failed", error: { code: "unauthorized", message: v.reason } };
        return { status: faults.authFailsWith200 ? 200 : 401, body };
      }
    }
    const envelope = JSON.parse(raw.toString("utf8"));
    const checked = validateDownstream(envelope, { strict: faults.strictEnvelope ?? false });
    if (!checked.ok) {
      if (checked.errors[0]?.rule === "D-TYPE-1") {
        if (faults.unknownType500) throw new Error("unknown type");
        return { status: 200, body: { status: "failed", error: { code: "not_supported" } } };
      }
      return { status: 200, body: { status: "failed", error: { code: "invalid_input", details: checked.errors } } };
    }
    const env = checked.value;
    const extra = faults.extraFields ? { request_id: "req_123" } : {};
    if (env.type === "ping") return { status: 200, body: { status: "ok", challenge: env.challenge, rsp: "1.0", ...extra } };
    if (env.type !== "action.invoke") return { status: 200, body: { status: "failed", error: { code: "not_supported" } } };
    if (!faults.notIdempotent && done.has(env.idempotency_key)) return { status: 200, body: done.get(env.idempotency_key) };
    seq += 1;
    const input = env.input as { flower: string; count: number };
    const data = faults.badOutput ? { order_no: seq } : { order_no: `F${seq}`, total_cents: input.count * 1000 };
    const body = { status: "completed", output: { data, parts: [{ type: "text", text: `已下单 ${input.flower} × ${input.count}` }] }, ...extra };
    done.set(env.idempotency_key, body);
    return { status: 200, body };
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const reply = () => {
        let out: { status: number; body: unknown };
        try {
          out = handle(Buffer.concat(chunks), req.headers["x-relay-signature"] as string | undefined);
        } catch {
          res.writeHead(500, { "content-type": "text/plain" }).end("Internal Server Error");
          return;
        }
        res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
      };
      requests += 1;
      if (faults.slowFirstMs && requests === 1) setTimeout(reply, faults.slowFirstMs);
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/relay`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
