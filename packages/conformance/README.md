# @dreamcavy/ai-relay-conformance

RSP 1.0 接入验收工具。它读你的清单，用真签名向你的 `POST /relay` 端点逐项发信封，每项给出 **通过 / 失败 / 警告 / 未测**。没有失败项就算接入验收通过。

命令行和 Relay 供给方后台的「在线验收」按钮用的是同一个 `runConformance`，本机跑通了，后台也会是同样的结果（后台额外要求 HTTPS、拒绝私网地址）。

> 尚未发布到 npm。发布前在仓库里用 `pnpm --filter @dreamcavy/ai-relay-conformance conformance ...` 运行（见下文）。

## 命令行

```sh
npx @dreamcavy/ai-relay-conformance \
  --manifest manifest.json \
  --endpoint http://127.0.0.1:8787/relay \
  --secret "$RELAY_SECRET" \
  --inputs inputs.json
```

| 参数 | 说明 |
|---|---|
| `--manifest <文件>` | 清单 JSON，必填 |
| `--endpoint <URL>` | 被测端点，默认用清单里的 `endpoint.url` |
| `--secret <secret>` | 当前 secret；也可以放在环境变量 `RELAY_SECRET`，避免留在 shell 历史里 |
| `--old-secret <secret>` | 轮换期的旧 secret（或 `RELAY_OLD_SECRET`）；给了才测「只用旧 secret 签也通过」 |
| `--inputs <文件>` | 每个动作一份样例输入，见下文；不给的动作标「未测」 |
| `--require-https` | 端点不是 HTTPS 直接判失败（默认只警告，方便本机联调） |
| `--timeout <毫秒>` | 单个请求的超时，默认 60000（RSP 同步硬超时） |
| `--time-zone <时区>` | `{{$today}}` 按哪个时区算，默认本机时区 |
| `--allow-zero-fee` | 允许收费动作 `fee=0`，只给 Relay 自营的沙箱用 |
| `--json` | 输出机器可读的 JSON 报告（结构见 `ConformanceReport`） |

退出码：`0` 通过（可以有警告和未测），`1` 有失败项，`2` 参数或文件错误。

**验收会真的调用你的动作。** 请接测试环境，或者让样例输入走一条可撤销的路径（比如先预约再取消）。

### 样例输入

`--inputs` 是一个 JSON 对象，键是动作名，值是这个动作的输入。动作按键的顺序执行，所以可以把「先查、再订、再取消」串起来。值如果整个是一个占位符，会被替换（保留原类型）：

| 占位符 | 替换成 |
|---|---|
| `{{动作名.路径}}` | 前面某个动作返回 `completed` 时 `output.data` 里的值，路径写法 `slots[0].slot_id` |
| `{{$today}}`、`{{$tomorrow}}` | 今天、明天的日期 `YYYY-MM-DD`，按 `--time-zone` 算 |

沙箱理发店的样例在 [`examples/sandbox-shop.inputs.json`](examples/sandbox-shop.inputs.json)：

```json
{
  "list_slots": { "date": "{{$tomorrow}}", "service": "haircut" },
  "book_slot": {
    "slot_id": "{{list_slots.slots[0].slot_id}}",
    "price_cents": "{{list_slots.slots[0].price_cents}}",
    "name": "验收测试",
    "phone": "13800138000"
  },
  "get_booking": { "booking_id": "{{book_slot.booking_id}}" },
  "cancel_booking": { "booking_id": "{{book_slot.booking_id}}" }
}
```

样例输入不符合清单里的 `input` Schema 时，这个动作标「未测」并列出原因：Relay 永远不会发这样的请求，测了也没有意义。

## 检查项

