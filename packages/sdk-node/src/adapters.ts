import type { IncomingMessage, ServerResponse } from "node:http";
import { HEADERS } from "@dreamcavy/ai-relay-protocol";
import type { RelayHandler, RelayReply } from "./handler.js";

/** 信封很小；超过这个大小直接 413，不读进内存。 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface AdapterOptions {
  maxBodyBytes?: number;
}

const SIGNATURE_HEADER = HEADERS.signature.toLowerCase();

/**
 * Node 原生 http 和 Express（4、5）共用：`(req, res) => void`。
 *
 * ```ts
 * http.createServer((req, res) => req.url === "/relay" ? relayHandler(req, res) : ...);
 * app.post("/relay", toNodeHandler(relay)); // Express：挂在 express.json() 之前，或这条路由用 express.raw()
 * ```
 *
 * 验签要原始字节。请求流还没被读过时直接读流；Express 用了 `express.raw()` 时 `req.body` 是 Buffer，也可以；
 * 已经被 `express.json()` 解析成对象时原始字节拿不回来，回 500 并提示改挂载顺序。
 */
export function toNodeHandler(relay: RelayHandler, options: AdapterOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return (req, res) => {
    run(req, res).catch((error: unknown) => {
      console.error("[ai-relay-sdk]", error);
      if (!res.headersSent) sendNode(res, jsonReply(500, { status: "failed", error: { code: "temporary", message: "内部错误" } }));
      else res.end();
    });
  };

  async function run(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return sendNode(res, { ...jsonReply(405, { error: "只接受 POST" }), headers: { ...JSON_HEADERS, Allow: "POST" } });
    const body = await rawBodyOf(req, maxBodyBytes);
    if (body === TOO_LARGE) return sendNode(res, jsonReply(413, { status: "failed", error: { code: "invalid_input", message: "请求体过大" } }));
    if (body === PARSED) {
      return sendNode(
        res,
        jsonReply(500, {
          status: "failed",
          error: { code: "temporary", message: "请求体已被 JSON 中间件解析，拿不到原始字节验签。把 /relay 挂在 express.json() 之前，或对这条路由用 express.raw({ type: '*/*' })" },
        }),
      );
    }
    const header = req.headers[SIGNATURE_HEADER];
    sendNode(res, await relay.handle(body, Array.isArray(header) ? header[0] : header));
  }
}

/**
 * Fetch API 风格：`(Request) => Promise<Response>`。
 * Next.js App Router（`export const POST = toFetchHandler(relay)`，用 Node.js 运行时）、Hono、Bun 都能直接用。
 */
export function toFetchHandler(relay: RelayHandler, options: AdapterOptions = {}): (request: Request) => Promise<Response> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return async (request) => {
    if (request.method !== "POST") return toResponse({ ...jsonReply(405, { error: "只接受 POST" }), headers: { ...JSON_HEADERS, Allow: "POST" } });
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > maxBodyBytes) return toResponse(jsonReply(413, { status: "failed", error: { code: "invalid_input", message: "请求体过大" } }));
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > maxBodyBytes) return toResponse(jsonReply(413, { status: "failed", error: { code: "invalid_input", message: "请求体过大" } }));
    return toResponse(await relay.handle(body, request.headers.get(HEADERS.signature)));
  };
}

/** Fastify 用到的最小接口，不依赖 fastify 的类型。 */
interface FastifyInstanceLike {
  removeAllContentTypeParsers(): unknown;
  addContentTypeParser(
    contentType: string,
    options: { parseAs: "buffer" },
    parser: (request: unknown, body: Buffer, done: (error: Error | null, body?: Buffer) => void) => void,
  ): unknown;
  post(path: string, handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown>): unknown;
}
interface FastifyRequestLike {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}
interface FastifyReplyLike {
  code(status: number): FastifyReplyLike;
  headers(values: Record<string, string>): FastifyReplyLike;
  send(payload: string): unknown;
}

export interface FastifyAdapterOptions extends AdapterOptions {
  /** 路由，默认 /relay。 */
  path?: string;
}

/**
 * Fastify 插件：`app.register(fastifyRelay(relay))`。
 * 插件作用域内把请求体解析成原始 Buffer（不影响其他路由的 JSON 解析）。
 */
export function fastifyRelay(relay: RelayHandler, options: FastifyAdapterOptions = {}): (instance: FastifyInstanceLike) => Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return async (instance) => {
    // 插件作用域内替换掉 Fastify 自带的 JSON 解析（不影响外层），所有请求体都按原始 Buffer 交给验签。
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    instance.post(options.path ?? "/relay", async (request, reply) => {
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const result =
        body.length > maxBodyBytes
          ? jsonReply(413, { status: "failed", error: { code: "invalid_input", message: "请求体过大" } })
          : await relay.handle(body, first(request.headers[SIGNATURE_HEADER]));
      return reply.code(result.status).headers(result.headers).send(result.body);
    });
  };
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const TOO_LARGE = Symbol("too-large");
const PARSED = Symbol("parsed");

async function rawBodyOf(req: IncomingMessage, maxBodyBytes: number): Promise<Uint8Array | string | typeof TOO_LARGE | typeof PARSED> {
  const preread = (req as IncomingMessage & { body?: unknown }).body;
  if (preread instanceof Uint8Array || typeof preread === "string") {
    return Buffer.byteLength(preread) > maxBodyBytes ? TOO_LARGE : preread;
  }
  if (req.readableEnded || (preread !== undefined && preread !== null && typeof preread === "object" && Object.keys(preread).length)) {
    return PARSED;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBodyBytes) return TOO_LARGE;
    chunks.push(chunk);
  }
  // 拼好再整段交给验签，不能逐块解码。
  return Buffer.concat(chunks);
}

function jsonReply(status: number, body: unknown): RelayReply {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function sendNode(res: ServerResponse, reply: RelayReply): void {
  res.writeHead(reply.status, reply.headers);
  res.end(reply.body);
}

function toResponse(reply: RelayReply): Response {
  return new Response(reply.body, { status: reply.status, headers: reply.headers });
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
