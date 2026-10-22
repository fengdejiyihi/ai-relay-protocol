import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { signBody, validateDownstream, verifySignature } from "@dreamcavy/ai-relay-protocol";

/** 异步供给方故意写错的地方，每个开关对应一类常见错误。 */
export interface AsyncFaults {
  /** 回调用错的 secret 签名。 */
  badCallbackSignature?: boolean;
  /** 同一个 event_id 发两次，第二次的结果不同。 */
  conflictingDuplicate?: boolean;
  /** 发完 completed 又发 failed（换了 event_id），终态后还改状态。 */
  changeAfterTerminal?: boolean;
  /** 回调路径里的 order_id 和请求体对不上。 */
  pathMismatch?: boolean;
  /** 非多方案动作也发 proposal.add。 */
  proposalOnAsync?: boolean;
  /** task.cancel 回 cancelled，但任务照样完成并回调 completed。 */
  completeAfterCancel?: boolean;
  /** task.poll 的结果和回调不一致：回调 completed，补拉说 failed。 */
  pollContradicts?: boolean;
  /** 不发回调，只能靠补拉。 */
  noCallbacks?: boolean;
  /** task.poll 回不合法的响应。 */
  badPoll?: boolean;
  /** 永远不给结果。 */
  never?: boolean;
}

export const ASYNC_SECRET = "whsec_async_fixture";

export const ASYNC_MANIFEST = {
  rsp: "1.0",
  supplier: {
    name: "验收夹具海报工坊",
    description: "Conformance 异步验收测试用的本地供给方，只在测试里启动。",
    locale: "zh-CN",
    categories: ["设计"],
    user_binding: "none",
  },
  endpoint: { url: "https://posters.example.test/relay", auth: "hmac-sha256" },
  actions: [
    {
      name: "render_poster",
      title: "生成一张海报",
      input: { type: "object", properties: { headline: { type: "string" } }, required: ["headline"], additionalProperties: false },
      output: { type: "object", properties: { image_url: { type: "string" } }, required: ["image_url"] },
      risk: "medium",
      confirm: "by_grant",
      mode: "async",
      billing: "on_complete",
      fee: 500,
      amount: "none",
      timeout_seconds: 3600,
    },
  ],
};

export const ASYNC_INPUTS = { render_poster: { headline: "周末上新" } };

interface Task {
  order_id: string;
  done: boolean;
  cancelled: boolean;
}

export interface AsyncFixture {
  url: string;
  close(): Promise<void>;
}

/** 起一个异步供给方：接单 100 毫秒后完成，回调发到 callbackBase。 */
export async function startAsyncFixture(callbackBase: string, faults: AsyncFaults = {}): Promise<AsyncFixture> {
  const tasks = new Map<string, Task>();
  const invoked = new Map<string, unknown>();
  const timers = new Set<NodeJS.Timeout>();
  let seq = 0;

  const later = (ms: number, fn: () => Promise<void>) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn().catch(() => {});
    }, ms);
    timers.add(t);
  };
  const output = (taskId: string, n = 1) => ({ data: { image_url: `https://posters.example.test/${taskId}/${n}.png` } });
  const callback = async (orderId: string, event: Record<string, unknown>, opts: { eventId?: string; pathOrderId?: string } = {}) => {
    const body = JSON.stringify({ rsp: "1.0", order_id: orderId, event_id: opts.eventId ?? `evt_${++seq}`, occurred_at: Math.floor(Date.now() / 1000), ...event });
    const secret = faults.badCallbackSignature ? "whsec_not_the_right_one" : ASYNC_SECRET;
    await fetch(`${callbackBase}/v1/callbacks/${opts.pathOrderId ?? orderId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-signature": signBody(secret, body, Math.floor(Date.now() / 1000)) },
      body,
    });
  };

  const finish = async (taskId: string) => {
    const task = tasks.get(taskId)!;
    if (faults.never || (task.cancelled && !faults.completeAfterCancel)) return;
    task.done = true;
    if (faults.noCallbacks) return;
    if (faults.proposalOnAsync) {
      await callback(task.order_id, { type: "proposal.add", proposal: { proposal_id: "p_1", title: "方案", content: { data: {} } } });
    }
    const opts = faults.pathMismatch ? { pathOrderId: "ord_someoneelse0000000000" } : {};
    await callback(task.order_id, { type: "completed", output: output(taskId) }, { ...opts, eventId: `evt_done_${taskId}` });
    if (faults.conflictingDuplicate) await callback(task.order_id, { type: "completed", output: output(taskId, 2) }, { eventId: `evt_done_${taskId}` });
    if (faults.changeAfterTerminal) await callback(task.order_id, { type: "failed", error: { code: "permanent", message: "又失败了" } });
  };

  const handle = (raw: Buffer, signature: string | undefined): { status: number; body: unknown } => {
    if (!verifySignature({ secrets: [ASYNC_SECRET], header: signature, body: raw }).ok) {
      return { status: 401, body: { status: "failed", error: { code: "unauthorized" } } };
    }
    const checked = validateDownstream(JSON.parse(raw.toString("utf8")));
    if (!checked.ok) return { status: 200, body: { status: "failed", error: { code: checked.errors[0]?.rule === "D-TYPE-1" ? "not_supported" : "invalid_input" } } };
    const env = checked.value;
    const ok = (body: unknown) => ({ status: 200, body });
    switch (env.type) {
      case "ping":
        return ok({ status: "ok", challenge: env.challenge, rsp: "1.0" });
      case "action.invoke": {
        if (invoked.has(env.idempotency_key)) return ok(invoked.get(env.idempotency_key));
        const taskId = `t_${++seq}`;
        tasks.set(taskId, { order_id: env.order_id, done: false, cancelled: false });
        later(100, () => finish(taskId));
        const body = { status: "accepted", task_id: taskId, eta_seconds: 1 };
        invoked.set(env.idempotency_key, body);
        return ok(body);
      }
      case "task.poll": {
        const task = tasks.get(env.task_id);
        if (!task) return ok({ status: "failed", error: { code: "invalid_input" } });
        if (faults.badPoll) return ok({ status: "running" });
        if (task.cancelled) return ok({ status: "failed", error: { code: "permanent", message: "已取消" } });
        if (!task.done) return ok({ status: "pending", eta_seconds: 1 });
        if (faults.pollContradicts) return ok({ status: "failed", error: { code: "permanent", message: "渲染失败" } });
        return ok({ status: "completed", output: output(env.task_id) });
      }
      case "task.cancel": {
        const task = tasks.get(env.task_id);
        if (!task) return ok({ status: "failed", error: { code: "invalid_input" } });
        if (task.done && !task.cancelled) return ok({ status: "cancel_failed", reason: "已经生成" });
        task.cancelled = true;
        return ok({ status: "cancelled" });
      }
      default:
        return ok({ status: "failed", error: { code: "not_supported" } });
    }
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const out = handle(Buffer.concat(chunks), req.headers["x-relay-signature"] as string | undefined);
      res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/relay`,
    close: () =>
      new Promise((resolve, reject) => {
        for (const t of timers) clearTimeout(t);
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
