import { type Manifest, signBody } from "@dreamcavy/ai-relay-protocol";
import { describe, expect, it, vi } from "vitest";
import { accepted, completed, createRelayHandler, failed, type RelayHandlerOptions, RelayError } from "../src/index.js";
import { invokeEnvelope, OLD_SECRET, orderId, pingEnvelope, SECRET, signed } from "./helpers.js";

const manifest: Manifest = {
  rsp: "1.0",
  supplier: { name: "单测商家", description: "单测用", locale: "zh-CN", categories: ["测试"], user_binding: "none" },
  endpoint: { url: "https://supplier.example.com/relay", auth: "hmac-sha256" },
  actions: [
    {
      name: "book",
      title: "预约",
      input: {
        type: "object",
        properties: { slot: { type: "string" }, price_cents: { type: "integer" } },
        required: ["slot", "price_cents"],
        additionalProperties: false,
      },
      risk: "medium",
      confirm: "by_grant",
      mode: "sync",
      billing: "on_complete",
      fee: 100,
      amount: { from: "input.price_cents" },
    },
    {
      name: "publish",
      title: "发布",
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      risk: "high",
      confirm: "always",
      mode: "async",
      billing: "on_complete",
      fee: 200,
      amount: "none",
    },
  ],
} as Manifest;

function setup(overrides: Partial<RelayHandlerOptions> = {}) {
  const book = vi.fn((input: { slot: string }) => completed({ booking_id: `b_${input.slot}` }));
  const publish = vi.fn((_input: unknown, ctx: { orderId: string }) => accepted(`task_${ctx.orderId}`, 60));
  const onError = vi.fn();
  const relay = createRelayHandler({ secrets: [SECRET, OLD_SECRET], manifest, handlers: { book, publish }, onError, ...overrides });
  async function send(envelope: unknown, secret = SECRET) {
    const { body, signature } = signed(envelope, secret);
    const reply = await relay.handle(Buffer.from(body), signature);
    return { status: reply.status, body: JSON.parse(reply.body), headers: reply.headers };
  }
  return { relay, send, book, publish, onError };
}

describe("创建", () => {
  it("清单不合法时抛错", () => {
    const bad = { ...manifest, actions: [{ ...manifest.actions[0]!, risk: "low" }] } as Manifest;
    expect(() => createRelayHandler({ secrets: SECRET, manifest: bad, handlers: { book: () => completed({}) } })).toThrow(/M-RISK-1/);
  });
  it("清单动作缺处理函数、或处理函数多出来时抛错", () => {
    expect(() => createRelayHandler({ secrets: SECRET, manifest, handlers: { book: () => completed({}) } })).toThrow(/publish/);
    expect(() =>
      createRelayHandler({ secrets: SECRET, manifest, handlers: { book: () => completed({}), publish: () => completed({}), extra: () => completed({}) } }),
    ).toThrow(/extra/);
  });
  it("secrets 为空时抛错", () => {
    expect(() => createRelayHandler({ secrets: [], manifest, handlers: {} })).toThrow(/secrets/);
  });
});

describe("验签", () => {
  it("新 secret、旧 secret 都通过，错 secret 回 401", async () => {
    const { send } = setup();
    expect((await send(pingEnvelope(), SECRET)).status).toBe(200);
    expect((await send(pingEnvelope(), OLD_SECRET)).status).toBe(200);
    const wrong = await send(pingEnvelope(), "whsec_wrong");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ status: "failed", error: { code: "unauthorized" } });
  });

  it("超过 5 分钟的时间戳回 401", async () => {
    const { relay } = setup();
    const { body, signature } = signed(pingEnvelope(), SECRET, Math.floor(Date.now() / 1000) - 301);
    expect((await relay.handle(body, signature)).status).toBe(401);
    const ok = signed(pingEnvelope(), SECRET, Math.floor(Date.now() / 1000) - 299);
    expect((await relay.handle(ok.body, ok.signature)).status).toBe(200);
  });

  it("头部带两个 v1（一个错一个对）通过", async () => {
    const { relay } = setup();
    const body = JSON.stringify(pingEnvelope());
    const t = Math.floor(Date.now() / 1000);
    const good = signBody(SECRET, body, t).split("v1=")[1]!;
    const header = `t=${t},v1=${"0".repeat(64)},v1=${good}`;
    expect((await relay.handle(body, header)).status).toBe(200);
  });

  it("用原始字节验签：多字节字符、空白和键序都不能变", async () => {
    const { relay } = setup();
    // 故意带空格、非 ASCII，重新序列化后字节就不同了。
    const body = `{ "type":"ping","rsp":"1.0","issued_at":${Math.floor(Date.now() / 1000)},"challenge":"挑战挑战挑战挑战挑战挑战挑战挑战" }`;
    const signature = signBody(SECRET, body);
    expect((await relay.handle(Buffer.from(body, "utf8"), signature)).status).toBe(200);
    const reserialized = JSON.stringify(JSON.parse(body));
    expect((await relay.handle(reserialized, signature)).status).toBe(401);
  });

  it("没有签名头回 401", async () => {
    const { relay } = setup();
    expect((await relay.handle(JSON.stringify(pingEnvelope()), undefined)).status).toBe(401);
  });
});

