import { DOWNSTREAM_TYPES, HEADERS, signBody, validateResponse } from "@ai-relay/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASE_URL, expectValid, type Harness, invoke, OLD_SECRET, orderId, send, startShop } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await startShop();
});
afterEach(async () => {
  await h.close();
});

const PHONE = "13800138000";
/** 剪发的价格，book_slot 要照抄 list_slots 返回的 price_cents。 */
const HAIRCUT = 6800;

async function call(action: string, input: Record<string, unknown>, extra: Parameters<typeof invoke>[3] = {}) {
  const sent = await send(h, invoke(h, action, input, extra));
  expectValid("action.invoke", sent, h.shop.manifest, action);
  return sent.body;
}

async function firstSlot(service = "haircut", date = "2026-10-22"): Promise<string> {
  const body = await call("list_slots", { date, service });
  return body.output.data.slots[0].slot_id;
}

describe("ping", () => {
  it("原样回 challenge", async () => {
    const sent = await send(h, { type: "ping", rsp: "1.0", issued_at: Math.floor(h.clock.now / 1000), challenge: "c".repeat(32) });
    expectValid("ping", sent, h.shop.manifest);
    expect(sent.body).toEqual({ status: "ok", challenge: "c".repeat(32), rsp: "1.0" });
    expect(sent.headers.get(HEADERS.rspVersion)).toBe("1.0");
  });
});

describe("验签", () => {
  const ping = () => ({ type: "ping", rsp: "1.0", issued_at: Math.floor(h.clock.now / 1000), challenge: "x".repeat(16) });

  it("轮换期内旧 secret 也接受", async () => {
    expect((await send(h, ping(), { secret: OLD_SECRET })).body.status).toBe("ok");
  });

  it.each([
    ["没有签名头", { signature: null }],
    ["错误的 secret", { secret: "whsec_wrong" }],
    ["时间戳超过 5 分钟", { timestamp: Math.floor(Date.parse("2026-10-22T09:20:00+08:00") / 1000) }],
    ["格式不对", { signature: "v1=abc" }],
  ])("%s → 401 unauthorized", async (_name, opts) => {
    const sent = await send(h, ping(), opts);
    expect(sent.status).toBe(401);
    expect(sent.body.error.code).toBe("unauthorized");
  });

  it("签名后改动请求体 → 401", async () => {
    const body = JSON.stringify(ping());
    const signature = signBody("whsec_sandbox_test_current", body, Math.floor(h.clock.now / 1000));
    const sent = await send(h, null, { raw: body.replace("xxxx", "yyyy"), signature });
    expect(sent.status).toBe(401);
  });
});

describe("信封", () => {
  it("非法 JSON → 200 invalid_input", async () => {
    const sent = await send(h, null, { raw: "{not json" });
    expect(sent.status).toBe(200);
    expect(sent.body.error.code).toBe("invalid_input");
  });

  it("缺字段 → 200 invalid_input，带出错位置", async () => {
    const env = invoke(h, "list_slots", { date: "2026-10-22" }) as Record<string, unknown>;
    delete env.user;
    const sent = await send(h, env);
    expectValid("action.invoke", sent, h.shop.manifest);
    expect(sent.body.error.details.length).toBeGreaterThan(0);
  });

  it("1.x 新增的字段和更高的 rsp 小版本照常处理（向前兼容）", async () => {
    const env = { ...invoke(h, "list_slots", { date: "2026-10-22" }), rsp: "1.3", trace_id: "future-field" };
    const sent = await send(h, env);
    expect(sent.body.status).toBe("completed");
  });

  it("中文请求体按原始字节验签", async () => {
    const env = invoke(h, "book_slot", { slot_id: await firstSlot(), price_cents: HAIRCUT, name: "欧阳娜娜😀", phone: PHONE });
    const sent = await send(h, env);
    expect(sent.body.status).toBe("completed");
  });

  it("将来的信封类型 → not_supported", async () => {
    const sent = await send(h, { type: "task.resume", rsp: "1.0", issued_at: Math.floor(h.clock.now / 1000) });
    expect(sent.status).toBe(200);
    expect(sent.body.error.code).toBe("not_supported");
  });

  it("沙箱用不到的已知类型 → not_supported，且符合该类型的响应 Schema", async () => {
    const issued_at = Math.floor(h.clock.now / 1000);
    const envelopes = {
      "task.poll": { order_id: orderId(), task_id: "t1" },
      "task.cancel": { order_id: orderId(), task_id: "t1", reason: "user_cancelled" },
      "proposal.select": { order_id: orderId(), task_id: "t1", proposal_id: "p1" },
      "binding.verify": { relay_uid: "u_alice_000001", code: "1234" },
    } as const;
    for (const [type, fields] of Object.entries(envelopes)) {
      const sent = await send(h, { type, rsp: "1.0", issued_at, ...fields });
      expectValid(type as (typeof DOWNSTREAM_TYPES)[number], sent, h.shop.manifest);
      expect(sent.body.error.code).toBe("not_supported");
    }
  });
});

