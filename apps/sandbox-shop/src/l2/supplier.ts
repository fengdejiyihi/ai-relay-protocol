import {
  type AcceptedResponse,
  type ActionInvokeEnvelope,
  type CancelFailedResponse,
  type CancelledResponse,
  type CompletedResponse,
  compileActionInput,
  type FailedResponse,
  type Manifest,
  type PendingResponse,
  type ProposalsResponse,
  RETRYABLE_ERROR_CODES,
  RSP_VERSION,
  type SelectedResponse,
  type TaskCancelEnvelope,
} from "@dreamcavy/ai-relay-protocol";
import { failed } from "../actions.js";
import { openEnvelope } from "../envelope.js";
import { hashInput, type RelayReply } from "../relay.js";
import type { Outbox } from "./outbox.js";
import { type Account, FAULTS, type Fault, type Job, type L2Store, type SupplierKey, type Task } from "./store.js";

export type InvokeResponse = CompletedResponse | FailedResponse | AcceptedResponse;
export type PollResponse = CompletedResponse | FailedResponse | PendingResponse | ProposalsResponse;
export type CancelResponse = CancelledResponse | CancelFailedResponse | FailedResponse;
export type SelectResponse = SelectedResponse | CompletedResponse | FailedResponse;

export interface L2Settings {
  /** 发文：接单后多久「发出」并回调 completed。 */
  publishDelayMs: number;
  /** 撮合：接单后每隔多久来一个方案。 */
  proposalIntervalMs: number;
  /** 撮合：选定后多久交换联系方式并回调 completed。 */
  selectDelayMs: number;
  /** 对所有单子生效的故障开关（另可在标题里写 #drop 等只影响一单）。 */
  faults: Fault[];
}

export interface L2Context {
  store: L2Store;
  outbox: Outbox;
  settings: L2Settings;
  /** 这个供给方网页的根地址，比如 https://sandbox.example.com/match。 */
  baseUrl: string;
  now: () => number;
}

export interface InvokeContext extends L2Context {
  envelope: ActionInvokeEnvelope;
  account: Account;
}

/** 一个 L2 供给方要实现的部分。验签、信封校验、绑定、幂等由 createL2Handler 统一做。 */
export interface SupplierImpl {
  key: SupplierKey;
  manifest: Manifest;
  actions: Record<string, (input: Record<string, unknown>, ctx: InvokeContext) => InvokeResponse>;
  poll(task: Task, ctx: L2Context): PollResponse;
  cancel(task: Task, reason: TaskCancelEnvelope["reason"], ctx: L2Context): CancelResponse;
  select?(task: Task, proposalId: string, ctx: L2Context): SelectResponse;
  runJob(job: Job, task: Task, ctx: L2Context): void;
}

