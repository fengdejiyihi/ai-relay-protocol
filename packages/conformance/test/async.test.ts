import { afterEach, describe, expect, it } from "vitest";
import { type CallbackReceiver, type Check, type ConformanceReport, runConformance, startCallbackReceiver } from "../src/index.js";
import { ASYNC_INPUTS, ASYNC_MANIFEST, ASYNC_SECRET, type AsyncFaults, type AsyncFixture, startAsyncFixture } from "./async-fixture.js";

let fx: AsyncFixture | undefined;
let receiver: CallbackReceiver | undefined;
afterEach(async () => {
  await fx?.close();
  await receiver?.close();
  fx = undefined;
  receiver = undefined;
});

async function run(faults: AsyncFaults = {}, extra: { callbacks?: boolean; asyncTimeoutMs?: number; totalTimeoutMs?: number } = {}): Promise<Record<string, Check>> {
  receiver = await startCallbackReceiver({ secrets: [ASYNC_SECRET] });
  fx = await startAsyncFixture(receiver.url, faults);
  const report: ConformanceReport = await runConformance({
    manifest: ASYNC_MANIFEST,
    endpoint: fx.url,
    secret: ASYNC_SECRET,
    inputs: ASYNC_INPUTS,
    ...(extra.callbacks === false ? {} : { callbacks: receiver.store, callbackUrl: receiver.url }),
    asyncTimeoutMs: extra.asyncTimeoutMs ?? 5_000,
    ...(extra.totalTimeoutMs ? { totalTimeoutMs: extra.totalTimeoutMs } : {}),
    pollIntervalMs: 150,
    settleMs: 400,
  });
  return Object.fromEntries(report.checks.map((c) => [c.id, c]));
}

const ASYNC_IDS = [
  "invoke.render_poster",
  "replay.render_poster",
  "poll.render_poster",
  "async.render_poster",
  "output.render_poster",
  "cancel.render_poster",
  "callback.received",
  "callback.signature",
  "callback.schema",
  "callback.dedupe",
  "callback.terminal",
  "callback.state",
];

describe("写对的异步供给方", () => {
  it("回调、补拉、取消全部通过", async () => {
    const c = await run();
    expect(Object.fromEntries(ASYNC_IDS.map((id) => [id, c[id]?.status]))).toEqual(Object.fromEntries(ASYNC_IDS.map((id) => [id, "pass"])));
  });

  it("不给回调接收端：只验补拉，回调标未测", async () => {
    const c = await run({}, { callbacks: false });
    expect(c["async.render_poster"]).toMatchObject({ status: "pass", detail: "completed（来自task.poll）" });
    expect(c["callback.receiver"]?.status).toBe("skip");
    expect(c["callback.signature"]).toBeUndefined();
  });
});

describe("故意写错的异步供给方逐项报出", () => {
  it("回调错签名：callback.signature 失败，结果靠补拉", async () => {
    const c = await run({ badCallbackSignature: true });
    expect(c["callback.signature"]).toMatchObject({ status: "fail", detail: expect.stringContaining("HTTP 401") });
    expect(c["async.render_poster"]?.detail).toBe("completed（来自task.poll）");
  });

  it("重复 event_id 结果不同：callback.dedupe 失败并指出差异", async () => {
    const c = await run({ conflictingDuplicate: true });
    expect(c["callback.dedupe"]).toMatchObject({ status: "fail", detail: expect.stringContaining("/output/data/image_url") });
  });

  it("终态后还改状态：callback.terminal 失败，Relay 回 409", async () => {
    const c = await run({ changeAfterTerminal: true });
    expect(c["callback.terminal"]).toMatchObject({ status: "fail", detail: expect.stringContaining("HTTP 409") });
    expect(c["callback.terminal"]?.detail).toContain("又收到 failed");
  });

  it("取消成功后又完成：callback.terminal 失败", async () => {
    const c = await run({ completeAfterCancel: true });
    expect(c["cancel.render_poster"]?.status).toBe("pass");
    expect(c["callback.terminal"]).toMatchObject({ status: "fail", detail: expect.stringContaining("cancelled") });
  });

  it("路径和 order_id 不一致：callback.schema 失败", async () => {
    const c = await run({ pathMismatch: true });
    expect(c["callback.schema"]).toMatchObject({ status: "fail", detail: expect.stringContaining("签名不覆盖路径") });
  });

  it("非多方案动作发 proposal.add：callback.state 失败", async () => {
    const c = await run({ proposalOnAsync: true });
    expect(c["callback.state"]).toMatchObject({ status: "fail", detail: expect.stringContaining("不是 async_multi") });
  });

  it("补拉和回调结果矛盾：async 失败", async () => {
    const c = await run({ pollContradicts: true });
    expect(c["async.render_poster"]).toMatchObject({ status: "fail", detail: expect.stringContaining("同一个任务只能有一个最终结果") });
  });

  it("task.poll 响应不合法：poll 失败", async () => {
    const c = await run({ badPoll: true, noCallbacks: true }, { asyncTimeoutMs: 800 });
    expect(c["poll.render_poster"]?.status).toBe("fail");
    expect(c["async.render_poster"]).toMatchObject({ status: "fail", detail: expect.stringContaining("秒内没有终态") });
  });

  it("不发回调：只是警告", async () => {
    const c = await run({ noCallbacks: true });
    expect(c["callback.received"]).toMatchObject({ status: "warn", detail: expect.stringContaining("/v1/callbacks/{order_id}") });
    expect(c["async.render_poster"]?.status).toBe("pass");
  });

  it("永远不给结果：超时失败，output 未测", async () => {
    const c = await run({ never: true }, { asyncTimeoutMs: 600 });
    expect(c["async.render_poster"]).toMatchObject({ status: "fail", detail: expect.stringContaining("当前 accepted") });
    expect(c["output.render_poster"]?.status).toBe("skip");
  });

  it("整次验收的时间预算用完：异步动作判超时，取消用例未测", async () => {
    const c = await run({ never: true }, { asyncTimeoutMs: 60_000, totalTimeoutMs: 800 });
    expect(c["async.render_poster"]).toMatchObject({ status: "fail", detail: expect.stringContaining("整次验收的时间预算用完") });
    expect(c["cancel.render_poster"]?.status).toBe("skip");
  });
});
