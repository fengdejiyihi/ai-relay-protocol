import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HEADERS, RSP_VERSION } from "@dreamcavy/ai-relay-protocol";
import { maskPhone } from "./actions.js";
import { SERVICES } from "./catalog.js";
import type { RelayReply } from "./relay.js";
import type { ShopStore } from "./store.js";
import { humanTime, shanghaiDate } from "./time.js";
import { escapeHtml, page, readBody, sendHtml, sendJson } from "./web.js";

/** 另外挂在同一个服务上的路由（L2 供给方）。处理了返回 true。 */
export type ExtraRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

export interface HttpOptions {
  relay: (rawBody: Uint8Array, signature: string | undefined) => RelayReply;
  store: ShopStore;
  now?: () => number;
  extra?: ExtraRoute;
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
    if (options.extra && (await options.extra(req, res, url))) return;
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
