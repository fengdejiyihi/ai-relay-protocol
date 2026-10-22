import type { AcceptedResponse, CompletedResponse, FailedResponse } from "@dreamcavy/ai-relay-protocol";

export type InvokeResponse = CompletedResponse | FailedResponse | AcceptedResponse;

/** 一个幂等键记下的最终结果。`fingerprint` 是动作名 + 规范化输入的 sha256，用来发现同键不同请求。 */
export interface IdempotencyRecord {
  fingerprint: string;
  response: InvokeResponse;
}

export type BeginResult =
  | { state: "acquired" }
  | { state: "in_progress" }
  | { state: "done"; record: IdempotencyRecord };

/**
 * action.invoke 的幂等存储（RSP 1.0 第 10 节）。默认是进程内存；多实例部署换成 Redis、数据库等共享存储，
 * 实现这三个方法即可。
 *
 * - `begin` 必须是原子的：键不存在时占住它（处理中）并返回 acquired；处理中返回 in_progress；已有结果返回 done。
 * - `finish` 记下最终结果并释放占用。SDK 只对 completed、accepted 和不可重试的 failed 调它。
 * - `abandon` 只释放占用、不记结果：可重试的失败（temporary、rate_limited）或结果未知（处理函数抛异常）。
 */
export interface IdempotencyStore {
  begin(key: string, fingerprint: string): BeginResult | Promise<BeginResult>;
  finish(key: string, record: IdempotencyRecord): void | Promise<void>;
  abandon(key: string): void | Promise<void>;
}

export interface MemoryIdempotencyStoreOptions {
  /** 结果保留多久（秒）。默认 8 天：异步任务最长 7 天，后台核对还可能用同一个键重新下发。 */
  ttlSeconds?: number;
  /** 处理中占用的最长时间（秒），防止处理函数挂死后这个键永远回 temporary。默认 120。 */
  lockSeconds?: number;
  /** 最多记多少个键，超出时先淘汰最早的。默认 100000。 */
  maxEntries?: number;
  now?: () => number;
}

type Entry = { state: "in_progress"; until: number } | { state: "done"; record: IdempotencyRecord; until: number };

/** 进程内存实现。单进程部署够用；进程重启会丢，多实例之间不共享。 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #entries = new Map<string, Entry>();
  readonly #ttlMs: number;
  readonly #lockMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    this.#ttlMs = (options.ttlSeconds ?? 8 * 24 * 3600) * 1000;
    this.#lockMs = (options.lockSeconds ?? 120) * 1000;
    this.#maxEntries = options.maxEntries ?? 100_000;
    this.#now = options.now ?? Date.now;
  }

  begin(key: string): BeginResult {
    const now = this.#now();
    const entry = this.#entries.get(key);
    if (entry && entry.until > now) return entry.state === "done" ? { state: "done", record: entry.record } : { state: "in_progress" };
    this.#set(key, { state: "in_progress", until: now + this.#lockMs });
    return { state: "acquired" };
  }

  finish(key: string, record: IdempotencyRecord): void {
    this.#set(key, { state: "done", record, until: this.#now() + this.#ttlMs });
  }

  abandon(key: string): void {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }

  #set(key: string, entry: Entry): void {
    // Map 按插入顺序遍历：删掉再插，让最近写入的排在最后，淘汰时从头删。
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
  }
}
