import { HEADERS, RSP_VERSION, signBody } from "@dreamcavy/ai-relay-protocol";

/** fetch 的最小子集。全局 fetch、undici 的 fetch 都满足。 */
export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "manual"; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

/** 一次 HTTP 往返的结果。network 是请求没拿到响应（连不上、超时、被地址策略拦下）。 */
export type Exchange =
  | { kind: "http"; status: number; body: unknown; text: string; json: boolean; ms: number }
  | { kind: "network"; error: string; ms: number };

export interface PostOptions {
  /** 原样作为 X-Relay-Signature；null 表示不带签名头。 */
  signature: string | null;
  orderId?: string;
  timeoutMs: number;
  fetch: FetchLike;
}

export async function post(endpoint: string, body: string, options: PostOptions): Promise<Exchange> {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    [HEADERS.rspVersion]: RSP_VERSION,
  };
  if (options.signature !== null) headers[HEADERS.signature] = options.signature;
  if (options.orderId) headers[HEADERS.orderId] = options.orderId;
  const started = performance.now();
  try {
    const res = await options.fetch(endpoint, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - started);
    try {
      return { kind: "http", status: res.status, body: JSON.parse(text), text, json: true, ms };
    } catch {
      return { kind: "http", status: res.status, body: undefined, text, json: false, ms };
    }
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    return { kind: "network", error: describeError(error, options.timeoutMs), ms };
  }
}

function describeError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return `${timeoutMs} 毫秒内没有响应`;
    const cause = (error as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? cause.message : "";
    return detail && detail !== error.message ? `${error.message}：${detail}` : error.message;
  }
  return String(error);
}

/** 多个 secret 签同一个请求体，合成一个带多个 v1= 的头（RSP 第 3 节轮换）。 */
export function signWith(secrets: readonly string[], body: string, timestamp: number): string {
  const [first, ...rest] = secrets.map((s) => signBody(s, body, timestamp));
  return [first, ...rest.map((h) => h.slice(h.indexOf(",") + 1))].join(",");
}

/** 一个格式合法、但不是任何 secret 算出来的 v1。 */
export function bogusV1(timestamp: number): string {
  return `t=${timestamp},v1=${"0".repeat(64)}`;
}
