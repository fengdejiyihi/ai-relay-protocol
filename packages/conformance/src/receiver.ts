import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HEADERS } from "@dreamcavy/ai-relay-protocol";
import { judgeCallback, type CallbackReply, type TestOrder } from "./callbacks.js";

/**
 * 验收订单的存放处。命令行版用内存（memoryStore），Relay 在线版用数据库：
 * 回调可能落到另一台应用实例上，update 必须是原子的（行锁）。
 */
export interface CallbackStore {
  /** 下发前登记一笔验收订单：回调可能比同步响应先到。 */
  create(order: TestOrder): Promise<void>;
  get(orderId: string): Promise<TestOrder | undefined>;
  /** 原子地改一笔订单，fn 返回新的订单。没有这笔订单时不调 fn，返回 undefined。 */
  update(orderId: string, fn: (order: TestOrder) => TestOrder): Promise<TestOrder | undefined>;
}

export function memoryStore(): CallbackStore {
  const orders = new Map<string, TestOrder>();
  return {
    async create(order) {
      orders.set(order.order_id, structuredClone(order));
    },
    async get(orderId) {
      const o = orders.get(orderId);
      return o && structuredClone(o);
    },
    async update(orderId, fn) {
      const o = orders.get(orderId);
      if (!o) return undefined;
      const next = fn(structuredClone(o));
      orders.set(orderId, next);
      return structuredClone(next);
    },
  };
}

/** 收一条回调。不是验收订单（store 里没有）时返回 null，调用方按「订单不存在」回 404。 */
export async function receiveCallback(
  store: CallbackStore,
  req: { pathOrderId: string; rawBody: string | Uint8Array; signature: string | null | undefined; secrets: readonly string[]; now?: number },
): Promise<Omit<CallbackReply, "order"> | null> {
  let reply: CallbackReply | undefined;
  const judge = (order: TestOrder) => {
    reply = judgeCallback(order, { ...req, now: req.now ?? Date.now() });
    return reply.order;
  };
  await store.update(req.pathOrderId, judge);
  // 路径写错、请求体里是验收订单：记到那笔订单上（判成路径不一致），供给方才知道错在哪。
  const bodyOrderId = reply ? undefined : orderIdOf(req.rawBody);
  if (bodyOrderId && bodyOrderId !== req.pathOrderId) await store.update(bodyOrderId, judge);
  return reply ? { http: reply.http, body: reply.body } : null;
}

function orderIdOf(raw: string | Uint8Array): string | undefined {
  try {
    const id = (JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as { order_id?: unknown } | null)?.order_id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

export interface CallbackReceiver {
  /** 回调根地址，供给方把回调发到 {url}/v1/callbacks/{order_id}。 */
  url: string;
  store: CallbackStore;
  /** 收到但不属于本次验收的回调次数（比如上一次验收的迟到回调）。 */
  strays(): number;
  close(): Promise<void>;
}

export interface ReceiverOptions {
  secrets: readonly string[];
  /** 默认 0（随机端口）。 */
  port?: number;
  /** 默认 127.0.0.1。供给方在另一台机器上时用 ::（监听所有地址）。 */
  host?: string;
  /** 告诉供给方的根地址，默认 http://{host}:{port}。 */
  publicUrl?: string;
  store?: CallbackStore;
  now?: () => number;
}

const CALLBACK_PATH = /^\/v1\/callbacks\/([^/?#]+)$/;
const MAX_BODY = 1024 * 1024;

/** 命令行版的回调接收端：本机起一个 HTTP 服务，路由和 Relay 一样是 POST /v1/callbacks/{order_id}。 */
export async function startCallbackReceiver(options: ReceiverOptions): Promise<CallbackReceiver> {
  const store = options.store ?? memoryStore();
  const now = options.now ?? Date.now;
  let strays = 0;
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
    const match = CALLBACK_PATH.exec(new URL(req.url ?? "/", "http://receiver").pathname);
    if (!match) return void send(404, { error: { code: "not_found", message: "回调地址是 POST /v1/callbacks/{order_id}" } });
    if (req.method !== "POST") return void send(405, { error: { code: "method_not_allowed" } });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return void send(413, { error: { code: "too_large" } });
      const signature = req.headers[HEADERS.signature.toLowerCase()];
      receiveCallback(store, {
        pathOrderId: decodeURIComponent(match[1]!),
        rawBody: Buffer.concat(chunks),
        signature: Array.isArray(signature) ? signature[0] : signature,
        secrets: options.secrets,
        now: now(),
      }).then(
        (reply) => {
          if (reply) return send(reply.http, reply.body);
          strays += 1;
          send(404, { error: { code: "not_found", message: "订单不存在" } });
        },
        () => send(500, { error: { code: "internal" } }),
      );
    });
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  // 监听所有地址（:: 或全 0 的 IPv4）时，提示里写本机地址。
  const shownHost = host === "::" || host.split(".").every((p) => p === "0") ? "127.0.0.1" : host;
  return {
    url: (options.publicUrl ?? `http://${shownHost}:${port}`).replace(/\/+$/, ""),
    store,
    strays: () => strays,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
