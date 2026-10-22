import type { IncomingMessage, ServerResponse } from "node:http";

/** 信封很小；超过这个大小直接拒绝，不读进内存。 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** 读原始请求体字节。签名按原始字节算，验签前不解码、不解析。超过上限返回 null。 */
export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location });
  res.end();
}

export function page(title: string, body: string, site = "Relay 沙箱理发店"): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${escapeHtml(site)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse}td,th{padding:.25rem .75rem;border-bottom:1px solid #ddd;text-align:left}code{font-size:1.25rem;letter-spacing:.1em}pre{white-space:pre-wrap;background:#f6f6f6;padding:1rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
