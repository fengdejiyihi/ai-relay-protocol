import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { verifySignature } from "@dreamcavy/ai-relay-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completed, proposal, RelayCallbackClient, RelayCallbackError } from "../src/index.js";
import { orderId, SECRET } from "./helpers.js";

type Call = { url: string; body: string; signature: string };

function fakeFetch(responses: Array<number | Error | { status: number; headers?: Record<string, string>; body?: string }>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init!.headers as Record<string, string>;
    calls.push({ url: String(url), body: String(init!.body), signature: headers["X-Relay-Signature"]! });
    const next = responses.shift() ?? 200;
    if (next instanceof Error) throw next;
    const spec = typeof next === "number" ? { status: next } : next;
    return new Response(spec.body ?? JSON.stringify({ ok: true }), { status: spec.status, ...(spec.headers ? { headers: spec.headers } : {}) });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function client(fetchFn: typeof fetch, sleep = vi.fn(async (_ms: number) => {})) {
  return { sleep, client: new RelayCallbackClient({ secret: SECRET, baseUrl: "https://relay.test/", fetch: fetchFn, sleep }) };
}

describe("RelayCallbackClient", () => {
  it("签名、路径、事件字段都对", async () => {
    const { fn, calls } = fakeFetch([200]);
    const id = orderId();
    const result = await client(fn).client.completed(id, completed({ url: "https://example.com/a/1" }).output);
    expect(result).toMatchObject({ ok: true, status: 200, attempts: 1 });
    expect(result.eventId).toMatch(/^evt_[0-9a-f]{32}$/);
    const call = calls[0]!;
    expect(call.url).toBe(`https://relay.test/v1/callbacks/${id}`);
    expect(verifySignature({ secrets: [SECRET], header: call.signature, body: call.body }).ok).toBe(true);
    expect(JSON.parse(call.body)).toMatchObject({ type: "completed", rsp: "1.0", order_id: id, event_id: result.eventId, output: { data: { url: "https://example.com/a/1" } } });
  });

  it("5xx、超时、连接失败按退避重发，event_id 和请求体不变", async () => {
    const { fn, calls } = fakeFetch([503, new Error("timeout"), 502, 200]);
    const { client: c, sleep } = client(fn);
    const result = await c.addProposal(orderId(), proposal("p1", "方案一", { price: 1 }, { priceCents: 100 }));
    expect(result).toMatchObject({ ok: true, attempts: 4 });
    expect(new Set(calls.map((x) => x.body)).size).toBe(1);
    expect(sleep.mock.calls.map((x) => x[0])).toEqual([1000, 4000, 16000]);
  });

  it("429 按 Retry-After 等", async () => {
    const { fn } = fakeFetch([{ status: 429, headers: { "Retry-After": "30" } }, 200]);
    const { client: c, sleep } = client(fn);
    await c.failed(orderId(), { code: "permanent", message: "x" });
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("4xx 不重发，409 返回当前状态", async () => {
    for (const status of [401, 404, 409, 422]) {
      const { fn, calls } = fakeFetch([{ status, body: JSON.stringify({ status: "completed" }) }]);
      const result = await client(fn).client.cancelFailed(orderId(), "已发出");
      expect(result).toMatchObject({ ok: false, status, attempts: 1 });
      expect(calls).toHaveLength(1);
    }
  });

  it("重发次数用完抛 RelayCallbackError，带 event_id", async () => {
    const { fn, calls } = fakeFetch([500, 500, 500, 500, 500, 500, 500]);
    const error = await client(fn).client.dispute(orderId(), "用户投诉未到店", { event_id: "evt_mine" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayCallbackError);
    expect(error).toMatchObject({ eventId: "evt_mine", attempts: 6, lastStatus: 500 });
    expect(calls).toHaveLength(6);
  });

  it("事件不合 Schema 时不发请求，直接抛 TypeError", async () => {
    const { fn, calls } = fakeFetch([]);
    await expect(client(fn).client.send({ type: "completed", order_id: "bad", output: { data: {} } })).rejects.toThrow(TypeError);
    await expect(client(fn).client.withdrawProposal(orderId(), "")).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  describe("真实 HTTP", () => {
    let close: (() => void) | undefined;
    afterEach(() => close?.());

    it("请求超时会重发", async () => {
      let hits = 0;
      const server = createServer((req, res) => {
        hits += 1;
        if (hits === 1) return; // 第一次不回应，等客户端超时
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      close = () => {
        server.closeAllConnections();
        server.close();
      };
      const { port } = server.address() as AddressInfo;
      const c = new RelayCallbackClient({ secret: SECRET, baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 200, retryDelaysMs: [10] });
      const result = await c.completed(orderId(), { data: {} });
      expect(result).toMatchObject({ ok: true, attempts: 2 });
    });
  });
});
