import { describe, expect, it } from "vitest";
import { compileActionInput, validateDownstream, validateResponse, validateUpstream } from "../src/index.js";
import { example } from "./helpers.js";

const now = 1761055200;
const order_id = "ord_01JABCDEFGHJKM";

describe("下行信封", () => {
  const invoke = {
    type: "action.invoke",
    rsp: "1.0",
    issued_at: now,
    order_id,
    action: "book_slot",
    manifest_version: 3,
    input: { slot_id: "s_1", name: "张三", phone: "13800001234" },
    user: { relay_uid: "u_pair_7f3a9c21", display_name: "小李", supplier_user_ref: null },
    idempotency_key: order_id,
  };

  it("action.invoke 合法", () => {
    expect(validateDownstream(invoke).ok).toBe(true);
  });

  it("每种类型都能通过", () => {
    const samples = [
      { type: "ping", rsp: "1.0", issued_at: now, challenge: "c".repeat(32) },
      { type: "task.poll", rsp: "1.0", issued_at: now, order_id, task_id: "t_9" },
      { type: "task.cancel", rsp: "1.0", issued_at: now, order_id, task_id: "t_9", reason: "expired" },
      { type: "proposal.select", rsp: "1.0", issued_at: now, order_id, task_id: "t_9", proposal_id: "p_1" },
      { type: "binding.verify", rsp: "1.0", issued_at: now, relay_uid: "u_pair_7f3a9c21", code: "AB12CD" },
    ];
    for (const s of samples) expect(validateDownstream(s), s.type).toMatchObject({ ok: true });
  });

  it("供给方默认按第 14 节向前兼容：忽略新字段，接受 1.x", () => {
    expect(validateDownstream({ ...invoke, extra: 1 }).ok).toBe(true);
    expect(validateDownstream({ ...invoke, rsp: "1.3", user: { ...invoke.user, locale: "zh-CN" } }).ok).toBe(true);
    expect(validateDownstream({ ...invoke, rsp: "2.0" }).ok).toBe(false);
    expect(validateDownstream({ ...invoke, order_id: "bad" }).ok).toBe(false);
  });

  it("strict 模式给 Relay 自测：不允许未定义字段，rsp 必须是 1.0", () => {
    expect(validateDownstream(invoke, { strict: true }).ok).toBe(true);
    expect(validateDownstream({ ...invoke, extra: 1 }, { strict: true }).ok).toBe(false);
    expect(validateDownstream({ ...invoke, rsp: "1.1" }, { strict: true }).ok).toBe(false);
  });

  it("不认识的 type（含 v0.1 的 order.confirm）返回 D-TYPE-1，对应 not_supported", () => {
    for (const strict of [false, true]) {
      const r = validateDownstream({ type: "order.confirm", rsp: "1.0", issued_at: now, order_id }, { strict });
      expect(r.ok ? [] : r.errors.map((e) => e.rule)).toEqual(["D-TYPE-1"]);
    }
  });

  it("user 必须带 supplier_user_ref（可为 null）", () => {
    const { supplier_user_ref: _, ...user } = invoke.user;
    expect(validateDownstream({ ...invoke, user }).ok).toBe(false);
  });
});

