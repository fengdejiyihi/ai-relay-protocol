import type { Manifest, Output, Proposal } from "@dreamcavy/ai-relay-protocol";
import { failed } from "../actions.js";
import type { ProposalRow, Task } from "./store.js";
import { faultsFor, type L2Context, type SupplierImpl } from "./supplier.js";

/** 三家虚构服务商，报价按预算的倍数，工期按期望天数的倍数。 */
export const VENDORS = [
  { name: "青柠工作室", priceFactor: 0.8, etaFactor: 1.25 },
  { name: "北岸软件", priceFactor: 1.0, etaFactor: 1.0 },
  { name: "山海技术", priceFactor: 1.2, etaFactor: 0.75 },
] as const;

const DEFAULT_DEADLINE_DAYS = 14;

/**
 * 撮合供给方（examples/manifests/l2-matching.json，多方案）：
 * post_request 回 accepted，之后每隔 proposalIntervalMs 回调一个 proposal.add，共 3 个；
 * proposal.select 回 selected，selectDelayMs 后回调 completed 带服务商联系方式。
 */
export function matching(manifest: Manifest): SupplierImpl {
  return {
    key: "match",
    manifest,
    actions: {
      post_request(input, { envelope, account, store, settings, now }) {
        const task = store.createTask({
          supplier: "match",
          order_id: envelope.order_id,
          account_ref: account.ref,
          action: envelope.action,
          input,
          state: "open",
          faults: faultsFor(input.title as string, settings.faults),
        });
        VENDORS.forEach((_, i) => store.schedule(task.task_id, "proposal", now() + settings.proposalIntervalMs * (i + 1), i + 1));
        return { status: "accepted", task_id: task.task_id, eta_seconds: Math.ceil((settings.proposalIntervalMs * VENDORS.length) / 1000) };
      },
    },

    poll(task, { store, settings, now }) {
      switch (task.state) {
        case "open": {
          // 只列有效方案：Relay 把列表里没有的方案当作已撤回。
          const active = store.proposals(task.task_id).filter((p) => p.status === "active");
          if (active.length > 0) return { status: "proposals", proposals: active.map(toProposal) };
          return { status: "pending", eta_seconds: Math.max(0, Math.ceil((task.created_at + settings.proposalIntervalMs * VENDORS.length - now()) / 1000)) };
        }
        case "selected":
          return { status: "pending", eta_seconds: Math.ceil(settings.selectDelayMs / 1000) };
        case "completed":
          return { status: "completed", output: (task.result as { output: Output }).output };
        default:
          return failed("permanent", "需求已取消");
      }
    },

    cancel(task, _reason, { store }) {
      switch (task.state) {
        case "open":
          store.updateTask(task.task_id, { state: "cancelled" });
          return { status: "cancelled" };
        case "cancelled":
          return { status: "cancelled" };
        default:
          return { status: "cancel_failed", reason: "已经和服务商交换联系方式，不能撤回" };
      }
    },

    select(task, proposalId, { store, settings, now }) {
      const proposal = store.proposal(proposalId);
      if (!proposal || proposal.task_id !== task.task_id) return failed("invalid_input", "没有这个方案");
      switch (task.state) {
        case "open":
          if (proposal.status !== "active") return failed("invalid_input", "这个方案已被服务商撤回，请换一个");
          store.setProposalStatus(proposalId, "selected");
          store.updateTask(task.task_id, { state: "selected", selected_proposal: proposalId });
          // arg 记下选的是第几个方案：被撤回后再选别的，旧的 complete 不能提前完成新的。
          store.schedule(task.task_id, "complete", now() + settings.selectDelayMs, proposal.seq);
          return { status: "selected" };
        case "selected":
          return task.selected_proposal === proposalId ? { status: "selected" } : failed("not_available", "已选定另一个方案，正在交换联系方式");
        case "completed":
          return task.selected_proposal === proposalId
            ? { status: "completed", output: (task.result as { output: Output }).output }
            : failed("not_available", "已选定另一个方案并完成");
        default:
          return failed("not_available", "需求已取消");
      }
    },

    runJob(job, task, ctx) {
      const { store, settings, now } = ctx;
      switch (job.kind) {
        case "proposal": {
          // 用户已经选了（或取消了）就不再来新方案。
          if (task.state !== "open" || store.proposalBySeq(task.task_id, job.arg)) return;
          addProposal(task, job.arg, ctx);
          if (job.arg === VENDORS.length && task.faults.includes("withdraw")) {
            store.schedule(task.task_id, "withdraw", now() + settings.proposalIntervalMs, 2);
          }
          return;
        }
        case "withdraw": {
          const p = store.proposalBySeq(task.task_id, job.arg);
          if (p && p.status !== "withdrawn" && (task.state === "open" || task.state === "selected")) {
            withdraw(task, p, "服务商临时接不了这个单", ctx);
          }
          return;
        }
        case "complete": {
          if (task.state !== "selected" || !task.selected_proposal) return;
          const selected = store.proposal(task.selected_proposal)!;
          // arg 为 0 是加序号之前排的旧定时，照常完成。
          if (job.arg !== 0 && selected.seq !== job.arg) return;
          if (task.faults.includes("withdraw-selected")) {
            // 只撤一次：用户重新选别的方案后正常完成。
            store.updateTask(task.task_id, { faults: task.faults.filter((f) => f !== "withdraw-selected") });
            withdraw(store.task(task.task_id)!, selected, "服务商临时没有档期", ctx);
            return;
          }
          complete(task, selected, ctx);
          return;
        }
        default:
          return;
      }
    },
  };
}

