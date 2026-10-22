// 按接入验收（Conformance）的 8 项检查跑 examples/l1：真起 HTTP 服务、真签名，只用协议包。
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  checkPlatformPolicy,
  compileActionInput,
  type Manifest,
  signBody,
  validateManifest,
  validateResponse,
} from "@dreamcavy/ai-relay-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toNodeHandler } from "../src/index.js";
import { createFlowerShop, manifest as exampleManifest } from "../examples/l1/server.ts";
import { invokeEnvelope, OLD_SECRET, orderId, pingEnvelope, SECRET } from "./helpers.js";

const manifest = exampleManifest as Manifest;
const SAMPLE_INPUTS: Record<string, Record<string, unknown>> = {
  list_products: { category: "玫瑰" },
  place_order: { sku: "rose-11", quantity: 1, total_cents: 19900, recipient: "李女士", phone: "13800001234", address: "北京市朝阳区示例路 1 号" },
};

let endpoint = "";
let close: () => void = () => {};

beforeAll(async () => {
  const server = createServer(toNodeHandler(createFlowerShop([SECRET, OLD_SECRET])));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/relay`;
  close = () => server.close();
});
afterAll(() => close());

async function send(envelope: unknown, signature?: (body: string) => string) {
  const body = JSON.stringify(envelope);
  const response = await fetch(endpoint, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", "X-Relay-Signature": signature ? signature(body) : signBody(SECRET, body) },
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as unknown };
}

describe("示例 L1 过接入验收", () => {
  it("1 清单：协议校验无错误，平台策略无错误", () => {
    expect(validateManifest(manifest)).toMatchObject({ ok: true });
    expect(checkPlatformPolicy(manifest).errors).toEqual([]);
  });

  it("2 ping", async () => {
    const reply = await send(pingEnvelope("conformance_challenge_42"));
    expect(reply.status).toBe(200);
    expect(validateResponse("ping", reply.body).ok).toBe(true);
    expect(reply.body).toMatchObject({ challenge: "conformance_challenge_42" });
  });

  it.each(manifest.actions.map((a) => a.name))("3 动作 %s：响应合法，output.data 符合 output Schema", async (name) => {
    const action = manifest.actions.find((a) => a.name === name)!;
    const reply = await send(invokeEnvelope(name, SAMPLE_INPUTS[name]!));
    expect(reply.status).toBe(200);
    const checked = validateResponse("action.invoke", reply.body);
    expect(checked.ok).toBe(true);
    expect(reply.body).toMatchObject({ status: "completed" });
    if (action.output) {
      const data = (reply.body as { output: { data: unknown } }).output.data;
      expect(compileActionInput(action.output as Record<string, unknown>)(data)).toMatchObject({ ok: true });
    }
  });

  it.each(manifest.actions.map((a) => a.name))("4 同键重放 %s：响应一致", async (name) => {
    const envelope = invokeEnvelope(name, SAMPLE_INPUTS[name]!);
    const first = await send(envelope);
    const second = await send(envelope);
    expect(second.body).toEqual(first.body);
  });

  it("5 错签名、过期时间戳都被拒", async () => {
    const wrong = await send(pingEnvelope(), (body) => signBody("whsec_wrong_secret", body));
    expect([401, 403]).toContain(wrong.status);
    const expired = await send(pingEnvelope(), (body) => signBody(SECRET, body, Math.floor(Date.now() / 1000) - 301));
    expect([401, 403]).toContain(expired.status);
  });

  it("6 轮换：只用旧 secret 通过；两个 v1（一错一对）通过", async () => {
    expect((await send(pingEnvelope(), (body) => signBody(OLD_SECRET, body))).status).toBe(200);
    const both = await send(pingEnvelope(), (body) => {
      const t = Math.floor(Date.now() / 1000);
      return `t=${t},v1=${"f".repeat(64)},v1=${signBody(SECRET, body, t).split("v1=")[1]}`;
    });
    expect(both.status).toBe(200);
  });

  it("7 未知 type：200 + not_supported", async () => {
    const reply = await send({ type: "future.thing", rsp: "1.1", issued_at: Math.floor(Date.now() / 1000), extra: 1 });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ status: "failed", error: { code: "not_supported" } });
  });

  it("8 多余字段：严格校验也没有警告", async () => {
    expect(validateResponse("ping", (await send(pingEnvelope())).body, { strict: true }).ok).toBe(true);
    for (const action of manifest.actions) {
      const reply = await send(invokeEnvelope(action.name, SAMPLE_INPUTS[action.name]!, orderId()));
      expect(validateResponse("action.invoke", reply.body, { strict: true }).ok).toBe(true);
    }
  });
});
