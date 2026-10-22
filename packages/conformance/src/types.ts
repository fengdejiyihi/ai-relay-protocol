import type { Issue, PolicyOptions } from "@dreamcavy/ai-relay-protocol";
import type { SampleInputs } from "./inputs.js";
import type { FetchLike } from "./transport.js";

/** pass 通过；fail 失败（不能接入）；warn 警告（规范里是「应当」，不阻塞）；skip 未测。 */
export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export type CheckGroup = "transport" | "manifest" | "ping" | "auth" | "envelope" | "action";

export interface Check {
  /** 稳定的检查项编号，比如 auth.wrong_secret、invoke.book_slot，后台按它对比前后两次报告。 */
  id: string;
  group: CheckGroup;
  title: string;
  status: CheckStatus;
  /** 给人看的一句话：为什么失败、实际收到了什么。 */
  detail?: string;
  /** Schema 校验错误，逐条带 JSON 指针。 */
  issues?: Issue[];
  /** 这一项用到的 HTTP 往返耗时（毫秒）。 */
  ms?: number;
}

export interface ConformanceOptions {
  /** 清单 JSON（已解析的对象）。 */
  manifest: unknown;
  /** 被测端点。不给时用清单里的 endpoint.url。 */
  endpoint?: string;
  /** 当前 secret。 */
  secret: string;
  /** 轮换期的旧 secret。给了才测「只用旧 secret 签也能通过」。 */
  oldSecret?: string;
  /** 每个动作一份样例输入，键是动作名，按键顺序执行。值里可以用占位符，见 README。 */
  inputs?: SampleInputs;
  /**
   * 要求端点是 HTTPS。默认 false：http 只出警告，方便本机联调。
   * Relay 后台的在线验收传 true，并配合 fetch 用正式地址策略（拒私网）。
   */
  requireHttps?: boolean;
  /** 换掉发请求的 fetch，比如带地址策略的版本。默认全局 fetch。 */
  fetch?: FetchLike;
  /** 单个请求的超时（毫秒），默认 RSP 的同步硬超时 60 秒。 */
  timeoutMs?: number;
  /** 当前时间（毫秒），签名时间戳和 $today 用它。默认 Date.now。 */
  now?: () => number;
  /** $today / $tomorrow 按哪个时区算，默认本机时区。 */
  timeZone?: string;
  /** 平台审核策略选项，透传给 checkPlatformPolicy。 */
  policy?: PolicyOptions;
  /** 信封里的 manifest_version，默认 1。 */
  manifestVersion?: number;
  /** 每出一项结果回调一次，命令行用它边跑边打印。 */
  onCheck?: (check: Check) => void;
}

export interface ConformanceSummary {
  pass: number;
  fail: number;
  warn: number;
  skip: number;
}

export interface ConformanceReport {
  tool: { name: string; version: string };
  rsp: string;
  endpoint: string;
  /** ISO 时间。 */
  startedAt: string;
  durationMs: number;
  /** 没有一项失败。警告和未测不影响。 */
  ok: boolean;
  summary: ConformanceSummary;
  checks: Check[];
}
