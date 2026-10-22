import { HEADERS, RSP_VERSION, signBody, type UpstreamEvent } from "@dreamcavy/ai-relay-protocol";
import { type Fault, type L2Store, newId, type OutboxRow, type SupplierKey } from "./store.js";

/** 回调遇到 5xx、超时或连不上时的重发间隔（秒）。用完还没成功就放弃，Relay 会靠 task.poll 补拉。 */
export const CALLBACK_BACKOFF_SECONDS = [1, 4, 16, 60, 300, 900] as const;
/** 单次回调请求的超时。 */
const CALLBACK_TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>;

/** 分布在 UpstreamEvent 各个成员上的字段都保留下来（Omit 作用在联合上会丢字段）。 */
type EventBody = UpstreamEvent extends infer E ? (E extends UpstreamEvent ? Omit<E, "rsp" | "event_id" | "occurred_at"> : never) : never;

export interface OutboxOptions {
  store: L2Store;
  /** Relay 的根地址，回调发到 {callbackBase}/v1/callbacks/{order_id}。 */
  callbackBase: string;
  /** 每个供给方用自己的 secret 签名，取第一个（新的）。 */
  secrets: Record<SupplierKey, readonly string[]>;
  /** 「迟到回调」推迟多久发出。 */
  lateMs: number;
  now: () => number;
  fetch?: FetchLike;
  log?: (message: string) => void;
}

/**
 * 回调发件箱：事件先在业务事务里落库，再由 tick 发出。
 * 2xx 算送达；4xx（含 409 终态、422 状态不接受）是 Relay 明确的答复，记下不再重发；
 * 5xx、超时、连不上用同一个 event_id 按 CALLBACK_BACKOFF_SECONDS 重发（RSP 1.0 第 7 节）。
 */
export class Outbox {
  private readonly fetch: FetchLike;

  constructor(private readonly options: OutboxOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** 生成事件放进发件箱，返回 event_id。drop / late / dup 在这里生效。 */
  enqueue(supplier: SupplierKey, event: EventBody, faults: readonly Fault[]): string {
    const now = this.options.now();
    const full = { ...event, rsp: RSP_VERSION, event_id: newId("evt_"), occurred_at: Math.floor(now / 1000) } as UpstreamEvent;
    this.options.store.enqueueEvent({
      event_id: full.event_id,
      supplier,
      order_id: full.order_id,
      type: full.type,
      body: JSON.stringify(full),
      state: faults.includes("drop") ? "dropped" : "pending",
      copies: faults.includes("dup") ? 2 : 1,
      next_at: now + (faults.includes("late") ? this.options.lateMs : 0),
    });
    return full.event_id;
  }

  /** 发出所有到点的回调。签名时间戳用发送时刻，重发时重新签。 */
  async deliverDue(): Promise<void> {
    for (const row of this.options.store.dueEvents()) await this.deliver(row);
  }

  private async deliver(row: OutboxRow): Promise<void> {
    const { store, callbackBase, secrets, now } = this.options;
    const url = `${callbackBase}/v1/callbacks/${row.order_id}`;
    let status: number | null = null;
    try {
      const res = await this.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          [HEADERS.signature]: signBody(secrets[row.supplier][0]!, row.body, Math.floor(now() / 1000)),
        },
        body: row.body,
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      status = res.status;
    } catch (error) {
      this.options.log?.(`回调 ${row.event_id} ${row.type} → ${url} 失败：${(error as Error).message}`);
    }

    if (status !== null && status < 500) {
      if (status >= 200 && status < 300 && row.copies > 1) {
        // 「重复回调」：同一个 event_id 原样再发一次。
        store.updateEvent(row.event_id, { copies: row.copies - 1, last_status: status, next_at: now() });
        return;
      }
      if (status >= 300) this.options.log?.(`回调 ${row.event_id} ${row.type} 被 Relay 拒绝：HTTP ${status}`);
      store.updateEvent(row.event_id, { state: status < 300 ? "sent" : "rejected", last_status: status, attempts: row.attempts + 1 });
      return;
    }
    const attempts = row.attempts + 1;
    const delay = CALLBACK_BACKOFF_SECONDS[attempts - 1];
    store.updateEvent(row.event_id, {
      attempts,
      last_status: status,
      ...(delay === undefined ? { state: "gave_up" } : { next_at: now() + delay * 1000 }),
    });
  }
}