| 编号 | 检查什么 | 不满足时 |
|---|---|---|
| `manifest.schema` | 清单通过 `validateManifest` | 失败（动作检查全部跳过） |
| `manifest.policy` | 清单通过平台审核策略 `checkPlatformPolicy` | 失败；策略警告列为警告 |
| `transport.endpoint` | 端点是合法的 http/https URL | 失败 |
| `transport.https` | 端点是 HTTPS（规范第 2 节） | 警告；`--require-https` 时失败 |
| `transport.endpoint_match` | 测的端点就是清单里的 `endpoint.url` | 警告 |
| `ping` | `ping` 回 `{"status":"ok"}` 并原样带回 `challenge` | 失败；连不上时其余网络检查标「未测」 |
| `auth.missing` | 没有签名头 → 401 或 403 | 失败 |
| `auth.wrong_secret` | 错误 secret 的签名 → 401 或 403 | 失败 |
| `auth.expired` | 时间戳超过 5 分钟 → 401 或 403 | 失败 |
| `auth.tampered` | 签名后改动请求体 → 401 或 403 | 失败 |
| `auth.multi_v1` | 头部带两个 `v1=`（一错一对）照常通过（第 3 节轮换） | 失败 |
| `auth.old_secret` | 只用旧 secret 签照常通过（需要 `--old-secret`） | 失败 |
| `envelope.unknown_type` | 不认识的 `type` → 200 + `{"status":"failed","error":{"code":"not_supported"}}` | 失败 |
| `envelope.forward_compat` | `rsp` 为 `1.9`、带未知字段的 `ping` 照常处理（第 14 节） | 失败 |
| `invoke.<动作>` | `action.invoke` 的响应是 HTTP 200，并通过 `validateResponse` | 失败；响应合法但是 `failed` 时警告（样例输入没走通） |
| `output.<动作>` | `completed` 的 `output.data` 符合动作的 `output` Schema（第 8 节「应当」） | 警告；`accepted`（异步结果）标「未测」 |
| `replay.<动作>` | 同一个 `idempotency_key` 再发一次，响应和第一次一致（第 10 节） | 失败；第一次是 `temporary`、`rate_limited` 时不比对 |
| `transport.latency` | 所有请求都在 3 秒内响应（第 2 节「应当」） | 警告 |
| `envelope.extra_fields` | 响应用 `{ strict: true }` 校验没有 Schema 外的字段（第 6、14 节） | 警告 |

验签用例都发 `ping`，不会触发任何业务动作。重放用例请求体不变、重新签名，和 Relay 重试时完全一样。

异步动作的回调、`task.poll`、`task.cancel`、多方案和账号绑定的验收还没有做，会在下一个版本加上。

## 在代码里用

```ts
import { runConformance, formatReport } from "@dreamcavy/ai-relay-conformance";

const report = await runConformance({
  manifest,                       // 已解析的清单对象
  endpoint: "https://shop.example.com/relay",
  secret: process.env.RELAY_SECRET!,
  inputs: { list_slots: { date: "{{$tomorrow}}" } },
  requireHttps: true,
});
console.log(formatReport(report));
if (!report.ok) process.exitCode = 1;
```

`runConformance(options): Promise<ConformanceReport>` 不抛异常，连不上、超时都记在报告里。

| 选项 | 说明 |
|---|---|
| `manifest` | 清单对象（`unknown`，不合法也能跑，会报在 `manifest.schema`） |
| `endpoint?` | 被测端点，默认清单的 `endpoint.url` |
| `secret` / `oldSecret?` | 当前 secret / 轮换期旧 secret |
| `inputs?` | `{ [动作名]: 输入 }`，占位符见上文 |
| `requireHttps?` | `true` 时 http 端点直接失败，不发任何请求 |
| `fetch?` | 换掉发请求的函数，签名 `(url, init) => Promise<{ status, text() }>`。服务端在线验收用它接入带地址策略（拒私网）的 HTTP 客户端 |
| `timeoutMs?` | 单个请求超时，默认 60000 |
| `now?` / `timeZone?` | 当前时间（毫秒）和 `$today` 的时区，测试时固定用 |
| `policy?` | 透传给 `checkPlatformPolicy` 的选项 |
| `manifestVersion?` | 信封里的 `manifest_version`，默认 1 |
| `onCheck?` | 每出一项结果回调一次 |

报告结构：

```ts
interface ConformanceReport {
  tool: { name: string; version: string };
  rsp: string;              // "1.0"
  endpoint: string;
  startedAt: string;        // ISO 时间
  durationMs: number;
  ok: boolean;              // 没有失败项
  summary: { pass: number; fail: number; warn: number; skip: number };
  checks: Check[];
}

interface Check {
  id: string;               // 稳定编号，见上表
  group: "transport" | "manifest" | "ping" | "auth" | "envelope" | "action";
  title: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail?: string;          // 为什么失败、实际收到了什么
  issues?: Issue[];         // Schema 错误，带 JSON 指针
  ms?: number;              // 这一项的 HTTP 往返耗时
}
```

其他导出：`formatReport`、`formatCheck`、`formatHeader`、`formatSummary`（终端文本），`resolveInput`（占位符替换），`firstDifference`（重放比对用的 JSON 差异定位）。

## 在仓库里运行

```sh
pnpm install
pnpm --filter @dreamcavy/ai-relay-conformance... build
pnpm --filter @dreamcavy/ai-relay-conformance conformance \
  --manifest ../../examples/manifests/sandbox-shop.json \
  --endpoint http://127.0.0.1:8787/relay \
  --secret whsec_local \
  --inputs examples/sandbox-shop.inputs.json \
  --allow-zero-fee
```

脚本在包目录下执行，相对路径按 `packages/conformance/` 算。测试 `pnpm --filter @dreamcavy/ai-relay-conformance test` 需要先 build（命令行用例跑的是 `dist/cli.js`）。
