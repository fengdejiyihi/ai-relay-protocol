import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  checkPlatformPolicy,
  compileActionInput,
  type DownstreamType,
  type Issue,
  LIMITS,
  type ManifestAction,
  RETRYABLE_ERROR_CODES,
  RSP_VERSION,
  signBody,
  validateManifest,
  validateResponse,
} from "@dreamcavy/ai-relay-protocol";
import { firstDifference } from "./diff.js";
import {
  activeProposals,
  applyCancelResponse,
  applyInvokeResponse,
  applyPollResponse,
  applySelectResponse,
  type CallbackVerdict,
  isTerminalStatus,
  newTestOrder,
  type ReceivedCallback,
} from "./callbacks.js";
import { resolveInput } from "./inputs.js";
import { memoryStore } from "./receiver.js";
import { bogusV1, type Exchange, type FetchLike, post } from "./transport.js";
import type { Check, CheckGroup, CheckStatus, ConformanceOptions, ConformanceReport } from "./types.js";

/** 本工具的包名和版本，写进报告。 */
export const TOOL = readTool();

/** 规范第 2 节：供给方应当在 3 秒内响应。 */
const SLOW_MS = 3_000;
/** 异步动作等最终结果的默认上限。 */
export const DEFAULT_ASYNC_TIMEOUT_MS = 120_000;
/** 验收时 task.poll 的默认间隔。Relay 正式补拉按 1、2、5、15 分钟退避，验收等不了那么久。 */
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
/** 验收用的假名用户，供给方日志里一眼能认出来。 */
const RELAY_UID = "u_conformance_probe";
/** 测绑定码一次性时冒充的另一个用户。 */
const OTHER_RELAY_UID = "u_conformance_other";

interface Recorded {
  where: string;
  type: DownstreamType;
  body: unknown;
}

