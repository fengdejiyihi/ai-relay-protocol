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
import { resolveInput } from "./inputs.js";
import { bogusV1, type Exchange, type FetchLike, post } from "./transport.js";
import type { Check, CheckGroup, CheckStatus, ConformanceOptions, ConformanceReport } from "./types.js";

/** 本工具的包名和版本，写进报告。 */
export const TOOL = readTool();

/** 规范第 2 节：供给方应当在 3 秒内响应。 */
const SLOW_MS = 3_000;
/** 验收用的假名用户，供给方日志里一眼能认出来。 */
const RELAY_UID = "u_conformance_probe";

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

  // ───────────── 动作 ─────────────
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

    const orderId = newOrderId();
    const envelope = {
      type: "action.invoke",
      rsp: RSP_VERSION,
      issued_at: seconds(),
      order_id: orderId,
      action: name,
      manifest_version: options.manifestVersion ?? 1,
      input: resolved.value,
      user: { relay_uid: RELAY_UID, display_name: "Conformance", supplier_user_ref: null },
      idempotency_key: orderId,
    };
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
    if (status === "failed") {
      make(`invoke.${name}`, "action", invokeTitle, "warn", {
        detail: `响应格式正确，但动作返回 failed（${error?.code}${error?.message ? `：${error.message}` : ""}）。检查样例输入是否能走通`,
        ms: ex.ms,
      });
    } else {
      make(`invoke.${name}`, "action", invokeTitle, "pass", { detail: status, ms: ex.ms });
    }

    // 输出 Schema
    const outputTitle = `${name} 的 output.data 符合清单`;
    if (status === "completed") {
      const data = (first.body.output as { data: unknown }).data;
      outputs.set(name, data);
      if (action.output) {
        const checked = compileActionInput(action.output)(data);
        make(`output.${name}`, "action", outputTitle, checked.ok ? "pass" : "warn", {
          ...(checked.ok ? {} : { detail: "output.data 应当符合动作的 output Schema（规范第 8 节）", issues: checked.errors }),
        });
      } else {
        make(`output.${name}`, "action", outputTitle, "skip", { detail: "清单没有声明 output" });
      }
    } else if (status === "accepted") {
      make(`output.${name}`, "action", outputTitle, "skip", { detail: "异步动作的结果要等轮询或回调，这次未测" });
    } else {
      make(`output.${name}`, "action", outputTitle, "skip", { detail: "动作返回 failed，未测" });
    }

    // 同键重放：请求体不变，重新签名
    const replayTitle = `${name} 同一 idempotency_key 重放结果一致`;
    if (status === "failed" && (RETRYABLE_ERROR_CODES as readonly string[]).includes(error?.code ?? "")) {
      make(`replay.${name}`, "action", replayTitle, "skip", { detail: `第一次是 ${error?.code}，规范第 10 节规定不得缓存，不比对` });
      return;
    }
    const again = await send(body, signed(options.secret), `replay.${name}`);
    const second = expectResponse(again, "action.invoke");
    if (!second.ok) {
      make(`replay.${name}`, "action", replayTitle, "fail", { ...second.extra, ms: again.ms });
      return;
    }
    const diff = firstDifference(first.body, second.body);
    make(`replay.${name}`, "action", replayTitle, diff === null ? "pass" : "fail", {
      ...(diff === null
        ? {}
        : { detail: `第二次响应和第一次不同（${diff}）。同一个键必须返回第一次的最终结果，不得重复执行（规范第 10 节）` }),
      ms: again.ms,
    });
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

/** 两个 JSON 值第一处不同的位置（JSON 指针），相同返回 null。对象键的顺序不算差异。 */
export function firstDifference(a: unknown, b: unknown, path = ""): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path || "/"} 长度 ${a.length} → ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}/${i}`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}/${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path || "/"}：${short(a)} → ${short(b)}`;
}

function short(v: unknown): string {
  const s = v === undefined ? "（无）" : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
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
