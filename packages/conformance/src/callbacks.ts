import { type Issue, type Mode, type Proposal, type UpstreamEvent, validateUpstream, verifySignature } from "@dreamcavy/ai-relay-protocol";
import { firstDifference } from "./diff.js";

/**
 * 验收用的回调接收端：一笔验收订单在 Relay 那边会怎么走，就在这里按同样的规则走一遍（RSP 1.0 第 7、12 节）。
 * 纯函数、状态可以 JSON 序列化：命令行版存在内存里，Relay 在线版存在数据库里，两边判定一致。
 *
 * 和 Relay 的区别只有一处：Relay 对「重复的 event_id」不看内容直接 200；这里也回 200，但会比对内容，不一致记成问题。
 */

/** 和 Relay 订单状态同名。选定方案后回到 accepted，selected 记着选的是哪个。 */
export type TestOrderStatus = "dispatched" | "accepted" | "awaiting_selection" | "completed" | "failed" | "cancelled";

const TERMINAL: readonly TestOrderStatus[] = ["completed", "failed", "cancelled"];

export function isTerminalStatus(status: TestOrderStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * 每条回调的判定。
 * accepted 收下并生效；duplicate 同一事件重发（内容一致）；echo 终态之后又来一次同样的结果（比如补拉先拿到了 completed），不算问题；
 * ignored 验收不处理的事件（order.dispute）。其余都是供给方的问题，报告里逐项列出。
 */
export type CallbackVerdict =
  | "accepted"
  | "duplicate"
  | "echo"
  | "ignored"
  | "bad_signature"
  | "invalid"
  | "path_mismatch"
  | "duplicate_conflict"
  | "after_terminal"
  | "rejected_state";

export const CALLBACK_PROBLEMS: readonly CallbackVerdict[] = ["bad_signature", "invalid", "path_mismatch", "duplicate_conflict", "after_terminal", "rejected_state"];

export interface ReceivedCallback {
  /** 收到的时间（毫秒）。 */
  at: number;
  /** 回给供给方的 HTTP 状态码。 */
  http: number;
  verdict: CallbackVerdict;
  detail?: string;
  issues?: Issue[];
  type?: string;
  event_id?: string;
}

export interface TestProposal {
  proposal_id: string;
  withdrawn: boolean;
  /** 从回调 proposal.add 还是从 task.poll 的 proposals 得知。 */
  via: "callback" | "poll";
}

export interface TestOrder {
  order_id: string;
  action: string;
  mode: Mode;
  status: TestOrderStatus;
  task_id?: string;
  proposals: TestProposal[];
  /** 已选定（供给方回了 selected）的方案。 */
  selected: string | null;
  /** 终态是从哪里得知的，以及结果（completed 的 output、failed 的 error）。后来的结果和它比对。 */
  terminal?: { source: "response" | "callback" | "poll" | "cancel"; status: TestOrderStatus; result?: unknown };
  /** 已收下的事件：`${type}:${event_id}` → 事件 JSON，重复的 event_id 拿来比对。 */
  seen: Record<string, unknown>;
  /** 收到的回调，最多 MAX_RECORDED 条；验签失败的只留前 MAX_UNSIGNED 条。 */
  callbacks: ReceivedCallback[];
  /** 超出上面上限、只计数不记明细的回调（验签失败的计在 unsigned_extra，其余计在 dropped）。 */
  unsigned_extra?: number;
  dropped?: number;
}

/** 每笔验收订单最多记多少条回调明细。状态会落库，不能被灌爆。 */
export const MAX_RECORDED = 200;
/** 验签失败的回调谁都能发，只留几条明细说明问题，其余只计数。 */
export const MAX_UNSIGNED = 5;

export function newTestOrder(orderId: string, action: string, mode: Mode): TestOrder {
  return { order_id: orderId, action, mode, status: "dispatched", proposals: [], selected: null, seen: {}, callbacks: [] };
}

export interface CallbackRequest {
  /** 路径 /v1/callbacks/{order_id} 里的 order_id。 */
  pathOrderId: string;
  /** 原始请求体，验签用。 */
  rawBody: string | Uint8Array;
  signature: string | null | undefined;
  /** 用来验签的 secret，新的在前。 */
  secrets: readonly string[];
  /** 当前时间（毫秒）。 */
  now: number;
}

export interface CallbackReply {
  http: number;
  body: Record<string, unknown>;
  order: TestOrder;
}

/**
 * 判定一条回调：验签 → 解析 → Schema → 路径与 order_id → 去重 → 终态 → 当前状态是否接受。
 * 返回要回给供给方的响应和更新后的订单（原对象不改）。
 */
export function judgeCallback(current: TestOrder, req: CallbackRequest): CallbackReply {
  const order: TestOrder = structuredClone(current);
  const record = (http: number, verdict: CallbackVerdict, body: Record<string, unknown>, extra: Partial<ReceivedCallback> = {}): CallbackReply => {
    if (verdict === "bad_signature" && order.callbacks.filter((c) => c.verdict === "bad_signature").length >= MAX_UNSIGNED) {
      order.unsigned_extra = (order.unsigned_extra ?? 0) + 1;
    } else if (order.callbacks.length >= MAX_RECORDED) {
      order.dropped = (order.dropped ?? 0) + 1;
    } else {
      order.callbacks.push({ at: req.now, http, verdict, ...extra });
    }
    return { http, body, order };
  };

  const verified = verifySignature({ secrets: req.secrets, header: req.signature, body: req.rawBody, now: Math.floor(req.now / 1000) });
  if (!verified.ok) {
    const why = { malformed: "签名头缺失或格式不对", expired: "签名时间戳和当前时间相差超过 5 分钟", mismatch: "签名和请求体对不上" }[verified.reason];
    return record(401, "bad_signature", { error: { code: "unauthorized", message: why } }, { detail: `${why}。回调必须用同一个 secret 对原始请求体签名（规范第 3、7 节）` });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof req.rawBody === "string" ? req.rawBody : new TextDecoder().decode(req.rawBody));
  } catch {
    return record(422, "invalid", { error: { code: "invalid_event", message: "请求体不是 JSON" } }, { detail: "请求体不是 JSON" });
  }
  const meta = parsed as { type?: unknown; event_id?: unknown };
  const ids = { ...(typeof meta.type === "string" ? { type: meta.type } : {}), ...(typeof meta.event_id === "string" ? { event_id: meta.event_id } : {}) };
  const checked = validateUpstream(parsed);
  if (!checked.ok) {
    return record(422, "invalid", { error: { code: "invalid_event", message: "事件不符合 RSP 1.0 回调 Schema" } }, {
      ...ids,
      detail: "事件不符合 RSP 1.0 回调 Schema（规范第 7 节）",
      issues: checked.errors,
    });
  }
  const event = checked.value;
  if (event.order_id !== req.pathOrderId) {
    return record(422, "path_mismatch", { error: { code: "order_mismatch", message: "路径和请求体的 order_id 不一致" } }, {
      ...ids,
      detail: `路径里是 ${req.pathOrderId}，请求体里是 ${event.order_id}。签名不覆盖路径，两者必须一致（规范第 7 节）`,
    });
  }

  const key = `${event.type}:${event.event_id}`;
  if (key in order.seen) {
    const diff = firstDifference(order.seen[key], event);
    if (diff === null) return record(200, "duplicate", { ok: true, duplicate: true }, ids);
    return record(200, "duplicate_conflict", { ok: true, duplicate: true }, {
      ...ids,
      detail: `同一个 event_id 第二次发来的内容和第一次不同（${diff}）。Relay 按 (order_id, type, event_id) 去重，只认第一次，后来的改动会被丢掉；重发必须原样（规范第 7 节）`,
    });
  }
  order.seen[key] = event;

  if (event.type === "order.dispute") return record(200, "ignored", { ok: true, status: order.status }, { ...ids, detail: "验收订单不计费，争议不处理" });

  if (isTerminalStatus(order.status)) {
    if (isEcho(order, event)) return record(409, "echo", { error: { code: "terminal" }, status: order.status }, ids);
    return record(409, "after_terminal", { error: { code: "terminal" }, status: order.status }, {
      ...ids,
      detail: `订单已是终态 ${order.status}${order.terminal ? `（来自${SOURCE[order.terminal.source]}）` : ""}，又收到 ${event.type}。终态之后不能再改状态，Relay 回 409 只记录不生效（规范第 7、12 节）`,
    });
  }

  const rejected = rejectReason(order, event);
  if (rejected) return record(422, "rejected_state", { error: { code: rejected.code }, status: order.status }, { ...ids, detail: rejected.detail });

  applyEvent(order, event);
  return record(200, "accepted", { ok: true, status: order.status }, ids);
}

