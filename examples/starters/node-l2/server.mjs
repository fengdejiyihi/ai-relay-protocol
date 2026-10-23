// AI Relay L2 起步模板：异步单结果（write_report）+ 异步多方案（find_vendor）+ 账号绑定（token）。
// 零依赖，Node 22.13 以上直接跑：node server.mjs。数据存在 SQLite（node:sqlite），进程重启不丢幂等结果、任务和待发回调。
// 要改成你的业务，搜「TODO(业务)」，只改那几个函数；验签、幂等、绑定、取消、回调重试、终态处理都已经按 RSP 1.0 写好。

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const here = (p) => new URL(p, import.meta.url);
const manifest = JSON.parse(readFileSync(here("./manifest.json"), "utf8"));
const ACTIONS = new Map(manifest.actions.map((a) => [a.name, a]));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
// 轮换期写成「新,旧」，验签时依次试。
const SECRETS = (process.env.RELAY_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// 回调根地址。本机跑接入验收时指到验收工具的回调接收端：http://127.0.0.1:8788
const CALLBACK_BASE = (process.env.RELAY_CALLBACK_BASE ?? "https://relay.newbeeai.online").replace(/\/$/, "");
const db = new DatabaseSync(process.env.DB_FILE ?? new URL("./relay-starter.db", import.meta.url).pathname);
// 模拟业务耗时，接入验收默认等 120 秒（在线验收 90 秒），别设太长。
const WORK_DELAY_MS = Number(process.env.WORK_DELAY_MS ?? 2000);
// 测试买家账号：绑定到这些账号的订单走测试数据，不碰真实商家。见 README「测试隔离」。
const TEST_ACCOUNTS = new Set((process.env.TEST_ACCOUNTS ?? "test_buyer").split(",").map((s) => s.trim()).filter(Boolean));

db.exec(`
  CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, response TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, action TEXT NOT NULL, mode TEXT NOT NULL,
    input TEXT NOT NULL, account TEXT, test INTEGER NOT NULL,
    status TEXT NOT NULL,            -- working | proposing | completed | failed | cancelled
    result TEXT,                     -- completed 的 output 或 failed 的 error
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS proposals (
    task_id TEXT NOT NULL, proposal_id TEXT NOT NULL, body TEXT NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, proposal_id)
  );
  CREATE TABLE IF NOT EXISTS binding_codes (code_hash TEXT PRIMARY KEY, account TEXT NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT);
  CREATE TABLE IF NOT EXISTS bindings (relay_uid TEXT PRIMARY KEY, account TEXT NOT NULL, bound_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS outbox (
    event_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, body TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, last_error TEXT
  );
`);

const now = () => Date.now();
const seconds = () => Math.floor(now() / 1000);
const json = (v) => JSON.stringify(v);
const failed = (code, message) => ({ status: "failed", error: message ? { code, message } : { code } });
const completed = (data, parts) => ({ status: "completed", output: parts ? { data, parts } : { data } });
const isTestOrder = (orderId, account) => orderId.startsWith("ord_cf") || TEST_ACCOUNTS.has(account ?? "");

function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ───────────── TODO(业务)：把这几个函数换成你自己的 ─────────────

/** 异步单结果的业务：真正去办事。test=true 时走测试数据（不发真实消息、不碰真实商家）。返回 output.data 或抛错。 */
function doReport(input, { test }) {
  const id = `r_${randomBytes(4).toString("hex")}`;
  return { data: { report_id: id, report_url: `https://example.com/reports/${id}${test ? "?test=1" : ""}` }, parts: [{ type: "markdown", text: `「${input.topic}」的报告已生成。` }] };
}

/** 多方案的业务：给出候选方案。真实产品里通常是一段时间内陆续来的，这里一次给 3 个。 */
function findVendors(input, { test }) {
  const names = test ? ["测试商家 A", "测试商家 B", "测试商家 C"] : ["星河工作室", "青柠设计", "北斗外包"];
  return names.map((name, i) => ({
    proposal_id: `p_${randomBytes(4).toString("hex")}`,
    title: `${name}：${input.need.slice(0, 40)}`,
    price_cents: Math.max(100, Math.round(input.budget_cents * (0.8 + i * 0.1))),
    eta_days: 7 + i * 3,
    content: { data: { vendor: name, quote_cents: Math.max(100, Math.round(input.budget_cents * (0.8 + i * 0.1))) }, parts: [{ type: "markdown", text: `**${name}** 可以做，报价约为预算的 ${80 + i * 10}%。` }] },
  }));
}

/** 用户选定方案后交付：返回 output.data。test=true 时给假的联系方式，也不要给测试商家发真实消息。 */
function deliverSelection(proposal, { test }) {
  return { data: { proposal_id: proposal.proposal_id, vendor: proposal.content.data.vendor, contact: test ? "测试联系方式（不会真的发出）" : "微信 vendor_001" } };
}

/** 能不能撤回。返回 false 表示已经办完、撤不回（回 cancel_failed）。 */
function canCancel(task) {
  return task.status === "working" || task.status === "proposing";
}

// ───────────── 验签 ─────────────

function verify(header, raw) {
  const parts = String(header ?? "").split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/.test(v ?? "")).map(([, v]) => Buffer.from(v, "hex"));
  if (!/^\d+$/.test(t ?? "") || sigs.length === 0 || Math.abs(seconds() - Number(t)) > 300) return false;
  return SECRETS.some((secret) => {
    const want = createHmac("sha256", secret).update(`${t}.`).update(raw).digest();
    return sigs.some((v) => timingSafeEqual(want, v));
  });
}

