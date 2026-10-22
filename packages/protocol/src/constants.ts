/**
 * RSP 1.0 与 Relay MCP 1.0 的常量。数值是协议定下的时限和上限；
 * 改动任何一个值都是协议变更，需要走 ADR。
 */

export const RSP_VERSION = "1.0" as const;
export const MCP_PROTOCOL_VERSION = "1.0" as const;

export const RISKS = ["low", "medium", "high"] as const;
export const CONFIRMS = ["never", "by_grant", "always"] as const;
export const MODES = ["sync", "async", "async_multi"] as const;
export const BILLINGS = ["none", "on_accept", "on_complete"] as const;
export const USER_BINDINGS = ["none", "token", "oauth"] as const;

/** 产品只需用这 6 个；not_supported 仅用于不认识的信封类型（2.6）。 */
export const ERROR_CODES = [
  "invalid_input",
  "not_available",
  "unauthorized",
  "rate_limited",
  "temporary",
  "permanent",
  "not_supported",
] as const;

/** 只有这两类错误会被 Relay 重试（5.4）。网络错误同样重试。供给方不得把它们写进幂等缓存。 */
export const RETRYABLE_ERROR_CODES = ["temporary", "rate_limited"] as const;

/**
 * Relay 自己拒绝时给 AI 的错误码，只出现在 MCP 结果里，供给方不用（RSP 1.0 第 15 节）。
 * grant_*、supplier_not_allowed 会带 grant_url，让用户去授权页调整。
 */
export const RELAY_ERROR_CODES = [
  "grant_risk_exceeded",
  "grant_amount_exceeded",
  "supplier_not_allowed",
  "supplier_unavailable",
  "confirmation_expired",
  "binding_invalid",
] as const;

/** 下行信封：Relay → 供给方 POST /relay。binding.verify 见 ADR-003。 */
export const DOWNSTREAM_TYPES = [
  "ping",
  "action.invoke",
  "task.poll",
  "task.cancel",
  "proposal.select",
  "binding.verify",
] as const;

/** 上行事件：供给方 → Relay POST /v1/callbacks/{order_id}。 */
export const UPSTREAM_TYPES = [
  "completed",
  "failed",
  "proposal.add",
  "proposal.withdraw",
  "order.dispute",
  "cancel_failed",
] as const;

/** 每种下行信封允许的同步响应 status。 */
export const RESPONSE_STATUSES_BY_TYPE = {
  ping: ["ok", "failed"],
  "action.invoke": ["completed", "failed", "accepted"],
  "task.poll": ["completed", "failed", "pending", "proposals"],
  "task.cancel": ["cancelled", "cancel_failed", "failed"],
  "proposal.select": ["selected", "completed", "failed"],
  "binding.verify": ["bound", "failed"],
} as const;

/** Order 状态（第 4 章状态机）。终态之后的回调返回 409。 */
export const ORDER_STATUSES = [
  "created",
  "awaiting_confirmation",
  "dispatched",
  "accepted",
  "awaiting_selection",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;
export const TERMINAL_ORDER_STATUSES = ["completed", "failed", "cancelled", "expired"] as const;

/**
 * 订单上的附加标记，不是独立状态（RSP 1.0 第 12 节）。
 * needs_reconcile：待核对，挂在 dispatched 上（已发出后 5xx、超时或超过同步硬超时），AI 看到 pending，
 *   后台核对后迁到 completed（按 billing 计费）或 failed（不扣费）。
 * disputed：争议中，挂在已扣费的 completed 上，裁定后写退款流水或驳回，状态不变。
 */
export const ORDER_FLAGS = ["needs_reconcile", "disputed"] as const;

export const MCP_TOOL_NAMES = [
  "relay_search",
  "relay_describe",
  "relay_invoke",
  "relay_status",
  "relay_choose",
] as const;

export const MCP_RESULTS = [
  "completed",
  "failed",
  "pending",
  "awaiting_selection",
  "confirmation_required",
  "binding_required",
  "duplicate_suspected",
  "cancelled",
  "expired",
] as const;

export const PART_TYPES = ["text", "markdown", "image", "file", "link", "json"] as const;

export const HEADERS = {
  signature: "X-Relay-Signature",
  rspVersion: "X-Relay-RSP",
  orderId: "X-Relay-Order-Id",
} as const;

export const LIMITS = {
  /** 签名时间窗（秒）。 */
  signatureToleranceSeconds: 300,
  /** 密钥轮换时新旧 secret 并存时长（秒）。 */
  secretRotationOverlapSeconds: 24 * 3600,
  /** 同步调用总预算（毫秒），超出后先给 AI 返回 pending，HTTP 请求继续等到硬超时。 */
  syncBudgetMs: 20_000,
  /** 同步请求的 HTTP 硬超时（毫秒）。之前收到的响应照常完成并计费，超过则进待核对、不扣费。 */
  syncHardTimeoutMs: 60_000,
  /** 同步路径重试次数。 */
  syncRetries: 1,
  /** 异步下发重试次数与退避（毫秒）。 */
  asyncRetries: 3,
  asyncRetryBackoffMs: [1_000, 4_000, 16_000],
  /** task.poll 退避（秒）。 */
  pollBackoffSeconds: [60, 120, 300, 900],
  /** 异步任务默认超时与上限（秒）。 */
  asyncDefaultTimeoutSeconds: 24 * 3600,
  asyncMaxTimeoutSeconds: 7 * 24 * 3600,
  /** 待确认过期（秒）。 */
  confirmationTtlSeconds: 600,
  /** request_id 去重窗口（秒）。 */
  requestIdTtlSeconds: 24 * 3600,
  /** 无 request_id 时的疑似重复窗口（秒）。 */
  duplicateSuspectWindowSeconds: 60,
  /** 争议窗口（秒）。 */
  disputeWindowSeconds: 72 * 3600,
  /** relay_status 不带 order_id 时返回条数。 */
  statusListLimit: 20,
  /** 单次返回内联内容合计上限（字节）。 */
  inlineContentMaxBytes: 1024 * 1024,
  /** 图片内联：长边像素与体积上限。 */
  imageMaxEdgePx: 1024,
  imageMaxBytes: 300 * 1024,
  /** 拉取供给方 URL：超时与最多跳转。 */
  fetchTimeoutMs: 5_000,
  fetchMaxRedirects: 2,
  /** 超大载荷转 COS 的阈值（字节）与链接有效期（秒）。 */
  payloadOffloadBytes: 64 * 1024,
  offloadLinkTtlSeconds: 24 * 3600,
  /** 每个 AI 客户端默认限速（次/分钟）。 */
  aiClientRatePerMinute: 60,
} as const;

/** 平台审核策略，不是协议有效性的一部分。 */
export const PLATFORM_POLICY = {
  feeMinCents: 100,
  feeMaxCents: 10_000,
  defaultGrant: { maxRisk: "medium", maxAmountCents: 20_000, confirmEach: true },
} as const;
