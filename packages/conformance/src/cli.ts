#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatCheck, formatHeader, formatSummary } from "./report.js";
import { RSP_VERSION } from "@dreamcavy/ai-relay-protocol";
import { type CallbackReceiver, startCallbackReceiver } from "./receiver.js";
import { runConformance, TOOL } from "./run.js";
import type { Check, ConformanceOptions } from "./types.js";

const USAGE = `用法：conformance --manifest manifest.json --secret <secret> [选项]

对供给方的 POST /relay 端点做 RSP 1.0 接入验收。会真的调用 --inputs 里的动作，
请接测试环境或用可撤销的样例。

  --manifest <文件>     清单 JSON（必填）
  --endpoint <URL>      被测端点，默认用清单里的 endpoint.url
  --secret <secret>     当前 secret，也可以用环境变量 RELAY_SECRET（避免进 shell 历史）
  --old-secret <secret> 轮换期的旧 secret，也可以用 RELAY_OLD_SECRET；给了才测旧 secret
  --inputs <文件>       每个动作一份样例输入：{"动作名": {...输入}}，按键顺序执行
  --require-https       端点不是 HTTPS 直接判失败（默认只警告，方便本机联调）
  --timeout <毫秒>      单个请求超时，默认 60000
  --time-zone <时区>    {{$today}} 按哪个时区算，默认本机时区
  --allow-zero-fee      允许收费动作 fee=0（只给 Relay 自营的沙箱用，正式入驻不接受）

异步动作（mode 为 async、async_multi）：
  --callback-port <端口>  本机起回调接收端，供给方把回调发到 http://<地址>:<端口>/v1/callbacks/{order_id}；
                          不给时不验回调，只靠 task.poll
  --callback-host <地址>  接收端监听的地址，默认 127.0.0.1；供给方在另一台机器上时用 ::（监听所有地址）
  --callback-url <URL>    提示给供给方的回调根地址（比如内网穿透的公网地址），默认 http://<地址>:<端口>
  --binding-code <码>     user_binding=token 的供给方：在你的产品里生成的一次性绑定码
  --supplier-user-ref <账号> 不走绑定，直接用这个测试账号作为 supplier_user_ref 调用动作
  --async-timeout <秒>    每个异步动作等最终结果的上限，默认 120
  --poll-interval <秒>    task.poll 间隔，默认 3
  --no-cancel             不测 task.cancel（默认每个异步动作额外下一单并立刻取消）
  --json                输出机器可读的 JSON 报告
  -h, --help            显示这段说明

退出码：0 验收通过（可以有警告和未测），1 有失败项，2 参数或文件错误。`;

