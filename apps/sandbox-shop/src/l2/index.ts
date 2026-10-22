import type { IncomingMessage, ServerResponse } from "node:http";
import { HEADERS, type Manifest, RSP_VERSION } from "@dreamcavy/ai-relay-protocol";
import type { ExtraRoute } from "../http.js";
import type { RelayReply } from "../relay.js";
import { escapeHtml, page, readBody, redirect, sendHtml, sendJson } from "../web.js";
import { matching, withdraw } from "./matching.js";
import { type FetchLike, Outbox } from "./outbox.js";
import { publisher } from "./publisher.js";
import { L2Store, type SupplierKey, type Task } from "./store.js";
import { createL2Handler, type L2Context, type L2Settings, type SupplierImpl } from "./supplier.js";

export { CALLBACK_BACKOFF_SECONDS, Outbox, type FetchLike } from "./outbox.js";
export { BINDING_CODE_TTL_MS, FAULTS, L2Store, type Fault, type SupplierKey } from "./store.js";
export type { L2Settings } from "./supplier.js";

export interface L2Config {
  /** 哪家没配 secret 就不挂哪家。 */
  secrets: Partial<Record<SupplierKey, readonly string[]>>;
  manifests: Record<SupplierKey, Manifest>;
  /** Relay 根地址，回调发到 {callbackBase}/v1/callbacks/{order_id}。 */
  callbackBase: string;
  /** 沙箱对外根地址；发文挂在 {publicBaseUrl}/publisher，撮合挂在 {publicBaseUrl}/match。 */
  publicBaseUrl: string;
  settings: L2Settings;
  lateMs: number;
}

export interface L2Options {
  dbPath: string;
  now?: () => number;
  fetch?: FetchLike;
  log?: (message: string) => void;
}

/** 两家 L2 供给方的路径前缀。清单里 example.com 的根换成 {publicBaseUrl}{前缀}。 */
export const L2_PREFIXES: Record<SupplierKey, string> = { publisher: "/publisher", match: "/match" };

export interface L2 {
  store: L2Store;
  outbox: Outbox;
  /** 已启用的供给方。 */
  suppliers: SupplierKey[];
  manifests: Record<SupplierKey, Manifest>;
  /** 挂到 createHttpServer 的 extra 上。 */
  route: ExtraRoute;
  /** 与框架无关的入口，同 createRelayHandler。 */
  handlers: Partial<Record<SupplierKey, (rawBody: Uint8Array | string, signature: string | undefined) => RelayReply>>;
  /** 跑掉所有到点的定时动作，再发出所有到点的回调。 */
  tick(): Promise<void>;
  /** 每 intervalMs 自动 tick 一次。 */
  start(intervalMs?: number): void;
  stop(): void;
  issueBindingCode(supplier: SupplierKey, displayName: string): ReturnType<L2Store["issueBindingCode"]>;
  /** 服务商主动撤回一个方案（任务网页上的按钮也走这里）。 */
  withdrawProposal(proposalId: string, reason?: string): boolean;
  close(): void;
}