describe("list_slots", () => {
  it("返回当天空闲时段、markdown 与 link", async () => {
    const body = await call("list_slots", { date: "2026-10-22" });
    const slots = body.output.data.slots;
    expect(slots).toHaveLength(23);
    expect(slots[0]).toEqual({ slot_id: "s_20261022_1000_color", start: "2026-10-22T10:00:00+08:00", service: "color", price_cents: 28800 });
    expect(body.output.parts.map((p: { type: string }) => p.type)).toEqual(["markdown", "link"]);
    expect(body.output.parts[1].url).toBe(`${BASE_URL}/?date=2026-10-22`);
  });

  it("按服务过滤，已开始的时段不返回", async () => {
    h.clock.now = Date.parse("2026-10-22T15:30:00+08:00");
    const body = await call("list_slots", { date: "2026-10-22", service: "haircut" });
    expect(body.output.data.slots.map((s: { start: string }) => s.start.slice(11, 16))).toEqual(["16:00", "17:00", "18:00", "19:00"]);
  });

  it("7 天窗口外返回空列表并说明范围", async () => {
    const body = await call("list_slots", { date: "2026-10-29" });
    expect(body.output.data.slots).toEqual([]);
    expect(body.output.parts[0].text).toContain("2026-10-22 到 2026-10-28");
    expect((await call("list_slots", { date: "2026-10-28" })).output.data.slots.length).toBeGreaterThan(0);
  });

  it("输入不符合 Schema → invalid_input", async () => {
    for (const input of [{}, { date: "明天" }, { date: "2026-10-22", service: "massage" }, { date: "2026-10-22", extra: 1 }]) {
      const body = await call("list_slots", input);
      expect(body.error.code).toBe("invalid_input");
    }
  });
});