const SOURCE: Record<NonNullable<TestOrder["terminal"]>["source"], string> = {
  response: "同步响应",
  callback: "回调",
  poll: "task.poll",
  cancel: "task.cancel 的响应",
};

/** 终态后同样的结果再来一次：completed 的 output、failed 的 error 和已有终态一致。 */
function isEcho(order: TestOrder, event: UpstreamEvent): boolean {
  const t = order.terminal;
  if (!t) return false;
  if (event.type === "completed") return t.status === "completed" && firstDifference(t.result, event.output) === null;
  if (event.type === "failed") return t.status === "failed" && firstDifference(t.result, event.error) === null;
  return false;
}

/** 当前状态、订单模式不接受这个事件时的原因（Relay 回 422）。和 core 的状态机同一套规则。 */
function rejectReason(order: TestOrder, event: UpstreamEvent): { code: string; detail: string } | null {
  const multi = order.mode === "async_multi";
  switch (event.type) {
    case "proposal.add":
    case "proposal.withdraw":
      if (!multi) return { code: "mode_mismatch", detail: `动作 ${order.action} 的 mode 是 ${order.mode}，不是 async_multi，不接受 ${event.type}（规范第 7 节）` };
      if (event.type === "proposal.withdraw" && !order.proposals.some((p) => p.proposal_id === event.proposal_id)) {
        return { code: "unknown_proposal", detail: `撤回的方案 ${event.proposal_id} 从没出现过（没有 proposal.add，task.poll 里也没有）` };
      }
      if (event.type === "proposal.withdraw" && order.status === "dispatched") {
        return { code: "invalid_transition", detail: "订单还在已下发，不接受 proposal.withdraw" };
      }
      return null;
    case "completed":
      if (multi && !order.selected) {
        return { code: "selection_required", detail: "多方案订单还没有选定方案（没有回过 selected）就发了 completed。用户没选，不能成交（规范第 7 节）" };
      }
      return null;
    case "cancel_failed":
      if (order.status === "dispatched") return { code: "invalid_transition", detail: "订单还在已下发，不接受 cancel_failed" };
      return null;
    default:
      return null;
  }
}

