// AI Relay L1 起步模板：同步动作（查询 + 下单），不绑定账号。
// 零依赖，Node 22.13 以上直接跑：node server.mjs。幂等结果存在 SQLite（node:sqlite），进程重启不丢。
// 要改成你的业务，搜「TODO(业务)」，只改那几个函数；验签、幂等、输入校验、错误码都已经按 RSP 1.0 写好。

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const ACTIONS = new Map(manifest.actions.map((a) => [a.name, a]));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
// 轮换期写成「新,旧」，验签时依次试。
const SECRETS = (process.env.RELAY_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const db = new DatabaseSync(process.env.DB_FILE ?? new URL("./relay-starter.db", import.meta.url).pathname);
// 测试订单走测试数据：在线验收的订单号以 ord_cf 开头；你自己用 AI 测时，用这些手机号下单。见 README「测试隔离」。
const TEST_PHONES = new Set((process.env.TEST_PHONES ?? "13800138000").split(",").map((s) => s.trim()).filter(Boolean));

db.exec("CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, response TEXT NOT NULL, created_at INTEGER NOT NULL)");

const failed = (code, message) => ({ status: "failed", error: message ? { code, message } : { code } });
const completed = (data, parts) => ({ status: "completed", output: parts ? { data, parts } : { data } });
const isTestOrder = (env) => env.order_id.startsWith("ord_cf") || TEST_PHONES.has(env.input?.phone ?? "");

// ───────────── TODO(业务)：把这几个函数换成你自己的 ─────────────

const ITEMS = [
  { sku: "A001", name: "示例商品 A", price_cents: 1990 },
  { sku: "B002", name: "示例商品 B", price_cents: 4990 },
];

function listItems(input) {
  const items = input.keyword ? ITEMS.filter((i) => i.name.includes(input.keyword)) : ITEMS;
  return completed({ items });
}

/** test=true 时走测试数据：不发真实短信、不通知真实商家、订单记到测试库。 */
function placeOrder(input, { orderId, test }) {
  const item = ITEMS.find((i) => i.sku === input.sku);
  if (!item) return failed("invalid_input", `没有商品 ${input.sku}`);
  // 金额必须核对：清单 amount 取 input.total_cents，Relay 拿它和用户给 AI 设的单笔上限比较。
  if (input.total_cents !== item.price_cents * input.quantity) return failed("invalid_input", "总价不对");
  const orderNo = `${test ? "TEST-" : ""}${randomBytes(4).toString("hex").toUpperCase()}`;
  void orderId; // 真实产品里把 Relay 的 order_id 存进你的订单，对账和排查用
  return completed({ order_no: orderNo, total_cents: input.total_cents }, [{ type: "markdown", text: `已下单，订单号 ${orderNo}` }]);
}

const HANDLERS = { list_items: listItems, place_order: placeOrder };

// ───────────── 验签 ─────────────

function verify(header, raw) {
  const parts = String(header ?? "").split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/.test(v ?? "")).map(([, v]) => Buffer.from(v, "hex"));
  if (!/^\d+$/.test(t ?? "") || sigs.length === 0 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  return SECRETS.some((secret) => {
    const want = createHmac("sha256", secret).update(`${t}.`).update(raw).digest();
    return sigs.some((v) => timingSafeEqual(want, v));
  });
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
    const action = ACTIONS.get(env.action);
    const problem = action ? checkInput(action.input, env.input) : `没有动作 ${env.action}`;
    const out = problem ? failed("invalid_input", problem) : HANDLERS[env.action](env.input, { orderId: env.order_id, test: isTestOrder(env) });
    if (isFinal(out)) db.prepare("INSERT OR IGNORE INTO idempotency (key, response, created_at) VALUES (?, ?, ?)").run(key, JSON.stringify(out), Date.now());
    return out;
  } finally {
    busy.delete(key);
  }
}

// ───────────── HTTP 入口 ─────────────

function handleRelay(raw) {
  const env = JSON.parse(raw.toString("utf8"));
  // 信封里不认识的字段直接忽略；不认识的 type 回 not_supported。
  if (env.type === "ping") return { status: "ok", challenge: env.challenge, rsp: "1.0" };
  if (env.type === "action.invoke") return invoke(env);
  return failed("not_supported");
}

if (SECRETS.length === 0) throw new Error("请设置环境变量 RELAY_SECRET（后台给的 whsec_…；本机自测随便写一个）");
createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/relay") return res.writeHead(404).end();
  const chunks = []; // 先收齐原始字节再验签
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    if (!verify(req.headers["x-relay-signature"], raw)) return res.writeHead(401).end();
    try {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(handleRelay(raw)));
    } catch (e) {
      // 不确定有没有办成：回 500，不要编结果。Relay 不重试、不扣费，订单进「待核对」。
      console.error(e);
      res.writeHead(500).end();
    }
  });
}).listen(PORT, HOST, () => console.log(`AI Relay L1 起步模板：http://${HOST === "::" ? "[::]" : HOST}:${PORT}/relay`));