export function createL2Handler(
  impl: SupplierImpl,
  ctx: L2Context,
  secrets: readonly string[],
): (rawBody: Uint8Array | string, signature: string | undefined) => RelayReply {
  const actions = new Map(
    impl.manifest.actions.map((action) => {
      const handler = impl.actions[action.name];
      if (!handler) throw new Error(`Manifest 里的动作 ${action.name} 没有实现`);
      return [action.name, { action, handler, validate: compileActionInput(action.input) }] as const;
    }),
  );
  const { store, now } = ctx;

  function invoke(envelope: ActionInvokeEnvelope): InvokeResponse {
    const entry = actions.get(envelope.action);
    if (!entry) return failed("invalid_input", `没有动作 ${envelope.action}`);
    if (envelope.deadline_at !== undefined && envelope.deadline_at * 1000 < now()) {
      return failed("temporary", "已超过 deadline_at，Relay 不再等待这次结果，未做任何处理");
    }
    const checked = entry.validate(envelope.input);
    if (!checked.ok) return failed("invalid_input", "输入不符合动作的 input Schema", checked.errors);

    const run = (): InvokeResponse => {
      // user_binding=token：没绑、不是本家账号、账号已作废都回 unauthorized，Relay 据此把绑定标失效（RSP 1.0 第 11 节）。
      const ref = envelope.user.supplier_user_ref;
      const account = ref ? store.account(impl.key, ref) : undefined;
      if (!account) return failed("unauthorized", ref ? "没有这个账号，请重新绑定" : "需要先绑定账号");
      if (account.status !== "active") return failed("unauthorized", "账号绑定已失效，请重新绑定");
      return entry.handler(checked.value, { ...ctx, envelope, account });
    };
    if (entry.action.readonly) return run();

    // 写动作按 idempotency_key 记下最终结果（只记 completed、accepted、不可重试的 failed，RSP 1.0 第 10 节）。
    const key = envelope.idempotency_key;
    const inputHash = hashInput(envelope.action, checked.value);
    return store.transaction(() => {
      const stored = store.storedResponse(impl.key, key);
      if (stored) {
        if (stored.action === envelope.action && stored.input_hash === inputHash) return JSON.parse(stored.response) as InvokeResponse;
        return failed("invalid_input", "这个 idempotency_key 已用于另一笔不同的请求");
      }
      const response = run();
      const retryable = response.status === "failed" && (RETRYABLE_ERROR_CODES as readonly string[]).includes(response.error.code);
      if (!retryable) store.saveResponse(impl.key, key, { action: envelope.action, input_hash: inputHash, response: JSON.stringify(response) });
      return response;
    });
  }

  /** task.* / proposal.select 要找到本供给方、本订单的任务；task_id 和 order_id 对不上一律当作没有。 */
  function findTask(orderId: string, taskId: string): Task | undefined {
    const task = store.task(taskId, impl.key);
    return task && task.order_id === orderId ? task : undefined;
  }

  return (rawBody, signature) => {
    const opened = openEnvelope(rawBody, signature, secrets, now());
    if (!opened.ok) return opened.reply;
    const value = opened.envelope;
    const reply = (body: unknown): RelayReply => ({ httpStatus: 200, body });
    switch (value.type) {
      case "ping":
        return reply({ status: "ok", challenge: value.challenge, rsp: RSP_VERSION });
      case "action.invoke":
        return reply(invoke(value));
      case "binding.verify": {
        const result = store.verifyBindingCode(impl.key, value.code, value.relay_uid);
        if (result.ok) {
          return reply({ status: "bound", supplier_user_ref: result.account.ref, display_name: result.account.display_name });
        }
        const message = { unknown: "绑定码无效", used: "绑定码已使用", expired: "绑定码已过期", revoked: "这个账号已作废" }[result.reason];
        return reply(failed("invalid_input", `${message}，请在供给方页面重新生成`, { reason: result.reason }));
      }
      case "task.poll": {
        const task = findTask(value.order_id, value.task_id);
        return reply(task ? store.transaction(() => impl.poll(task, ctx)) : failed("invalid_input", "没有这个任务"));
      }
      case "task.cancel": {
        const task = findTask(value.order_id, value.task_id);
        return reply(task ? store.transaction(() => impl.cancel(task, value.reason, ctx)) : failed("invalid_input", "没有这个任务"));
      }
      case "proposal.select": {
        if (!impl.select) return reply(failed("not_supported", "这家供给方没有多方案动作"));
        const task = findTask(value.order_id, value.task_id);
        return reply(task ? store.transaction(() => impl.select!(task, value.proposal_id, ctx)) : failed("invalid_input", "没有这个任务"));
      }
      default:
        return reply(failed("not_supported", `不处理 ${(value as { type: string }).type}`));
    }
  };
}

/** 全局开关加上标题里的 #标记。#withdraw-selected 要先于 #withdraw 匹配。 */
export function faultsFor(text: string, defaults: readonly Fault[]): Fault[] {
  const found = new Set<Fault>(defaults);
  for (const m of text.matchAll(/#(withdraw-selected|[a-z]+)/g)) {
    if ((FAULTS as readonly string[]).includes(m[1]!)) found.add(m[1] as Fault);
  }
  return [...found];
}
