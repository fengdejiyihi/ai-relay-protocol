import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { completed, createRelayHandler, fastifyRelay, toFetchHandler, toNodeHandler } from "../src/index.js";
import { manifest } from "../examples/l1/server.ts";
import { invokeEnvelope, pingEnvelope, SECRET, signed } from "./helpers.js";

const relay = createRelayHandler({
  secrets: SECRET,
  manifest,
  handlers: { list_products: () => completed({ products: [] }), place_order: () => completed({ order_no: "F1", total_cents: 1 }) },
});

let closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(url: string, envelope: unknown, secret = SECRET) {
  const { body, signature } = signed(envelope, secret);
  const response = await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json", "X-Relay-Signature": signature } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, rsp: response.headers.get("x-relay-rsp") };
}

async function expectWorks(url: string) {
  expect(await post(url, pingEnvelope())).toMatchObject({ status: 200, rsp: "1.0", body: { status: "ok" } });
  expect((await post(url, invokeEnvelope("list_products", {}))).body).toMatchObject({ status: "completed" });
  expect((await post(url, pingEnvelope(), "whsec_wrong")).status).toBe(401);
}

describe("适配", () => {
  it("Node http", async () => {
    const handler = toNodeHandler(relay);
    const base = await listen(createServer((req, res) => handler(req, res)));
    await expectWorks(base);
    expect((await fetch(base, { method: "GET" })).status).toBe(405);
  });

  it("Node http：请求体超限回 413", async () => {
    const base = await listen(createServer(toNodeHandler(relay, { maxBodyBytes: 10 })));
    expect((await post(base, pingEnvelope())).status).toBe(413);
  });

  it("Express：挂在 express.json() 之前", async () => {
    const app = express();
    app.post("/relay", toNodeHandler(relay));
    app.use(express.json());
    await expectWorks(`${await listen(createServer(app))}/relay`);
  });

  it("Express：这条路由用 express.raw()", async () => {
    const app = express();
    app.post("/relay", express.raw({ type: "*/*" }), toNodeHandler(relay));
    await expectWorks(`${await listen(createServer(app))}/relay`);
  });

  it("Express：被 express.json() 先解析了，回 500 并说明原因", async () => {
    const app = express();
    app.use(express.json());
    app.post("/relay", toNodeHandler(relay));
    const reply = await post(`${await listen(createServer(app))}/relay`, pingEnvelope());
    expect(reply.status).toBe(500);
    expect(JSON.stringify(reply.body)).toMatch(/express\.json/);
  });

  it("Fastify：插件内原始字节，不影响其他路由的 JSON 解析", async () => {
    const app = Fastify();
    await app.register(fastifyRelay(relay));
    app.post("/echo", async (request) => request.body);
    await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    await expectWorks(`${base}/relay`);
    const echo = await fetch(`${base}/echo`, { method: "POST", body: '{"a":1}', headers: { "Content-Type": "application/json" } });
    expect(await echo.json()).toEqual({ a: 1 });
  });

  it("Fetch API / Next.js Route Handler", async () => {
    const POST = toFetchHandler(relay);
    const { body, signature } = signed(pingEnvelope());
    const response = await POST(new Request("https://supplier.example.com/relay", { method: "POST", body, headers: { "X-Relay-Signature": signature } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
    const bad = await POST(new Request("https://supplier.example.com/relay", { method: "POST", body, headers: { "X-Relay-Signature": "t=1,v1=00" } }));
    expect(bad.status).toBe(401);
  });
});