describe("分发", () => {
  it("ping 原样带回 challenge", async () => {
    const { send } = setup();
    const reply = await send(pingEnvelope("challenge_abcdefghijklmnop"));
    expect(reply.body).toEqual({ status: "ok", challenge: "challenge_abcdefghijklmnop", rsp: "1.0" });
    expect(reply.headers["X-Relay-RSP"]).toBe("1.0");
  });

  it("不认识的 type 回 200 + not_supported", async () => {
    const { send } = setup();
    const reply = await send({ type: "future.thing", rsp: "1.3", issued_at: Math.floor(Date.now() / 1000), extra: 1 });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ status: "failed", error: { code: "not_supported" } });
  });

  it("认识但没实现的 type（task.poll）回 not_supported", async () => {
    const { send } = setup();
    const reply = await send({ type: "task.poll", rsp: "1.0", issued_at: Math.floor(Date.now() / 1000), order_id: orderId(), task_id: "t1" });
    expect(reply.body).toMatchObject({ status: "failed", error: { code: "not_supported" } });
  });

  it("实现了 tasks.poll 就交给它", async () => {
    const poll = vi.fn(() => completed({ url: "https://example.com/p/1" }));
    const { send } = setup({ tasks: { poll } });
    const reply = await send({ type: "task.poll", rsp: "1.0", issued_at: Math.floor(Date.now() / 1000), order_id: orderId(), task_id: "t1" });
    expect(reply.body).toEqual({ status: "completed", output: { data: { url: "https://example.com/p/1" } } });
    expect(poll).toHaveBeenCalledOnce();
  });

  it("信封带多余字段、rsp 是 1.x 也接受", async () => {
    const { send } = setup();
    const reply = await send({ ...invokeEnvelope("book", { slot: "s1", price_cents: 100 }), rsp: "1.4", trace_id: "x" });
    expect(reply.body).toEqual({ status: "completed", output: { data: { booking_id: "b_s1" } } });
  });

  it("请求体不是 JSON、信封不合法回 200 + invalid_input", async () => {
    const { relay, send } = setup();
    const body = "not json";
    const reply = await relay.handle(body, signBody(SECRET, body));
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ error: { code: "invalid_input" } });
    expect((await send({ type: "action.invoke", rsp: "1.0", issued_at: 1 })).body).toMatchObject({ error: { code: "invalid_input" } });
  });

  it("不存在的动作、输入不合 Schema 回 invalid_input，不调处理函数", async () => {
    const { send, book } = setup();
    expect((await send(invokeEnvelope("nope", {}))).body).toMatchObject({ error: { code: "invalid_input" } });
    expect((await send(invokeEnvelope("book", { slot: 1 }))).body).toMatchObject({ error: { code: "invalid_input" } });
    expect(book).not.toHaveBeenCalled();
  });

  it("处理函数拿到上下文", async () => {
    const { send, publish } = setup();
    const id = orderId();
    const reply = await send(invokeEnvelope("publish", { text: "hi" }, id));
    expect(reply.body).toEqual({ status: "accepted", task_id: `task_${id}`, eta_seconds: 60 });
    expect(publish.mock.calls[0]![1]).toMatchObject({ orderId: id, idempotencyKey: id, manifestVersion: 1, user: { relay_uid: "u_pair_test01" } });
  });

  it("已过 deadline_at 回 temporary，不执行", async () => {
    const { send, book } = setup();
    const reply = await send(invokeEnvelope("book", { slot: "s1", price_cents: 1 }, orderId(), { deadline_at: Math.floor(Date.now() / 1000) - 10 }));
    expect(reply.body).toMatchObject({ error: { code: "temporary" } });
    expect(book).not.toHaveBeenCalled();
  });

  it("已有结果的键过了 deadline_at 再重放，返回第一次的结果", async () => {
    const { send, book } = setup();
    const id = orderId();
    const first = await send(invokeEnvelope("book", { slot: "s1", price_cents: 1 }, id));
    const late = await send(invokeEnvelope("book", { slot: "s1", price_cents: 1 }, id, { deadline_at: Math.floor(Date.now() / 1000) - 10 }));
    expect(late.body).toEqual(first.body);
    expect(book).toHaveBeenCalledOnce();
  });

  it("throw RelayError 等同 return failed", async () => {
    const { send } = setup({
      handlers: { book: () => { throw new RelayError("not_available", "约满了"); }, publish: () => accepted("t") },
    });
    expect((await send(invokeEnvelope("book", { slot: "s", price_cents: 1 }))).body).toEqual({
      status: "failed",
      error: { code: "not_available", message: "约满了" },
    });
  });

  it("其他异常回 500（结果未知）并通知 onError", async () => {
    const { send, onError } = setup({ handlers: { book: () => { throw new Error("db down"); }, publish: () => accepted("t") } });
    const reply = await send(invokeEnvelope("book", { slot: "s", price_cents: 1 }));
    expect(reply.status).toBe(500);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("处理函数返回不合协议的响应回 500", async () => {
    const { send, onError } = setup({
      handlers: { book: () => ({ status: "pending" }) as never, publish: () => accepted("t") },
    });
    expect((await send(invokeEnvelope("book", { slot: "s", price_cents: 1 }))).status).toBe(500);
    expect(String(onError.mock.calls[0]![0])).toMatch(/不合协议/);
  });
});