/**
 * 对一个供给方端点做 RSP 1.0 接入验收，返回结构化报告。不抛异常：连不上、超时都记在报告里。
 * 会真的调用 inputs 里的动作，请接测试环境或用可撤销的样例。
 */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const now = options.now ?? Date.now;
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? LIMITS.syncHardTimeoutMs;
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const asyncTimeoutMs = options.asyncTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS;
  /** 整次验收的截止时间（performance.now() 刻度）。异步动作等结果不会超过它。 */
  const runDeadline = options.totalTimeoutMs === undefined ? Infinity : performance.now() + options.totalTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const settleMs = options.settleMs ?? Math.min(2_000, pollIntervalMs);
  const startedAt = new Date(now()).toISOString();
  const t0 = performance.now();

  const checks: Check[] = [];
  const recorded: Recorded[] = [];
  const latencies: { where: string; ms: number }[] = [];
  /** 不为空时，所有需要发请求的检查都跳过，值是原因。 */
  let blocked: string | null = null;

  const add = (check: Check): Check => {
    checks.push(check);
    options.onCheck?.(check);
    return check;
  };
  const make = (id: string, group: CheckGroup, title: string, status: CheckStatus, extra: Partial<Check> = {}): Check =>
    add({ id, group, title, status, ...dropUndefined(extra) });

  const seconds = () => Math.floor(now() / 1000);
  const send = async (envelope: Record<string, unknown> | string, signature: (body: string) => string | null, where: string) => {
    const body = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
    const orderId = typeof envelope === "string" ? undefined : (envelope.order_id as string | undefined);
    const ex = await post(endpoint, body, { signature: signature(body), timeoutMs, fetch: fetchFn, ...(orderId ? { orderId } : {}) });
    latencies.push({ where, ms: ex.ms });
    return ex;
  };
  const signed = (secret: string) => (body: string) => signBody(secret, body, seconds());
  const pingEnvelope = (extra: Record<string, unknown> = {}) => ({
    type: "ping",
    rsp: RSP_VERSION,
    issued_at: seconds(),
    challenge: randomBytes(18).toString("base64url"),
    ...extra,
  });

  // ───────────── 清单 ─────────────
  const manifestResult = validateManifest(options.manifest);
  if (manifestResult.ok) {
    make("manifest.schema", "manifest", "清单符合 RSP 1.0 Schema", manifestResult.warnings.length ? "warn" : "pass", {
      ...(manifestResult.warnings.length ? { detail: "清单有效，但有建议修改的地方", issues: manifestResult.warnings } : {}),
    });
    const policy = checkPlatformPolicy(manifestResult.manifest, options.policy);
    const status: CheckStatus = policy.errors.length ? "fail" : policy.warnings.length ? "warn" : "pass";
    make("manifest.policy", "manifest", "清单符合平台审核策略", status, {
      ...(status === "pass" ? {} : { issues: [...policy.errors, ...policy.warnings] }),
      ...(status === "fail" ? { detail: "按当前平台策略不予通过" } : {}),
    });
  } else {
    make("manifest.schema", "manifest", "清单符合 RSP 1.0 Schema", "fail", { issues: manifestResult.errors, detail: "清单不合法，动作检查全部跳过" });
    make("manifest.policy", "manifest", "清单符合平台审核策略", "skip", { detail: "清单不合法，先修清单" });
  }

  // ───────────── 端点 ─────────────
  const manifestUrl = manifestEndpoint(options.manifest);
  const endpoint = options.endpoint ?? manifestUrl ?? "";
  let url: URL | null = null;
  try {
    url = new URL(endpoint);
  } catch {
    make("transport.endpoint", "transport", "端点地址有效", "fail", {
      detail: endpoint ? `不是合法的 URL：${endpoint}` : "清单里没有 endpoint.url，也没有单独指定端点",
    });
    blocked = "端点地址无效";
  }
  if (url) {
    if (url.protocol === "https:") {
      make("transport.https", "transport", "端点使用 HTTPS", "pass");
    } else if (url.protocol === "http:") {
      make("transport.https", "transport", "端点使用 HTTPS", options.requireHttps ? "fail" : "warn", {
        detail: options.requireHttps ? "正式接入要求 HTTPS（规范第 2 节）" : "本机联调可以用 http，正式接入必须是 HTTPS（规范第 2 节）",
      });
      if (options.requireHttps) blocked = "端点不是 HTTPS";
    } else {
      make("transport.endpoint", "transport", "端点地址有效", "fail", { detail: `不支持的协议 ${url.protocol}` });
      blocked = "端点地址无效";
    }
    if (manifestUrl && options.endpoint && options.endpoint !== manifestUrl) {
      make("transport.endpoint_match", "transport", "测的就是清单里的端点", "warn", {
        detail: `清单里写的是 ${manifestUrl}，这次测的是 ${options.endpoint}。上线前用清单里的地址再测一次`,
      });
    }
  }

  const skipNet = (id: string, group: CheckGroup, title: string) => make(id, group, title, "skip", { detail: blocked! });

  // ───────────── ping ─────────────
  if (blocked) {
    skipNet("ping", "ping", "ping 原样带回 challenge");
  } else {
    const env = pingEnvelope();
    const ex = await send(env, signed(options.secret), "ping");
    const verdict = expectPingOk(ex, env.challenge);
    make("ping", "ping", "ping 原样带回 challenge", verdict.status, { ...verdict.extra, ms: ex.ms });
    if (ex.kind === "network") blocked = `端点连不上（${ex.error}）`;
    if (ex.kind === "http" && ex.status === 200 && ex.json) recorded.push({ where: "ping", type: "ping", body: ex.body });
  }

  // ───────────── 验签 ─────────────
  const rejectCase = async (id: string, title: string, build: () => { body: string; signature: string | null }) => {
    if (blocked) return skipNet(id, "auth", title);
    const { body, signature } = build();
    const ex = await send(body, () => signature, id);
    if (ex.kind === "network") return make(id, "auth", title, "fail", { detail: `请求没拿到响应：${ex.error}`, ms: ex.ms });
    if (ex.status === 401 || ex.status === 403) return make(id, "auth", title, "pass", { detail: `HTTP ${ex.status}`, ms: ex.ms });
    return make(id, "auth", title, "fail", {
      detail:
        ex.status === 200
          ? "回了 HTTP 200，说明没有验签或验签有漏洞。必须回 401 或 403（规范第 2、3 节）"
          : `必须回 401 或 403，实际 HTTP ${ex.status}${snippet(ex.text)}`,
      ms: ex.ms,
    });
  };
  const acceptCase = async (id: string, title: string, sign: (body: string) => string) => {
    if (blocked) return skipNet(id, "auth", title);
    const env = pingEnvelope();
    const ex = await send(env, sign, id);
    const verdict = expectPingOk(ex, env.challenge);
    return make(id, "auth", title, verdict.status, { ...verdict.extra, ms: ex.ms });
  };

  await rejectCase("auth.missing", "没有签名头被拒绝", () => ({ body: JSON.stringify(pingEnvelope()), signature: null }));
  await rejectCase("auth.wrong_secret", "错误 secret 的签名被拒绝", () => {
    const body = JSON.stringify(pingEnvelope());
    // 每次随机生成，不可能碰巧等于被测端点的 secret
    const wrong = `whsec_conformance_${randomBytes(16).toString("hex")}`;
    return { body, signature: signBody(wrong, body, seconds()) };
  });
  await rejectCase("auth.expired", "时间戳超过 5 分钟被拒绝", () => {
    const body = JSON.stringify(pingEnvelope());
    return { body, signature: signBody(options.secret, body, seconds() - LIMITS.signatureToleranceSeconds - 300) };
  });
  await rejectCase("auth.tampered", "签名后改动请求体被拒绝", () => {
    const env = pingEnvelope();
    const signature = signBody(options.secret, JSON.stringify(env), seconds());
    return { body: JSON.stringify({ ...env, challenge: `${env.challenge}x` }), signature };
  });
  await acceptCase("auth.multi_v1", "带多个 v1= 时任一匹配即通过", (body) => {
    const ts = seconds();
    const good = signBody(options.secret, body, ts);
    return `${bogusV1(ts)},${good.slice(good.indexOf(",") + 1)}`;
  });
  if (options.oldSecret) {
    await acceptCase("auth.old_secret", "轮换期内只用旧 secret 签也通过", signed(options.oldSecret));
  } else {
    make("auth.old_secret", "auth", "轮换期内只用旧 secret 签也通过", "skip", { detail: "没有提供旧 secret，未测" });
  }

  // ───────────── 信封 ─────────────
  if (blocked) {
    skipNet("envelope.unknown_type", "envelope", "不认识的 type 回 not_supported");
    skipNet("envelope.forward_compat", "envelope", "忽略未知字段、接受 1.x 小版本");
  } else {
    const env = { type: "conformance.probe", rsp: RSP_VERSION, issued_at: seconds(), probe: randomBytes(8).toString("hex") };
    const ex = await send(env, signed(options.secret), "envelope.unknown_type");
    const title = "不认识的 type 回 not_supported";
    if (ex.kind === "network") {
      make("envelope.unknown_type", "envelope", title, "fail", { detail: `请求没拿到响应：${ex.error}`, ms: ex.ms });
    } else if (ex.status !== 200 || !ex.json) {
      make("envelope.unknown_type", "envelope", title, "fail", {
        detail: `必须回 HTTP 200 + {"status":"failed","error":{"code":"not_supported"}}，实际 HTTP ${ex.status}${ex.json ? "" : "，响应体不是 JSON"}${snippet(ex.text)}`,
        ms: ex.ms,
      });
    } else {
      const shape = validateResponse("action.invoke", ex.body);
      const code = (ex.body as { error?: { code?: unknown } } | null)?.error?.code;
      if (!shape.ok || (ex.body as { status?: unknown }).status !== "failed") {
        make("envelope.unknown_type", "envelope", title, "fail", {
          detail: '必须回 {"status":"failed","error":{"code":"not_supported"}}（规范第 5 节）',
          ...(shape.ok ? {} : { issues: shape.errors }),
          ms: ex.ms,
        });
      } else if (code !== "not_supported") {
        make("envelope.unknown_type", "envelope", title, "fail", {
          detail: `错误码必须是 not_supported，实际是 ${String(code)}。新增信封类型时，已接通的动作才不受影响（规范第 5、14 节）`,
          ms: ex.ms,
        });
      } else {
        make("envelope.unknown_type", "envelope", title, "pass", { ms: ex.ms });
      }
      recorded.push({ where: "envelope.unknown_type", type: "action.invoke", body: ex.body });
    }

    const future = pingEnvelope({ rsp: "1.9", x_conformance_future: { note: "1.x 以后可能新增的字段" } });
    const fx = await send(future, signed(options.secret), "envelope.forward_compat");
    const fv = expectPingOk(fx, future.challenge);
    make("envelope.forward_compat", "envelope", "忽略未知字段、接受 1.x 小版本", fv.status, {
      ...(fv.status === "pass"
        ? {}
        : { detail: `rsp 为 "1.9"、带一个未知字段的 ping 没有正常处理：${fv.extra.detail ?? ""}。供给方必须忽略不认识的字段并接受任何 1.x（规范第 14 节）` }),
      ...(fv.extra.issues ? { issues: fv.extra.issues } : {}),
      ms: fx.ms,
    });
  }

  // ───────────── 账号绑定 ─────────────
  /** binding.verify 成功后拿到的账号标识，之后的 action.invoke 都带上。 */
  let supplierUserRef: string | null = options.supplierUserRef ?? null;
  if (manifestResult.ok && manifestResult.manifest.supplier.user_binding === "token") {
    supplierUserRef = (await runBinding()) ?? supplierUserRef;
  }

  async function verifyBinding(code: string, relayUid = RELAY_UID) {
    const env = { type: "binding.verify", rsp: RSP_VERSION, issued_at: seconds(), relay_uid: relayUid, code };
    const ex = await send(env, signed(options.secret), "binding.verify");
    return { ex, r: expectResponse(ex, "binding.verify") };
  }

  async function runBinding(): Promise<string | null> {
    const invalidTitle = "无效的绑定码不能绑定";
    const verifyTitle = "binding.verify 用有效绑定码绑定成功";
    const reuseTitle = "绑定码不能被另一个用户再用";
    if (blocked) {
      skipNet("binding.invalid_code", "binding", invalidTitle);
      skipNet("binding.verify", "binding", verifyTitle);
      return null;
    }
    const bogus = await verifyBinding(`conformance-${randomBytes(6).toString("hex")}`);
    if (!bogus.r.ok) {
      make("binding.invalid_code", "binding", invalidTitle, "fail", { ...bogus.r.extra, ms: bogus.ex.ms });
    } else {
      recorded.push({ where: "binding.invalid_code", type: "binding.verify", body: bogus.r.body });
      make("binding.invalid_code", "binding", invalidTitle, bogus.r.body.status === "failed" ? "pass" : "fail", {
        ...(bogus.r.body.status === "failed" ? {} : { detail: "随便编的绑定码也回了 bound。必须核对绑定码是本产品生成、未过期、未使用（规范第 11 节）" }),
        ms: bogus.ex.ms,
      });
    }

    if (!options.bindingCode) {
      make("binding.verify", "binding", verifyTitle, "skip", {
        detail: supplierUserRef
          ? `没有提供绑定码（命令行 --binding-code），未测。动作调用带指定的 supplier_user_ref = ${supplierUserRef}`
          : "没有提供绑定码（命令行 --binding-code），未测。需要绑定的动作会以未绑定身份（supplier_user_ref 为 null）调用；也可以用 --supplier-user-ref 直接指定测试账号",
      });
      return null;
    }
    const first = await verifyBinding(options.bindingCode);
    if (!first.r.ok) {
      make("binding.verify", "binding", verifyTitle, "fail", { ...first.r.extra, ms: first.ex.ms });
      return null;
    }
    recorded.push({ where: "binding.verify", type: "binding.verify", body: first.r.body });
    if (first.r.body.status !== "bound") {
      const err = first.r.body.error as { code?: string; message?: string } | undefined;
      make("binding.verify", "binding", verifyTitle, "fail", {
        detail: `回了 failed（${err?.code ?? "无错误码"}${err?.message ? `：${err.message}` : ""}）。绑定码一次性、10 分钟内有效，重新生成一个再测`,
        ms: first.ex.ms,
      });
      return null;
    }
    const ref = first.r.body.supplier_user_ref as string;
    make("binding.verify", "binding", verifyTitle, "pass", { detail: `supplier_user_ref = ${ref}`, ms: first.ex.ms });

    // 同一个用户重发 binding.verify（Relay 网络重试）可以再回 bound；换一个用户必须拒绝。
    const again = await verifyBinding(options.bindingCode, OTHER_RELAY_UID);
    if (!again.r.ok) {
      make("binding.reuse", "binding", reuseTitle, "fail", { ...again.r.extra, ms: again.ex.ms });
    } else {
      make("binding.reuse", "binding", reuseTitle, again.r.body.status === "failed" ? "pass" : "warn", {
        ...(again.r.body.status === "failed" ? {} : { detail: "已经被一个用户用掉的绑定码，换一个 relay_uid 又回了 bound。绑定码应当一次性（规范第 11 节）" }),
        ms: again.ex.ms,
      });
    }
    return ref;
  }

  // ───────────── 动作 ─────────────
  const store = options.callbacks ?? memoryStore();
  /** 本次验收下发的异步订单，最后汇总回调检查。 */
  const asyncOrders: string[] = [];

  if (!manifestResult.ok) {
    make("actions", "action", "动作调用", "skip", { detail: "清单不合法，动作没有测" });
  } else {
    const actions = new Map(manifestResult.manifest.actions.map((a) => [a.name, a]));
    const inputs = options.inputs ?? {};
    for (const name of Object.keys(inputs)) {
      if (!actions.has(name)) make(`inputs.${name}`, "action", `样例输入 ${name}`, "warn", { detail: `清单里没有动作 ${name}，这份样例输入没用上` });
    }
    const order = [
      ...Object.keys(inputs).filter((n) => actions.has(n)),
      ...manifestResult.manifest.actions.map((a) => a.name).filter((n) => !(n in inputs)),
    ];
    const outputs = new Map<string, unknown>();
    for (const name of order) {
      await runAction(actions.get(name)!, inputs[name], outputs);
    }
  }

  function invokeEnvelope(action: ManifestAction, input: Record<string, unknown>) {
    const orderId = newOrderId();
    return {
      type: "action.invoke",
      rsp: RSP_VERSION,
      issued_at: seconds(),
      order_id: orderId,
      action: action.name,
      manifest_version: options.manifestVersion ?? 1,
      input,
      user: { relay_uid: RELAY_UID, display_name: "Conformance", supplier_user_ref: supplierUserRef },
      idempotency_key: orderId,
    };
  }

  async function runAction(action: ManifestAction, sample: Record<string, unknown> | undefined, outputs: Map<string, unknown>) {
    const name = action.name;
    const invokeTitle = `调用 ${name}`;
    if (sample === undefined) {
      make(`invoke.${name}`, "action", invokeTitle, "skip", { detail: "没有样例输入，未测" });
      return;
    }
    if (blocked) {
      skipNet(`invoke.${name}`, "action", invokeTitle);
      return;
    }
    const resolved = resolveInput(sample, { outputs, nowMs: now(), timeZone });
    if (!resolved.ok) {
      make(`invoke.${name}`, "action", invokeTitle, "skip", { detail: resolved.reason });
      return;
    }
    const inputCheck = compileActionInput(action.input)(resolved.value);
    if (!inputCheck.ok) {
      make(`invoke.${name}`, "action", invokeTitle, "skip", {
        detail: "样例输入不符合清单里的 input Schema，Relay 不会发这样的请求，未测",
        issues: inputCheck.errors,
      });
      return;
    }

    const envelope = invokeEnvelope(action, resolved.value);
    const orderId = envelope.order_id;
    // 回调可能比同步响应先到，异步动作先登记再下发。
    if (action.mode !== "sync") await store.create(newTestOrder(orderId, name, action.mode));
    const body = JSON.stringify(envelope);
    const ex = await send(envelope, signed(options.secret), `invoke.${name}`);
    const first = expectResponse(ex, "action.invoke");
    if (!first.ok) {
      make(`invoke.${name}`, "action", invokeTitle, "fail", { ...first.extra, ms: ex.ms });
      return;
    }
    recorded.push({ where: `invoke.${name}`, type: "action.invoke", body: first.body });
    const status = first.body.status as string;
    const error = first.body.error as { code?: string; message?: string } | undefined;
    if (status === "accepted") {
      if (action.mode === "sync") await store.create(newTestOrder(orderId, name, action.mode));
      asyncOrders.push(orderId);
    }
    await store.update(orderId, (o) => (applyInvokeResponse(o, first.body as never), o));
    if (status === "failed") {
      make(`invoke.${name}`, "action", invokeTitle, "warn", {
        detail: `响应格式正确，但动作返回 failed（${error?.code}${error?.message ? `：${error.message}` : ""}）。检查样例输入是否能走通`,
        ms: ex.ms,
      });
    } else {
      make(`invoke.${name}`, "action", invokeTitle, "pass", { detail: status, ms: ex.ms });
    }

    // 同步结果的输出 Schema
    if (status === "completed") {
      const data = (first.body.output as { data: unknown }).data;
      outputs.set(name, data);
      checkOutput(action, data);
    } else if (status === "failed") {
      make(`output.${name}`, "action", `${name} 的 output.data 符合清单`, "skip", { detail: "动作返回 failed，未测" });
    }

    // 同键重放：请求体不变，重新签名
    const replayTitle = `${name} 同一 idempotency_key 重放结果一致`;
    if (status === "failed" && (RETRYABLE_ERROR_CODES as readonly string[]).includes(error?.code ?? "")) {
      make(`replay.${name}`, "action", replayTitle, "skip", { detail: `第一次是 ${error?.code}，规范第 10 节规定不得缓存，不比对` });
    } else {
      const again = await send(body, signed(options.secret), `replay.${name}`);
      const second = expectResponse(again, "action.invoke");
      if (!second.ok) {
        make(`replay.${name}`, "action", replayTitle, "fail", { ...second.extra, ms: again.ms });
      } else {
        const diff = firstDifference(first.body, second.body);
        make(`replay.${name}`, "action", replayTitle, diff === null ? "pass" : "fail", {
          ...(diff === null
            ? {}
            : { detail: `第二次响应和第一次不同（${diff}）。同一个键必须返回第一次的最终结果，不得重复执行（规范第 10 节）` }),
          ms: again.ms,
        });
      }
    }

    if (status !== "accepted") return;
    const data = await followAsync(action, orderId, first.body.task_id as string);
    if (data !== undefined) outputs.set(name, data);
    if (options.testCancel === false) return;
    if (performance.now() >= runDeadline) {
      make(`cancel.${name}`, "async", `${name} 的 task.cancel 响应合法`, "skip", { detail: "整次验收的时间预算用完，未测" });
      return;
    }
    await runCancel(action, resolved.value);
  }

  function checkOutput(action: ManifestAction, data: unknown) {
    const title = `${action.name} 的 output.data 符合清单`;
    if (!action.output) return make(`output.${action.name}`, "action", title, "skip", { detail: "清单没有声明 output" });
    const checked = compileActionInput(action.output)(data);
    return make(`output.${action.name}`, "action", title, checked.ok ? "pass" : "warn", {
      ...(checked.ok ? {} : { detail: "output.data 应当符合动作的 output Schema（规范第 8 节）", issues: checked.errors }),
    });
  }

  /** 发一个 task.* / proposal.select 信封，按对应的响应 Schema 校验。 */
  async function sendTask(type: "task.poll" | "task.cancel" | "proposal.select", orderId: string, taskId: string, extra: Record<string, unknown>, where: string) {
    const env = { type, rsp: RSP_VERSION, issued_at: seconds(), order_id: orderId, task_id: taskId, ...extra };
    const ex = await send(env, signed(options.secret), where);
    const r = expectResponse(ex, type);
    if (r.ok) recorded.push({ where, type, body: r.body });
    return { ex, r };
  }

  /**
   * 异步单：按 pollIntervalMs 发 task.poll，同时看回调接收端，直到终态或超时。
   * 多方案单有了有效方案就选第一个（先用一个不存在的方案号试一次 proposal.select），已选的被撤回就再选。
   * 返回 completed 的 output.data。
   */
  async function followAsync(action: ManifestAction, orderId: string, taskId: string): Promise<unknown> {
    const name = action.name;
    const multi = action.mode === "async_multi";
    const started = performance.now();
    const deadline = Math.min(performance.now() + asyncTimeoutMs, runDeadline);
    const waitedFor = () => `${Math.round((deadline - started) / 1000)} 秒${deadline === runDeadline ? "（整次验收的时间预算用完）" : ""}`;
    const conflicts: string[] = [];
    const pollFailures: string[] = [];
    const pollIssues: Issue[] = [];
    const pollStatuses = new Map<string, number>();
    const selectFailures: string[] = [];
    const selectIssues: Issue[] = [];
    const selected: string[] = [];
    let probed = false;
    let lastPoll = -Infinity;

    const poll = async () => {
      lastPoll = performance.now();
      const { r } = await sendTask("task.poll", orderId, taskId, {}, `poll.${name}`);
      if (!r.ok) {
        pollFailures.push(r.extra.detail);
        if (r.extra.issues) pollIssues.push(...r.extra.issues);
        return;
      }
      const s = r.body.status as string;
      pollStatuses.set(s, (pollStatuses.get(s) ?? 0) + 1);
      if (s === "proposals" && !multi) pollFailures.push(`动作 mode 是 ${action.mode}，task.poll 却回了 proposals`);
      const code = (r.body.error as { code?: string } | undefined)?.code ?? "";
      // 可重试的失败不是最终结果，下一轮接着补拉。
      if (s === "failed" && (RETRYABLE_ERROR_CODES as readonly string[]).includes(code)) return;
      await store.update(orderId, (o) => {
        const c = applyPollResponse(o, r.body as never);
        if (c) conflicts.push(c);
        return o;
      });
    };

    const select = async (proposalId: string, where: string) => (await sendTask("proposal.select", orderId, taskId, { proposal_id: proposalId }, where)).r;

    for (;;) {
      let o = (await store.get(orderId))!;
      if (isTerminalStatus(o.status)) break;
      if (performance.now() > deadline) break;

      if (multi && !o.selected) {
        const active = activeProposals(o);
        if (active.length > 0) {
          if (!probed) {
            probed = true;
            const bogus = `p_conformance_${randomBytes(6).toString("hex")}`;
            const r = await select(bogus, `select_unknown.${name}`);
            if (!r.ok) {
              make(`select_unknown.${name}`, "async", `${name} 选不存在的方案被拒绝`, "fail", r.extra);
            } else {
              make(`select_unknown.${name}`, "async", `${name} 选不存在的方案被拒绝`, r.body.status === "failed" ? "pass" : "fail", {
                ...(r.body.status === "failed" ? {} : { detail: `proposal.select 选一个从没出现过的方案也回了 ${String(r.body.status)}。必须核对方案属于这个任务、仍然有效` }),
              });
            }
          }
          const target = active.find((p) => !selected.includes(p)) ?? active[0]!;
          if (selected.length >= 5) {
            selectFailures.push("已经选了 5 次方案仍然没有完成，放弃");
            break;
          }
          selected.push(target);
          const r = await select(target, `select.${name}`);
          if (!r.ok) {
            selectFailures.push(r.extra.detail);
            if (r.extra.issues) selectIssues.push(...r.extra.issues);
            break;
          }
          const s = r.body.status as string;
          if (s === "failed") {
            // 选的时候方案刚好被撤回不算错；否则是供给方拒绝了一个有效方案。
            o = (await store.get(orderId))!;
            if (!o.proposals.find((p) => p.proposal_id === target)?.withdrawn) {
              const err = r.body.error as { code?: string; message?: string } | undefined;
              selectFailures.push(`选有效方案 ${target} 回了 failed（${err?.code ?? "无错误码"}${err?.message ? `：${err.message}` : ""}）`);
              break;
            }
          } else {
            await store.update(orderId, (x) => {
              const c = applySelectResponse(x, target, r.body as never);
              if (c) conflicts.push(c);
              return x;
            });
          }
          continue;
        }
      }

      if (performance.now() - lastPoll >= pollIntervalMs) await poll();
      else await sleep(Math.min(100, pollIntervalMs));
    }

    let final = (await store.get(orderId))!;
    // 终态从回调得知时，再补拉一次核对：task.poll 也必须给出同一个最终结果。
    if (isTerminalStatus(final.status) && final.terminal?.source !== "poll" && final.status !== "cancelled") {
      await poll();
      final = (await store.get(orderId))!;
    }

    // task.poll
    const pollTitle = `${name} 的 task.poll 响应合法`;
    const polled = [...pollStatuses.values()].reduce((a, b) => a + b, 0) + pollFailures.length;
    if (polled === 0) {
      make(`poll.${name}`, "async", pollTitle, "skip", { detail: "没来得及补拉就有了结果" });
    } else {
      make(`poll.${name}`, "async", pollTitle, pollFailures.length ? "fail" : "pass", {
        detail: pollFailures.length
          ? `${pollFailures[0]}${pollFailures.length > 1 ? `（共 ${pollFailures.length} 次有问题）` : ""}`
          : `补拉 ${polled} 次：${[...pollStatuses].map(([s, n]) => `${s} × ${n}`).join("，")}`,
        ...(pollIssues.length ? { issues: pollIssues } : {}),
      });
    }

    // 多方案
    if (multi) {
      const title = `${name} 收到方案并选定`;
      const viaCallback = final.proposals.filter((p) => p.via === "callback").length;
      const withdrawn = final.proposals.filter((p) => p.withdrawn).length;
      const summary = `收到 ${final.proposals.length} 个方案（回调 ${viaCallback} 个），撤回 ${withdrawn} 个，选了 ${selected.length} 次`;
      if (!probed) make(`select_unknown.${name}`, "async", `${name} 选不存在的方案被拒绝`, "skip", { detail: "没有收到方案，未测" });
      if (selectFailures.length) {
        make(`proposal.${name}`, "async", title, "fail", { detail: `${selectFailures[0]}。${summary}`, ...(selectIssues.length ? { issues: selectIssues } : {}) });
      } else if (final.proposals.length === 0) {
        make(`proposal.${name}`, "async", title, "fail", { detail: `${waitedFor()}内没有收到任何方案（proposal.add 回调或 task.poll 的 proposals）` });
      } else {
        make(`proposal.${name}`, "async", title, "pass", { detail: summary });
      }
    }

    // 最终结果
    const asyncTitle = `${name} 异步任务按时给出最终结果`;
    if (conflicts.length) {
      make(`async.${name}`, "async", asyncTitle, "fail", { detail: conflicts[0]! });
    } else if (!isTerminalStatus(final.status)) {
      make(`async.${name}`, "async", asyncTitle, "fail", {
        detail: `${waitedFor()}内没有终态（回调和 task.poll 都没有给出 completed 或 failed），当前 ${final.status}`,
      });
    } else {
      const t = final.terminal!;
      const via = { response: "proposal.select 的响应", callback: "回调", poll: "task.poll", cancel: "task.cancel" }[t.source];
      const status = t.status === "failed" ? "warn" : "pass";
      const err = t.status === "failed" ? (t.result as { code?: string; message?: string }) : undefined;
      make(`async.${name}`, "async", asyncTitle, status, {
        detail:
          status === "warn"
            ? `最终结果是 failed（${err?.code}${err?.message ? `：${err.message}` : ""}，来自${via}）。检查样例输入是否能走通`
            : `${t.status}（来自${via}）`,
      });
    }

    if (final.terminal?.status === "completed") {
      const data = (final.terminal.result as { data?: unknown } | undefined)?.data;
      checkOutput(action, data);
      return data;
    }
    make(`output.${name}`, "action", `${name} 的 output.data 符合清单`, "skip", { detail: "没有拿到 completed 结果，未测" });
    return undefined;
  }

  /** 再下一单同样的异步任务，立刻 task.cancel（reason user_cancelled）。 */
  async function runCancel(action: ManifestAction, input: Record<string, unknown>) {
    const name = action.name;
    const title = `${name} 的 task.cancel 响应合法`;
    const envelope = invokeEnvelope(action, input);
    const orderId = envelope.order_id;
    await store.create(newTestOrder(orderId, name, action.mode));
    const ex = await send(envelope, signed(options.secret), `cancel.${name}`);
    const r = expectResponse(ex, "action.invoke");
    if (!r.ok || r.body.status !== "accepted") {
      make(`cancel.${name}`, "async", title, "skip", { detail: `为测取消再下的一单没有回 accepted${r.ok ? `（回了 ${String(r.body.status)}）` : `：${r.extra.detail}`}，未测` });
      return;
    }
    asyncOrders.push(orderId);
    const taskId = r.body.task_id as string;
    await store.update(orderId, (o) => (applyInvokeResponse(o, r.body as never), o));

    const c1 = await sendTask("task.cancel", orderId, taskId, { reason: "user_cancelled" }, `cancel.${name}`);
    if (!c1.r.ok) {
      make(`cancel.${name}`, "async", title, "fail", { ...c1.r.extra, ms: c1.ex.ms });
      return;
    }
    const cancelBody = c1.r.body;
    let conflict: string | null = null;
    await store.update(orderId, (o) => ((conflict = applyCancelResponse(o, cancelBody as never)), o));
    const s = cancelBody.status as string;
    if (conflict) {
      make(`cancel.${name}`, "async", title, "fail", { detail: conflict, ms: c1.ex.ms });
      return;
    }
    if (s === "cancel_failed") {
      make(`cancel.${name}`, "async", title, "pass", { detail: "刚接单就取消，供给方回 cancel_failed（已不可撤回）", ms: c1.ex.ms });
      return;
    }
    if (s === "failed") {
      const err = cancelBody.error as { code?: string; message?: string } | undefined;
      make(`cancel.${name}`, "async", title, "warn", {
        detail: `刚接单就取消回了 failed（${err?.code ?? "无错误码"}${err?.message ? `：${err.message}` : ""}）。还能撤回时应当回 cancelled，已不能撤回时回 cancel_failed`,
        ms: c1.ex.ms,
      });
      return;
    }

    // cancelled：再取消一次应当仍是 cancelled；补拉不能再说 completed。
    const problems: string[] = [];
    let level: CheckStatus = "pass";
    const c2 = await sendTask("task.cancel", orderId, taskId, { reason: "user_cancelled" }, `cancel.${name}`);
    if (!c2.r.ok) {
      problems.push(`第二次 task.cancel：${c2.r.extra.detail}`);
      level = "fail";
    } else if (c2.r.body.status !== "cancelled") {
      problems.push(`第二次 task.cancel 回了 ${String(c2.r.body.status)}，重复取消应当仍回 cancelled`);
      level = "warn";
    }
    const p = await sendTask("task.poll", orderId, taskId, {}, `cancel.${name}`);
    if (!p.r.ok) {
      problems.push(`取消后的 task.poll：${p.r.extra.detail}`);
      level = "fail";
    } else if (p.r.body.status === "completed") {
      problems.push("已经回了 cancelled，task.poll 却说 completed。取消成功的任务不能再完成");
      level = "fail";
    } else if (p.r.body.status !== "failed") {
      problems.push(`已经回了 cancelled，task.poll 还说 ${String(p.r.body.status)}；应当回 failed`);
      if (level === "pass") level = "warn";
    }
    make(`cancel.${name}`, "async", title, level, { detail: problems.length ? problems.join("；") : "cancelled，重复取消仍是 cancelled，之后补拉不再给结果", ms: c1.ex.ms });
  }

  // ───────────── 回调 ─────────────
  if (asyncOrders.length > 0) {
    await sleep(settleMs);
    await summarizeCallbacks();
  }

  async function summarizeCallbacks() {
    if (!options.callbacks) {
      make("callback.receiver", "callback", "回调接收端", "skip", {
        detail: "没有开回调接收端（命令行加 --callback-port），回调未测，只验了 task.poll",
      });
      return;
    }
    const all: { order: string; action: string; cb: ReceivedCallback }[] = [];
    let unsignedExtra = 0;
    let dropped = 0;
    for (const id of asyncOrders) {
      const o = await store.get(id);
      for (const cb of o?.callbacks ?? []) all.push({ order: id, action: o!.action, cb });
      unsignedExtra += o?.unsigned_extra ?? 0;
      dropped += o?.dropped ?? 0;
    }
    const where = options.callbackUrl ? `${options.callbackUrl}/v1/callbacks/{order_id}` : "回调接收端";
    if (all.length === 0) {
      make("callback.received", "callback", "收到回调", "warn", {
        detail: `${asyncOrders.length} 笔异步单一条回调都没收到。确认供给方的回调地址指向 ${where}；只靠 task.poll 也能接入，但用户要多等 1–15 分钟`,
      });
      return;
    }
    const counts = new Map<string, number>();
    for (const { cb } of all) if (cb.type) counts.set(cb.type, (counts.get(cb.type) ?? 0) + 1);
    make("callback.received", "callback", "收到回调", "pass", {
      detail: `${all.length} 条：${[...counts].map(([t, n]) => `${t} × ${n}`).join("，")}${dropped ? `；另有 ${dropped} 条超出明细上限，只计数` : ""}`,
    });

    const group = (id: string, title: string, verdicts: CallbackVerdict[], okDetail: string, uncounted = 0) => {
      const bad = all.filter((x) => verdicts.includes(x.cb.verdict));
      if (bad.length === 0) return make(id, "callback", title, "pass", { detail: okDetail });
      const first = bad[0]!;
      const label = `${first.action} 的 ${first.cb.type ?? "回调"}${first.cb.event_id ? `（${first.cb.event_id}）` : ""}`;
      return make(id, "callback", title, "fail", {
        detail: `${bad.length + uncounted} 条有问题。${label}：${first.cb.detail ?? first.cb.verdict}，Relay 回了 HTTP ${first.cb.http}`,
        ...(bad.some((x) => x.cb.issues) ? { issues: bad.flatMap((x) => (x.cb.issues ?? []).map((i) => ({ ...i, message: `${x.action}：${i.message}` }))) } : {}),
      });
    };
    group("callback.signature", "回调签名正确", ["bad_signature"], "全部用当前 secret 正确签名", unsignedExtra);
    group("callback.schema", "回调符合 Schema，路径和 order_id 一致", ["invalid", "path_mismatch"], "全部合法");
    const dups = all.filter((x) => x.cb.verdict === "duplicate").length;
    group("callback.dedupe", "同一 event_id 重发内容不变", ["duplicate_conflict"], dups ? `${dups} 条重发，内容和第一次一致` : "没有重发");
    group("callback.terminal", "终态之后不再改状态", ["after_terminal"], "终态之后没有再改状态的回调");
    group("callback.state", "事件符合订单当前状态和模式", ["rejected_state"], "全部被接受");
  }

  // ───────────── 汇总类检查 ─────────────
  if (latencies.length) {
    const slowest = latencies.reduce((a, b) => (b.ms > a.ms ? b : a));
    make("transport.latency", "transport", "3 秒内响应", slowest.ms > SLOW_MS ? "warn" : "pass", {
      detail:
        slowest.ms > SLOW_MS
          ? `最慢的是 ${slowest.where}，${slowest.ms} 毫秒。规范第 2 节要求应当在 3 秒内响应，超过 20 秒 AI 先收到 pending`
          : `最慢 ${slowest.ms} 毫秒`,
    });
  }
  if (recorded.length) {
    const issues: Issue[] = [];
    for (const r of recorded) {
      const strict = validateResponse(r.type, r.body, { strict: true });
      if (!strict.ok) issues.push(...strict.errors.map((e) => ({ ...e, message: `${r.where}：${e.message}` })));
    }
    make("envelope.extra_fields", "envelope", "响应里没有 Schema 外的字段", issues.length ? "warn" : "pass", {
      ...(issues.length ? { detail: "Relay 会忽略这些字段，不影响接入；建议去掉（规范第 6、14 节）", issues } : {}),
    });
  }

  const summary = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const c of checks) summary[c.status] += 1;
  return {
    tool: TOOL,
    rsp: RSP_VERSION,
    endpoint,
    startedAt,
    durationMs: Math.round(performance.now() - t0),
    ok: summary.fail === 0,
    summary,
    checks,
  };
}

