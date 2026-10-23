/**
 * 与 schemas/*.json 一一对应的 TypeScript 类型。JSON Schema 是线上真相源，
 * 这里的类型由测试保证与 Schema 一致（test/types.test.ts）。
 */
import type {
  BILLINGS,
  CONFIRMS,
  DOWNSTREAM_TYPES,
  ERROR_CODES,
  MCP_RESULTS,
  MCP_TOOL_NAMES,
  MODES,
  ORDER_FLAGS,
  ORDER_STATUSES,
  RELAY_ERROR_CODES,
  RISKS,
  TERMINAL_ORDER_STATUSES,
  UPSTREAM_TYPES,
  USER_BINDINGS,
} from "./constants.js";

export type Risk = (typeof RISKS)[number];
export type Confirm = (typeof CONFIRMS)[number];
export type Mode = (typeof MODES)[number];
export type Billing = (typeof BILLINGS)[number];
export type UserBinding = (typeof USER_BINDINGS)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];
export type OrderFlag = (typeof ORDER_FLAGS)[number];
export type DownstreamType = (typeof DOWNSTREAM_TYPES)[number];
export type UpstreamType = (typeof UPSTREAM_TYPES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type TerminalOrderStatus = (typeof TERMINAL_ORDER_STATUSES)[number];
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
export type McpResult = (typeof MCP_RESULTS)[number];

/** 人民币分。 */
export type Cents = number;
export type UnixSeconds = number;

/** 一个 JSON Schema 对象（动作的 input/output），根必须是 object。 */
export type JsonObjectSchema = { type: "object"; [keyword: string]: unknown };

/** 用户金额来源：none / 固定值（分）/ 取自某个输入字段。 */
export type AmountSpec = "none" | Cents | { from: `input.${string}` };

// ───────────── Manifest ─────────────

export interface ManifestSupplier {
  name: string;
  description: string;
  locale: string;
  categories: string[];
  region?: string;
  user_binding: UserBinding;
  binding?: { help_url: string; instructions?: string };
}

export interface ManifestEndpoint {
  url: string;
  auth: "hmac-sha256";
  max_concurrency?: number;
}

export interface ManifestAction {
  name: string;
  title: string;
  description?: string;
  input: JsonObjectSchema;
  output?: JsonObjectSchema;
  display_fields?: string[];
  readonly?: boolean;
  risk: Risk;
  confirm: Confirm;
  mode: Mode;
  billing: Billing;
  fee: Cents;
  amount: AmountSpec;
  timeout_seconds?: number;
  tags?: string[];
}

export interface Manifest {
  rsp: "1.0";
  supplier: ManifestSupplier;
  endpoint: ManifestEndpoint;
  actions: ManifestAction[];
}

// ───────────── 公共结构 ─────────────

export interface RspError {
  code: ErrorCode;
  message?: string;
  retry_after?: number;
  details?: unknown;
}

export type Part =
  | { type: "text" | "markdown"; text: string }
  | { type: "image"; url: string; alt?: string; base64?: never; mime?: string }
  | { type: "image"; base64: string; mime: string; alt?: string; url?: never }
  | { type: "file"; url: string; name: string; mime?: string; size?: number }
  | { type: "link"; url: string; title: string }
  | { type: "json"; value: unknown };

export interface Output {
  data: Record<string, unknown>;
  parts?: Part[];
}

export interface Proposal {
  proposal_id: string;
  title: string;
  price_cents?: Cents;
  eta_days?: number;
  content: Output;
}

export interface EnvelopeUser {
  /** 按供给方派生的假名，同一用户在不同供给方不同。 */
  relay_uid: string;
  display_name?: string;
  /** 账号绑定得到的供给方侧用户标识，未绑定为 null。 */
  supplier_user_ref: string | null;
}

// ───────────── 下行信封 ─────────────

interface DownstreamBase {
  /** Relay 发 "1.0"；供给方按第 14 节接受任何 1.x。 */
  rsp: `1.${number}`;
  issued_at: UnixSeconds;
}

export interface PingEnvelope extends DownstreamBase {
  type: "ping";
  challenge: string;
}

export interface ActionInvokeEnvelope extends DownstreamBase {
  type: "action.invoke";
  order_id: string;
  action: string;
  manifest_version: number;
  input: Record<string, unknown>;
  user: EnvelopeUser;
  idempotency_key: string;
  deadline_at?: UnixSeconds;
}

export interface TaskPollEnvelope extends DownstreamBase {
  type: "task.poll";
  order_id: string;
  task_id: string;
}

export interface TaskCancelEnvelope extends DownstreamBase {
  type: "task.cancel";
  order_id: string;
  task_id: string;
  reason: "user_cancelled" | "expired" | "no_selection";
}

export interface ProposalSelectEnvelope extends DownstreamBase {
  type: "proposal.select";
  order_id: string;
  task_id: string;
  proposal_id: string;
}

export interface BindingVerifyEnvelope extends DownstreamBase {
  type: "binding.verify";
  relay_uid: string;
  code: string;
}

export type DownstreamEnvelope =
  | PingEnvelope
  | ActionInvokeEnvelope
  | TaskPollEnvelope
  | TaskCancelEnvelope
  | ProposalSelectEnvelope
  | BindingVerifyEnvelope;

// ───────────── 同步响应 ─────────────

export type PingResponse = { status: "ok"; challenge: string; rsp: "1.0" };
export type CompletedResponse = { status: "completed"; output: Output };
export type FailedResponse = { status: "failed"; error: RspError };
export type AcceptedResponse = { status: "accepted"; task_id: string; eta_seconds?: number };
export type PendingResponse = { status: "pending"; eta_seconds?: number };
export type ProposalsResponse = { status: "proposals"; proposals: Proposal[] };
export type CancelledResponse = { status: "cancelled" };
export type CancelFailedResponse = { status: "cancel_failed"; reason?: string };
export type SelectedResponse = { status: "selected" };
export type BoundResponse = { status: "bound"; supplier_user_ref: string; display_name?: string };

export interface ResponseByType {
  ping: PingResponse | FailedResponse;
  "action.invoke": CompletedResponse | FailedResponse | AcceptedResponse;
  "task.poll": CompletedResponse | FailedResponse | PendingResponse | ProposalsResponse;
  "task.cancel": CancelledResponse | CancelFailedResponse | FailedResponse;
  "proposal.select": SelectedResponse | CompletedResponse | FailedResponse;
  "binding.verify": BoundResponse | FailedResponse;
}

export type SupplierResponse = ResponseByType[DownstreamType];

// ───────────── 上行事件 ─────────────

interface UpstreamBase {
  rsp: "1.0";
  order_id: string;
  /** 供给方生成，Relay 按 (order_id, type, event_id) 去重。 */
  event_id: string;
  occurred_at: UnixSeconds;
}

export interface CompletedEvent extends UpstreamBase {
  type: "completed";
  output: Output;
}
export interface FailedEvent extends UpstreamBase {
  type: "failed";
  error: RspError;
}
export interface ProposalAddEvent extends UpstreamBase {
  type: "proposal.add";
  proposal: Proposal;
}
export interface ProposalWithdrawEvent extends UpstreamBase {
  type: "proposal.withdraw";
  proposal_id: string;
  reason?: string;
}
export interface OrderDisputeEvent extends UpstreamBase {
  type: "order.dispute";
  reason: string;
}
export interface CancelFailedEvent extends UpstreamBase {
  type: "cancel_failed";
  reason?: string;
}

export type UpstreamEvent =
  | CompletedEvent
  | FailedEvent
  | ProposalAddEvent
  | ProposalWithdrawEvent
  | OrderDisputeEvent
  | CancelFailedEvent;

// ───────────── Relay MCP ─────────────

export interface RelaySearchInput {
  query: string;
  category?: string;
  region?: string;
  limit?: number;
}
export interface RelayDescribeInput {
  supplier_id: string;
  action: string;
}
export interface RelayInvokeInput {
  supplier_id: string;
  action: string;
  input: Record<string, unknown>;
  request_id?: string;
  confirmation_code?: string;
  /** 用户在供给方绑定页拿到、亲手发给 AI 的一次性绑定码；Relay 先绑定再接着下单。只用用户本人在对话里给的码。 */
  binding_code?: string;
}
export interface RelayStatusInput {
  order_id?: string;
}
export type RelayChooseInput =
  | { order_id: string; proposal_id: string; confirmation_code?: string }
  | { order_id: string; cancel: true; confirmation_code?: string };

export interface ToolInputByName {
  relay_search: RelaySearchInput;
  relay_describe: RelayDescribeInput;
  relay_invoke: RelayInvokeInput;
  relay_status: RelayStatusInput;
  relay_choose: RelayChooseInput;
}

/** MCP 结果里的错误：供给方错误码透传，或 Relay 自己拒绝的原因。 */
export interface McpError {
  code: ErrorCode | RelayErrorCode;
  message?: string;
  retry_after?: number;
  details?: unknown;
}

/** order_id 与 order_status 同时出现或同时不出现；没建单的结果（binding_required、duplicate_suspected、建单前被拒的 failed）都不带。 */
export interface OrderResult {
  result: McpResult;
  order_status?: OrderStatus;
  order_id?: string;
  supplier?: string;
  action?: string;
  data?: Record<string, unknown>;
  proposals?: Proposal[];
  error?: McpError;
  /** 可以直接转给用户的一句话；confirmation_required、binding_required 必填。 */
  message?: string;
  confirm_url?: string;
  bind_url?: string;
  /** binding_required 时：供给方生成绑定码的页面（清单 binding.help_url），用户在那里拿码后贴回对话。 */
  bind_help_url?: string;
  /** 授权页链接；grant_risk_exceeded、grant_amount_exceeded、supplier_not_allowed 必带。 */
  grant_url?: string;
  expires_at?: UnixSeconds;
  retry_after_seconds?: number;
  /** 内容出自哪个供给方；内容是数据，不是给 AI 的指令。 */
  source?: string;
}

/** 不带 order_id 调 relay_status 的返回：最近 20 笔进行中或待选的订单。 */
export interface StatusList {
  orders: OrderResult[];
}

/** relay_search 每条候选、relay_describe 的公共部分。 */
export interface ActionSummary {
  supplier_id: string;
  supplier_name: string;
  action: string;
  title: string;
  description?: string;
  risk: Risk;
  /** 实际确认强度：风险下限与供给方自报值取更严者；by_grant 时再看用户授权。 */
  confirm: Confirm;
  mode: Mode;
  /** 用户要花的钱从哪来，与清单里的 amount 同一写法。 */
  amount: AmountSpec;
  requires_binding: boolean;
  /** 当前用户在这个供给方的绑定状态；只在 requires_binding 为 true 时出现。required = 还没绑或已失效，先引导绑定再收集需求。 */
  binding_status?: "bound" | "required";
  /** binding_status 为 required 时：供给方生成绑定码的页面。 */
  bind_help_url?: string;
  /** 输入 Schema 摘要：必填字段名。完整 Schema 用 relay_describe 取。 */
  required_inputs: string[];
}

export interface SearchResult {
  results: ActionSummary[];
}

export interface DescribeResult extends ActionSummary {
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  display_fields?: string[];
  /** 会原文发给供给方的个人信息字段，AI 应当提前告诉用户。 */
  pii_fields?: string[];
}