describe("book_slot", () => {
  it("预约成功，时段从列表里消失", async () => {
    const slot_id = await firstSlot();
    const body = await call("book_slot", { slot_id, price_cents: HAIRCUT, name: "张三", phone: PHONE });
    expect(body.status).toBe("completed");
    const data = body.output.data;
    expect(data.booking_id).toMatch(/^b_[0-9a-z]{12}$/);
    expect(data).toMatchObject({ start: "2026-10-22T10:00:00+08:00", service: "haircut", price_cents: 6800 });
    expect(body.output.parts[0].text).toContain("138****8000");
    expect(body.output.parts[0].text).not.toContain(PHONE);
    expect(body.output.parts[1]).toEqual({ type: "link", url: `${BASE_URL}/b/${data.booking_id}`, title: "在网页查看预约" });
    expect(await firstSlot()).not.toBe(slot_id);
  });

  it("同一 idempotency_key 重发返回同一预约", async () => {
    const slot_id = await firstSlot();
    const env = invoke(h, "book_slot", { slot_id, price_cents: HAIRCUT, name: "张三", phone: PHONE });
    const first = await send(h, env);
    const second = await send(h, { ...env, issued_at: env.issued_at + 3 });
    expectValid("action.invoke", second, h.shop.manifest, "book_slot");
    expect(second.body).toEqual(first.body);
    expect(second.body.status).toBe("completed");
  });

  it("重发时键顺序不同也算同一笔", async () => {
    const slot_id = await firstSlot();
    const env = invoke(h, "book_slot", { slot_id, price_cents: HAIRCUT, name: "张三", phone: PHONE });
    const first = await send(h, env);
    const second = await send(h, { ...env, input: { phone: PHONE, name: "张三", price_cents: HAIRCUT, slot_id } });
    expect(second.body.output.data.booking_id).toBe(first.body.output.data.booking_id);
  });

  it("同一 key 换了输入 → invalid_input，不新建预约", async () => {
    const slot_id = await firstSlot();
    const env = invoke(h, "book_slot", { slot_id, price_cents: HAIRCUT, name: "张三", phone: PHONE });
    await send(h, env);
    const other = await firstSlot();
    const sent = await send(h, { ...env, input: { slot_id: other, price_cents: HAIRCUT, name: "张三", phone: PHONE } });
    expectValid("action.invoke", sent, h.shop.manifest, "book_slot");
    expect(sent.body.error.code).toBe("invalid_input");
    expect(await firstSlot()).toBe(other);
  });

  it("失败结果也按 key 记住：时段被别人约走后重发同一笔，仍是同一个失败", async () => {
    const slot_id = await firstSlot();
    await call("book_slot", { slot_id, price_cents: HAIRCUT, name: "张三", phone: PHONE });
    const env = invoke(h, "book_slot", { slot_id, price_cents: HAIRCUT, name: "李四", phone: "13900139000" }, { relay_uid: "u_bob_00000001" });
    const first = await send(h, env);
    expect(first.body.error.code).toBe("not_available");
    expect((await send(h, env)).body).toEqual(first.body);
  });

  it("不存在的时段、已过去的时段 → not_available", async () => {
    expect((await call("book_slot", { slot_id: "s_nope", price_cents: HAIRCUT, name: "张三", phone: PHONE })).error.code).toBe("not_available");
    const slot_id = await firstSlot();
    h.clock.now = Date.parse("2026-10-22T10:00:00+08:00");
    expect((await call("book_slot", { slot_id, price_cents: HAIRCUT, name: "张三", phone: PHONE })).error.code).toBe("not_available");
  });

  it("price_cents 和时段价格对不上 → invalid_input，不预约", async () => {
    const slot_id = await firstSlot();
    const body = await call("book_slot", { slot_id, price_cents: 100, name: "张三", phone: PHONE });
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.message).toContain("6800");
    expect(await firstSlot()).toBe(slot_id);
    expect((await call("book_slot", { slot_id, name: "张三", phone: PHONE })).error.code).toBe("invalid_input");
  });

  it("手机号不合法 → invalid_input", async () => {
    const slot_id = await firstSlot();
    expect((await call("book_slot", { slot_id, price_cents: HAIRCUT, name: "张三", phone: "12345" })).error.code).toBe("invalid_input");
  });

  it("超过 deadline_at → temporary，不预约，也不占用 key", async () => {
    const slot_id = await firstSlot();
    const env = invoke(h, "book_slot", { slot_id, price_cents: HAIRCUT, name: "张三", phone: PHONE }, { deadline_at: Math.floor(h.clock.now / 1000) - 1 });
    const late = await send(h, env);
    expectValid("action.invoke", late, h.shop.manifest, "book_slot");
    expect(late.body.error.code).toBe("temporary");
    expect(await firstSlot()).toBe(slot_id);
    const { deadline_at: _unused, ...retry } = env as typeof env & { deadline_at?: number };
    expect((await send(h, retry)).body.status).toBe("completed");
  });
});

