import type { Issue, PolicyOptions } from "@dreamcavy/ai-relay-protocol";
import type { SampleInputs } from "./inputs.js";
import type { CallbackStore } from "./receiver.js";
import type { FetchLike } from "./transport.js";

/** pass 通过；fail 失败（不能接入）；warn 警告（规范里是「应当」，不阻塞）；skip 未测。 */
export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export type CheckGroup = "transport" | "manifest" | "ping" | "auth" | "envelope" | "binding" | "action" | "async" | "callback";

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
  /**
   * 回调接收端的订单存放处。给了才验回调：命令行用 startCallbackReceiver 起本地接收端，
   * Relay 在线版用数据库实现（回调落到正式回调地址）。不给时异步动作只靠 task.poll 验。
   */
  callbacks?: CallbackStore;
  /** 回调根地址（{callbackUrl}/v1/callbacks/{order_id}），只用在报告的提示里。 */
  callbackUrl?: string;
  /** 异步动作等最终结果的上限（毫秒），默认 120000。 */
  asyncTimeoutMs?: number;
  /**
   * 整次验收的时间预算（毫秒）。所有异步动作共用：用完后还没结果的判超时，取消用例标未测。
   * 默认不限。Relay 在线验收在一个 HTTP 请求里跑完，用它守住反向代理的读超时。
   */
  totalTimeoutMs?: number;
  /** 异步动作 task.poll 的间隔（毫秒），默认 3000。 */
  pollIntervalMs?: number;
  /** 异步动作跑完后再等多久收迟到的回调（毫秒），默认 min(2000, pollIntervalMs)。 */
  settleMs?: number;
  /** user_binding=token 的供给方：用户在供给方页面生成的一次性绑定码。不给时绑定成功的用例标未测。 */
  bindingCode?: string;
  /**
   * 直接指定 action.invoke 里的 user.supplier_user_ref（供给方那边的测试账号）。
   * 给了 bindingCode 且绑定成功时，用绑定得到的账号。
   */
  supplierUserRef?: string;
  /** 每个异步动作额外下一单并立刻 task.cancel。默认 true；会多产生一笔测试单。 */
  testCancel?: boolean;
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