describe("同步响应", () => {
  it("按信封类型限定 status", () => {
    expect(validateResponse("action.invoke", { status: "accepted", task_id: "t_9" }).ok).toBe(true);
    expect(validateResponse("action.invoke", { status: "pending" }).ok).toBe(false);
    expect(validateResponse("task.poll", { status: "pending", eta_seconds: 30 }).ok).toBe(true);
    expect(validateResponse("ping", { status: "ok", challenge: "x", rsp: "1.0" }).ok).toBe(true);
    expect(validateResponse("binding.verify", { status: "bound", supplier_user_ref: "acct_42" }).ok).toBe(true);
  });

  it("completed 必须带 output.data，parts 可装万物", () => {
    const ok = validateResponse("action.invoke", {
      status: "completed",
      output: {
        data: { booking_id: "b_88" },
        parts: [
          { type: "markdown", text: "已预约 **10 月 23 日 15:00**" },
          { type: "image", url: "https://shop.example.com/qr/b_88.png", alt: "核销码" },
          { type: "file", url: "https://shop.example.com/r.pdf", name: "凭证.pdf", mime: "application/pdf" },
          { type: "link", url: "https://shop.example.com/b/b_88", title: "查看" },
          { type: "json", value: { any: ["thing"] } },
        ],
      },
    });
    expect(ok.ok ? [] : ok.errors).toEqual([]);
    expect(validateResponse("action.invoke", { status: "completed", output: { parts: [] } }).ok).toBe(false);
  });

  it("image 块的 url 与 base64 二选一", () => {
    const image = (extra: Record<string, unknown>) =>
      validateResponse("action.invoke", { status: "completed", output: { data: {}, parts: [{ type: "image", ...extra }] } }).ok;
    expect(image({ url: "https://shop.example.com/a.png" })).toBe(true);
    expect(image({ base64: "iVBORw0KGgo=", mime: "image/png" })).toBe(true);
    expect(image({ url: "https://shop.example.com/a.png", base64: "iVBORw0KGgo=" })).toBe(false);
    expect(image({ url: "https://shop.example.com/a.png", base64: "iVBORw0KGgo=", mime: "image/png" })).toBe(false);
    expect(image({ base64: "iVBORw0KGgo=" })).toBe(false);
  });

  it("Relay 收响应时默认忽略多余字段，其余照样严格", () => {
    const completed = { status: "completed", output: { data: {} }, request_id: "x", trace_id: "y" };
    expect(validateResponse("action.invoke", completed).ok).toBe(true);
    expect(validateResponse("action.invoke", { status: "failed", error: { code: "permanent", trace: "z" } }).ok).toBe(true);
    expect(validateResponse("action.invoke", completed, { strict: true }).ok).toBe(false);
    expect(validateResponse("action.invoke", { status: "completed", output: {}, request_id: "x" }).ok).toBe(false);
    expect(validateResponse("action.invoke", { status: "failed", error: { code: "oops" }, request_id: "x" }).ok).toBe(false);
    expect(validateResponse("action.invoke", { status: "completed", output: { data: {}, parts: [{ type: "video", url: "https://x.example.com" }] } }).ok).toBe(false);
  });

  it("failed 只能用协议错误码", () => {
    expect(validateResponse("action.invoke", { status: "failed", error: { code: "not_available" } }).ok).toBe(true);
    expect(validateResponse("action.invoke", { status: "failed", error: { code: "oops" } }).ok).toBe(false);
  });
});

describe("上行事件", () => {
  const base = { rsp: "1.0", order_id, event_id: "evt_1", occurred_at: now };

  it("6 种事件都合法", () => {
    const samples = [
      { ...base, type: "completed", output: { data: { article_url: "https://x.example.com/a" } } },
      { ...base, type: "failed", error: { code: "permanent", message: "账号被封" } },
      { ...base, type: "proposal.add", proposal: { proposal_id: "p_1", title: "小程序开发", price_cents: 1_800_000, eta_days: 20, content: { data: {} } } },
      { ...base, type: "proposal.withdraw", proposal_id: "p_1" },
      { ...base, type: "order.dispute", reason: "用户未到店" },
      { ...base, type: "cancel_failed", reason: "已发布" },
    ];
    for (const s of samples) expect(validateUpstream(s), s.type).toMatchObject({ ok: true });
  });

  it("回调默认忽略多余字段，strict 时报出来", () => {
    const event = { ...base, type: "completed", output: { data: {} }, request_id: "req_1" };
    expect(validateUpstream(event).ok).toBe(true);
    expect(validateUpstream(event, { strict: true }).ok).toBe(false);
    expect(validateUpstream({ ...base, type: "order.confirm", request_id: "req_1" }).ok).toBe(false);
  });

  it("必须带 event_id 用于去重", () => {
    const { event_id: _, ...rest } = base;
    expect(validateUpstream({ ...rest, type: "proposal.withdraw", proposal_id: "p_1" }).ok).toBe(false);
  });
});

describe("动作输入校验", () => {
  it("按清单里的 input Schema 校验，认识 x-pii", () => {
    const check = compileActionInput(example("sandbox-shop.json").actions[1].input);
    expect(check({ slot_id: "s_1", price_cents: 6800, name: "张三", phone: "13800001234" }).ok).toBe(true);
    expect(check({ slot_id: "s_1", price_cents: 6800, name: "张三", phone: "123" }).ok).toBe(false);
    expect(check({ slot_id: "s_1", name: "张三", phone: "13800001234" }).ok).toBe(false);
  });
});
