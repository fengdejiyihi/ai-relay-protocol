import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createShop, type Shop } from "@ai-relay/sandbox-shop";
import { afterEach, describe, expect, it } from "vitest";
import { type ConformanceReport, runConformance } from "../src/index.js";

const SECRET = "whsec_sandbox_conformance";
const OLD_SECRET = "whsec_sandbox_conformance_old";
const MANIFEST_PATH = fileURLToPath(new URL("../../../examples/manifests/sandbox-shop.json", import.meta.url));
const INPUTS_PATH = fileURLToPath(new URL("../examples/sandbox-shop.inputs.json", import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const inputs = JSON.parse(readFileSync(INPUTS_PATH, "utf8"));

let shop: Shop | undefined;
afterEach(async () => {
  await new Promise((resolve) => shop?.server.close(resolve) ?? resolve(undefined));
  shop = undefined;
});

async function startShop(now: () => number = Date.now): Promise<string> {
  shop = createShop({ secrets: [SECRET, OLD_SECRET], dbPath: ":memory:", publicBaseUrl: "https://sandbox.example.test", manifestPath: MANIFEST_PATH }, now);
  await new Promise<void>((resolve) => shop!.server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(shop.server.address() as AddressInfo).port}/relay`;
}

describe("沙箱理发店", () => {
  it("全绿：除了本机 http 和端点不一致，没有失败、警告和未测", async () => {
    const clock = Date.parse("2026-10-22T09:30:00+08:00");
    const endpoint = await startShop(() => clock);
    const report = await runConformance({
      manifest,
      endpoint,
      secret: SECRET,
      oldSecret: OLD_SECRET,
      inputs,
      now: () => clock,
      timeZone: "Asia/Shanghai",
      policy: { allowZeroFee: true },
    });
    const notPass = report.checks.filter((c) => c.status !== "pass").map((c) => `${c.id}:${c.status}`);
    expect(notPass).toEqual(["transport.https:warn", "transport.endpoint_match:warn"]);
    // 四个动作都真的调到了：查时段 → 预约 → 查预约 → 取消
    for (const action of ["list_slots", "book_slot", "get_booking", "cancel_booking"]) {
      expect(report.checks.find((c) => c.id === `invoke.${action}`)).toMatchObject({ status: "pass", detail: "completed" });
      expect(report.checks.find((c) => c.id === `replay.${action}`)?.status).toBe("pass");
    }
    expect(report.ok).toBe(true);
  });

  it("命令行：--json 输出报告，退出码 0", async () => {
    const endpoint = await startShop();
    const { stdout } = await promisify(execFile)(process.execPath, [
      CLI,
      "--manifest", MANIFEST_PATH,
      "--endpoint", endpoint,
      "--inputs", INPUTS_PATH,
      "--old-secret", OLD_SECRET,
      "--time-zone", "Asia/Shanghai",
      "--allow-zero-fee",
      "--json",
    ], { env: { ...process.env, RELAY_SECRET: SECRET } });
    const report = JSON.parse(stdout) as ConformanceReport;
    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.summary.skip).toBe(0);
  });

  it("命令行：有失败时退出码 1，终端文本列出失败项", async () => {
    const endpoint = await startShop();
    const error = await promisify(execFile)(process.execPath, [CLI, "--manifest", MANIFEST_PATH, "--endpoint", endpoint, "--secret", "whsec_not_this_one"]).catch((e) => e);
    expect(error.code).toBe(1);
    expect(error.stdout).toContain("✗ 失败  ping 原样带回 challenge");
    expect(error.stdout).toContain("验收未通过");
  });

  it("命令行：无效时区退出码 2", async () => {
    const error = await promisify(execFile)(process.execPath, [CLI, "--manifest", MANIFEST_PATH, "--secret", "s", "--time-zone", "Mars/Olympus"]).catch((e) => e);
    expect(error.code).toBe(2);
    expect(error.stderr).toContain("不是有效的时区");
  });

  it("命令行：缺参数退出码 2", async () => {
    const error = await promisify(execFile)(process.execPath, [CLI, "--manifest", MANIFEST_PATH], { env: { ...process.env, RELAY_SECRET: "" } }).catch((e) => e);
    expect(error.code).toBe(2);
    expect(error.stderr).toContain("缺少 --secret");
  });
});