function sign(body) {
  const t = seconds();
  return `t=${t},v1=${createHmac("sha256", SECRETS[0]).update(`${t}.${body}`).digest("hex")}`;
}

// ───────────── 输入校验（清单 input Schema 的常用子集；用 SDK 时换成完整的 JSON Schema 校验） ─────────────

function checkInput(schema, input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "input 必须是对象";
  for (const key of schema.required ?? []) if (!(key in input)) return `缺少字段 ${key}`;
  for (const [key, value] of Object.entries(input)) {
    const p = schema.properties?.[key];
    if (!p) {
      if (schema.additionalProperties === false) return `不认识的字段 ${key}`;
      continue;
    }
    const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (p.type === "integer" ? !Number.isInteger(value) : p.type && p.type !== type) return `${key} 应当是 ${p.type}`;
    if (p.enum && !p.enum.includes(value)) return `${key} 只能是 ${p.enum.join("、")}`;
    if (typeof value === "string" && ((p.minLength && [...value].length < p.minLength) || (p.maxLength && [...value].length > p.maxLength))) return `${key} 长度不对`;
    if (typeof value === "string" && p.pattern && !new RegExp(p.pattern, "u").test(value)) return `${key} 格式不对`;
    if (typeof value === "number" && ((p.minimum !== undefined && value < p.minimum) || (p.maximum !== undefined && value > p.maximum))) return `${key} 超出范围`;
  }
  return null;
}

// ───────────── 账号绑定 ─────────────

const hashCode = (code) => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");

/** 生成一次性绑定码（10 分钟有效，库里只存哈希）。真实产品里放在用户登录后的「设置 → AI Relay」页面。 */
export function newBindingCode(account) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join("");
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  db.prepare("INSERT INTO binding_codes (code_hash, account, expires_at) VALUES (?, ?, ?)").run(hashCode(code), account, now() + 10 * 60_000);
  return code;
}

