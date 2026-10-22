import type {
  AcceptedResponse,
  BoundResponse,
  CancelFailedResponse,
  CancelledResponse,
  CompletedResponse,
  ErrorCode,
  FailedResponse,
  Output,
  Part,
  PendingResponse,
  Proposal,
  ProposalsResponse,
  SelectedResponse,
} from "@dreamcavy/ai-relay-protocol";

/**
 * 同步响应的构造辅助（RSP 1.0 第 6 节）。都返回普通对象，可以直接从处理函数 return。
 */

/** 完成。`data` 应当符合动作的 output Schema；`parts` 是给人看的内容块（第 8 节）。 */
export function completed(data: Record<string, unknown>, parts?: Part[]): CompletedResponse {
  return { status: "completed", output: output(data, parts) };
}

export interface FailedOptions {
  /** 只配 rate_limited：建议 Relay 多少秒后再试。 */
  retryAfter?: number;
  details?: unknown;
}

/**
 * 失败。错误码见第 9 节：只有 `temporary`（确认没有执行）和 `rate_limited` 会被 Relay 重试，
 * SDK 也只不缓存这两种。
 */
export function failed(code: ErrorCode, message?: string, options: FailedOptions = {}): FailedResponse {
  return {
    status: "failed",
    error: {
      code,
      ...(message !== undefined ? { message } : {}),
      ...(options.retryAfter !== undefined ? { retry_after: options.retryAfter } : {}),
      ...(options.details !== undefined ? { details: options.details } : {}),
    },
  };
}

/** 异步接单。之后用回调（RelayCallbackClient）或等 Relay 发 task.poll 交结果。 */
export function accepted(taskId: string, etaSeconds?: number): AcceptedResponse {
  return { status: "accepted", task_id: taskId, ...(etaSeconds !== undefined ? { eta_seconds: etaSeconds } : {}) };
}

/** 只用于 task.poll：仍在处理。 */
export function pending(etaSeconds?: number): PendingResponse {
  return { status: "pending", ...(etaSeconds !== undefined ? { eta_seconds: etaSeconds } : {}) };
}

/** 只用于 task.poll：多方案任务当前全部有效方案。 */
export function proposals(list: Proposal[]): ProposalsResponse {
  return { status: "proposals", proposals: list };
}

export interface ProposalOptions {
  priceCents?: number;
  etaDays?: number;
  parts?: Part[];
}

/** 构造一个方案，给 proposals() 或回调 proposal.add 用。 */
export function proposal(id: string, title: string, data: Record<string, unknown>, options: ProposalOptions = {}): Proposal {
  return {
    proposal_id: id,
    title,
    ...(options.priceCents !== undefined ? { price_cents: options.priceCents } : {}),
    ...(options.etaDays !== undefined ? { eta_days: options.etaDays } : {}),
    content: output(data, options.parts),
  };
}

/** task.cancel：已撤回。 */
export function cancelled(): CancelledResponse {
  return { status: "cancelled" };
}

/** task.cancel：已不可撤回（比如文章已发出）。 */
export function cancelFailed(reason?: string): CancelFailedResponse {
  return { status: "cancel_failed", ...(reason !== undefined ? { reason } : {}) };
}

/** proposal.select：已受理，最终结果之后用 completed 回调。 */
export function selected(): SelectedResponse {
  return { status: "selected" };
}

/** binding.verify：绑定码有效。 */
export function bound(supplierUserRef: string, displayName?: string): BoundResponse {
  return { status: "bound", supplier_user_ref: supplierUserRef, ...(displayName !== undefined ? { display_name: displayName } : {}) };
}

export function output(data: Record<string, unknown>, parts?: Part[]): Output {
  return parts?.length ? { data, parts } : { data };
}

/**
 * 在处理函数里 `throw new RelayError("not_available", "这个时段已约满")`，等同于 return failed(...)。
 * 其他异常 SDK 当作「结果未知」回 HTTP 500（第 2 节），Relay 不重试、不扣费，订单进待核对。
 */
export class RelayError extends Error {
  readonly code: ErrorCode;
  readonly options: FailedOptions;

  constructor(code: ErrorCode, message?: string, options: FailedOptions = {}) {
    super(message ?? code);
    this.name = "RelayError";
    this.code = code;
    this.options = options;
  }

  toResponse(): FailedResponse {
    return failed(this.code, this.message === this.code ? undefined : this.message, this.options);
  }
}
