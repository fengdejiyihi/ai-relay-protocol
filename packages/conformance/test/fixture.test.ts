import { afterEach, describe, expect, it } from "vitest";
import { type Check, type ConformanceOptions, type ConformanceReport, runConformance } from "../src/index.js";
import { type Faults, type Fixture, MANIFEST, OLD_SECRET, SECRET, startFixture } from "./fixture.js";

let fx: Fixture | undefined;
afterEach(async () => {
  await fx?.close();
  fx = undefined;
});

const INPUTS = { order_bouquet: { flower: "玫瑰", count: 3 } };

type Extra = { [K in keyof ConformanceOptions]?: ConformanceOptions[K] | undefined };

/** extra 里显式给 undefined 表示去掉这个默认选项。 */
async function run(faults: Faults = {}, extra: Extra = {}): Promise<ConformanceReport> {
  fx = await startFixture(faults);
  const options = { manifest: MANIFEST, endpoint: fx.url, secret: SECRET, oldSecret: OLD_SECRET, inputs: INPUTS, ...extra };
  return runConformance(Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as unknown as ConformanceOptions);
}

function byId(report: ConformanceReport): Record<string, Check> {
  return Object.fromEntries(report.checks.map((c) => [c.id, c]));
}

function statuses(report: ConformanceReport): Record<string, string> {
  return Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
}

describe("写对的供给方", () => {
  it("除了 http 和端点不一致两条警告，其余全部通过", async () => {
    const report = await run();
    expect(report.ok).toBe(true);
    expect(statuses(report)).toEqual({
      "manifest.schema": "pass",
      "manifest.policy": "pass",
      "transport.https": "warn",
      "transport.endpoint_match": "warn",
      ping: "pass",
      "auth.missing": "pass",
      "auth.wrong_secret": "pass",
      "auth.expired": "pass",
      "auth.tampered": "pass",
      "auth.multi_v1": "pass",
      "auth.old_secret": "pass",
      "envelope.unknown_type": "pass",
      "envelope.forward_compat": "pass",
      "invoke.order_bouquet": "pass",
      "output.order_bouquet": "pass",
      "replay.order_bouquet": "pass",
      "transport.latency": "pass",
      "envelope.extra_fields": "pass",
    });
    expect(report.summary).toEqual({ pass: 16, fail: 0, warn: 2, skip: 0 });
    expect(report.tool.name).toBe("@dreamcavy/ai-relay-conformance");
  });

  it("没给旧 secret、没给样例输入时标未测，不算失败", async () => {
    const report = await run({}, { oldSecret: undefined, inputs: undefined });
    const c = byId(report);
    expect(c["auth.old_secret"]?.status).toBe("skip");
    expect(c["invoke.order_bouquet"]).toMatchObject({ status: "skip", detail: expect.stringContaining("没有样例输入") });
    expect(report.ok).toBe(true);
  });

  it("onCheck 按顺序收到每一项", async () => {
    const seen: string[] = [];
    const report = await run({}, { onCheck: (c) => seen.push(c.id) });
    expect(seen).toEqual(report.checks.map((c) => c.id));
  });
});

