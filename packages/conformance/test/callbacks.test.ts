import { signBody } from "@dreamcavy/ai-relay-protocol";
import { describe, expect, it } from "vitest";
import { judgeCallback, newTestOrder, type TestOrder } from "../src/index.js";
import { applyCancelResponse, applyPollResponse, applySelectResponse, MAX_RECORDED, MAX_UNSIGNED } from "../src/callbacks.js";

const SECRET = "whsec_unit";
const NOW = Date.parse("2026-10-22T10:00:00Z");
const ORDER = "ord_cfUnitTest00000000001";
let seq = 0;

function event(type: string, fields: Record<string, unknown> = {}, eventId = `evt_${++seq}`) {
  return { type, rsp: "1.0", order_id: ORDER, event_id: eventId, occurred_at: Math.floor(NOW / 1000), ...fields };
}

function deliver(order: TestOrder, body: unknown, opts: { secret?: string; path?: string } = {}) {
  const raw = JSON.stringify(body);
  return judgeCallback(order, {
    pathOrderId: opts.path ?? ORDER,
    rawBody: raw,
    signature: signBody(opts.secret ?? SECRET, raw, Math.floor(NOW / 1000)),
    secrets: [SECRET],
    now: NOW,
  });
}

const proposal = (id: string) => ({ proposal_id: id, title: id, content: { data: {} } });
const multi = () => ({ ...newTestOrder(ORDER, "post_request", "async_multi"), status: "accepted" as const, task_id: "t_1" });
const single = () => ({ ...newTestOrder(ORDER, "render", "async"), status: "accepted" as const, task_id: "t_1" });

describe("judgeCallback", () => {
  it("多方案：proposal.add 进方案待选；没选定就 completed 回 422；选定后 completed 进终态", () => {
    let r = deliver(multi(), event("proposal.add", { proposal: proposal("p_1") }));
    expect([r.http, r.order.status]).toEqual([200, "awaiting_selection"]);
    r = deliver(r.order, event("completed", { output: { data: {} } }));
    expect([r.http, r.order.callbacks.at(-1)?.verdict]).toEqual([422, "rejected_state"]);
    applySelectResponse(r.order, "p_1", { status: "selected" });
    r = deliver(r.order, event("completed", { output: { data: { ok: 1 } } }));
    expect([r.http, r.order.status]).toEqual([200, "completed"]);
  });

  it("撤回已选方案回到待选；撤回从没出现过的方案回 422", () => {
    let r = deliver(multi(), event("proposal.add", { proposal: proposal("p_1") }));
    applySelectResponse(r.order, "p_1", { status: "selected" });
    r = deliver(r.order, event("proposal.withdraw", { proposal_id: "p_1" }));
    expect([r.http, r.order.status, r.order.selected]).toEqual([200, "awaiting_selection", null]);
    r = deliver(r.order, event("proposal.withdraw", { proposal_id: "p_9" }));
    expect([r.http, r.order.callbacks.at(-1)?.verdict]).toEqual([422, "rejected_state"]);
  });

  it("重复 event_id：内容一致 200 duplicate，内容不同记 duplicate_conflict", () => {
    const e = event("completed", { output: { data: { n: 1 } } }, "evt_same");
    let r = deliver(single(), e);
    r = deliver(r.order, e);
    expect([r.http, r.order.callbacks.at(-1)?.verdict]).toEqual([200, "duplicate"]);
    r = deliver(r.order, { ...e, output: { data: { n: 2 } } });
    expect([r.http, r.order.callbacks.at(-1)?.verdict]).toEqual([200, "duplicate_conflict"]);
  });

  it("补拉先拿到 completed，同样结果的回调后到：409 但不算问题；结果不同算终态后改状态", () => {
    const order = single();
    applyPollResponse(order, { status: "completed", output: { data: { n: 1 } } });
    let r = deliver(order, event("completed", { output: { data: { n: 1 } } }));
    expect([r.http, r.order.callbacks.at(-1)?.verdict]).toEqual([409, "echo"]);
    r = deliver(r.order, event("completed", { output: { data: { n: 2 } } }));
    expect([r.http, r.order.callbacks.at(-1)?.verdict]).toEqual([409, "after_terminal"]);
  });

  it("错签名 401；Schema 不对 422；路径不一致 422", () => {
    expect(deliver(single(), event("completed", { output: { data: {} } }), { secret: "whsec_wrong" }).http).toBe(401);
    expect(deliver(single(), event("completed", {})).order.callbacks[0]?.verdict).toBe("invalid");
    expect(deliver(single(), event("completed", { output: { data: {} } }), { path: "ord_cfOther000000000000" }).order.callbacks[0]?.verdict).toBe("path_mismatch");
  });

  it("task.cancel 回 cancelled 但之前回调已经 completed：矛盾", () => {
    const r = deliver(single(), event("completed", { output: { data: {} } }));
    expect(applyCancelResponse(r.order, { status: "cancelled" })).toContain("应当回 cancel_failed");
  });

  it("补拉的 proposals 列表里没有的方案视为撤回", () => {
    const r = deliver(multi(), event("proposal.add", { proposal: proposal("p_1") }));
    applyPollResponse(r.order, { status: "proposals", proposals: [proposal("p_2") as never] });
    expect(r.order.proposals).toEqual([
      { proposal_id: "p_1", withdrawn: true, via: "callback" },
      { proposal_id: "p_2", withdrawn: false, via: "poll" },
    ]);
  });

  it("明细有上限：验签失败只留前几条、其余计数；总数超限的只计数", () => {
    let order: TestOrder = single();
    for (let i = 0; i < MAX_UNSIGNED + 3; i++) order = deliver(order, event("failed", { error: { code: "permanent" } }), { secret: "whsec_wrong" }).order;
    expect(order.callbacks.length).toBe(MAX_UNSIGNED);
    expect(order.unsigned_extra).toBe(3);
    for (let i = 0; i < MAX_RECORDED; i++) order = deliver(order, event("completed", {})).order;
    expect(order.callbacks.length).toBe(MAX_RECORDED);
    expect(order.dropped).toBe(MAX_UNSIGNED);
  });
});