function applyEvent(order: TestOrder, event: UpstreamEvent): void {
  switch (event.type) {
    case "completed":
      setTerminal(order, "completed", "callback", event.output);
      return;
    case "failed":
      setTerminal(order, "failed", "callback", event.error);
      return;
    case "proposal.add":
      addProposal(order, event.proposal, "callback");
      if (order.status === "dispatched" || (order.status === "accepted" && !order.selected)) order.status = "awaiting_selection";
      return;
    case "proposal.withdraw": {
      const p = order.proposals.find((x) => x.proposal_id === event.proposal_id)!;
      p.withdrawn = true;
      if (order.selected === event.proposal_id) {
        order.selected = null;
        order.status = "awaiting_selection";
      }
      return;
    }
    default:
      return;
  }
}

function addProposal(order: TestOrder, proposal: Proposal, via: TestProposal["via"]): void {
  if (!order.proposals.some((p) => p.proposal_id === proposal.proposal_id)) order.proposals.push({ proposal_id: proposal.proposal_id, withdrawn: false, via });
}

function setTerminal(order: TestOrder, status: TestOrderStatus, source: NonNullable<TestOrder["terminal"]>["source"], result?: unknown): void {
  order.status = status;
  order.terminal = { source, status, ...(result === undefined ? {} : { result }) };
}