describe("get_booking / cancel_booking", () => {
  async function book(relay_uid = "u_alice_000001") {
    const slot_id = await firstSlot();
    const body = await call("book_slot", { slot_id, price_cents: HAIRCUT, name: "张三", phone: PHONE }, { relay_uid });
    return body.output.data.booking_id as string;
  }

  it("查得到自己的预约", async () => {
    const booking_id = await book();
    const body = await call("get_booking", { booking_id });
    expect(body.output.data).toEqual({ booking_id, status: "booked", start: "2026-10-22T10:00:00+08:00" });
  });

  it("别的用户查不到、也取消不了", async () => {
    const booking_id = await book();
    const other = { relay_uid: "u_bob_00000001" };
    expect((await call("get_booking", { booking_id }, other)).error.code).toBe("not_available");
    expect((await call("cancel_booking", { booking_id }, other)).error.code).toBe("not_available");
    expect((await call("get_booking", { booking_id })).output.data.status).toBe("booked");
  });

  it("取消后时段放回，再取消仍返回 cancelled", async () => {
    const booking_id = await book();
    const slot = "s_20261022_1000_haircut";
    expect(await firstSlot()).not.toBe(slot);
    const body = await call("cancel_booking", { booking_id });
    expect(body.output.data).toEqual({ booking_id, status: "cancelled" });
    expect(await firstSlot()).toBe(slot);
    expect((await call("get_booking", { booking_id })).output.data.status).toBe("cancelled");
    expect((await call("cancel_booking", { booking_id })).output.data.status).toBe("cancelled");
  });

  it("取消的同一 key 重发返回同一结果", async () => {
    const booking_id = await book();
    const env = invoke(h, "cancel_booking", { booking_id });
    const first = await send(h, env);
    expect((await send(h, env)).body).toEqual(first.body);
  });

  it("开始时间已到不能取消", async () => {
    const booking_id = await book();
    h.clock.now = Date.parse("2026-10-22T10:05:00+08:00");
    expect((await call("cancel_booking", { booking_id })).error.code).toBe("not_available");
  });
});

describe("每天滚动", () => {
  it("过零点后删掉昨天，补上第 7 天，明天的预约仍在", async () => {
    const today = await call("book_slot", { slot_id: await firstSlot(), price_cents: HAIRCUT, name: "张三", phone: PHONE });
    const slot_id = await firstSlot("haircut", "2026-10-23");
    const env = invoke(h, "book_slot", { slot_id, price_cents: HAIRCUT, name: "张三", phone: PHONE });
    const tomorrow = await send(h, env);
    const booking_id = tomorrow.body.output.data.booking_id;

    h.clock.now = Date.parse("2026-10-23T00:00:01+08:00");
    expect((await call("get_booking", { booking_id: today.output.data.booking_id })).error.code).toBe("not_available");
    expect((await call("get_booking", { booking_id })).output.data.status).toBe("booked");
    expect(await firstSlot("haircut", "2026-10-23")).not.toBe(slot_id);
    expect((await call("list_slots", { date: "2026-10-22" })).output.data.slots).toEqual([]);
    expect((await call("list_slots", { date: "2026-10-29" })).output.data.slots).toHaveLength(23);

    // 跨零点的同键重试仍返回第一次的结果，不会再约一次。
    const retry = await send(h, { ...env, issued_at: Math.floor(h.clock.now / 1000) });
    expect(retry.body).toEqual(tomorrow.body);
    expect((await call("cancel_booking", { booking_id })).output.data.status).toBe("cancelled");
    expect(await firstSlot("haircut", "2026-10-23")).toBe(slot_id);
  });
});

describe("网页", () => {
  it("预约详情页手机号脱敏，不存在的返回 404", async () => {
    const slot_id = await firstSlot();
    const body = await call("book_slot", { slot_id, price_cents: HAIRCUT, name: "<b>张三</b>", phone: PHONE });
    const html = await (await fetch(`${h.url}/b/${body.output.data.booking_id}`)).text();
    expect(html).toContain("138****8000");
    expect(html).not.toContain(PHONE);
    expect(html).not.toContain("<b>张三</b>");
    expect((await fetch(`${h.url}/b/b_000000000000`)).status).toBe(404);
  });

  it("请求体超过 1MB → 413", async () => {
    const sent = await fetch(`${h.url}/relay`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    expect(sent.status).toBe(413);
  });

  it("GET /relay → 405，/healthz → 200", async () => {
    expect((await fetch(`${h.url}/relay`)).status).toBe(405);
    expect(await (await fetch(`${h.url}/healthz`)).json()).toEqual({ ok: true });
  });
});

describe("响应 Schema 自检", () => {
  it("validateResponse 能抓住错误的 status", () => {
    expect(validateResponse("action.invoke", { status: "ok" }).ok).toBe(false);
  });
});
