import { createHash } from "node:crypto";
import {
  type ActionInvokeEnvelope,
  type BindingVerifyEnvelope,
  compileActionInput,
  type DownstreamEnvelope,
  type DownstreamType,
  type EnvelopeUser,
  HEADERS,
  type Manifest,
  type ManifestAction,
  type ProposalSelectEnvelope,
  type ResponseByType,
  RETRYABLE_ERROR_CODES,
  RSP_VERSION,
  type TaskCancelEnvelope,
  type TaskPollEnvelope,
  validateDownstream,
  validateManifest,
  validateResponse,
  verifySignature,
} from "@dreamcavy/ai-relay-protocol";
import { type IdempotencyStore, type InvokeResponse, MemoryIdempotencyStore } from "./idempotency.js";
import { failed, RelayError } from "./responses.js";

type MaybePromise<T> = T | Promise<T>;

/** 处理函数拿到的上下文：信封里除 input 以外的东西。 */
export interface ActionContext {
  orderId: string;
  /** 等于 orderId。处理函数自己调下游时可以拿它当下游的幂等键。 */
  idempotencyKey: string;
  user: EnvelopeUser;
  manifestVersion: number;
  /** Relay 不再等这次结果的时间（unix 秒），可能没有。 */
  deadlineAt?: number;
  /** 清单里这个动作的定义。 */
  action: ManifestAction;
  envelope: ActionInvokeEnvelope;
}

/**
 * 一个动作的处理函数。`input` 已经按清单的 input Schema 校验过。
 * 返回 completed / failed / accepted（用 responses 里的辅助构造），或者 throw RelayError。
 */
export type ActionHandler<I = any> = (input: I, ctx: ActionContext) => MaybePromise<InvokeResponse>;

/** 异步、多方案动作要实现的信封（L2）。不实现的那类信封 SDK 回 not_supported。 */
export interface TaskHandlers {
  poll?: (envelope: TaskPollEnvelope) => MaybePromise<ResponseByType["task.poll"]>;
  cancel?: (envelope: TaskCancelEnvelope) => MaybePromise<ResponseByType["task.cancel"]>;
  select?: (envelope: ProposalSelectEnvelope) => MaybePromise<ResponseByType["proposal.select"]>;
}

/** user_binding=token 的供给方实现 binding.verify。 */
export interface BindingHandlers {
  verify: (envelope: BindingVerifyEnvelope) => MaybePromise<ResponseByType["binding.verify"]>;
}

export interface RelayHandlerOptions {
  /** Relay 后台给的 secret。轮换期内新旧两个都放，新的在前。 */
  secrets: string | readonly string[];
  /** 提交给 Relay 的清单（对象）。创建时校验，动作和处理函数必须一一对应。 */
  manifest: Manifest;
  /** 动作名 → 处理函数。 */
  handlers: Record<string, ActionHandler>;
  tasks?: TaskHandlers;
  binding?: BindingHandlers;
  /** 幂等存储，默认进程内存。多实例部署要换成共享存储。 */
  idempotency?: IdempotencyStore;
  /**
   * 处理函数抛了 RelayError 以外的异常，或者返回了不合协议的响应时调用，用来记日志。
   * 这两种情况 SDK 都回 HTTP 500（结果未知），不缓存。默认 console.error。
   */
  onError?: (error: unknown, envelope: DownstreamEnvelope) => void;
  /** 毫秒时间戳，测试用。 */
  now?: () => number;
}

/** 与 HTTP 框架无关的回复。`body` 已经是 JSON 字符串。 */
export interface RelayReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RelayHandler {
  /**
   * 处理一次 POST /relay。`rawBody` 必须是收到的原始字节（或整段一次解码的字符串），
   * 不能是解析后再序列化的 JSON，否则验签会失败。
   */
  handle(rawBody: Uint8Array | string, signature: string | null | undefined): Promise<RelayReply>;
  readonly manifest: Manifest;
}

/**
 * RSP 1.0 供给方端点的全部协议逻辑：
 * 验签（原始字节、5 分钟时间窗、轮换期多个 secret）→ 宽松解析信封 → 按 type 分发。
 * `ping` 自动应答；不认识的 type 回 not_supported；`action.invoke` 校验输入、按幂等键去重后交给处理函数。
 */
