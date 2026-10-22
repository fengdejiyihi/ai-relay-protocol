import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createShop, type Fault, type Shop, type SupplierKey } from "@ai-relay/sandbox-shop";
import { afterEach, describe, expect, it } from "vitest";
import { type CallbackReceiver, type ConformanceReport, runConformance, startCallbackReceiver } from "../src/index.js";

const SECRETS: Record<SupplierKey, string> = { publisher: "whsec_l2_conformance_publisher", match: "whsec_l2_conformance_match" };
const OLD_SECRET = "whsec_l2_conformance_previous";
const manifestPath = (name: string) => fileURLToPath(new URL(`../../../examples/manifests/${name}`, import.meta.url));
const MANIFESTS: Record<SupplierKey, string> = { publisher: manifestPath("l2-publisher.json"), match: manifestPath("l2-matching.json") };
const SHOP_MANIFEST = manifestPath("sandbox-shop.json");
const INPUTS: Record<SupplierKey, string> = {
  publisher: fileURLToPath(new URL("../examples/sandbox-publisher.inputs.json", import.meta.url)),
  match: fileURLToPath(new URL("../examples/sandbox-matching.inputs.json", import.meta.url)),
};
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** 验收等得起的节奏：发文 300 毫秒发出，方案每 150 毫秒来一个，选定 200 毫秒后交换联系方式。 */
const FAST = { publishDelayMs: 300, proposalIntervalMs: 150, selectDelayMs: 200 };
const TIMING = { asyncTimeoutMs: 10_000, pollIntervalMs: 250, settleMs: 700 };

let shop: Shop | undefined;
let receiver: CallbackReceiver | undefined;
afterEach(async () => {
  await new Promise((resolve) => shop?.server.close(resolve) ?? resolve(undefined));
  await receiver?.close();
  shop = undefined;
  receiver = undefined;
});

