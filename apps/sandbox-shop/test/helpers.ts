import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  compileActionInput,
  type DownstreamType,
  HEADERS,
  type Manifest,
  signBody,
  validateResponse,
} from "@ai-relay/protocol";
import { expect } from "vitest";
import { createShop, type Shop } from "../src/index.js";

export const SECRET = "whsec_sandbox_test_current";
export const OLD_SECRET = "whsec_sandbox_test_previous";
export const BASE_URL = "https://sandbox.example.test";
export const MANIFEST_PATH = fileURLToPath(new URL("../../../examples/manifests/sandbox-shop.json", import.meta.url));

/** 北京时间 2026-10-22 09:30，门店 10:00 开门前。 */
export const START = Date.parse("2026-10-22T09:30:00+08:00");

export interface Harness {
  shop: Shop;
  url: string;
  clock: { now: number };
  close(): Promise<void>;
}

export async function startShop(): Promise<Harness> {
  const clock = { now: START };
  const shop = createShop(
    { secrets: [SECRET, OLD_SECRET], dbPath: ":memory:", publicBaseUrl: BASE_URL, manifestPath: MANIFEST_PATH },
    () => clock.now,
  );
  await new Promise<void>((resolve) => shop.server.listen(0, "127.0.0.1", resolve));
  const { port } = shop.server.address() as AddressInfo;
  return {
    shop,
    url: `http://127.0.0.1:${port}`,
    clock,
    close: () => new Promise((resolve, reject) => shop.server.close((e) => (e ? reject(e) : resolve()))),
  };
}

let seq = 0;
export function orderId(): string {
  seq += 1;
  return `ord_test${String(seq).padStart(10, "0")}`;
}

export function invoke(
  h: Harness,
  action: string,
  input: Record<string, unknown>,
  extra: { order_id?: string; relay_uid?: string; deadline_at?: number } = {},
) {
  const id = extra.order_id ?? orderId();
  return {
    type: "action.invoke",
    rsp: "1.0",
    issued_at: Math.floor(h.clock.now / 1000),
    order_id: id,
    action,
    manifest_version: 1,
    input,
    user: { relay_uid: extra.relay_uid ?? "u_alice_000001", supplier_user_ref: null },
    idempotency_key: id,
    ...(extra.deadline_at === undefined ? {} : { deadline_at: extra.deadline_at }),
  };
}

export interface Sent {
  status: number;
  headers: Headers;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** 用真签名把信封 POST 到 /relay。raw 给定时原样发送（用来测篡改、非法 JSON）。 */
export async function send(
  h: Harness,
  envelope: unknown,
  opts: { secret?: string; timestamp?: number; raw?: string; signature?: string | null } = {},
): Promise<Sent> {
  const body = opts.raw ?? JSON.stringify(envelope);
  const timestamp = opts.timestamp ?? Math.floor(h.clock.now / 1000);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const signature = opts.signature === undefined ? signBody(opts.secret ?? SECRET, body, timestamp) : opts.signature;
  if (signature !== null) headers[HEADERS.signature] = signature;
  const res = await fetch(`${h.url}/relay`, { method: "POST", headers, body });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

/**
 * 每个 200 响应都过协议包的 validateResponse；action.invoke 的 completed 还要过该动作的 output Schema。
 */
export function expectValid(type: DownstreamType, sent: Sent, manifest: Manifest, action?: string): void {
  expect(sent.status).toBe(200);
  const result = validateResponse(type, sent.body);
  expect(result.ok ? [] : result.errors).toEqual([]);
  if (action && sent.body.status === "completed") {
    const schema = manifest.actions.find((a) => a.name === action)?.output;
    expect(schema).toBeDefined();
    const checked = compileActionInput(schema!)(sent.body.output.data);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
  }
}
