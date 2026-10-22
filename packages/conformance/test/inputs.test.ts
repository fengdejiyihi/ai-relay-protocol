import { describe, expect, it } from "vitest";
import { firstDifference, resolveInput } from "../src/index.js";

const NOW = Date.parse("2026-10-22T20:30:00+08:00");

describe("resolveInput", () => {
  const outputs = new Map<string, unknown>([["list_slots", { slots: [{ slot_id: "s1", price_cents: 6800 }] }]]);

  it("引用前面动作的 output.data，保留类型", () => {
    const r = resolveInput(
      { slot_id: "{{list_slots.slots[0].slot_id}}", price: "{{ list_slots.slots[0].price_cents }}", note: "原样 {{不替换}}" },
      { outputs, nowMs: NOW, timeZone: "Asia/Shanghai" },
    );
    expect(r).toEqual({ ok: true, value: { slot_id: "s1", price: 6800, note: "原样 {{不替换}}" } });
  });

  it("$today / $tomorrow 按时区算", () => {
    const sh = resolveInput({ a: "{{$today}}", b: "{{$tomorrow}}" }, { outputs, nowMs: NOW, timeZone: "Asia/Shanghai" });
    expect(sh).toEqual({ ok: true, value: { a: "2026-10-22", b: "2026-10-23" } });
    const utc = resolveInput({ a: "{{$today}}" }, { outputs, nowMs: Date.parse("2026-10-22T23:30:00+08:00"), timeZone: "UTC" });
    expect(utc).toEqual({ ok: true, value: { a: "2026-10-22" } });
  });

  it("$tomorrow 按日历加一天，夏令时结束那天也对", () => {
    const r = resolveInput({ b: "{{$tomorrow}}" }, { outputs, nowMs: Date.parse("2026-11-01T00:30:00-04:00"), timeZone: "America/New_York" });
    expect(r).toEqual({ ok: true, value: { b: "2026-11-02" } });
  });

  it("引用的动作没有结果或路径不存在时给出原因", () => {
    const ctx = { outputs, nowMs: NOW, timeZone: "UTC" };
    expect(resolveInput({ x: "{{book_slot.booking_id}}" }, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("book_slot") });
    expect(resolveInput({ x: "{{list_slots.slots[3].slot_id}}" }, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("取不到") });
  });
});

describe("firstDifference", () => {
  it("键顺序不算差异", () => {
    expect(firstDifference({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBeNull();
  });
  it("指出第一处不同", () => {
    expect(firstDifference({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe("/a/b/1：2 → 3");
    expect(firstDifference({ a: 1 }, { a: 1, x: true })).toBe("/x：（无） → true");
  });
});