// ───────────── 验收这一侧的状态变化（同步响应、task.poll、proposal.select、task.cancel 的结果） ─────────────

/** 本侧推进订单得出的矛盾：比如回调说 completed，task.poll 说 failed。null 表示没有矛盾。 */
export type Conflict = string | null;

/** action.invoke 的同步响应。 */
export function applyInvokeResponse(order: TestOrder, response: { status: string; task_id?: string; output?: unknown; error?: unknown }): Conflict {
  if (response.status === "accepted") {
    order.task_id = response.task_id!;
    if (order.status === "dispatched") order.status = "accepted";
    return null;
  }
  if (response.status === "completed" || response.status === "failed") {
    return settle(order, response.status, "response", response.status === "completed" ? response.output : response.error);
  }
  return null;
}

/** task.poll 的响应：completed、failed 进终态；proposals 补进方案列表，列表里没有的视为已撤回（Relay 同样处理）。 */
export function applyPollResponse(order: TestOrder, response: { status: string; output?: unknown; error?: unknown; proposals?: Proposal[] }): Conflict {
  if (response.status === "completed" || response.status === "failed") {
    return settle(order, response.status, "poll", response.status === "completed" ? response.output : response.error);
  }
  if (response.status === "proposals" && !isTerminalStatus(order.status)) {
    const listed = new Set((response.proposals ?? []).map((p) => p.proposal_id));
    for (const p of response.proposals ?? []) addProposal(order, p, "poll");
    for (const p of order.proposals) if (!listed.has(p.proposal_id)) p.withdrawn = true;
    if (order.selected && !listed.has(order.selected)) order.selected = null;
    if (order.status === "accepted" && !order.selected) order.status = "awaiting_selection";
  }
  return null;
}

/** proposal.select 的响应。 */
export function applySelectResponse(order: TestOrder, proposalId: string, response: { status: string; output?: unknown }): Conflict {
  if (response.status === "selected" || response.status === "completed") {
    if (!isTerminalStatus(order.status)) {
      order.selected = proposalId;
      order.status = "accepted";
    }
    if (response.status === "completed") return settle(order, "completed", "response", response.output);
  }
  return null;
}

/** task.cancel 的响应：cancelled 进终态。 */
export function applyCancelResponse(order: TestOrder, response: { status: string }): Conflict {
  if (response.status !== "cancelled") return null;
  if (order.status === "cancelled") return null;
  if (isTerminalStatus(order.status)) {
    return `task.cancel 回了 cancelled，但订单之前已经是 ${order.status}（来自${SOURCE[order.terminal!.source]}）。已完成或已失败的任务应当回 cancel_failed 或 failed`;
  }
  setTerminal(order, "cancelled", "cancel");
  return null;
}

/** 进终态；已经是终态时比对，结果不同就是矛盾。 */
function settle(order: TestOrder, status: "completed" | "failed", source: NonNullable<TestOrder["terminal"]>["source"], result: unknown): Conflict {
  const t = order.terminal;
  if (!t) {
    setTerminal(order, status, source, result);
    return null;
  }
  if (t.status !== status) return `${SOURCE[source]}说 ${status}，但之前${SOURCE[t.source]}已经是 ${t.status}。同一个任务只能有一个最终结果`;
  const diff = firstDifference(t.result, result);
  if (diff !== null) return `${SOURCE[source]}和之前${SOURCE[t.source]}的 ${status} 结果不同（${diff}）。同一个任务只能有一个最终结果`;
  return null;
}

/** 当前有效（未撤回）的方案。 */
export function activeProposals(order: TestOrder): string[] {
  return order.proposals.filter((p) => !p.withdrawn).map((p) => p.proposal_id);
}
