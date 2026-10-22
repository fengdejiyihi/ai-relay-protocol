import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  compileActionInput,
  type DownstreamType,
  HEADERS,
  signBody,
  type UpstreamEvent,
  validateResponse,
  validateUpstream,
  verifySignature,
} from "@dreamcavy/ai-relay-protocol";
import { expect } from "vitest";
import { createShop, L2_DEFAULTS, type Shop, type SupplierKey } from "../src/index.js";
import { BASE_URL, MANIFEST_PATH, SECRET, START } from "./helpers.js";

export const PUBLISHER_SECRET = "whsec_sandbox_test_publisher";
export const MATCH_SECRET = "whsec_sandbox_test_match";
const manifest = (name: string) => fileURLToPath(new URL(`../../../examples/manifests/${name}`, import.meta.url));

export interface Received {
  path: string;
  /** 签名用哪个供给方的 secret 验过。 */
  supplier: SupplierKey | null;
  event: UpstreamEvent;
}

/**
 * 假 Relay 回调端点：按 RSP 1.0 第 7 节验签、校验事件 Schema、核对路径与 order_id，记下收到的每个事件。
 * replies 里放下一次（几次）要回的 HTTP 状态码，用来测 5xx 重发和 409 不重发。
 */
export interface Receiver {
  url: string;
  received: Received[];
  replies: number[];
  /** 每次请求（包括回 5xx 的）都记一条。 */
  attempts: { event_id: string; status: number }[];
  close(): Promise<void>;
}

export interface L2Harness {
  shop: Shop;
  url: string;
  clock: { now: number };
  receiver: Receiver;
  /** 时钟前进 ms，跑掉期间到点的定时动作和回调（按时间顺序一步步走）。 */
  advance(ms: number): Promise<void>;
  close(): Promise<void>;
}

export async function startL2(faults: string[] = []): Promise<L2Harness> {
  const clock = { now: START };
  const receiver = await startReceiver(clock);
  const shop = createShop(
    {
      secrets: [SECRET],
      dbPath: ":memory:",
      publicBaseUrl: BASE_URL,
      manifestPath: MANIFEST_PATH,
      l2: {
        secrets: { publisher: [PUBLISHER_SECRET], match: [MATCH_SECRET] },
        manifestPaths: { publisher: manifest("l2-publisher.json"), match: manifest("l2-matching.json") },
        callbackBase: receiver.url,
        settings: {
          publishDelayMs: L2_DEFAULTS.publishDelayMs,
          proposalIntervalMs: L2_DEFAULTS.proposalIntervalMs,
          selectDelayMs: L2_DEFAULTS.selectDelayMs,
          faults: faults as never,
        },
        lateMs: L2_DEFAULTS.lateMs,
      },
    },
    () => clock.now,
    { tickMs: false, log: () => {} },
  );
  await new Promise<void>((resolve) => shop.server.listen(0, "127.0.0.1", resolve));
  const { port } = shop.server.address() as AddressInfo;
  const l2 = shop.l2!;

  async function advance(ms: number): Promise<void> {
    const target = clock.now + ms;
    await l2.tick();
    for (;;) {
      const next = l2.store.nextWakeAt();
      if (next === null || next > target) break;
      clock.now = Math.max(clock.now, next);
      await l2.tick();
    }
    clock.now = target;
    await l2.tick();
  }

  return {
    shop,
    url: `http://127.0.0.1:${port}`,
    clock,
    receiver,
    advance,
    close: async () => {
      await new Promise<void>((resolve, reject) => shop.server.close((e) => (e ? reject(e) : resolve())));
      await receiver.close();
    },
  };
}

async function startReceiver(clock: { now: number }): Promise<Receiver> {
  const received: Received[] = [];
  const replies: number[] = [];
  const attempts: Receiver["attempts"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const header = req.headers[HEADERS.signature.toLowerCase()] as string | undefined;
      const now = Math.floor(clock.now / 1000);
      const supplier = (["publisher", "match"] as const).find(
        (k) => verifySignature({ secrets: [k === "publisher" ? PUBLISHER_SECRET : MATCH_SECRET], header, body: raw, now }).ok,
      );
      const parsed = JSON.parse(raw.toString("utf8")) as UpstreamEvent;
      const status = replies.shift() ?? 200;
      attempts.push({ event_id: parsed.event_id, status });
      if (status < 300) {
        // 沙箱自己发的事件按严格模式校验：不该有任何多余字段。
        const checked = validateUpstream(parsed, { strict: true });
        expect(checked.ok ? [] : checked.errors).toEqual([]);
        expect(req.url).toBe(`/v1/callbacks/${parsed.order_id}`);
        received.push({ path: req.url!, supplier: supplier ?? null, event: parsed });
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: status < 300 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    replies,
    attempts,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

let seq = 0;
export function nextOrderId(): string {
  seq += 1;
  return `ord_l2test${String(seq).padStart(10, "0")}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function envelope(h: L2Harness, type: string, fields: Record<string, unknown>): Record<string, any> {
  return { type, rsp: "1.0", issued_at: Math.floor(h.clock.now / 1000), ...fields };
}

export function invokeEnvelope(
  h: L2Harness,
  action: string,
  input: Record<string, unknown>,
  ref: string | null,
  extra: { order_id?: string; relay_uid?: string } = {},
) {
  const id = extra.order_id ?? nextOrderId();
  return envelope(h, "action.invoke", {
    order_id: id,
    action,
    manifest_version: 1,
    input,
    user: { relay_uid: extra.relay_uid ?? "u_alice_000001", supplier_user_ref: ref },
    idempotency_key: id,
  });
}

/** 真签名发到某家供给方的端点。每个 200 响应都过 validateResponse；completed 再过动作的 output Schema。 */
export async function post(
  h: L2Harness,
  supplier: SupplierKey,
  body: Record<string, unknown>,
  opts: { secret?: string } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(body);
  const secret = opts.secret ?? (supplier === "publisher" ? PUBLISHER_SECRET : MATCH_SECRET);
  const res = await fetch(`${h.url}/${supplier}/relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [HEADERS.signature]: signBody(secret, raw, Math.floor(h.clock.now / 1000)) },
    body: raw,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sent = { status: res.status, body: (await res.json()) as any };
  if (sent.status === 200) {
    const checked = validateResponse(body.type as DownstreamType, sent.body);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
    if (body.type === "action.invoke" && sent.body.status === "completed") expectOutput(h, supplier, body.action as string, sent.body.output.data);
  }
  return sent;
}

export function expectOutput(h: L2Harness, supplier: SupplierKey, action: string, data: unknown): void {
  const schema = h.shop.l2!.manifests[supplier].actions.find((a) => a.name === action)!.output!;
  const checked = compileActionInput(schema)(data);
  expect(checked.ok ? [] : checked.errors).toEqual([]);
}

/** 走 binding.verify 拿到账号标识。 */
export async function bind(h: L2Harness, supplier: SupplierKey, relayUid = "u_alice_000001"): Promise<string> {
  const { code } = h.shop.l2!.issueBindingCode(supplier, "测试用户");
  const sent = await post(h, supplier, envelope(h, "binding.verify", { relay_uid: relayUid, code }));
  expect(sent.body.status).toBe("bound");
  return sent.body.supplier_user_ref as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function eventsFor(h: L2Harness, orderId: string): any[] {
  return h.receiver.received.filter((r) => r.event.order_id === orderId).map((r) => r.event);
}
