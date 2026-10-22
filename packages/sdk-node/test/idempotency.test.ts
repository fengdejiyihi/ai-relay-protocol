import { describe, expect, it } from "vitest";
import { completed, MemoryIdempotencyStore } from "../src/index.js";

describe("MemoryIdempotencyStore", () => {
  it("处理中占用过期后可以重新占用", () => {
    let now = 0;
    const store = new MemoryIdempotencyStore({ lockSeconds: 10, now: () => now });
    expect(store.begin("k")).toEqual({ state: "acquired" });
    expect(store.begin("k")).toEqual({ state: "in_progress" });
    now = 11_000;
    expect(store.begin("k")).toEqual({ state: "acquired" });
  });

  it("结果按 ttl 过期", () => {
    let now = 0;
    const store = new MemoryIdempotencyStore({ ttlSeconds: 60, now: () => now });
    store.begin("k");
    store.finish("k", { fingerprint: "f", response: completed({}) });
    expect(store.begin("k")).toMatchObject({ state: "done" });
    now = 61_000;
    expect(store.begin("k")).toEqual({ state: "acquired" });
  });

  it("超出上限先淘汰最早的", () => {
    const store = new MemoryIdempotencyStore({ maxEntries: 2 });
    for (const k of ["a", "b", "c"]) {
      store.begin(k);
      store.finish(k, { fingerprint: k, response: completed({}) });
    }
    expect(store.size).toBe(2);
    expect(store.begin("a")).toEqual({ state: "acquired" });
    expect(store.begin("c")).toMatchObject({ state: "done" });
  });

  it("abandon 释放占用", () => {
    const store = new MemoryIdempotencyStore();
    store.begin("k");
    store.abandon("k");
    expect(store.begin("k")).toEqual({ state: "acquired" });
  });
});