function addProposal(task: Task, seq: number, { store, outbox }: L2Context): void {
  const vendor = VENDORS[seq - 1]!;
  const budget = task.input.budget_cents as number;
  const days = (task.input.deadline_days as number | undefined) ?? DEFAULT_DEADLINE_DAYS;
  const row = store.addProposal({
    task_id: task.task_id,
    seq,
    vendor: vendor.name,
    title: `${vendor.name}：${String(task.input.title)}`,
    price_cents: Math.round((budget * vendor.priceFactor) / 100) * 100,
    eta_days: Math.max(1, Math.round(days * vendor.etaFactor)),
    contact: `${vendor.name}，邮箱 vendor-${seq}@example.com（沙箱虚构）`,
  });
  outbox.enqueue("match", { type: "proposal.add", order_id: task.order_id, proposal: toProposal(row) }, task.faults);
}

export function withdraw(task: Task, p: ProposalRow, reason: string, { store, outbox }: L2Context): void {
  store.setProposalStatus(p.proposal_id, "withdrawn");
  // 已选的方案被撤回：任务回到待选，Relay 那边订单回到 awaiting_selection。
  if (task.selected_proposal === p.proposal_id) store.updateTask(task.task_id, { state: "open", selected_proposal: null });
  outbox.enqueue("match", { type: "proposal.withdraw", order_id: task.order_id, proposal_id: p.proposal_id, reason }, task.faults);
}

function complete(task: Task, p: ProposalRow, { store, outbox }: L2Context): void {
  const output: Output = {
    data: { proposal_id: p.proposal_id, contact: p.contact },
    parts: [{ type: "markdown", text: `已为您和 **${p.vendor}** 交换联系方式：${p.contact}。对方会在 1 个工作日内联系您。` }],
  };
  store.updateTask(task.task_id, { state: "completed", result: { output } });
  outbox.enqueue("match", { type: "completed", order_id: task.order_id, output }, task.faults);
}

export function toProposal(p: ProposalRow): Proposal {
  return {
    proposal_id: p.proposal_id,
    title: p.title,
    price_cents: p.price_cents,
    eta_days: p.eta_days,
    content: {
      data: { proposal_id: p.proposal_id, vendor: p.vendor, price_cents: p.price_cents, eta_days: p.eta_days },
      parts: [{ type: "markdown", text: `**${p.vendor}** 报价 ¥${(p.price_cents / 100).toFixed(0)}，工期 ${p.eta_days} 天。` }],
    },
  };
}