function bindingVerify(env) {
  return tx(() => {
    const row = db.prepare("SELECT * FROM binding_codes WHERE code_hash = ?").get(hashCode(String(env.code ?? "")));
    if (!row || row.expires_at < now()) return failed("unauthorized", "绑定码无效或已过期");
    // 同一个用户重发同一个码（Relay 网络重试）可以再成功；别的用户拿同一个码来必须失败。
    if (row.used_by && row.used_by !== env.relay_uid) return failed("unauthorized", "绑定码已被使用");
    db.prepare("UPDATE binding_codes SET used_by = ? WHERE code_hash = ?").run(env.relay_uid, row.code_hash);
    db.prepare("INSERT INTO bindings (relay_uid, account, bound_at) VALUES (?, ?, ?) ON CONFLICT (relay_uid) DO UPDATE SET account = excluded.account").run(env.relay_uid, row.account, now());
    // display_name 换成用户在你产品里的昵称：Relay 绑定成功时会告诉用户绑的是哪个账号，确认页也会显示。
    return { status: "bound", supplier_user_ref: row.account, display_name: row.account };
  });
}

// ───────────── 下单（幂等） ─────────────

const busy = new Set();
// 只缓存最终结果：temporary、rate_limited 不缓存，Relay 会用同一个键重试。
const isFinal = (out) => out.status !== "failed" || !["temporary", "rate_limited"].includes(out.error?.code);

function invoke(env) {
  const key = env.idempotency_key;
  const hit = db.prepare("SELECT response FROM idempotency WHERE key = ?").get(key);
  if (hit) return JSON.parse(hit.response);
  if (busy.has(key)) return failed("temporary", "同一个订单正在处理");
  busy.add(key);
  try {
    const out = invokeOnce(env);
    if (isFinal(out)) db.prepare("INSERT OR IGNORE INTO idempotency (key, response, created_at) VALUES (?, ?, ?)").run(key, json(out), now());
    return out;
  } finally {
    busy.delete(key);
  }
}

function invokeOnce(env) {
  const action = ACTIONS.get(env.action);
  if (!action) return failed("invalid_input", `没有动作 ${env.action}`);
  const problem = checkInput(action.input, env.input);
  if (problem) return failed("invalid_input", problem);
  const account = env.user?.supplier_user_ref ?? null;
  if (manifest.supplier.user_binding === "token" && !account) return failed("unauthorized", "还没有绑定账号");
  // TODO(业务)：核对金额。清单 amount 取 input.budget_cents，和你这边的真实价格对不上时回 invalid_input。
  const taskId = `t_${randomUUID()}`;
  db.prepare("INSERT INTO tasks (task_id, order_id, action, mode, input, account, test, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'working', ?, ?)").run(
    taskId, env.order_id, action.name, action.mode, json(env.input), account, isTestOrder(env.order_id, account) ? 1 : 0, now(), now(),
  );
  return { status: "accepted", task_id: taskId, eta_seconds: Math.ceil(WORK_DELAY_MS / 1000) + 1 };
}

// ───────────── 异步任务：补拉、取消、选方案 ─────────────

function findTask(env) {
  const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(String(env.task_id ?? ""));
  return task && task.order_id === env.order_id ? task : undefined;
}

const activeProposals = (taskId) => db.prepare("SELECT body FROM proposals WHERE task_id = ? AND withdrawn = 0").all(taskId).map((r) => JSON.parse(r.body));

/** 任务当前状态对应的响应。task.poll 和重复的取消、选定都用它，保证同一个终态说法一致。 */
function taskResponse(task) {
  switch (task.status) {
    case "working":
      return { status: "pending", eta_seconds: 2 };
    case "proposing":
      return { status: "proposals", proposals: activeProposals(task.task_id) };
    case "completed":
      return { status: "completed", output: JSON.parse(task.result) };
    case "failed":
      return { status: "failed", error: JSON.parse(task.result) };
    case "cancelled":
      // 取消成功之后补拉必须回 failed，不能再给出 completed。
      return failed("permanent", "任务已取消");
  }
  return failed("permanent", `未知任务状态 ${task.status}`);
}

function taskPoll(env) {
  const task = findTask(env);
  return task ? taskResponse(task) : failed("permanent", "没有这个任务");
}

