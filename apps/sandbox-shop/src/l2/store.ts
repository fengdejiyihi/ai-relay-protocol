import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Output, RspError } from "@dreamcavy/ai-relay-protocol";

/** 同一个服务上的两个 L2 供给方，各有各的账号、任务和 secret。 */
export type SupplierKey = "publisher" | "match";

/**
 * 任务状态（供给方自己的，不是 Relay 的订单状态）：
 * - 发文：queued → published | failed | cancelled
 * - 撮合：open（收方案、等用户选）→ selected（交换联系方式中）→ completed；open → cancelled
 *   被选的方案撤回时 selected → open。
 */
export type TaskState = "queued" | "published" | "failed" | "cancelled" | "open" | "selected" | "completed";

/** 任务不会再变的状态，过了保留期可以清掉。 */
const TERMINAL_TASK_STATES: readonly TaskState[] = ["published", "failed", "cancelled", "completed"];

/** 沙箱故障开关，见 README「故障开关」。 */
export const FAULTS = ["drop", "late", "dup", "fail", "withdraw", "withdraw-selected"] as const;
export type Fault = (typeof FAULTS)[number];

export interface Account {
  supplier: SupplierKey;
  ref: string;
  display_name: string;
  status: "active" | "revoked";
}

export interface Task {
  task_id: string;
  supplier: SupplierKey;
  order_id: string;
  account_ref: string;
  action: string;
  input: Record<string, unknown>;
  state: TaskState;
  faults: Fault[];
  /** completed 的 output 或 failed 的 error。 */
  result: { output: Output } | { error: RspError } | null;
  selected_proposal: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProposalRow {
  proposal_id: string;
  task_id: string;
  seq: number;
  vendor: string;
  title: string;
  price_cents: number;
  eta_days: number;
  contact: string;
  status: "active" | "selected" | "withdrawn";
}

export type JobKind = "publish" | "proposal" | "complete" | "withdraw";

export interface Job {
  id: number;
  task_id: string;
  kind: JobKind;
  arg: number;
  due_at: number;
}

export type OutboxState = "pending" | "sent" | "dropped" | "rejected" | "gave_up";

export interface OutboxRow {
  event_id: string;
  supplier: SupplierKey;
  order_id: string;
  type: string;
  body: string;
  state: OutboxState;
  attempts: number;
  copies: number;
  next_at: number;
  last_status: number | null;
  created_at: number;
}

export type VerifyResult =
  | { ok: true; account: Account }
  | { ok: false; reason: "unknown" | "used" | "expired" | "revoked" };

/** 绑定码有效期（RSP 1.0 第 11 节：一次性、10 分钟内有效）。 */
export const BINDING_CODE_TTL_MS = 10 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS l2_accounts (
  ref TEXT PRIMARY KEY,
  supplier TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS l2_binding_codes (
  supplier TEXT NOT NULL,
  code TEXT NOT NULL,
  ref TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER,
  PRIMARY KEY (supplier, code)
);
CREATE TABLE IF NOT EXISTS l2_idempotency (
  supplier TEXT NOT NULL,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (supplier, key)
);
CREATE TABLE IF NOT EXISTS l2_tasks (
  task_id TEXT PRIMARY KEY,
  supplier TEXT NOT NULL,
  order_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  input TEXT NOT NULL,
  state TEXT NOT NULL,
  faults TEXT NOT NULL,
  result TEXT,
  selected_proposal TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS l2_proposals (
  proposal_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  vendor TEXT NOT NULL,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  eta_days INTEGER NOT NULL,
  contact TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE (task_id, seq)
);
CREATE TABLE IF NOT EXISTS l2_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  arg INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS l2_jobs_due ON l2_jobs (done, due_at);
CREATE TABLE IF NOT EXISTS l2_outbox (
  event_id TEXT PRIMARY KEY,
  supplier TEXT NOT NULL,
  order_id TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  copies INTEGER NOT NULL DEFAULT 1,
  next_at INTEGER NOT NULL,
  last_status INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS l2_outbox_due ON l2_outbox (state, next_at);
`;

/** 已结束的任务、发件箱和幂等记录保留多久。沙箱只是演示，过期就清。 */
const RETENTION_MS = 8 * 24 * 3600 * 1000;

/**
 * L2 供给方的数据。和门店数据可以放同一个 SQLite 文件（表名带 l2_ 前缀），单独一个连接。
 * 任务的定时动作（发出文章、来方案、交换联系方式）和回调都落库，进程重启后接着跑。
 */
export class L2Store {
  private readonly db: DatabaseSync;
  private inTransaction = false;

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ───────────── 账号与绑定码 ─────────────

  /** 新建一个供给方账号（沙箱没有登录，填个称呼就算注册）并生成一次性绑定码。 */
  issueBindingCode(supplier: SupplierKey, displayName: string, ref?: string): { code: string; supplier_user_ref: string; expires_at: number } {
    return this.transaction(() => {
      let accountRef = ref;
      if (accountRef === undefined) {
        accountRef = newId("acct_");
        this.db
          .prepare("INSERT INTO l2_accounts (ref, supplier, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)")
          .run(accountRef, supplier, displayName, this.now());
      } else if (!this.account(supplier, accountRef)) {
        throw new Error(`没有账号 ${accountRef}`);
      }
      const code = newCode();
      const expiresAt = this.now() + BINDING_CODE_TTL_MS;
      this.db.prepare("INSERT INTO l2_binding_codes (supplier, code, ref, expires_at) VALUES (?, ?, ?, ?)").run(supplier, code, accountRef, expiresAt);
      return { code, supplier_user_ref: accountRef, expires_at: expiresAt };
    });
  }

  /** binding.verify：码有效就标为已用。同一个 relay_uid 重发同一个码，返回同一个账号（幂等）。 */
  verifyBindingCode(supplier: SupplierKey, code: string, relayUid: string): VerifyResult {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT ref, expires_at, used_by FROM l2_binding_codes WHERE supplier = ? AND code = ?")
        .get(supplier, code.trim().toUpperCase()) as { ref: string; expires_at: number; used_by: string | null } | undefined;
      if (!row) return { ok: false, reason: "unknown" };
      if (row.used_by !== null && row.used_by !== relayUid) return { ok: false, reason: "used" };
      if (row.used_by === null && row.expires_at <= this.now()) return { ok: false, reason: "expired" };
      const account = this.account(supplier, row.ref);
      if (!account || account.status !== "active") return { ok: false, reason: "revoked" };
      if (row.used_by === null) {
        this.db
          .prepare("UPDATE l2_binding_codes SET used_by = ?, used_at = ? WHERE supplier = ? AND code = ?")
          .run(relayUid, this.now(), supplier, code.trim().toUpperCase());
      }
      return { ok: true, account };
    });
  }

  account(supplier: SupplierKey, ref: string): Account | undefined {
    return this.db.prepare("SELECT supplier, ref, display_name, status FROM l2_accounts WHERE supplier = ? AND ref = ?").get(supplier, ref) as
      | Account
      | undefined;
  }

  /** 作废账号：之后带这个 supplier_user_ref 的 action.invoke 回 unauthorized，Relay 据此把绑定标失效。 */
  revokeAccount(supplier: SupplierKey, ref: string): boolean {
    const r = this.db.prepare("UPDATE l2_accounts SET status = 'revoked' WHERE supplier = ? AND ref = ? AND status = 'active'").run(supplier, ref);
    return Number(r.changes) > 0;
  }

  // ───────────── 幂等 ─────────────

  storedResponse(supplier: SupplierKey, key: string): { action: string; input_hash: string; response: string } | undefined {
    return this.db.prepare("SELECT action, input_hash, response FROM l2_idempotency WHERE supplier = ? AND key = ?").get(supplier, key) as
      | { action: string; input_hash: string; response: string }
      | undefined;
  }

  saveResponse(supplier: SupplierKey, key: string, value: { action: string; input_hash: string; response: string }): void {
    this.db
      .prepare("INSERT OR IGNORE INTO l2_idempotency (supplier, key, action, input_hash, response, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(supplier, key, value.action, value.input_hash, value.response, this.now());
  }

  // ───────────── 任务 ─────────────

  createTask(t: { supplier: SupplierKey; order_id: string; account_ref: string; action: string; input: Record<string, unknown>; state: TaskState; faults: Fault[] }): Task {
    const taskId = newId("t_");
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO l2_tasks (task_id, supplier, order_id, account_ref, action, input, state, faults, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(taskId, t.supplier, t.order_id, t.account_ref, t.action, JSON.stringify(t.input), t.state, JSON.stringify(t.faults), now, now);
    return this.task(taskId)!;
  }

  task(taskId: string, supplier?: SupplierKey): Task | undefined {
    const row = this.db.prepare("SELECT * FROM l2_tasks WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!row || (supplier !== undefined && row.supplier !== supplier)) return undefined;
    return {
      ...(row as unknown as Task),
      input: JSON.parse(row.input as string) as Record<string, unknown>,
      faults: JSON.parse(row.faults as string) as Fault[],
      result: row.result === null ? null : (JSON.parse(row.result as string) as Task["result"]),
    };
  }

  updateTask(taskId: string, patch: Partial<Pick<Task, "state" | "result" | "selected_proposal" | "faults">>): Task {
    const sets: string[] = ["updated_at = ?"];
    const params: (string | number | null)[] = [this.now()];
    if (patch.state !== undefined) (sets.push("state = ?"), params.push(patch.state));
    if (patch.result !== undefined) (sets.push("result = ?"), params.push(patch.result === null ? null : JSON.stringify(patch.result)));
    if (patch.selected_proposal !== undefined) (sets.push("selected_proposal = ?"), params.push(patch.selected_proposal));
    if (patch.faults !== undefined) (sets.push("faults = ?"), params.push(JSON.stringify(patch.faults)));
    this.db.prepare(`UPDATE l2_tasks SET ${sets.join(", ")} WHERE task_id = ?`).run(...params, taskId);
    return this.task(taskId)!;
  }

  // ───────────── 方案 ─────────────

  addProposal(p: Omit<ProposalRow, "proposal_id" | "status">): ProposalRow {
    const proposalId = newId("p_");
    this.db
      .prepare(
        "INSERT INTO l2_proposals (proposal_id, task_id, seq, vendor, title, price_cents, eta_days, contact, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')",
      )
      .run(proposalId, p.task_id, p.seq, p.vendor, p.title, p.price_cents, p.eta_days, p.contact);
    return this.proposal(proposalId)!;
  }

  proposal(proposalId: string): ProposalRow | undefined {
    return this.db.prepare("SELECT * FROM l2_proposals WHERE proposal_id = ?").get(proposalId) as ProposalRow | undefined;
  }

  proposalBySeq(taskId: string, seq: number): ProposalRow | undefined {
    return this.db.prepare("SELECT * FROM l2_proposals WHERE task_id = ? AND seq = ?").get(taskId, seq) as ProposalRow | undefined;
  }

  proposals(taskId: string): ProposalRow[] {
    return this.db.prepare("SELECT * FROM l2_proposals WHERE task_id = ? ORDER BY seq").all(taskId) as unknown as ProposalRow[];
  }

  setProposalStatus(proposalId: string, status: ProposalRow["status"]): void {
    this.db.prepare("UPDATE l2_proposals SET status = ? WHERE proposal_id = ?").run(status, proposalId);
  }

  // ───────────── 定时动作 ─────────────

  schedule(taskId: string, kind: JobKind, dueAt: number, arg = 0): void {
    this.db.prepare("INSERT INTO l2_jobs (task_id, kind, arg, due_at) VALUES (?, ?, ?, ?)").run(taskId, kind, arg, dueAt);
  }

  dueJobs(limit = 100): Job[] {
    return this.db
      .prepare("SELECT id, task_id, kind, arg, due_at FROM l2_jobs WHERE done = 0 AND due_at <= ? ORDER BY due_at, id LIMIT ?")
      .all(this.now(), limit) as unknown as Job[];
  }

  finishJob(id: number): void {
    this.db.prepare("UPDATE l2_jobs SET done = 1 WHERE id = ?").run(id);
  }

  /** 最早一个还没到点的定时动作或回调，测试用来快进时钟。 */
  nextWakeAt(): number | null {
    const job = this.db.prepare("SELECT MIN(due_at) AS at FROM l2_jobs WHERE done = 0").get() as { at: number | null };
    const out = this.db.prepare("SELECT MIN(next_at) AS at FROM l2_outbox WHERE state = 'pending'").get() as { at: number | null };
    const all = [job.at, out.at].filter((v): v is number => v !== null);
    return all.length ? Math.min(...all) : null;
  }

  // ───────────── 回调发件箱 ─────────────

  enqueueEvent(row: Omit<OutboxRow, "attempts" | "last_status" | "created_at">): void {
    this.db
      .prepare("INSERT INTO l2_outbox (event_id, supplier, order_id, type, body, state, copies, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.event_id, row.supplier, row.order_id, row.type, row.body, row.state, row.copies, row.next_at, this.now());
  }

  dueEvents(limit = 50): OutboxRow[] {
    return this.db
      .prepare("SELECT * FROM l2_outbox WHERE state = 'pending' AND next_at <= ? ORDER BY next_at, created_at LIMIT ?")
      .all(this.now(), limit) as unknown as OutboxRow[];
  }

  updateEvent(eventId: string, patch: Partial<Pick<OutboxRow, "state" | "attempts" | "copies" | "next_at" | "last_status">>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    this.db
      .prepare(`UPDATE l2_outbox SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE event_id = ?`)
      .run(...keys.map((k) => patch[k] as string | number | null), eventId);
  }

  /** 某一单的回调记录，按生成先后。测试和任务网页用。 */
  events(orderId: string): OutboxRow[] {
    return this.db.prepare("SELECT * FROM l2_outbox WHERE order_id = ? ORDER BY created_at, rowid").all(orderId) as unknown as OutboxRow[];
  }

  /** 清掉 8 天前的数据。只删已结束的任务（连同方案和定时动作）；没结束的留着，等它走完。 */
  prune(): void {
    const before = this.now() - RETENTION_MS;
    this.transaction(() => {
      const stale = `SELECT task_id FROM l2_tasks WHERE updated_at < ? AND state IN (${TERMINAL_TASK_STATES.map(() => "?").join(", ")})`;
      for (const table of ["l2_proposals", "l2_jobs", "l2_tasks"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE task_id IN (${stale})`).run(before, ...TERMINAL_TASK_STATES);
      }
      this.db.prepare("DELETE FROM l2_jobs WHERE done = 1 AND due_at < ?").run(before);
      this.db.prepare("DELETE FROM l2_outbox WHERE state != 'pending' AND created_at < ?").run(before);
      this.db.prepare("DELETE FROM l2_idempotency WHERE created_at < ?").run(before);
      this.db.prepare("DELETE FROM l2_binding_codes WHERE expires_at < ?").run(before);
    });
  }

  /** 嵌套调用时只有最外层开事务。 */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newId(prefix: string, length = 16): string {
  return prefix + Array.from(randomBytes(length), (byte) => ALPHABET[byte & 31]).join("");
}

/** 8 位大写绑定码，去掉容易看错的 0/O、1/I/L。 */
function newCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  return Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join("");
}