export function createL2(config: L2Config, options: L2Options): L2 {
  const now = options.now ?? Date.now;
  const store = new L2Store(options.dbPath, now);
  const secrets = { publisher: config.secrets.publisher ?? [], match: config.secrets.match ?? [] };
  const outbox = new Outbox({
    store,
    callbackBase: config.callbackBase.replace(/\/+$/, ""),
    secrets,
    lateMs: config.lateMs,
    now,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const impls: Record<SupplierKey, SupplierImpl> = {
    publisher: publisher(config.manifests.publisher),
    match: matching(config.manifests.match),
  };
  const enabled = (Object.keys(impls) as SupplierKey[]).filter((k) => secrets[k].length > 0);
  const contexts = Object.fromEntries(
    enabled.map((k) => [k, { store, outbox, settings: config.settings, baseUrl: `${config.publicBaseUrl}${L2_PREFIXES[k]}`, now } satisfies L2Context]),
  ) as Record<SupplierKey, L2Context>;
  const handlers = Object.fromEntries(enabled.map((k) => [k, createL2Handler(impls[k], contexts[k], secrets[k])])) as L2["handlers"];

  /** 清单里 endpoint.url、binding.help_url 的路径部分，挂到前缀下面。 */
  const paths = Object.fromEntries(
    enabled.map((k) => {
      const m = config.manifests[k];
      return [k, { relay: new URL(m.endpoint.url).pathname, binding: m.supplier.binding ? new URL(m.supplier.binding.help_url).pathname : null }];
    }),
  ) as Record<SupplierKey, { relay: string; binding: string | null }>;

  let ticking: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastPrune = 0;

  async function runTick(): Promise<void> {
    for (const job of store.dueJobs()) {
      store.transaction(() => {
        store.finishJob(job.id);
        const task = store.task(job.task_id);
        if (task && contexts[task.supplier]) impls[task.supplier].runJob(job, task, contexts[task.supplier]);
      });
    }
    await outbox.deliverDue();
    if (now() - lastPrune > 3600_000) {
      lastPrune = now();
      store.prune();
    }
  }

  function tick(): Promise<void> {
    // 不重叠：上一轮还在发回调时，这一轮等它结束。
    ticking ??= runTick().finally(() => {
      ticking = null;
    });
    return ticking;
  }

  function withdrawProposal(proposalId: string, reason = "服务商撤回了这个方案"): boolean {
    return store.transaction(() => {
      const p = store.proposal(proposalId);
      const task = p && store.task(p.task_id, "match");
      if (!p || !task || !contexts.match || p.status === "withdrawn" || !(task.state === "open" || task.state === "selected")) return false;
      withdraw(task, p, reason, contexts.match);
      return true;
    });
  }

  const route: ExtraRoute = async (req, res, url) => {
    const key = enabled.find((k) => url.pathname === L2_PREFIXES[k] || url.pathname.startsWith(`${L2_PREFIXES[k]}/`));
    if (!key) return false;
    const sub = url.pathname.slice(L2_PREFIXES[key].length) || "/";
    const site = config.manifests[key].supplier.name;

    if (sub === paths[key].relay) {
      if (req.method !== "POST") return (sendJson(res, 405, { error: "只接受 POST" }, { Allow: "POST" }), true);
      const body = await readBody(req);
      if (body === null) return (sendJson(res, 413, { status: "failed", error: { code: "invalid_input", message: "请求体过大" } }), true);
      const signature = req.headers[HEADERS.signature.toLowerCase()];
      const reply = handlers[key]!(body, Array.isArray(signature) ? signature[0] : signature);
      sendJson(res, reply.httpStatus, reply.body, { [HEADERS.rspVersion]: RSP_VERSION });
      return true;
    }
    if (paths[key].binding && sub === paths[key].binding) {
      await bindingPage(req, res, key, site);
      return true;
    }
    if (paths[key].binding && sub === `${paths[key].binding}/revoke` && req.method === "POST") {
      const form = await readForm(req);
      const ref = form.get("ref") ?? "";
      const ok = store.revokeAccount(key, ref);
      if (wantsJson(req)) return (sendJson(res, ok ? 200 : 404, { ok }), true);
      sendHtml(res, ok ? 200 : 404, page(ok ? "账号已作废" : "没有这个账号", `<p>${ok ? `账号 ${escapeHtml(ref)} 已作废，Relay 下次调用会收到 unauthorized。` : "没找到，或已经作废。"}</p>`, site));
      return true;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const article = /^\/a\/(t_[0-9a-z]{16})$/.exec(sub);
      const taskPage = /^\/t\/(t_[0-9a-z]{16})$/.exec(sub);
      const task = article ? store.task(article[1]!, key) : taskPage ? store.task(taskPage[1]!, key) : undefined;
      if (article && task?.state === "published") return (sendHtml(res, 200, articlePage(task, site)), true);
      if (taskPage && task) return (sendHtml(res, 200, matchTaskPage(task, site)), true);
      if (sub === "/") return (sendHtml(res, 200, homePage(key, site)), true);
    }
    const withdraw = /^\/t\/(t_[0-9a-z]{16})\/withdraw\/(p_[0-9a-z]{16})$/.exec(sub);
    if (key === "match" && withdraw && req.method === "POST") {
      withdrawProposal(withdraw[2]!);
      redirect(res, `${L2_PREFIXES.match}/t/${withdraw[1]}`);
      return true;
    }
    sendHtml(res, 404, page("没有这个页面", "<p>没有找到。</p>", site));
    return true;
  };

  async function bindingPage(req: IncomingMessage, res: ServerResponse, key: SupplierKey, site: string): Promise<void> {
    const action = `${L2_PREFIXES[key]}${paths[key].binding}`;
    if (req.method === "POST") {
      const form = await readForm(req);
      const name = (form.get("display_name") ?? "").trim().slice(0, 100) || "沙箱用户";
      const issued = store.issueBindingCode(key, name);
      if (wantsJson(req)) return sendJson(res, 200, { ...issued, display_name: name });
      return sendHtml(
        res,
        200,
        page(
          "你的绑定码",
          `<p><code>${issued.code}</code></p><p>10 分钟内有效，只能用一次。回到 Relay 的绑定页粘贴它。</p>` +
            `<p>账号：${escapeHtml(name)}（${issued.supplier_user_ref}）</p>` +
            `<form method="post" action="${action}/revoke"><input type="hidden" name="ref" value="${issued.supplier_user_ref}">` +
            `<button>作废这个账号</button>（测试「绑定失效」：作废后 Relay 的调用会收到 unauthorized）</form>`,
          site,
        ),
      );
    }
    sendHtml(
      res,
      200,
      page(
        "绑定到 AI Relay",
        `<p>这是演示供给方，没有真实账号体系：填一个称呼就会新建一个账号，并生成一次性绑定码。</p>` +
          `<form method="post" action="${action}"><label>称呼 <input name="display_name" maxlength="100" placeholder="沙箱用户"></label> <button>生成绑定码</button></form>`,
        site,
      ),
    );
  }

  function matchTaskPage(task: Task, site: string): string {
    const rows = store
      .proposals(task.task_id)
      .map((p) => {
        const label = { active: "有效", selected: "已选定", withdrawn: "已撤回" }[p.status];
        const button =
          p.status !== "withdrawn" && (task.state === "open" || task.state === "selected")
            ? `<form method="post" action="${L2_PREFIXES.match}/t/${task.task_id}/withdraw/${p.proposal_id}"><button>撤回</button></form>`
            : "";
        return `<tr><td>${escapeHtml(p.vendor)}</td><td>¥${p.price_cents / 100}</td><td>${p.eta_days} 天</td><td>${label}</td><td>${button}</td></tr>`;
      })
      .join("");
    const state = { open: "收集方案中", selected: "已选定，交换联系方式中", completed: "已完成", cancelled: "已取消" }[task.state as string] ?? task.state;
    return page(
      `需求：${String(task.input.title)}`,
      `<p>状态：${state}。服务商可以在这里撤回自己的方案（演示「方案撤回」）。</p>` +
        (rows ? `<table><tr><th>服务商</th><th>报价</th><th>工期</th><th>状态</th><th></th></tr>${rows}</table>` : "<p>还没有方案。</p>"),
      site,
    );
  }

  return {
    store,
    outbox,
    suppliers: enabled,
    manifests: config.manifests,
    route,
    handlers,
    tick,
    start(intervalMs = 500) {
      timer ??= setInterval(() => {
        tick().catch((error: unknown) => console.error(error));
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    issueBindingCode: (supplier, displayName) => store.issueBindingCode(supplier, displayName),
    withdrawProposal,
    close() {
      if (timer) clearInterval(timer);
      timer = null;
      store.close();
    },
  };
}

function articlePage(task: Task, site: string): string {
  return page(String(task.input.title), `<pre>${escapeHtml(String(task.input.body_markdown))}</pre>`, site);
}

function homePage(key: SupplierKey, site: string): string {
  const text =
    key === "publisher"
      ? "异步单结果示例：发布文章在后台完成，结果通过回调返回。"
      : "多方案示例：发布需求后陆续收到服务商方案，选定后交换联系方式。";
  return page(site, `<p>${text}这是 AI Relay 的演示供给方，数据不定期清理。</p>`, site);
}

function wantsJson(req: IncomingMessage): boolean {
  return (req.headers.accept ?? "").includes("application/json");
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const body = await readBody(req, 16 * 1024);
  if (body === null) return new URLSearchParams();
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) {
    try {
      return new URLSearchParams(JSON.parse(body.toString("utf8")) as Record<string, string>);
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(body.toString("utf8"));
}