describe("幂等（第 10 节）", () => {
  it("同键重放返回第一次的结果，只执行一次", async () => {
    const { send, book } = setup();
    const envelope = invokeEnvelope("book", { slot: "s1", price_cents: 100 });
    const first = await send(envelope);
    const second = await send({ ...envelope, issued_at: envelope.issued_at + 5 });
    expect(second.body).toEqual(first.body);
    expect(book).toHaveBeenCalledOnce();
  });

  it("键序不同的同一输入算同一笔", async () => {
    const { send, book } = setup();
    const id = orderId();
    await send(invokeEnvelope("book", { slot: "s1", price_cents: 100 }, id));
    await send(invokeEnvelope("book", { price_cents: 100, slot: "s1" }, id));
    expect(book).toHaveBeenCalledOnce();
  });

  it("不可重试的 failed 也缓存", async () => {
    const book = vi.fn(() => failed("not_available", "满了"));
    const { send } = setup({ handlers: { book, publish: () => accepted("t") } });
    const envelope = invokeEnvelope("book", { slot: "s1", price_cents: 100 });
    await send(envelope);
    await send(envelope);
    expect(book).toHaveBeenCalledOnce();
  });

  it("temporary、rate_limited 不缓存，重试会真的再执行", async () => {
    const book = vi
      .fn()
      .mockReturnValueOnce(failed("temporary"))
      .mockReturnValueOnce(failed("rate_limited", undefined, { retryAfter: 3 }))
      .mockReturnValue(completed({ ok: true }));
    const { send } = setup({ handlers: { book, publish: () => accepted("t") } });
    const envelope = invokeEnvelope("book", { slot: "s1", price_cents: 100 });
    expect((await send(envelope)).body).toMatchObject({ error: { code: "temporary" } });
    expect((await send(envelope)).body).toMatchObject({ error: { code: "rate_limited", retry_after: 3 } });
    expect((await send(envelope)).body).toMatchObject({ status: "completed" });
    expect((await send(envelope)).body).toMatchObject({ status: "completed" });
    expect(book).toHaveBeenCalledTimes(3);
  });

  it("抛异常（结果未知）不缓存", async () => {
    const book = vi.fn().mockImplementationOnce(() => { throw new Error("boom"); }).mockReturnValue(completed({ ok: true }));
    const { send } = setup({ handlers: { book, publish: () => accepted("t") } });
    const envelope = invokeEnvelope("book", { slot: "s1", price_cents: 100 });
    expect((await send(envelope)).status).toBe(500);
    expect((await send(envelope)).body).toMatchObject({ status: "completed" });
  });

  it("同键还在处理中又到达回 temporary，不并行执行", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const book = vi.fn(async () => {
      await gate;
      return completed({ ok: true });
    });
    const { send } = setup({ handlers: { book, publish: () => accepted("t") } });
    const envelope = invokeEnvelope("book", { slot: "s1", price_cents: 100 });
    const first = send(envelope);
    const second = await send(envelope);
    expect(second.body).toMatchObject({ error: { code: "temporary" } });
    release();
    expect((await first).body).toMatchObject({ status: "completed" });
    expect((await send(envelope)).body).toMatchObject({ status: "completed" });
    expect(book).toHaveBeenCalledOnce();
  });

  it("同键不同输入回 invalid_input", async () => {
    const { send, book } = setup();
    const id = orderId();
    await send(invokeEnvelope("book", { slot: "s1", price_cents: 100 }, id));
    expect((await send(invokeEnvelope("book", { slot: "s2", price_cents: 100 }, id))).body).toMatchObject({ error: { code: "invalid_input" } });
    expect(book).toHaveBeenCalledOnce();
  });

  it("可以换成自己的存储", async () => {
    const records = new Map<string, unknown>();
    const store = {
      begin: vi.fn(async (key: string) => (records.has(key) ? { state: "done" as const, record: records.get(key) as never } : { state: "acquired" as const })),
      finish: vi.fn(async (key: string, record: unknown) => void records.set(key, record)),
      abandon: vi.fn(async () => {}),
    };
    const { send, book } = setup({ idempotency: store });
    const envelope = invokeEnvelope("book", { slot: "s1", price_cents: 100 });
    await send(envelope);
    await send(envelope);
    expect(book).toHaveBeenCalledOnce();
    expect(store.finish).toHaveBeenCalledOnce();
  });
});