function taskCancel(env) {
  return tx(() => {
    const task = findTask(env);
    if (!task) return failed("permanent", "没有这个任务");
    if (task.status === "cancelled") return { status: "cancelled" }; // 重复取消回同样的结果
    if (!canCancel(task)) return { status: "cancel_failed", reason: task.status === "completed" ? "已经交付，撤不回" : "任务已结束" };
    db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE task_id = ?").run(now(), task.task_id);
    // 回了 cancelled 之后不能再发改状态的回调：还没发出去的一律作废。
    db.prepare("UPDATE outbox SET done = 1, last_error = 'cancelled' WHERE order_id = ? AND done = 0").run(task.order_id);
    // TODO(业务)：真实产品在这里撤回需求、通知已报价的商家等。
    return { status: "cancelled" };
  });
}

function proposalSelect(env) {
  return tx(() => {
    const task = findTask(env);
    if (!task || task.mode !== "async_multi") return failed("permanent", "没有这个多方案任务");
    if (task.status === "completed") {
      // 重复选定（Relay 重试）：选的是同一个就回同样的交付结果，否则拒绝。
      const out = JSON.parse(task.result);
      return out.data?.proposal_id === env.proposal_id ? { status: "completed", output: out } : failed("not_available", "这一单已经选定了别的方案");
    }
    if (task.status !== "proposing") return failed("not_available", "这一单现在不能选方案");
    const row = db.prepare("SELECT body, withdrawn FROM proposals WHERE task_id = ? AND proposal_id = ?").get(task.task_id, String(env.proposal_id ?? ""));
    // 必须核对方案属于这个任务、仍然有效。
    if (!row || row.withdrawn) return failed("not_available", "方案不存在或已撤回");
    const output = deliverSelection(JSON.parse(row.body), { test: Boolean(task.test) });
    db.prepare("UPDATE tasks SET status = 'completed', result = ?, updated_at = ? WHERE task_id = ?").run(json(output), now(), task.task_id);
    // 当场交付就回 completed；要之后才能交付，改成回 { status: "selected" }，交付时再发 completed 回调。
    return { status: "completed", output };
  });
}

// ───────────── 后台进程：推进任务、投递回调（发件箱） ─────────────

function enqueue(orderId, event) {
  const body = { rsp: "1.0", order_id: orderId, event_id: `evt_${randomUUID()}`, occurred_at: seconds(), ...event };
  db.prepare("INSERT INTO outbox (event_id, order_id, body, next_at) VALUES (?, ?, ?, ?)").run(body.event_id, orderId, json(body), now());
}

function advanceTasks() {
  const due = db.prepare("SELECT * FROM tasks WHERE status = 'working' AND created_at <= ?").all(now() - WORK_DELAY_MS);
  for (const task of due) {
    const input = JSON.parse(task.input);
    const ctx = { test: Boolean(task.test) };
    // 状态变化和待发回调在同一个事务里写，进程崩在中间也不会丢回调或多发。
    tx(() => {
      const fresh = db.prepare("SELECT status FROM tasks WHERE task_id = ?").get(task.task_id);
      if (fresh.status !== "working") return; // 期间被取消了
      try {
        if (task.mode === "async_multi") {
          for (const p of findVendors(input, ctx)) {
            db.prepare("INSERT INTO proposals (task_id, proposal_id, body) VALUES (?, ?, ?)").run(task.task_id, p.proposal_id, json(p));
            enqueue(task.order_id, { type: "proposal.add", proposal: p });
          }
          db.prepare("UPDATE tasks SET status = 'proposing', updated_at = ? WHERE task_id = ?").run(now(), task.task_id);
        } else {
          const output = doReport(input, ctx);
          db.prepare("UPDATE tasks SET status = 'completed', result = ?, updated_at = ? WHERE task_id = ?").run(json(output), now(), task.task_id);
          enqueue(task.order_id, { type: "completed", output });
        }
      } catch (e) {
        const error = { code: "permanent", message: String(e?.message ?? e).slice(0, 200) };
        db.prepare("UPDATE tasks SET status = 'failed', result = ?, updated_at = ? WHERE task_id = ?").run(json(error), now(), task.task_id);
        enqueue(task.order_id, { type: "failed", error });
      }
    });
  }
}

