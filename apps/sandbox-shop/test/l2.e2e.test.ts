import { afterEach, describe, expect, it } from "vitest";
import { CALLBACK_BACKOFF_SECONDS } from "../src/index.js";
import { SECRET } from "./helpers.js";
import { bind, envelope, eventsFor, expectOutput, invokeEnvelope, type L2Harness, nextOrderId, post, startL2 } from "./l2-helpers.js";

let h: L2Harness;
afterEach(async () => {
  await h.close();
});

const ARTICLE = { channel_id: "ch_blog", title: "沙箱测试文章", body_markdown: "# 你好\n\n这是一篇测试文章。" };
const REQUEST = { title: "做一个小程序", detail: "需要一个预约小程序，带后台。", budget_cents: 500000, deadline_days: 20 };

async function publish(input: Record<string, unknown> = ARTICLE) {
  const ref = await bind(h, "publisher");
  const env = invokeEnvelope(h, "publish_article", input, ref);
  const sent = await post(h, "publisher", env);
  expect(sent.body.status).toBe("accepted");
  return { ref, env, orderId: env.order_id as string, taskId: sent.body.task_id as string };
}

async function postRequest(input: Record<string, unknown> = REQUEST) {
  const ref = await bind(h, "match");
  const env = invokeEnvelope(h, "post_request", input, ref);
  const sent = await post(h, "match", env);
  expect(sent.body.status).toBe("accepted");
  return { ref, env, orderId: env.order_id as string, taskId: sent.body.task_id as string };
}

const poll = (supplier: "publisher" | "match", orderId: string, taskId: string) =>
  post(h, supplier, envelope(h, "task.poll", { order_id: orderId, task_id: taskId }));
const cancel = (supplier: "publisher" | "match", orderId: string, taskId: string, reason = "user_cancelled") =>
  post(h, supplier, envelope(h, "task.cancel", { order_id: orderId, task_id: taskId, reason }));
const select = (orderId: string, taskId: string, proposalId: string) =>
  post(h, "match", envelope(h, "proposal.select", { order_id: orderId, task_id: taskId, proposal_id: proposalId }));

describe("端点与签名", () => {
  it("两家 L2 各用自己的 secret，互不通用", async () => {
    h = await startL2();
    const ping = envelope(h, "ping", { challenge: "c".repeat(16) });
    expect((await post(h, "publisher", ping)).body).toEqual({ status: "ok", challenge: "c".repeat(16), rsp: "1.0" });
    expect((await post(h, "match", ping)).body.status).toBe("ok");
    expect((await post(h, "match", ping, { secret: SECRET })).status).toBe(401);
    expect((await post(h, "publisher", ping, { secret: "whsec_sandbox_test_match" })).status).toBe(401);
  });

  it("L1 理发店照旧在 /relay", async () => {
    h = await startL2();
    const res = await fetch(`${h.url}/healthz`);
    expect(res.status).toBe(200);
    expect(h.shop.l2!.suppliers).toEqual(["publisher", "match"]);
  });

  it("理发店不需要的 task.poll 在 L2 端点上能处理，没有的任务回 invalid_input", async () => {
    h = await startL2();
    const sent = await poll("publisher", nextOrderId(), "t_0000000000000000");
    expect(sent.body.error.code).toBe("invalid_input");
  });
});

