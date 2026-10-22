import { describe, expect, it } from "vitest";
import {
  MCP_TOOL_NAMES,
  schemas,
  validateDescribeResult,
  validateOrderResult,
  validateSearchResult,
  validateStatusList,
  validateToolInput,
} from "../src/index.js";

describe("MCP 工具输入", () => {
  it("工具名全部是下划线", () => {
    for (const name of MCP_TOOL_NAMES) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("relay_invoke 带 request_id", () => {
    expect(
      validateToolInput("relay_invoke", { supplier_id: "sup_sandbox01", action: "book_slot", input: { slot_id: "s_1" }, request_id: "req_12345678" }).ok,
    ).toBe(true);
    expect(validateToolInput("relay_invoke", { supplier_id: "sup_sandbox01", action: "book_slot" }).ok).toBe(false);
  });

  it("relay_status 可不带 order_id", () => {
    expect(validateToolInput("relay_status", {}).ok).toBe(true);
  });

  it("relay_choose 选方案与取消二选一", () => {
    const order_id = "ord_01JABCDEFGHJKM";
    expect(validateToolInput("relay_choose", { order_id, proposal_id: "p_1" }).ok).toBe(true);
    expect(validateToolInput("relay_choose", { order_id, cancel: true }).ok).toBe(true);
    expect(validateToolInput("relay_choose", { order_id }).ok).toBe(false);
    expect(validateToolInput("relay_choose", { order_id, proposal_id: "p_1", cancel: true }).ok).toBe(false);
    expect(validateToolInput("relay_choose", { order_id, cancel: false }).ok).toBe(false);
  });

  it("工具 Schema 可以原样发布：自包含、顶层没有组合关键字", () => {
    const defs = schemas.mcpTools.$defs as Record<string, Record<string, unknown>>;
    for (const name of MCP_TOOL_NAMES) {
      const schema = defs[name]!;
      expect(schema.type, name).toBe("object");
      for (const k of ["oneOf", "anyOf", "allOf", "not", "if"]) expect(schema[k], `${name}.${k}`).toBeUndefined();
      expect(JSON.stringify(schema), name).not.toContain("$ref");
    }
    const r = validateToolInput("relay_choose", { order_id: "ord_01JABCDEFGHJKM" });
    expect(r.ok ? [] : r.errors.map((e) => e.rule)).toEqual(["T-CHOOSE-1"]);
  });
});

describe("MCP 结果", () => {
  it("confirmation_required 必须带确认链接和过期时间", () => {
    expect(validateOrderResult({ result: "confirmation_required", order_status: "awaiting_confirmation", order_id: "ord_01JABCDEFGHJKM" }).ok).toBe(false);
    expect(
      validateOrderResult({
        result: "confirmation_required",
        order_status: "awaiting_confirmation",
        order_id: "ord_01JABCDEFGHJKM",
        confirm_url: "https://relay.newbeeai.online/c/abc",
        expires_at: 1761055800,
        message: "这笔预约需要你确认：打开链接核对后点确认。",
      }).ok,
    ).toBe(true);
  });

  it("completed 必须注明来源供给方", () => {
    expect(validateOrderResult({ result: "completed", order_status: "completed", order_id: "ord_01JABCDEFGHJKM", data: {} }).ok).toBe(false);
  });

  const order_id = "ord_01JABCDEFGHJKM";

  it("pending 必须带 order_id，AI 才能用 relay_status 查", () => {
    expect(validateOrderResult({ result: "pending", order_status: "accepted" }).ok).toBe(false);
    expect(validateOrderResult({ result: "pending", order_status: "accepted", order_id }).ok).toBe(true);
  });

  it("result 只能配对应的订单状态", () => {
    const ok = (r: Record<string, unknown>) => validateOrderResult(r).ok;
    expect(ok({ result: "completed", order_status: "failed", order_id, data: {}, source: "sandbox" })).toBe(false);
    expect(ok({ result: "completed", order_status: "completed", order_id, data: {}, source: "sandbox" })).toBe(true);
    expect(ok({ result: "failed", order_status: "completed", order_id, error: { code: "permanent" } })).toBe(false);
    expect(ok({ result: "pending", order_status: "completed", order_id })).toBe(false);
    expect(ok({ result: "cancelled", order_status: "accepted", order_id })).toBe(false);
    expect(ok({ result: "expired", order_status: "expired", order_id })).toBe(true);
    expect(ok({ result: "awaiting_selection", order_status: "accepted", order_id, proposals: [] })).toBe(false);
  });

  it("没建单的结果不带 order_id 和 order_status，两者同进同出", () => {
    const ok = (r: Record<string, unknown>) => validateOrderResult(r).ok;
    expect(ok({ result: "binding_required", bind_url: "https://relay.newbeeai.online/bind/abc", message: "先绑定你在该产品的账号。" })).toBe(true);
    expect(ok({ result: "failed", error: { code: "invalid_input" } })).toBe(true);
    expect(ok({ result: "duplicate_suspected" })).toBe(true);
    expect(ok({ result: "failed", order_id, error: { code: "permanent" } })).toBe(false);
    expect(ok({ result: "failed", order_status: "failed", error: { code: "permanent" } })).toBe(false);
  });

  it("confirmation_required、binding_required 必须带一句可转给用户的话", () => {
    const ok = (r: Record<string, unknown>) => validateOrderResult(r).ok;
    expect(ok({ result: "binding_required", bind_url: "https://relay.newbeeai.online/bind/abc" })).toBe(false);
    expect(
      ok({ result: "confirmation_required", order_status: "awaiting_confirmation", order_id, confirm_url: "https://relay.newbeeai.online/c/abc", expires_at: 1761055800 }),
    ).toBe(false);
  });

  it("Relay 自己拒绝时用 Relay 错误码，授权类必须带 grant_url", () => {
    const ok = (r: Record<string, unknown>) => validateOrderResult(r).ok;
    const grant_url = "https://relay.newbeeai.online/settings/grants/cli_1";
    expect(ok({ result: "failed", error: { code: "grant_amount_exceeded", message: "超过你设的单笔上限 ¥200" }, grant_url })).toBe(true);
    expect(ok({ result: "failed", error: { code: "grant_amount_exceeded" } })).toBe(false);
    expect(ok({ result: "failed", error: { code: "grant_risk_exceeded" } })).toBe(false);
    expect(ok({ result: "failed", error: { code: "supplier_unavailable" } })).toBe(true);
    expect(ok({ result: "failed", order_status: "failed", order_id, error: { code: "binding_invalid" } })).toBe(true);
    expect(ok({ result: "expired", order_status: "expired", order_id, error: { code: "confirmation_expired" } })).toBe(true);
    expect(ok({ result: "failed", error: { code: "made_up" } })).toBe(false);
  });

  it("relay_status 不带 order_id 时返回订单列表", () => {
    const orders = [
      { result: "pending", order_status: "accepted", order_id },
      { result: "awaiting_selection", order_status: "awaiting_selection", order_id: "ord_01JABCDEFGHJKN", proposals: [] },
    ];
    expect(validateStatusList({ orders }).ok).toBe(true);
    expect(validateStatusList({ orders: [{ result: "pending", order_status: "accepted" }] }).ok).toBe(false);
    expect(validateStatusList({}).ok).toBe(false);
  });
});

describe("搜索与描述结果", () => {
  const summary = {
    supplier_id: "sup_sandbox01",
    supplier_name: "Relay 沙箱理发店",
    action: "book_slot",
    title: "预约到店",
    risk: "medium",
    confirm: "by_grant",
    mode: "sync",
    amount: { from: "input.price_cents" },
    requires_binding: false,
    required_inputs: ["slot_id", "price_cents", "name", "phone"],
  };

  it("relay_search 返回候选动作摘要", () => {
    expect(validateSearchResult({ results: [summary] }).ok).toBe(true);
    const { risk: _, ...noRisk } = summary;
    expect(validateSearchResult({ results: [noRisk] }).ok).toBe(false);
    expect(validateSearchResult({ results: Array.from({ length: 21 }, () => summary) }).ok).toBe(false);
  });

  it("relay_describe 在摘要之外带完整 Schema", () => {
    const input = { type: "object", properties: { slot_id: { type: "string" } }, required: ["slot_id"] };
    expect(validateDescribeResult({ ...summary, input, pii_fields: ["phone"] }).ok).toBe(true);
    expect(validateDescribeResult(summary).ok).toBe(false);
  });
});