describe("故意写错的供给方逐项报出", () => {
  it("不验签：四种坏签名全部失败", async () => {
    const report = await run({ noVerify: true });
    const c = byId(report);
    for (const id of ["auth.missing", "auth.wrong_secret", "auth.expired", "auth.tampered"]) {
      expect(c[id]).toMatchObject({ status: "fail", detail: expect.stringContaining("HTTP 200") });
    }
    expect(report.ok).toBe(false);
  });

  it("验签失败回 200 + failed 也算失败", async () => {
    const c = byId(await run({ authFailsWith200: true }));
    expect(c["auth.wrong_secret"]?.status).toBe("fail");
  });

  it("只认第一个 v1=：多签名头失败", async () => {
    const c = byId(await run({ firstV1Only: true }));
    expect(c["auth.multi_v1"]?.status).toBe("fail");
    expect(c["auth.old_secret"]?.status).toBe("pass");
  });

  it("重放不幂等：replay 失败并指出第一处不同", async () => {
    const c = byId(await run({ notIdempotent: true }));
    expect(c["replay.order_bouquet"]).toMatchObject({ status: "fail", detail: expect.stringContaining("/output/data/order_no") });
  });

  it("未知 type 回 500：失败", async () => {
    const c = byId(await run({ unknownType500: true }));
    expect(c["envelope.unknown_type"]).toMatchObject({ status: "fail", detail: expect.stringContaining("HTTP 500") });
  });

  it("响应带多余字段：只是警告，验收仍通过", async () => {
    const report = await run({ extraFields: true });
    const c = byId(report);
    expect(c["envelope.extra_fields"]?.status).toBe("warn");
    expect(c["envelope.extra_fields"]?.issues?.some((i) => i.message.includes("request_id"))).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("output.data 不符合清单：警告", async () => {
    const c = byId(await run({ badOutput: true }));
    expect(c["output.order_bouquet"]?.status).toBe("warn");
    expect(c["output.order_bouquet"]?.issues?.length).toBeGreaterThan(0);
  });

  it("严格校验信封：向前兼容失败", async () => {
    const c = byId(await run({ strictEnvelope: true }));
    expect(c["envelope.forward_compat"]?.status).toBe("fail");
  });

  it("响应慢于 3 秒：警告", async () => {
    const c = byId(await run({ slowFirstMs: 3_100 }));
    expect(c["transport.latency"]?.status).toBe("warn");
  }, 15_000);
});

describe("端点和清单", () => {
  it("连不上：ping 失败，其余网络检查标未测", async () => {
    const report = await runConformance({ manifest: MANIFEST, endpoint: "http://127.0.0.1:9/relay", secret: SECRET, inputs: INPUTS });
    const c = byId(report);
    expect(c.ping?.status).toBe("fail");
    expect(c["auth.missing"]).toMatchObject({ status: "skip", detail: expect.stringContaining("端点连不上") });
    expect(c["invoke.order_bouquet"]?.status).toBe("skip");
    expect(report.ok).toBe(false);
  });

  it("requireHttps 时 http 端点直接失败，不发请求", async () => {
    let calls = 0;
    const report = await runConformance({
      manifest: MANIFEST,
      endpoint: "http://flowers.example.test/relay",
      secret: SECRET,
      requireHttps: true,
      fetch: async () => {
        calls += 1;
        throw new Error("不该发请求");
      },
    });
    expect(byId(report)["transport.https"]?.status).toBe("fail");
    expect(byId(report).ping?.status).toBe("skip");
    expect(calls).toBe(0);
  });

  it("清单不合法：清单失败，动作跳过，其余照测", async () => {
    fx = await startFixture();
    const report = await runConformance({ manifest: { ...MANIFEST, actions: [] }, endpoint: fx.url, secret: SECRET });
    const c = byId(report);
    expect(c["manifest.schema"]?.status).toBe("fail");
    expect(c.actions?.status).toBe("skip");
    expect(c.ping?.status).toBe("pass");
  });

  it("平台策略不通过算失败", async () => {
    fx = await startFixture();
    const manifest = structuredClone(MANIFEST);
    manifest.actions[0]!.fee = 50;
    const c = byId(await runConformance({ manifest, endpoint: fx.url, secret: SECRET }));
    expect(c["manifest.policy"]).toMatchObject({ status: "fail" });
    expect(c["manifest.policy"]?.issues?.[0]?.rule).toBe("P-FEE-1");
  });

  it("样例输入不符合 input Schema：未测并列出原因", async () => {
    const c = byId(await run({}, { inputs: { order_bouquet: { flower: "玫瑰" }, nope: {} } }));
    expect(c["invoke.order_bouquet"]).toMatchObject({ status: "skip" });
    expect(c["invoke.order_bouquet"]?.issues?.length).toBeGreaterThan(0);
    expect(c["inputs.nope"]?.status).toBe("warn");
  });
});
