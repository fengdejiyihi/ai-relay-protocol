import { createHash } from "node:crypto";
import {
  type ActionInvokeEnvelope,
  compileActionInput,
  type Manifest,
  RETRYABLE_ERROR_CODES,
  RSP_VERSION,
} from "@dreamcavy/ai-relay-protocol";
import { ACTIONS, type ActionResponse, failed } from "./actions.js";
import { openEnvelope } from "./envelope.js";
import type { ShopStore } from "./store.js";

export interface RelayHandlerOptions {
  manifest: Manifest;
  store: ShopStore;
  /** Relay 后台给的 secret。轮换期内新旧两个都放，新的在前。 */
  secrets: readonly string[];
  publicBaseUrl: string;
  now?: () => number;
}

export interface RelayReply {
  httpStatus: number;
  body: unknown;
}

/**
 * POST /relay 的全部逻辑，与 HTTP 框架无关：给原始请求体和签名头，返回状态码和响应体。
 * 换成 Express、Koa、Fastify 时只需把这个函数接到路由上。请求体最好传收到的原始字节（Buffer）。
 *
 * 按 RSP 1.0 第 2 节：验签失败回 401，其余协议结果（包括业务失败、信封不合法）一律 200 + 响应体。
 */
export function createRelayHandler(
  options: RelayHandlerOptions,
): (rawBody: Uint8Array | string, signature: string | undefined) => RelayReply {
  const now = options.now ?? Date.now;
  const actions = new Map(
    options.manifest.actions.map((action) => {
      const handler = ACTIONS[action.name];
      if (!handler) throw new Error(`Manifest 里的动作 ${action.name} 没有实现`);
      return [action.name, { action, handler, validate: compileActionInput(action.input) }] as const;
    }),
  );

  function invoke(envelope: ActionInvokeEnvelope): ActionResponse {
    const entry = actions.get(envelope.action);
    if (!entry) return failed("invalid_input", `没有动作 ${envelope.action}`);
    if (envelope.deadline_at !== undefined && envelope.deadline_at * 1000 < now()) {
      return failed("temporary", "已超过 deadline_at，Relay 不再等待这次结果，未做任何处理");
    }
    const checked = entry.validate(envelope.input);
    if (!checked.ok) return failed("invalid_input", "输入不符合动作的 input Schema", checked.errors);

    const ctx = { envelope, store: options.store, publicBaseUrl: options.publicBaseUrl, now };
    // 只读动作重放没有副作用，不必记；写动作按 idempotency_key 记下最终结果。
    if (entry.action.readonly) return entry.handler(checked.value, ctx);

    const key = envelope.idempotency_key;
    const inputHash = hashInput(envelope.action, checked.value);
    return options.store.transaction(() => {
      const stored = options.store.storedResponse(key);
      if (stored) {
        if (stored.action === envelope.action && stored.input_hash === inputHash) return JSON.parse(stored.response) as ActionResponse;
        return failed("invalid_input", "这个 idempotency_key 已用于另一笔不同的请求");
      }
      const response = entry.handler(checked.value, ctx);
      // 可重试的失败不记：Relay 用同一个 key 重试时应当真的再试一次。
      const retryable =
        response.status === "failed" && (RETRYABLE_ERROR_CODES as readonly string[]).includes(response.error.code);
      if (!retryable) {
        options.store.saveResponse(key, { action: envelope.action, input_hash: inputHash, response: JSON.stringify(response) });
      }
      return response;
    });
  }

  return (rawBody, signature) => {
    const opened = openEnvelope(rawBody, signature, options.secrets, now());
    if (!opened.ok) return opened.reply;
    const value = opened.envelope;
    switch (value.type) {
      case "ping":
        return { httpStatus: 200, body: { status: "ok", challenge: value.challenge, rsp: RSP_VERSION } };
      case "action.invoke":
        return { httpStatus: 200, body: invoke(value) };
      default:
        // 沙箱只有同步动作、不需要账号绑定，task.* / proposal.select / binding.verify 都用不到。
        return { httpStatus: 200, body: failed("not_supported", `沙箱商家不处理 ${value.type}`) };
    }
  };
}

/** 动作名 + 规范化（键排序）后的输入的 sha256，用来判断同一个 key 是不是同一笔请求。 */
export function hashInput(action: string, input: unknown): string {
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