let delivering = false;
async function deliverOutbox() {
  if (delivering || SECRETS.length === 0) return;
  delivering = true;
  try {
    const rows = db.prepare("SELECT * FROM outbox WHERE done = 0 AND next_at <= ? ORDER BY rowid LIMIT 20").all(now());
    for (const row of rows) {
      let status = 0;
      try {
        const res = await fetch(`${CALLBACK_BASE}/v1/callbacks/${row.order_id}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-relay-signature": sign(row.body) },
          body: row.body,
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
      } catch {
        status = 0; // 连不上或超时：退避重发
      }
      // 200 收下（含重复）；401/404/409/422 重发也没用，记下来人工看；其余（5xx、超时）用同一个 event_id 退避重发。
      if (status === 200 || [401, 404, 409, 422].includes(status)) {
        db.prepare("UPDATE outbox SET done = 1, attempts = attempts + 1, last_error = ? WHERE event_id = ?").run(status === 200 ? null : `HTTP ${status}`, row.event_id);
        if (status !== 200) console.warn(`回调 ${row.event_id}（${row.order_id}）被拒：HTTP ${status}`);
      } else {
        const attempts = row.attempts + 1;
        const giveUp = attempts >= 20; // 约 24 小时后放弃，Relay 还会用 task.poll 补拉
        db.prepare("UPDATE outbox SET attempts = ?, next_at = ?, done = ?, last_error = ? WHERE event_id = ?").run(
          attempts, now() + Math.min(2 ** attempts * 1000, 15 * 60_000), giveUp ? 1 : 0, `HTTP ${status || "连接失败"}`, row.event_id,
        );
      }
    }
  } finally {
    delivering = false;
  }
}

// ───────────── HTTP 入口 ─────────────

const HANDLERS = {
  ping: (env) => ({ status: "ok", challenge: env.challenge, rsp: "1.0" }),
  "action.invoke": invoke,
  "task.poll": taskPoll,
  "task.cancel": taskCancel,
  "proposal.select": proposalSelect,
  "binding.verify": bindingVerify,
};

function handleRelay(raw) {
  const env = JSON.parse(raw.toString("utf8"));
  // 信封里不认识的字段直接忽略；不认识的 type 回 not_supported。
  const handler = Object.hasOwn(HANDLERS, env.type) ? HANDLERS[env.type] : undefined;
  return handler ? handler(env) : failed("not_supported");
}

function serve() {
  if (SECRETS.length === 0) throw new Error("请设置环境变量 RELAY_SECRET（后台给的 whsec_…；本机自测随便写一个）");
  createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/relay") return res.writeHead(404).end();
    const chunks = []; // 先收齐原始字节再验签
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (!verify(req.headers["x-relay-signature"], raw)) return res.writeHead(401).end();
      try {
        const out = handleRelay(raw);
        res.writeHead(200, { "content-type": "application/json" }).end(json(out));
      } catch (e) {
        // 不确定有没有办成：回 500，不要编结果。Relay 不重试、不扣费，订单进「待核对」。
        console.error(e);
        res.writeHead(500).end();
      }
    });
  }).listen(PORT, HOST, () => console.log(`AI Relay L2 起步模板：http://${HOST === "::" ? "[::]" : HOST}:${PORT}/relay，回调发往 ${CALLBACK_BASE}`));
  setInterval(() => {
    try {
      advanceTasks();
    } catch (e) {
      console.error(e);
    }
    void deliverOutbox().catch((e) => console.error(e));
  }, 500);
}

// node server.mjs binding-code <账号>：生成一次性绑定码（接入验收和在线验收用，账号用测试买家）。
if (process.argv[2] === "binding-code") {
  console.log(newBindingCode(process.argv[3] ?? "test_buyer"));
} else {
  serve();
}
