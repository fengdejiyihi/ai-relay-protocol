import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HEADERS, RSP_VERSION } from "@ai-relay/protocol";
import { maskPhone } from "./actions.js";
import { SERVICES } from "./catalog.js";
import type { RelayReply } from "./relay.js";
import type { ShopStore } from "./store.js";
import { humanTime, shanghaiDate } from "./time.js";

/** 信封很小；超过这个大小直接拒绝，不读进内存。 */
const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpOptions {
  relay: (rawBody: Uint8Array, signature: string | undefined) => RelayReply;
  store: ShopStore;
  now?: () => number;
}

/**
 * 路由：
 * - POST /relay   RSP 1.0 唯一入口
 * - GET  /healthz 健康检查
 * - GET  /        当天（或 ?date=）空闲时段，给人看的网页，link 内容块指向这里
 * - GET  /b/:id   预约详情页（手机号脱敏）
 */
export function createHttpServer(options: HttpOptions): Server {
  const now = options.now ?? Date.now;
  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { status: "failed", error: { code: "temporary", message: "内部错误" } });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/relay") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "只接受 POST" }, { Allow: "POST" });
      const body = await readBody(req);
      if (body === null) return sendJson(res, 413, { status: "failed", error: { code: "invalid_input", message: "请求体过大" } });
      const signature = req.headers[HEADERS.signature.toLowerCase()];
      const reply = options.relay(body, Array.isArray(signature) ? signature[0] : signature);
      return sendJson(res, reply.httpStatus, reply.body, { [HEADERS.rspVersion]: RSP_VERSION });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
    if (url.pathname === "/") return sendHtml(res, 200, slotsPage(url.searchParams.get("date") ?? shanghaiDate(now())));
    const match = /^\/b\/(b_[0-9a-z]{12})$/.exec(url.pathname);
    if (match) {
      const booking = options.store.booking(match[1]!);
      if (booking) return sendHtml(res, 200, bookingPage(booking));
    }
    return sendHtml(res, 404, page("没有这个页面", "<p>没有找到。</p>"));
  }

  function slotsPage(date: string): string {
    const { first, last } = options.store.window();
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= first && date <= last;
    const slots = valid ? options.store.freeSlots(date) : [];
    const rows = slots
      .map((s) => `<tr><td>${s.start.slice(11, 16)}</td><td>${SERVICES[s.service].title}</td><td>¥${s.price_cents / 100}</td></tr>`)
      .join("");
    return page(
      `${escapeHtml(date)} 可预约时段`,
      `<p>可预约 ${first} 到 ${last}。数据每天重置，这是演示门店。</p>` +
        (rows ? `<table><tr><th>时间</th><th>项目</th><th>价格</th></tr>${rows}</table>` : "<p>没有空闲时段。</p>"),
    );
  }
}

function bookingPage(b: { booking_id: string; start: string; service: keyof typeof SERVICES; status: string; name: string; phone: string }): string {
  return page(
    `预约 ${b.booking_id}`,
    `<p>${humanTime(b.start)} ${SERVICES[b.service].title}</p>` +
      `<p>${escapeHtml(b.name)}，${maskPhone(b.phone)}</p>` +
      `<p>状态：${b.status === "booked" ? "已预约" : "已取消"}</p>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Relay 沙箱理发店</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse}td,th{padding:.25rem .75rem;border-bottom:1px solid #ddd;text-align:left}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** 读原始请求体字节。签名按原始字节算，验签前不解码、不解析。 */
async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