async function startSandbox(callbackBase: string, faults: Fault[] = []): Promise<string> {
  shop = createShop(
    {
      secrets: ["whsec_l2_conformance_shop"],
      dbPath: ":memory:",
      publicBaseUrl: "https://sandbox.example.test",
      manifestPath: SHOP_MANIFEST,
      l2: {
        secrets: { publisher: [SECRETS.publisher, OLD_SECRET], match: [SECRETS.match, OLD_SECRET] },
        manifestPaths: MANIFESTS,
        callbackBase,
        settings: { ...FAST, faults },
        lateMs: 60_000,
      },
    },
    Date.now,
    { tickMs: 50, log: () => {} },
  );
  await new Promise<void>((resolve) => shop!.server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(shop.server.address() as AddressInfo).port}`;
}

/** 起回调接收端和沙箱（回调指向接收端），对一家 L2 供给方跑验收。 */
async function runL2(supplier: SupplierKey, opts: { faults?: Fault[]; inputs?: Record<string, unknown>; bind?: boolean; ref?: boolean } = {}): Promise<ConformanceReport> {
  receiver = await startCallbackReceiver({ secrets: [SECRETS[supplier]] });
  const base = await startSandbox(receiver.url, opts.faults);
  const bindingCode = opts.bind === false ? undefined : shop!.l2!.issueBindingCode(supplier, "验收").code;
  const supplierUserRef = opts.ref ? shop!.l2!.issueBindingCode(supplier, "测试账号").supplier_user_ref : undefined;
  return runConformance({
    manifest: read(MANIFESTS[supplier]),
    endpoint: `${base}/${supplier}/relay`,
    secret: SECRETS[supplier],
    oldSecret: OLD_SECRET,
    inputs: opts.inputs ?? read(INPUTS[supplier]),
    callbacks: receiver.store,
    callbackUrl: receiver.url,
    ...(bindingCode ? { bindingCode } : {}),
    ...(supplierUserRef ? { supplierUserRef } : {}),
    ...TIMING,
  });
}

function notPass(report: ConformanceReport): string[] {
  return report.checks.filter((c) => c.status !== "pass").map((c) => `${c.id}:${c.status}`);
}

const byId = (report: ConformanceReport) => Object.fromEntries(report.checks.map((c) => [c.id, c]));

describe("沙箱 L2 全绿", () => {
  it("发文（异步单结果）：绑定、回调、补拉、取消全部通过", async () => {
    const report = await runL2("publisher");
    expect(notPass(report)).toEqual(["transport.https:warn", "transport.endpoint_match:warn"]);
    const c = byId(report);
    expect(c["binding.verify"]?.detail).toMatch(/^supplier_user_ref = acct_/);
    expect(c["async.publish_article"]?.detail).toMatch(/^completed（来自(回调|task\.poll)）$/);
    expect(c["cancel.publish_article"]?.detail).toContain("cancelled");
    expect(c["callback.received"]?.detail).toContain("completed × 1");
    expect(report.ok).toBe(true);
  }, 30_000);

  it("撮合（多方案）：收方案、选不存在的方案被拒、选定后 completed", async () => {
    const report = await runL2("match");
    expect(notPass(report)).toEqual(["transport.https:warn", "transport.endpoint_match:warn"]);
    const c = byId(report);
    expect(c["proposal.post_request"]?.detail).toMatch(/收到 \d 个方案/);
    expect(c["select_unknown.post_request"]?.status).toBe("pass");
    expect(c["callback.received"]?.detail).toContain("proposal.add");
    expect(report.ok).toBe(true);
  }, 30_000);

  it("已选方案被撤回：回到待选，换一个方案后完成", async () => {
    const inputs = read(INPUTS.match);
    inputs.post_request.title = "验收：已选方案撤回 #withdraw-selected";
    const report = await runL2("match", { inputs });
    expect(notPass(report)).toEqual(["transport.https:warn", "transport.endpoint_match:warn"]);
    expect(byId(report)["proposal.post_request"]?.detail).toContain("选了 2 次");
  }, 30_000);

  it("重复回调、丢回调（只靠补拉）都不算错", async () => {
    const dup = await runL2("publisher", { faults: ["dup"] });
    expect(notPass(dup)).toEqual(["transport.https:warn", "transport.endpoint_match:warn"]);
    expect(byId(dup)["callback.dedupe"]?.detail).toMatch(/条重发，内容和第一次一致/);
    await new Promise((resolve) => shop!.server.close(resolve));
    await receiver!.close();
    shop = undefined;

    const dropped = await runL2("publisher", { faults: ["drop"] });
    expect(byId(dropped)["async.publish_article"]?.detail).toBe("completed（来自task.poll）");
    expect(byId(dropped)["callback.received"]?.status).toBe("warn");
    expect(dropped.ok).toBe(true);
  }, 60_000);

  it("没给绑定码：绑定用例未测，需要绑定的动作报 unauthorized 警告", async () => {
    const report = await runL2("publisher", { bind: false });
    const c = byId(report);
    expect(c["binding.invalid_code"]?.status).toBe("pass");
    expect(c["binding.verify"]?.status).toBe("skip");
    expect(c["invoke.list_channels"]).toMatchObject({ status: "warn", detail: expect.stringContaining("unauthorized") });
    expect(c["invoke.publish_article"]?.status).toBe("skip");
    expect(report.ok).toBe(true);
  }, 30_000);

  it("不走绑定、直接指定 supplier_user_ref：动作照常下单", async () => {
    const report = await runL2("publisher", { bind: false, ref: true });
    const c = byId(report);
    expect(c["binding.verify"]).toMatchObject({ status: "skip", detail: expect.stringContaining("supplier_user_ref = acct_") });
    expect(c["async.publish_article"]?.status).toBe("pass");
    expect(report.ok).toBe(true);
  }, 30_000);

  it("命令行：--callback-port 起接收端、--binding-code 绑定，退出码 0", async () => {
    // 先占一个端口给接收端，沙箱的回调指过去
    const probe = await startCallbackReceiver({ secrets: [] });
    const port = Number(new URL(probe.url).port);
    await probe.close();
    const base = await startSandbox(`http://127.0.0.1:${port}`);
    const { code } = shop!.l2!.issueBindingCode("match", "命令行验收");
    const manifest = join(tmpdir(), `l2-matching-${process.pid}.json`);
    writeFileSync(manifest, readFileSync(MANIFESTS.match));
    const { stdout } = await promisify(execFile)(process.execPath, [
      CLI,
      "--manifest", manifest,
      "--endpoint", `${base}/match/relay`,
      "--inputs", INPUTS.match,
      "--callback-port", String(port),
      "--binding-code", code,
      "--old-secret", OLD_SECRET,
      "--poll-interval", "0.25",
      "--async-timeout", "10",
      "--json",
    ], { env: { ...process.env, RELAY_SECRET: SECRETS.match } });
    const report = JSON.parse(stdout) as ConformanceReport;
    expect(notPass(report)).toEqual(["transport.https:warn", "transport.endpoint_match:warn"]);
  }, 30_000);
});
