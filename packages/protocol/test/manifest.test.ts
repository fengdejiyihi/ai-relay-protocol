import { describe, expect, it } from "vitest";
import { checkPlatformPolicy, effectiveConfirm, effectiveRisk, piiFields, resolveAmount, validateManifest } from "../src/index.js";
import { clone, example } from "./helpers.js";

const sandbox = example("sandbox-shop.json");

function rules(input: unknown): string[] {
  const r = validateManifest(input);
  return r.ok ? [] : r.errors.map((e) => e.rule);
}

describe("示例清单", () => {
  it.each(["sandbox-shop.json", "l2-publisher.json", "l2-matching.json"])("%s 通过校验", (name) => {
    const r = validateManifest(example(name));
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it("沙箱商家 fee=0 只在自营放行下不出警告", () => {
    expect(checkPlatformPolicy(sandbox, { allowZeroFee: true })).toEqual({ errors: [], warnings: [] });
    expect(checkPlatformPolicy(sandbox).warnings.map((w) => w.rule)).toEqual(["P-FEE-0"]);
  });
});

describe("Schema 层", () => {
  it("拒绝 v0.1 的 price 字段", () => {
    const m = clone(sandbox);
    m.actions[0].price = 100;
    expect(rules(m)).toContain("schema");
  });

  it("拒绝 on_confirm 计费", () => {
    const m = clone(sandbox);
    m.actions[1].billing = "on_confirm";
    expect(rules(m)).toContain("schema");
  });

  it("endpoint 必须是 https", () => {
    const m = clone(sandbox);
    m.endpoint.url = "http://shop.example.com/relay";
    expect(rules(m)).toContain("schema");
  });

  it("动作名只能小写下划线", () => {
    const m = clone(sandbox);
    m.actions[0].name = "List.Slots";
    expect(rules(m)).toContain("schema");
  });
});

describe("语义规则", () => {
  it("M-RISK-1：low 必须 readonly 且免费", () => {
    const m = clone(sandbox);
    m.actions[1].risk = "low";
    expect(rules(m)).toContain("M-RISK-1");
  });

  it("M-FEE-1：billing=none 时 fee 必须为 0", () => {
    const m = clone(sandbox);
    m.actions[0].fee = 100;
    expect(rules(m)).toContain("M-FEE-1");
  });

  it("M-BILL-1：同步动作不能 on_accept", () => {
    const m = clone(sandbox);
    m.actions[1].billing = "on_accept";
    expect(rules(m)).toContain("M-BILL-1");
  });

  it("M-NAME-1：动作名不能重复", () => {
    const m = clone(sandbox);
    m.actions[2].name = "list_slots";
    expect(rules(m)).toContain("M-NAME-1");
  });

  it("M-BIND-1：token 绑定必须给 help_url", () => {
    const m = clone(sandbox);
    m.supplier.user_binding = "token";
    expect(rules(m)).toContain("M-BIND-1");
  });

  it("M-AMT-1/2/3：amount 指向的字段必须存在、是整数、必填", () => {
    const opc = example("l2-matching.json");
    const missing = clone(opc);
    missing.actions[0].amount = { from: "input.nope" };
    expect(rules(missing)).toContain("M-AMT-1");
    const wrongType = clone(opc);
    wrongType.actions[0].input.properties.budget_cents.type = "number";
    expect(rules(wrongType)).toContain("M-AMT-2");
    const optional = clone(opc);
    optional.actions[0].input.required = ["title", "detail"];
    expect(rules(optional)).toContain("M-AMT-3");
  });

  it("M-AMT-2：amount 字段可经本地 $ref 指到整数定义，组合写法不认", () => {
    const viaRef = clone(example("l2-matching.json"));
    const input = viaRef.actions[0].input;
    input.$defs = { cents: { $ref: "#/$defs/money" }, money: { type: "integer", minimum: 0 } };
    input.properties.budget_cents = { $ref: "#/$defs/cents", description: "预算（分）" };
    expect(rules(viaRef)).toEqual([]);
    const viaAllOf = clone(example("l2-matching.json"));
    viaAllOf.actions[0].input.properties.budget_cents = { allOf: [{ type: "integer" }] };
    expect(rules(viaAllOf)).toContain("M-AMT-2");
    const dangling = clone(example("l2-matching.json"));
    dangling.actions[0].input.properties.budget_cents = { $ref: "#/$defs/nope" };
    expect(rules(dangling)).toContain("M-AMT-2");
  });

  it("字段存在判断不认原型链上的名字", () => {
    const disp = clone(sandbox);
    disp.actions[1].display_fields = ["constructor"];
    expect(rules(disp)).toContain("M-DISP-1");
    const amt = clone(example("l2-matching.json"));
    amt.actions[0].amount = { from: "input.constructor" };
    expect(rules(amt)).toContain("M-AMT-1");
    expect(() => resolveAmount({ from: "input.constructor" }, {})).toThrow(TypeError);
  });

  it("沙箱 book_slot 的金额取自 price_cents", () => {
    expect(sandbox.actions[1].amount).toEqual({ from: "input.price_cents" });
    expect(resolveAmount(sandbox.actions[1].amount, { slot_id: "s_1", price_cents: 6800 })).toBe(6800);
  });

  it("M-DISP-1：display_fields 只能引用输入字段", () => {
    const m = clone(sandbox);
    m.actions[1].display_fields = ["nope"];
    expect(rules(m)).toContain("M-DISP-1");
  });

  it("M-SCHEMA-1：动作 Schema 必须能编译", () => {
    const m = clone(sandbox);
    m.actions[0].input.properties.date.type = "datetime";
    expect(rules(m)).toContain("M-SCHEMA-1");
  });

  it("警告不阻塞激活", () => {
    const m = clone(sandbox);
    m.actions[1].timeout_seconds = 600;
    const r = validateManifest(m);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.rule)).toEqual(["M-MODE-1"]);
  });
});

describe("平台策略", () => {
  it("fee 超出 ¥1–¥100 不予通过", () => {
    const m = clone(example("l2-matching.json"));
    m.actions[0].fee = 20000;
    expect(checkPlatformPolicy(m).errors.map((e) => e.rule)).toEqual(["P-FEE-1"]);
  });

  it("V1 不接受 oauth 绑定", () => {
    const m = clone(example("l2-matching.json"));
    m.supplier.user_binding = "oauth";
    expect(checkPlatformPolicy(m).errors.map((e) => e.rule)).toContain("P-BIND-1");
  });
});

describe("判定辅助", () => {
  it("确认强度取风险下限与自报值中更严者", () => {
    expect(effectiveConfirm("high", "never")).toBe("always");
    expect(effectiveConfirm("medium", "never")).toBe("by_grant");
    expect(effectiveConfirm("medium", "always")).toBe("always");
    expect(effectiveConfirm("low", "never")).toBe("never");
  });

  it("risk_override 只能上调", () => {
    expect(effectiveRisk("medium", "high")).toBe("high");
    expect(effectiveRisk("medium", "low")).toBe("medium");
    expect(effectiveRisk("low", null)).toBe("low");
  });

  it("resolveAmount 三种写法", () => {
    expect(resolveAmount("none", {})).toBeNull();
    expect(resolveAmount(6800, {})).toBe(6800);
    expect(resolveAmount({ from: "input.budget_cents" }, { budget_cents: 2_000_000 })).toBe(2_000_000);
    expect(() => resolveAmount({ from: "input.budget_cents" }, { budget_cents: "2万" })).toThrow();
  });

  it("piiFields 找出 x-pii 字段", () => {
    expect(piiFields(sandbox.actions[1])).toEqual(["phone"]);
  });
});