describe("账号绑定", () => {
  it("绑定码换账号；同一 relay_uid 重发同一个码幂等", async () => {
    h = await startL2();
    const { code, supplier_user_ref } = h.shop.l2!.issueBindingCode("match", "小王");
    const verify = envelope(h, "binding.verify", { relay_uid: "u_alice_000001", code });
    expect((await post(h, "match", verify)).body).toEqual({ status: "bound", supplier_user_ref, display_name: "小王" });
    expect((await post(h, "match", verify)).body).toEqual({ status: "bound", supplier_user_ref, display_name: "小王" });
  });

  it("码无效、已被别人用、已过期都回 failed + invalid_input，details.reason 区分", async () => {
    h = await startL2();
    const l2 = h.shop.l2!;
    const unknown = await post(h, "match", envelope(h, "binding.verify", { relay_uid: "u_alice_000001", code: "ZZZZZZZZ" }));
    expect(unknown.body.error).toMatchObject({ code: "invalid_input", details: { reason: "unknown" } });

    const used = l2.issueBindingCode("match", "小王").code;
    await post(h, "match", envelope(h, "binding.verify", { relay_uid: "u_alice_000001", code: used }));
    const second = await post(h, "match", envelope(h, "binding.verify", { relay_uid: "u_bob_00000001", code: used }));
    expect(second.body.error).toMatchObject({ code: "invalid_input", details: { reason: "used" } });

    const late = l2.issueBindingCode("match", "小李").code;
    h.clock.now += 10 * 60 * 1000 + 1;
    const expired = await post(h, "match", envelope(h, "binding.verify", { relay_uid: "u_alice_000001", code: late }));
    expect(expired.body.error).toMatchObject({ code: "invalid_input", details: { reason: "expired" } });
  });

  it("一家的码在另一家无效", async () => {
    h = await startL2();
    const { code } = h.shop.l2!.issueBindingCode("publisher", "小王");
    const sent = await post(h, "match", envelope(h, "binding.verify", { relay_uid: "u_alice_000001", code }));
    expect(sent.body.error.details.reason).toBe("unknown");
  });

  it("没绑、账号不是本家的、账号已作废，action.invoke 都回 unauthorized；重新绑定后恢复", async () => {
    h = await startL2();
    const none = await post(h, "publisher", invokeEnvelope(h, "list_channels", {}, null));
    expect(none.body.error.code).toBe("unauthorized");

    const matchRef = await bind(h, "match");
    const foreign = await post(h, "publisher", invokeEnvelope(h, "list_channels", {}, matchRef));
    expect(foreign.body.error.code).toBe("unauthorized");

    const ref = await bind(h, "publisher");
    expect((await post(h, "publisher", invokeEnvelope(h, "list_channels", {}, ref))).body.status).toBe("completed");
    expect(h.shop.l2!.store.revokeAccount("publisher", ref)).toBe(true);
    const revoked = await post(h, "publisher", invokeEnvelope(h, "publish_article", ARTICLE, ref));
    expect(revoked.body.error.code).toBe("unauthorized");

    const again = await bind(h, "publisher");
    expect(again).not.toBe(ref);
    expect((await post(h, "publisher", invokeEnvelope(h, "publish_article", ARTICLE, again))).body.status).toBe("accepted");
  });

  it("绑定码网页：表单生成码（JSON 版给脚本用），作废按钮让绑定失效", async () => {
    h = await startL2();
    const page = await fetch(`${h.url}/match/settings/relay`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("生成绑定码");

    const res = await fetch(`${h.url}/match/settings/relay`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: "display_name=%E5%B0%8F%E8%B5%B5",
    });
    const issued = (await res.json()) as { code: string; supplier_user_ref: string };
    expect(issued).toMatchObject({ display_name: "小赵", supplier_user_ref: expect.stringMatching(/^acct_/), code: expect.stringMatching(/^[A-Z2-9]{8}$/) });
    const bound = await post(h, "match", envelope(h, "binding.verify", { relay_uid: "u_alice_000001", code: issued.code.toLowerCase() }));
    expect(bound.body.supplier_user_ref).toBe(issued.supplier_user_ref);

    const html = await fetch(`${h.url}/match/settings/relay`, { method: "POST", body: "display_name=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(await html.text()).toContain("作废这个账号");

    const revoke = await fetch(`${h.url}/match/settings/relay/revoke`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: `ref=${issued.supplier_user_ref}`,
    });
    expect(await revoke.json()).toEqual({ ok: true });
    const after = await post(h, "match", invokeEnvelope(h, "post_request", REQUEST, issued.supplier_user_ref));
    expect(after.body.error.code).toBe("unauthorized");
    // 发文的绑定页路径来自它自己的清单。
    expect((await fetch(`${h.url}/publisher/settings/relay-binding`)).status).toBe(200);
  });
});

describe("发文（异步单结果）", () => {
  it("list_channels 同步返回", async () => {
    h = await startL2();
    const ref = await bind(h, "publisher");
    const sent = await post(h, "publisher", invokeEnvelope(h, "list_channels", {}, ref));
    expect(sent.body.output.data.channels.map((c: { channel_id: string }) => c.channel_id)).toEqual(["ch_blog", "ch_weekly"]);
  });

  it("接单 → 补拉 pending → 几秒后回调 completed 带链接 → 补拉 completed；发出后取消回 cancel_failed", async () => {
    h = await startL2();
    const { env, orderId, taskId } = await publish();
    expect((await poll("publisher", orderId, taskId)).body).toMatchObject({ status: "pending", eta_seconds: 5 });

    // 同一个 idempotency_key 重发：返回同一个 task_id，不新建任务。
    expect((await post(h, "publisher", env)).body.task_id).toBe(taskId);

    await h.advance(4_000);
    expect(eventsFor(h, orderId)).toEqual([]);
    await h.advance(1_000);
    const [event] = eventsFor(h, orderId);
    expect(event).toMatchObject({ type: "completed", order_id: orderId, rsp: "1.0", event_id: expect.stringMatching(/^evt_/) });
    expect(h.receiver.received[0]!.supplier).toBe("publisher");
    const output = (event as { output: { data: { article_url: string } } }).output;
    expectOutput(h, "publisher", "publish_article", output.data);
    expect(output.data.article_url).toBe(`https://sandbox.example.test/publisher/a/${taskId}`);

    const article = await fetch(`${h.url}/publisher/a/${taskId}`);
    expect(await article.text()).toContain("沙箱测试文章");

    expect((await poll("publisher", orderId, taskId)).body).toEqual({ status: "completed", output });
    expect((await cancel("publisher", orderId, taskId)).body).toEqual({ status: "cancel_failed", reason: "文章已经发出，不能撤回" });
  });

  it("发出前取消回 cancelled，之后不再发文、不回调", async () => {
    h = await startL2();
    const { orderId, taskId } = await publish();
    await h.advance(1_000);
    expect((await cancel("publisher", orderId, taskId, "expired")).body).toEqual({ status: "cancelled" });
    expect((await cancel("publisher", orderId, taskId)).body).toEqual({ status: "cancelled" });
    await h.advance(60_000);
    expect(eventsFor(h, orderId)).toEqual([]);
    expect((await poll("publisher", orderId, taskId)).body.error.code).toBe("permanent");
  });

  it("task_id 对不上 order_id 时当作没有这个任务", async () => {
    h = await startL2();
    const { taskId } = await publish();
    expect((await poll("publisher", nextOrderId(), taskId)).body.error.code).toBe("invalid_input");
    expect((await cancel("publisher", nextOrderId(), taskId)).body.error.code).toBe("invalid_input");
  });

  it("没有的渠道回 invalid_input，不建任务", async () => {
    h = await startL2();
    const ref = await bind(h, "publisher");
    const sent = await post(h, "publisher", invokeEnvelope(h, "publish_article", { ...ARTICLE, channel_id: "ch_nope" }, ref));
    expect(sent.body.error.code).toBe("invalid_input");
  });

  it("#fail：以 failed 回调结束，补拉也是 failed", async () => {
    h = await startL2();
    const { orderId, taskId } = await publish({ ...ARTICLE, title: "会失败的文章 #fail" });
    await h.advance(5_000);
    expect(eventsFor(h, orderId)).toMatchObject([{ type: "failed", error: { code: "permanent" } }]);
    expect((await poll("publisher", orderId, taskId)).body.error.code).toBe("permanent");
  });
});

describe("回调投递与故障开关", () => {
  it("5xx 用同一个 event_id 按退避重发，直到 2xx", async () => {
    h = await startL2();
    h.receiver.replies.push(503, 500);
    const { orderId } = await publish();
    await h.advance(5_000);
    expect(h.receiver.attempts.map((a) => a.status)).toEqual([503]);
    await h.advance(CALLBACK_BACKOFF_SECONDS[0] * 1000);
    expect(h.receiver.attempts.map((a) => a.status)).toEqual([503, 500]);
    await h.advance(CALLBACK_BACKOFF_SECONDS[1] * 1000 - 1);
    expect(h.receiver.attempts).toHaveLength(2);
    await h.advance(1);
    expect(h.receiver.attempts.map((a) => a.status)).toEqual([503, 500, 200]);
    expect(new Set(h.receiver.attempts.map((a) => a.event_id)).size).toBe(1);
    expect(eventsFor(h, orderId)).toHaveLength(1);
    expect(h.shop.l2!.store.events(orderId)[0]).toMatchObject({ state: "sent", attempts: 3, last_status: 200 });
  });

  it("4xx（比如终态后的 409）记下不重发", async () => {
    h = await startL2();
    h.receiver.replies.push(409);
    const { orderId } = await publish();
    await h.advance(60 * 60 * 1000);
    expect(h.receiver.attempts.map((a) => a.status)).toEqual([409]);
    expect(h.shop.l2!.store.events(orderId)[0]).toMatchObject({ state: "rejected", last_status: 409 });
  });

  it("一直 5xx：重发 6 次后放弃，任务结果仍可补拉", async () => {
    h = await startL2();
    h.receiver.replies.push(...Array(10).fill(502));
    const { orderId, taskId } = await publish();
    await h.advance(2 * 3600 * 1000);
    expect(h.receiver.attempts).toHaveLength(1 + CALLBACK_BACKOFF_SECONDS.length);
    expect(h.shop.l2!.store.events(orderId)[0]!.state).toBe("gave_up");
    expect((await poll("publisher", orderId, taskId)).body.status).toBe("completed");
  });

  it("#drop：不发回调，只能靠 task.poll 拿结果", async () => {
    h = await startL2();
    const { orderId, taskId } = await publish({ ...ARTICLE, title: "丢回调 #drop" });
    await h.advance(60_000);
    expect(h.receiver.attempts).toEqual([]);
    expect(h.shop.l2!.store.events(orderId)[0]!.state).toBe("dropped");
    expect((await poll("publisher", orderId, taskId)).body.status).toBe("completed");
  });

  it("#late：回调推迟 90 秒才发出", async () => {
    h = await startL2();
    const { orderId, taskId } = await publish({ ...ARTICLE, title: "迟到回调 #late" });
    await h.advance(5_000);
    expect((await poll("publisher", orderId, taskId)).body.status).toBe("completed");
    await h.advance(89_000);
    expect(eventsFor(h, orderId)).toEqual([]);
    await h.advance(1_000);
    expect(eventsFor(h, orderId)).toHaveLength(1);
  });

  it("#dup：同一个事件（同一个 event_id、同一个请求体）发两次", async () => {
    h = await startL2();
    const { orderId } = await publish({ ...ARTICLE, title: "重复回调 #dup" });
    await h.advance(5_000);
    const events = eventsFor(h, orderId);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(events[1]);
  });

  it("CALLBACK_FAULTS 全局开关对所有单子生效", async () => {
    h = await startL2(["dup"]);
    const { orderId } = await publish();
    await h.advance(5_000);
    expect(eventsFor(h, orderId)).toHaveLength(2);
  });
});

describe("撮合（多方案）", () => {
  it("接单 → 陆续 3 个 proposal.add → 选定 → selected → 回调 completed 带联系方式；之后取消回 cancel_failed", async () => {
    h = await startL2();
    const { orderId, taskId } = await postRequest();
    expect((await poll("match", orderId, taskId)).body.status).toBe("pending");

    await h.advance(2_000);
    expect(eventsFor(h, orderId).map((e) => e.type)).toEqual(["proposal.add"]);
    await h.advance(4_000);
    const adds = eventsFor(h, orderId) as { type: string; proposal: { proposal_id: string; price_cents: number; eta_days: number } }[];
    expect(adds.map((e) => e.type)).toEqual(["proposal.add", "proposal.add", "proposal.add"]);
    expect(adds.map((e) => e.proposal.price_cents)).toEqual([400000, 500000, 600000]);
    expect(adds.map((e) => e.proposal.eta_days)).toEqual([25, 20, 15]);
    expect(h.receiver.received.every((r) => r.supplier === "match")).toBe(true);

    const listed = await poll("match", orderId, taskId);
    expect(listed.body.status).toBe("proposals");
    expect(listed.body.proposals).toEqual(adds.map((e) => e.proposal));

    const chosen = adds[1]!.proposal.proposal_id;
    expect((await select(orderId, taskId, chosen)).body).toEqual({ status: "selected" });
    expect((await select(orderId, taskId, chosen)).body).toEqual({ status: "selected" });
    expect((await select(orderId, taskId, adds[0]!.proposal.proposal_id)).body.error.code).toBe("not_available");
    expect((await poll("match", orderId, taskId)).body.status).toBe("pending");
    expect((await cancel("match", orderId, taskId)).body.status).toBe("cancel_failed");

    await h.advance(3_000);
    const done = eventsFor(h, orderId).at(-1) as { type: string; output: { data: { proposal_id: string; contact: string } } };
    expect(done.type).toBe("completed");
    expect(done.output.data.proposal_id).toBe(chosen);
    expect(done.output.data.contact).toContain("北岸软件");
    expectOutput(h, "match", "post_request", done.output.data);
    expect((await poll("match", orderId, taskId)).body).toEqual({ status: "completed", output: done.output });
    expect((await select(orderId, taskId, chosen)).body).toEqual({ status: "completed", output: done.output });
  });

  it("#withdraw：第 3 个方案到后撤回第 2 个；补拉只列有效方案；选撤回的回 invalid_input", async () => {
    h = await startL2();
    const { orderId, taskId } = await postRequest({ ...REQUEST, title: "会撤回一个 #withdraw" });
    await h.advance(8_000);
    const events = eventsFor(h, orderId) as { type: string; proposal?: { proposal_id: string }; proposal_id?: string }[];
    expect(events.map((e) => e.type)).toEqual(["proposal.add", "proposal.add", "proposal.add", "proposal.withdraw"]);
    const withdrawn = events[1]!.proposal!.proposal_id;
    expect(events[3]!.proposal_id).toBe(withdrawn);

    const listed = await poll("match", orderId, taskId);
    expect(listed.body.proposals.map((p: { proposal_id: string }) => p.proposal_id)).toEqual([
      events[0]!.proposal!.proposal_id,
      events[2]!.proposal!.proposal_id,
    ]);
    expect((await select(orderId, taskId, withdrawn)).body.error.code).toBe("invalid_input");
    expect((await select(orderId, taskId, "p_nope")).body.error.code).toBe("invalid_input");
  });

  it("#withdraw-selected：选定后被选的方案撤回，回到待选；再选别的正常完成", async () => {
    h = await startL2();
    const { orderId, taskId } = await postRequest({ ...REQUEST, title: "选了又撤 #withdraw-selected" });
    await h.advance(6_000);
    const listed = (await poll("match", orderId, taskId)).body.proposals as { proposal_id: string }[];
    expect((await select(orderId, taskId, listed[0]!.proposal_id)).body.status).toBe("selected");

    await h.advance(3_000);
    expect(eventsFor(h, orderId).at(-1)).toMatchObject({ type: "proposal.withdraw", proposal_id: listed[0]!.proposal_id });
    const after = await poll("match", orderId, taskId);
    expect(after.body.status).toBe("proposals");
    expect(after.body.proposals).toHaveLength(2);

    expect((await select(orderId, taskId, listed[2]!.proposal_id)).body.status).toBe("selected");
    await h.advance(3_000);
    expect(eventsFor(h, orderId).at(-1)).toMatchObject({ type: "completed", output: { data: { proposal_id: listed[2]!.proposal_id } } });
  });

  it("选定的方案被撤回后马上改选，新方案仍要等满 selectDelayMs 才完成", async () => {
    h = await startL2();
    const { orderId, taskId } = await postRequest();
    await h.advance(6_000);
    const listed = (await poll("match", orderId, taskId)).body.proposals as { proposal_id: string }[];
    await select(orderId, taskId, listed[0]!.proposal_id);
    await h.advance(1_000);
    expect(h.shop.l2!.withdrawProposal(listed[0]!.proposal_id)).toBe(true);
    await select(orderId, taskId, listed[1]!.proposal_id);
    await h.advance(2_000);
    expect(eventsFor(h, orderId).at(-1).type).toBe("proposal.withdraw");
    await h.advance(1_000);
    expect(eventsFor(h, orderId).at(-1)).toMatchObject({ type: "completed", output: { data: { proposal_id: listed[1]!.proposal_id } } });
  });

  it("8 天前已结束的任务连同方案一起清掉，没结束的留着", async () => {
    h = await startL2();
    const { orderId, taskId } = await postRequest();
    const open = await postRequest();
    await h.advance(6_000);
    const listed = (await poll("match", orderId, taskId)).body.proposals as { proposal_id: string }[];
    await select(orderId, taskId, listed[0]!.proposal_id);
    await h.advance(3_000);
    h.clock.now += 8 * 24 * 3600 * 1000 + 1;
    h.shop.l2!.store.prune();
    expect(h.shop.l2!.store.task(open.taskId)?.state).toBe("open");
    expect(h.shop.l2!.store.task(taskId)).toBeUndefined();
    expect(h.shop.l2!.store.proposals(taskId)).toEqual([]);
    expect((await poll("match", orderId, taskId)).body.error.code).toBe("invalid_input");
  });

  it("服务商在任务网页上撤回方案", async () => {
    h = await startL2();
    const { orderId, taskId } = await postRequest();
    await h.advance(2_000);
    const [add] = eventsFor(h, orderId) as { proposal: { proposal_id: string } }[];
    const pageRes = await fetch(`${h.url}/match/t/${taskId}`);
    expect(await pageRes.text()).toContain("撤回");
    const res = await fetch(`${h.url}/match/t/${taskId}/withdraw/${add!.proposal.proposal_id}`, { method: "POST", redirect: "manual" });
    expect(res.status).toBe(303);
    await h.advance(0);
    expect(eventsFor(h, orderId).at(-1)).toMatchObject({ type: "proposal.withdraw", proposal_id: add!.proposal.proposal_id });
    expect((await poll("match", orderId, taskId)).body.status).toBe("pending");
  });

  it("选定前取消回 cancelled，之后不再来方案", async () => {
    h = await startL2();
    const { orderId, taskId } = await postRequest();
    await h.advance(2_000);
    expect((await cancel("match", orderId, taskId, "no_selection")).body).toEqual({ status: "cancelled" });
    await h.advance(60_000);
    expect(eventsFor(h, orderId)).toHaveLength(1);
    expect((await poll("match", orderId, taskId)).body.error.code).toBe("permanent");
    expect((await select(orderId, taskId, "p_whatever")).body.error.code).toBe("invalid_input");
  });

  it("同一个 idempotency_key 重发返回同一个任务；同键异输入回 invalid_input", async () => {
    h = await startL2();
    const { env, taskId } = await postRequest();
    expect((await post(h, "match", env)).body.task_id).toBe(taskId);
    const other = { ...env, input: { ...REQUEST, budget_cents: 1 } };
    expect((await post(h, "match", other)).body.error.code).toBe("invalid_input");
  });
});