export function createRelayHandler(options: RelayHandlerOptions): RelayHandler {
  const secrets = (typeof options.secrets === "string" ? [options.secrets] : [...options.secrets]).filter(Boolean);
  if (!secrets.length) throw new Error("createRelayHandler: secrets 不能为空");
  const checked = validateManifest(options.manifest);
  if (!checked.ok) {
    const lines = checked.errors.map((e) => `  ${e.rule} ${e.path} ${e.message}`).join("\n");
    throw new Error(`createRelayHandler: 清单不合法\n${lines}`);
  }
  const manifest = options.manifest;
  const actions = new Map(
    manifest.actions.map((action) => {
      const handler = options.handlers[action.name];
      if (!handler) throw new Error(`createRelayHandler: 清单里的动作 ${action.name} 没有处理函数`);
      return [action.name, { action, handler, validate: compileActionInput(action.input) }] as const;
    }),
  );
  for (const name of Object.keys(options.handlers)) {
    if (!actions.has(name)) throw new Error(`createRelayHandler: 处理函数 ${name} 在清单里没有对应的动作`);
  }
  const store = options.idempotency ?? new MemoryIdempotencyStore(options.now ? { now: options.now } : {});
  const now = options.now ?? Date.now;
  const onError = options.onError ?? ((error: unknown) => console.error("[ai-relay-sdk]", error));

  async function invoke(envelope: ActionInvokeEnvelope): Promise<InvokeResponse> {
    const entry = actions.get(envelope.action);
    if (!entry) return failed("invalid_input", `没有动作 ${envelope.action}`);
    const input = entry.validate(envelope.input);
    if (!input.ok) return failed("invalid_input", "输入不符合动作的 input Schema", { details: input.errors });

    const key = envelope.idempotency_key;
    const fingerprint = fingerprintOf(envelope.action, input.value);
    const begun = await store.begin(key, fingerprint);
    if (begun.state === "in_progress") return failed("temporary", "同一个 idempotency_key 的请求还在处理中");
    if (begun.state === "done") {
      if (begun.record.fingerprint === fingerprint) return begun.record.response;
      return failed("invalid_input", "这个 idempotency_key 已用于另一笔不同的请求");
    }
    // 先查幂等再判 deadline：已有结果的键过了 deadline 再重放，仍返回第一次的结果。
    if (envelope.deadline_at !== undefined && envelope.deadline_at * 1000 < now()) {
      await store.abandon(key);
      return failed("temporary", "已超过 deadline_at，没有执行");
    }

    let response: InvokeResponse;
    try {
      response = await runHandler(() => entry.handler(input.value, contextOf(envelope, entry.action)));
      assertValid("action.invoke", response);
    } catch (error) {
      await store.abandon(key);
      throw error;
    }
    if (response.status === "failed" && (RETRYABLE_ERROR_CODES as readonly string[]).includes(response.error.code)) {
      await store.abandon(key);
    } else {
      await store.finish(key, { fingerprint, response });
    }
    return response;
  }

  async function dispatch(envelope: DownstreamEnvelope): Promise<unknown> {
    switch (envelope.type) {
      case "ping":
        return { status: "ok", challenge: envelope.challenge, rsp: RSP_VERSION };
      case "action.invoke":
        return invoke(envelope);
      case "task.poll":
        return other(envelope, options.tasks?.poll);
      case "task.cancel":
        return other(envelope, options.tasks?.cancel);
      case "proposal.select":
        return other(envelope, options.tasks?.select);
      case "binding.verify":
        return other(envelope, options.binding?.verify);
    }
  }

  async function other<E extends DownstreamEnvelope>(envelope: E, fn: ((e: E) => MaybePromise<unknown>) | undefined): Promise<unknown> {
    if (!fn) return failed("not_supported", `这个供给方不处理 ${envelope.type}`);
    const response = await runHandler(() => fn(envelope));
    assertValid(envelope.type, response);
    return response;
  }

  return {
    manifest,
    async handle(rawBody, signature) {
      const verified = verifySignature({ secrets, header: signature, body: rawBody, now: Math.floor(now() / 1000) });
      if (!verified.ok) return reply(401, failed("unauthorized", `签名校验失败：${verified.reason}`));

      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"));
      } catch {
        return reply(200, failed("invalid_input", "请求体不是 JSON"));
      }
      // 宽松校验：忽略不认识的字段、接受任何 1.x（RSP 1.0 第 14 节）。
      const envelope = validateDownstream(parsed);
      if (!envelope.ok) {
        const unknownType = envelope.errors.find((e) => e.rule === "D-TYPE-1");
        if (unknownType) return reply(200, failed("not_supported", unknownType.message));
        return reply(200, failed("invalid_input", "不是合法的 RSP 1.0 信封", { details: envelope.errors }));
      }

      try {
        return reply(200, await dispatch(envelope.value));
      } catch (error) {
        onError(error, envelope.value);
        // 结果未知：Relay 不重试、不扣费，订单进待核对（第 2 节）。
        return reply(500, failed("temporary", "供给方内部错误，结果未知"));
      }
    },
  };
}

/** 处理函数 throw RelayError 等同于 return 它对应的 failed。 */
async function runHandler<T>(fn: () => MaybePromise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RelayError) return error.toResponse() as T;
    throw error;
  }
}

function assertValid(type: DownstreamType, response: unknown): void {
  const result = validateResponse(type, response, { strict: true });
  if (!result.ok) {
    const lines = result.errors.map((e) => `${e.path} ${e.message}`).join("; ");
    throw new Error(`处理函数对 ${type} 返回了不合协议的响应：${lines}`);
  }
}

function contextOf(envelope: ActionInvokeEnvelope, action: ManifestAction): ActionContext {
  return {
    orderId: envelope.order_id,
    idempotencyKey: envelope.idempotency_key,
    user: envelope.user,
    manifestVersion: envelope.manifest_version,
    ...(envelope.deadline_at !== undefined ? { deadlineAt: envelope.deadline_at } : {}),
    action,
    envelope,
  };
}

function reply(status: number, body: unknown): RelayReply {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", [HEADERS.rspVersion]: RSP_VERSION },
    body: JSON.stringify(body),
  };
}

/** 动作名 + 规范化（键排序）后的输入的 sha256，用来判断同一个键是不是同一笔请求。 */
export function fingerprintOf(action: string, input: unknown): string {
  return createHash("sha256").update(`${action}\n${canonicalJson(input)}`).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