async function main(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        manifest: { type: "string" },
        endpoint: { type: "string" },
        secret: { type: "string" },
        "old-secret": { type: "string" },
        inputs: { type: "string" },
        "require-https": { type: "boolean" },
        timeout: { type: "string" },
        "time-zone": { type: "string" },
        "allow-zero-fee": { type: "boolean" },
        "callback-port": { type: "string" },
        "callback-host": { type: "string" },
        "callback-url": { type: "string" },
        "binding-code": { type: "string" },
        "supplier-user-ref": { type: "string" },
        "async-timeout": { type: "string" },
        "poll-interval": { type: "string" },
        "no-cancel": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (error) {
    return usageError((error as Error).message);
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const secret = values.secret ?? process.env.RELAY_SECRET;
  const oldSecret = values["old-secret"] ?? process.env.RELAY_OLD_SECRET;
  if (!values.manifest) return usageError("缺少 --manifest");
  if (!secret) return usageError("缺少 --secret（或环境变量 RELAY_SECRET）");

  let manifest: unknown;
  let inputs: ConformanceOptions["inputs"];
  try {
    manifest = readJson(values.manifest, "清单");
    if (values.inputs) {
      const parsed = readJson(values.inputs, "样例输入");
      if (!isInputs(parsed)) return usageError(`样例输入 ${values.inputs} 必须是 {"动作名": {...输入对象}}`);
      inputs = parsed;
    }
  } catch (error) {
    return usageError((error as Error).message);
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = Number(values.timeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return usageError("--timeout 必须是正整数（毫秒）");
  }

  const seconds = (flag: string, value: string | undefined): number | string | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : `${flag} 必须是正数（秒）`;
  };
  const asyncTimeoutMs = seconds("--async-timeout", values["async-timeout"]);
  if (typeof asyncTimeoutMs === "string") return usageError(asyncTimeoutMs);
  const pollIntervalMs = seconds("--poll-interval", values["poll-interval"]);
  if (typeof pollIntervalMs === "string") return usageError(pollIntervalMs);
  let callbackPort: number | undefined;
  if (values["callback-port"] !== undefined) {
    callbackPort = Number(values["callback-port"]);
    if (!Number.isInteger(callbackPort) || callbackPort < 0 || callbackPort > 65535) return usageError("--callback-port 必须是 0–65535 的整数");
  }

  if (values["time-zone"] !== undefined) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: values["time-zone"] });
    } catch {
      return usageError(`--time-zone 不是有效的时区：${values["time-zone"]}（例：Asia/Shanghai）`);
    }
  }

  const json = values.json ?? false;
  const color = !json && process.stdout.isTTY === true && !process.env.NO_COLOR;
  const endpoint = values.endpoint ?? endpointOf(manifest);
  if (!json) process.stdout.write(`${formatHeader({ tool: TOOL, rsp: RSP_VERSION, endpoint })}\n\n`);

  let receiver: CallbackReceiver | undefined;
  if (callbackPort !== undefined) {
    try {
      receiver = await startCallbackReceiver({
        secrets: oldSecret ? [secret, oldSecret] : [secret],
        port: callbackPort,
        ...(values["callback-host"] ? { host: values["callback-host"] } : {}),
        ...(values["callback-url"] ? { publicUrl: values["callback-url"] } : {}),
      });
    } catch (error) {
      return usageError(`回调接收端起不来：${(error as Error).message}`);
    }
    // --json 时 stdout 只放报告，提示写到 stderr。
    (json ? process.stderr : process.stdout).write(`回调接收端：${receiver.url}/v1/callbacks/{order_id}（请把供给方的回调地址指到这里）\n\n`);
  }

  const report = await runConformance({
    manifest,
    secret,
    ...(values.endpoint ? { endpoint: values.endpoint } : {}),
    ...(oldSecret ? { oldSecret } : {}),
    ...(inputs ? { inputs } : {}),
    ...(values["require-https"] ? { requireHttps: true } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(values["time-zone"] ? { timeZone: values["time-zone"] } : {}),
    ...(values["allow-zero-fee"] ? { policy: { allowZeroFee: true } } : {}),
    ...(receiver ? { callbacks: receiver.store, callbackUrl: receiver.url } : {}),
    ...(values["binding-code"] ? { bindingCode: values["binding-code"] } : {}),
    ...(values["supplier-user-ref"] ? { supplierUserRef: values["supplier-user-ref"] } : {}),
    ...(asyncTimeoutMs ? { asyncTimeoutMs } : {}),
    ...(pollIntervalMs ? { pollIntervalMs } : {}),
    ...(values["no-cancel"] ? { testCancel: false } : {}),
    ...(json ? {} : { onCheck: (check: Check) => void process.stdout.write(`${formatCheck(check, { color })}\n`) }),
  });

  await receiver?.close();
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`\n${formatSummary(report, { color })}\n`);
  return report.ok ? 0 : 1;
}

function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`读不到${what}文件 ${path}：${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what}文件 ${path} 不是合法 JSON：${(error as Error).message}`);
  }
}

function isInputs(v: unknown): v is Record<string, Record<string, unknown>> {
  const isObject = (x: unknown) => x !== null && typeof x === "object" && !Array.isArray(x);
  return isObject(v) && Object.values(v as object).every(isObject);
}

function endpointOf(manifest: unknown): string {
  const url = (manifest as { endpoint?: { url?: unknown } } | null)?.endpoint?.url;
  return typeof url === "string" ? url : "（清单里没有端点）";
}

function usageError(message: string): number {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
