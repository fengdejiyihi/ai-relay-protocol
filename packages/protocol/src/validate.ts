import { DOWNSTREAM_TYPES, RESPONSE_STATUSES_BY_TYPE } from "./constants.js";
import { actionAjv, type Issue, type SchemaFlavor, toIssues, validatorFor } from "./ajv.js";
import { SCHEMA_IDS } from "./schemas.js";
import type {
  DescribeResult,
  DownstreamEnvelope,
  DownstreamType,
  McpToolName,
  OrderResult,
  ResponseByType,
  SearchResult,
  StatusList,
  ToolInputByName,
  UpstreamEvent,
} from "./types.js";

export type Result<T> = { ok: true; value: T } | { ok: false; errors: Issue[] };

function run<T>(ref: string, input: unknown, flavor: SchemaFlavor = "strict"): Result<T> {
  const validate = validatorFor(ref, flavor);
  return validate(input) ? { ok: true, value: input as T } : { ok: false, errors: toIssues(validate.errors) };
}

export interface ValidateOptions {
  /**
   * 默认 false：收方视角，忽略不认识的字段、接受任何 1.x 的 rsp（RSP 1.0 第 14 节），
   * 必填字段、类型和 type/status/code 枚举照样严格。
   * true：不允许未定义字段、rsp 必须是 "1.0"。Relay 自测发出的信封、Conformance 报多余字段警告时用。
   */
  strict?: boolean;
}

const flavorOf = (options: ValidateOptions): SchemaFlavor => (options.strict ? "strict" : "tolerant");

/**
 * 供给方收到的下行信封。SDK 与沙箱商家用它校验 Relay 发来的请求。
 * 不认识的 type 返回规则 D-TYPE-1，供给方应回 not_supported；其余错误回 invalid_input。
 */
export function validateDownstream(input: unknown, options: ValidateOptions = {}): Result<DownstreamEnvelope> {
  const type = (input as { type?: unknown } | null)?.type;
  if (typeof type === "string" && !(DOWNSTREAM_TYPES as readonly string[]).includes(type)) {
    return { ok: false, errors: [{ path: "/type", rule: "D-TYPE-1", message: `不认识的信封类型：${type}，应回 not_supported` }] };
  }
  return run(SCHEMA_IDS.downstream, input, flavorOf(options));
}

/**
 * Relay 收到的上行回调事件。默认忽略多余字段（很多框架会自动加 request_id、trace_id），
 * 必填字段、类型和事件 type 照样严格。
 */
export function validateUpstream(input: unknown, options: ValidateOptions = {}): Result<UpstreamEvent> {
  return run(SCHEMA_IDS.upstream, input, flavorOf(options));
}

/**
 * 供给方对某类下行信封的同步响应，只接受该类型允许的 status。默认忽略多余字段，
 * 否则一个框架自动加的字段就会让已经执行的订单被当成失败。
 */
export function validateResponse<T extends DownstreamType>(type: T, input: unknown, options: ValidateOptions = {}): Result<ResponseByType[T]> {
  const status = (input as { status?: unknown } | null)?.status;
  const allowed = RESPONSE_STATUSES_BY_TYPE[type] as readonly string[];
  if (typeof status !== "string" || !allowed.includes(status)) {
    return { ok: false, errors: [{ path: "/status", rule: "R-STATUS-1", message: `${type} 的响应 status 必须是 ${allowed.join(" / ")}` }] };
  }
  return run(`${SCHEMA_IDS.responses}#/$defs/${status === "ok" ? "ping" : status}`, input, flavorOf(options));
}

/**
 * AI 调用 MCP 工具时的参数。Schema 之外再查组合约束（发布给模型的 Schema 顶层不能用 oneOf）：
 * T-CHOOSE-1：relay_choose 的 proposal_id 与 cancel 必须恰好给一个。
 */
export function validateToolInput<N extends McpToolName>(name: N, input: unknown): Result<ToolInputByName[N]> {
  const result = run<ToolInputByName[N]>(`${SCHEMA_IDS.mcpTools}#/$defs/${name}`, input);
  if (result.ok && name === "relay_choose") {
    const value = input as { proposal_id?: unknown; cancel?: unknown };
    if ((value.proposal_id === undefined) === (value.cancel === undefined)) {
      return { ok: false, errors: [{ path: "/", rule: "T-CHOOSE-1", message: "proposal_id 与 cancel 必须恰好给一个" }] };
    }
  }
  return result;
}

/** Relay 返回给 AI 的结构化结果（relay_invoke、带 order_id 的 relay_status、relay_choose）。 */
export function validateOrderResult(input: unknown): Result<OrderResult> {
  return run(`${SCHEMA_IDS.mcpResults}#/$defs/order_result`, input);
}

/** 不带 order_id 调 relay_status 时返回的最近订单列表。 */
export function validateStatusList(input: unknown): Result<StatusList> {
  return run(`${SCHEMA_IDS.mcpResults}#/$defs/status_list`, input);
}

/** relay_search 的结果。 */
export function validateSearchResult(input: unknown): Result<SearchResult> {
  return run(`${SCHEMA_IDS.mcpResults}#/$defs/search_result`, input);
}

/** relay_describe 的结果。 */
export function validateDescribeResult(input: unknown): Result<DescribeResult> {
  return run(`${SCHEMA_IDS.mcpResults}#/$defs/describe_result`, input);
}

/** 按动作的 input Schema 校验 AI 给出的输入。Relay 下发前调用。 */
export function compileActionInput(schema: Record<string, unknown>): (input: unknown) => Result<Record<string, unknown>> {
  const validate = actionAjv().compile(schema);
  return (input) =>
    validate(input) ? { ok: true, value: input as Record<string, unknown> } : { ok: false, errors: toIssues(validate.errors) };
}
