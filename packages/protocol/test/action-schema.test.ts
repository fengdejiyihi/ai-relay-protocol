import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionAjv } from "../src/ajv.js";
import { compileActionInput, validateManifest } from "../src/index.js";
import { clone, example } from "./helpers.js";

const sandbox = example("sandbox-shop.json");

/** n 个动作：不传 input 就轮流用沙箱商家的 4 个；传了就都用第一个（只读、金额和展示字段不引用输入），第 i 个的 input 换成 input(i)。 */
function many(n: number, input?: (i: number) => Record<string, unknown>) {
  const m = clone(sandbox);
  m.actions = Array.from({ length: n }, (_, i) => {
    const action = clone(sandbox.actions[input ? 0 : i % sandbox.actions.length]);
    return { ...action, name: `${action.name}_${i}`, ...(input ? { input: input(i) } : {}) };
  });
  return m;
}

/** 老写法：新实例连同元 Schema 检查一起编译，拿它的报错文字对照。 */
function oldCompileError(schema: Record<string, unknown>): string | undefined {
  try {
    actionAjv().compile(schema);
  } catch (err) {
    return (err as Error).message;
  }
  return undefined;
}

describe("动作 Schema 的编译", () => {
  afterEach(() => vi.restoreAllMocks());

  it("100 个动作（200 个 Schema）只在一个共用实例上按元 Schema 检查（改前每个 Schema 新建实例都要先编译一遍 2020-12 元 Schema，约 10 ms，整份清单 2 秒多）", () => {
    validateManifest(clone(sandbox)); // 协议 Schema 先编译好，不算在里面
    const spy = vi.spyOn(Ajv2020.prototype, "validateSchema");
    const started = performance.now();
    const r = validateManifest(many(100));
    const ms = performance.now() - started;
    expect(r.errors).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(200);
    expect(new Set(spy.mock.contexts).size).toBe(1);
    // 只是兜底，主要靠上面的计数：改前要 2 秒多
    expect(ms).toBeLessThan(1500);
  });

  it("下单前校验输入（compileActionInput）走同一个共用实例", () => {
    compileActionInput(sandbox.actions[0].input);
    const spy = vi.spyOn(Ajv2020.prototype, "validateSchema");
    for (const action of sandbox.actions) compileActionInput(action.input);
    expect(new Set(spy.mock.contexts).size).toBe(1);
    const check = compileActionInput(sandbox.actions[1].input);
    expect(check({ slot_id: "s1", price_cents: 100, name: "张三", phone: "13800000000" })).toMatchObject({ ok: true });
    expect(check({ slot_id: "s1" })).toMatchObject({ ok: false });
  });

  it("动作之间的 $id 仍互不影响：不同动作可以用同一个 $id，引用别的动作的 $id 照样找不到", () => {
    const same = validateManifest(many(2, () => ({ $id: "https://example.com/in", type: "object" })));
    expect(same.errors).toEqual([]);
    const cross = validateManifest(
      many(2, (i) => (i === 0 ? { $id: "https://example.com/a", type: "object" } : { type: "object", properties: { x: { $ref: "https://example.com/a" } } })),
    );
    expect(cross.errors.map((e) => [e.path, e.rule])).toEqual([["/actions/1/input", "M-SCHEMA-1"]]);
  });

  it("写错的 Schema 照旧报 M-SCHEMA-1，报错文字和改前一样；写了别的 $schema 的照旧在新实例里检查", () => {
    const cases: Record<string, unknown>[] = [
      { type: "object", properties: { q: { type: "strin" } } },
      { type: "object", required: "q" },
      { type: "object", properties: { q: { type: "string", pattern: "(" } } },
      { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
      { $schema: 1, type: "object" },
      // 自己定义的 $id 当 $schema：改前在同一个实例里能找到，照旧
      { $id: "https://example.com/meta", $schema: "https://example.com/meta", type: "object" },
    ];
    for (const schema of cases) {
      const m = clone(sandbox);
      m.actions[0].input = schema;
      const expected = oldCompileError(schema);
      const r = validateManifest(m);
      if (expected === undefined) {
        expect(r.errors).toEqual([]);
      } else {
        expect(r.errors).toEqual([
          { path: "/actions/0/input", rule: "M-SCHEMA-1", message: `不是合法的 JSON Schema 2020-12：${expected}` },
        ]);
      }
      let compileError: string | undefined;
      try {
        compileActionInput(schema);
      } catch (err) {
        compileError = (err as Error).message;
      }
      expect(compileError).toBe(expected);
    }
  });
});
