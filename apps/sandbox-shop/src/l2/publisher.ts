import type { Manifest, Output } from "@dreamcavy/ai-relay-protocol";
import { completed, failed } from "../actions.js";
import { faultsFor, type L2Context, type SupplierImpl } from "./supplier.js";
import type { Task } from "./store.js";

/** 每个账号都有这两个演示渠道。 */
export const CHANNELS = [
  { channel_id: "ch_blog", name: "沙箱博客" },
  { channel_id: "ch_weekly", name: "沙箱周刊" },
] as const;

/**
 * 发文供给方（examples/manifests/l2-publisher.json，异步单结果）：
 * publish_article 立刻回 accepted，publishDelayMs 后「发出」并回调 completed 带文章链接。
 * 发出前 task.cancel 回 cancelled，发出后回 cancel_failed。
 */
export function publisher(manifest: Manifest): SupplierImpl {
  return {
    key: "publisher",
    manifest,
    actions: {
      list_channels() {
        return completed({ channels: CHANNELS.map((c) => ({ ...c })) }, [
          { type: "markdown", text: ["**可发布渠道**", "", ...CHANNELS.map((c) => `- ${c.name}（${c.channel_id}）`)].join("\n") },
        ]);
      },

      publish_article(input, { envelope, account, store, settings, now }) {
        const channelId = input.channel_id as string;
        if (!CHANNELS.some((c) => c.channel_id === channelId)) {
          return failed("invalid_input", `没有渠道 ${channelId}，请先用 list_channels 查询`);
        }
        const task = store.createTask({
          supplier: "publisher",
          order_id: envelope.order_id,
          account_ref: account.ref,
          action: envelope.action,
          input,
          state: "queued",
          faults: faultsFor(input.title as string, settings.faults),
        });
        store.schedule(task.task_id, "publish", now() + settings.publishDelayMs);
        return { status: "accepted", task_id: task.task_id, eta_seconds: Math.ceil(settings.publishDelayMs / 1000) };
      },
    },

    poll(task, { settings, now }) {
      switch (task.state) {
        case "queued":
          return { status: "pending", eta_seconds: Math.max(0, Math.ceil((task.created_at + settings.publishDelayMs - now()) / 1000)) };
        case "published":
          return { status: "completed", output: (task.result as { output: Output }).output };
        case "cancelled":
          return failed("permanent", "任务已取消，文章没有发出");
        default:
          return { status: "failed", error: (task.result as { error: { code: "permanent"; message: string } }).error };
      }
    },

    cancel(task, _reason, { store }) {
      switch (task.state) {
        case "queued":
          store.updateTask(task.task_id, { state: "cancelled" });
          return { status: "cancelled" };
        case "cancelled":
          return { status: "cancelled" };
        case "published":
          return { status: "cancel_failed", reason: "文章已经发出，不能撤回" };
        default:
          return failed("not_available", "任务已失败结束，没有可撤回的内容");
      }
    },

    runJob(job, task, ctx) {
      if (job.kind !== "publish" || task.state !== "queued") return;
      publish(task, ctx);
    },
  };
}

function publish(task: Task, { store, outbox, baseUrl, now }: L2Context): void {
  if (task.faults.includes("fail")) {
    const error = { code: "permanent" as const, message: "渠道拒绝了这篇文章（沙箱 #fail 标记）" };
    store.updateTask(task.task_id, { state: "failed", result: { error } });
    outbox.enqueue("publisher", { type: "failed", order_id: task.order_id, error }, task.faults);
    return;
  }
  const url = `${baseUrl}/a/${task.task_id}`;
  const channel = CHANNELS.find((c) => c.channel_id === task.input.channel_id)!;
  const output: Output = {
    data: { article_url: url, published_at: new Date(now()).toISOString() },
    parts: [
      { type: "markdown", text: `《${String(task.input.title)}》已发布到「${channel.name}」。` },
      { type: "link", url, title: "查看文章" },
    ],
  };
  store.updateTask(task.task_id, { state: "published", result: { output } });
  outbox.enqueue("publisher", { type: "completed", order_id: task.order_id, output }, task.faults);
}