type Verdict = { status: CheckStatus; extra: { detail?: string; issues?: Issue[] } };

function expectPingOk(ex: Exchange, challenge: string): Verdict {
  const r = expectResponse(ex, "ping");
  if (!r.ok) return { status: "fail", extra: r.extra };
  if (r.body.status !== "ok") {
    const err = r.body.error as { code?: string } | undefined;
    return { status: "fail", extra: { detail: `回了 failed（${err?.code ?? "无错误码"}），应当回 {"status":"ok"} 并原样带回 challenge` } };
  }
  if (r.body.challenge !== challenge) return { status: "fail", extra: { detail: "challenge 没有原样带回" } };
  return { status: "pass", extra: {} };
}

type ResponseCheck = { ok: true; body: Record<string, unknown> } | { ok: false; extra: { detail: string; issues?: Issue[] } };

function expectResponse(ex: Exchange, type: DownstreamType): ResponseCheck {
  if (ex.kind === "network") return { ok: false, extra: { detail: `请求没拿到响应：${ex.error}` } };
  if (ex.status !== 200) {
    const hint = ex.status === 401 || ex.status === 403 ? "。正确签名的请求被拒，检查验签是否用原始请求体、secret 是否一致" : "";
    return { ok: false, extra: { detail: `协议结果必须用 HTTP 200 表达，实际 HTTP ${ex.status}${hint}${snippet(ex.text)}` } };
  }
  if (!ex.json) return { ok: false, extra: { detail: `响应体不是 JSON${snippet(ex.text)}` } };
  const result = validateResponse(type, ex.body);
  if (!result.ok) return { ok: false, extra: { detail: `响应不符合 RSP 1.0 的 ${type} 响应 Schema`, issues: result.errors } };
  return { ok: true, body: ex.body as Record<string, unknown> };
}

function snippet(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "";
  return `，响应体：${t.length > 120 ? `${t.slice(0, 117)}...` : t}`;
}

function manifestEndpoint(manifest: unknown): string | undefined {
  const url = (manifest as { endpoint?: { url?: unknown } } | null)?.endpoint?.url;
  return typeof url === "string" ? url : undefined;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function newOrderId(): string {
  const bytes = randomBytes(20);
  return `ord_cf${Array.from(bytes, (b) => BASE62[b % 62]).join("")}`;
}

function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function readTool(): { name: string; version: string } {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
    return { name: pkg.name, version: pkg.version };
  } catch {
    return { name: "@dreamcavy/ai-relay-conformance", version: "0.0.0" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
