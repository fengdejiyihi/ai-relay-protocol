import { randomUUID } from "node:crypto";
import {
  HEADERS,
  type Output,
  type Proposal,
  type RspError,
  RSP_VERSION,
  signBody,
  type UpstreamEvent,
  validateUpstream,
} from "@dreamcavy/ai-relay-protocol";

/** 回调事件里 SDK 能代填的字段：rsp 固定、event_id 自动生成、occurred_at 取当前时间。 */
type Fillable = "rsp" | "event_id" | "occurred_at";
export type CallbackEventInput = UpstreamEvent extends infer E
  ? E extends UpstreamEvent
    ? Omit<E, Fillable> & { event_id?: string; occurred_at?: number }
    : never
  : never;

export interface RelayCallbackClientOptions {
  /** 和验签同一个 secret（轮换期用新的）。 */
  secret: string;
  /** Relay 地址，默认 https://relay.newbeeai.online 。 */
  baseUrl?: string;
  /** 每次请求的超时（毫秒），默认 10000。 */
  timeoutMs?: number;
  /**
   * 5xx、429、超时、连接失败后的重发等待（毫秒）。数组长度就是最多重发几次。
   * 默认 [1000, 4000, 16000, 60000, 300000]：共 6 次，最后一次在约 6 分钟后。
   */
  retryDelaysMs?: readonly number[];
  fetch?: typeof fetch;
  /** 毫秒时间戳，测试用。 */
  now?: () => number;
  /** 测试用，替换退避等待。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface CallbackResult {
  /** HTTP 200：已收下（包括重复事件）。 */
  ok: boolean;
  /**
   * Relay 的 HTTP 状态：200 已收下；409 订单已是终态，事件只记录不生效；
   * 401 验签失败；404 订单不存在；422 事件不被当前订单接受。这些都不会重发。
   */
  status: number;
  body: unknown;
  eventId: string;
  attempts: number;
}

/** 重发次数用完仍是 5xx、超时或连接失败。同一个 event_id 之后再发是安全的。 */
export class RelayCallbackError extends Error {
  readonly eventId: string;
  readonly attempts: number;
  readonly lastStatus: number | undefined;

  constructor(message: string, eventId: string, attempts: number, lastStatus: number | undefined, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RelayCallbackError";
    this.eventId = eventId;
    this.attempts = attempts;
    this.lastStatus = lastStatus;
  }
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 4_000, 16_000, 60_000, 300_000] as const;

/**
 * 供给方回调 Relay（RSP 1.0 第 7 节）：`POST {baseUrl}/v1/callbacks/{order_id}`，用同一个 secret 签名。
 * 自动生成 event_id，5xx、429、超时、连接失败时用同一个 event_id、同一个请求体按退避重发
 * （每次重发重新签名，时间戳保持在 5 分钟窗内）。Relay 按 (order_id, type, event_id) 去重，重发是安全的。
 */
export class RelayCallbackClient {
  readonly #secret: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #retryDelaysMs: readonly number[];
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: RelayCallbackClientOptions) {
    if (!options.secret) throw new Error("RelayCallbackClient: secret 不能为空");
    this.#secret = options.secret;
    this.#baseUrl = (options.baseUrl ?? "https://relay.newbeeai.online").replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** 异步任务完成；多方案在交换联系方式后发。 */
  completed(orderId: string, output: Output, options: EventOptions = {}): Promise<CallbackResult> {
    return this.send({ type: "completed", order_id: orderId, output, ...options });
  }

  /** 异步任务失败。 */
  failed(orderId: string, error: RspError, options: EventOptions = {}): Promise<CallbackResult> {
    return this.send({ type: "failed", order_id: orderId, error, ...options });
  }

  /** 多方案：每来一个方案发一次。 */
  addProposal(orderId: string, proposal: Proposal, options: EventOptions = {}): Promise<CallbackResult> {
    return this.send({ type: "proposal.add", order_id: orderId, proposal, ...options });
  }

  /** 撤回方案。 */
  withdrawProposal(orderId: string, proposalId: string, reason?: string, options: EventOptions = {}): Promise<CallbackResult> {
    return this.send({ type: "proposal.withdraw", order_id: orderId, proposal_id: proposalId, ...(reason !== undefined ? { reason } : {}), ...options });
  }

  /** 对已计费的订单提出争议（计费后 72 小时内）。 */
  dispute(orderId: string, reason: string, options: EventOptions = {}): Promise<CallbackResult> {
    return this.send({ type: "order.dispute", order_id: orderId, reason, ...options });
  }

  /** 收到 task.cancel 但已不可撤回。 */
  cancelFailed(orderId: string, reason?: string, options: EventOptions = {}): Promise<CallbackResult> {
    return this.send({ type: "cancel_failed", order_id: orderId, ...(reason !== undefined ? { reason } : {}), ...options });
  }

  /** 发任意一个上行事件。发之前按协议 Schema 严格校验，不合法直接抛 TypeError，不发请求。 */
  async send(input: CallbackEventInput): Promise<CallbackResult> {
    const event = {
      ...input,
      rsp: RSP_VERSION,
      event_id: input.event_id ?? newEventId(),
      occurred_at: input.occurred_at ?? Math.floor(this.#now() / 1000),
    };
    const checked = validateUpstream(event, { strict: true });
    if (!checked.ok) {
      throw new TypeError(`回调事件不合法：${checked.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
    }
    const body = JSON.stringify(event);
    const url = `${this.#baseUrl}/v1/callbacks/${encodeURIComponent(event.order_id)}`;

    let attempts = 0;
    let lastStatus: number | undefined;
    let lastError: unknown;
    for (;;) {
      attempts += 1;
      let retryAfterMs: number | undefined;
      try {
        const response = await this.#fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            [HEADERS.signature]: signBody(this.#secret, body, Math.floor(this.#now() / 1000)),
          },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        lastStatus = response.status;
        const text = await response.text();
        if (response.status < 500 && response.status !== 429) {
          return { ok: response.status === 200, status: response.status, body: parseJson(text), eventId: event.event_id, attempts };
        }
        lastError = undefined;
        if (response.status === 429) retryAfterMs = retryAfterOf(response.headers.get("retry-after"));
      } catch (error) {
        // 超时或连接失败：Relay 可能已经收下了，同一个 event_id 重发会被去重。
        lastStatus = undefined;
        lastError = error;
      }
      const delay = this.#retryDelaysMs[attempts - 1];
      if (delay === undefined) {
        const what = lastStatus === undefined ? `请求失败（${describe(lastError)}）` : `HTTP ${lastStatus}`;
        throw new RelayCallbackError(`回调 ${event.type} ${event.order_id} 重发 ${attempts} 次仍失败：${what}`, event.event_id, attempts, lastStatus, lastError);
      }
      await this.#sleep(Math.max(delay, retryAfterMs ?? 0));
    }
  }
}

export interface EventOptions {
  /** 自己指定 event_id。业务上「同一件事」重发时传同一个值，Relay 才能去重。 */
  event_id?: string;
  occurred_at?: number;
}

/** evt_ + 32 位十六进制。 */
export function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, "")}`;
}

function retryAfterOf(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
