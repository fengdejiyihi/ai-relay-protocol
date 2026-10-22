# @dreamcavy/ai-relay-conformance

RSP 1.0 接入验收工具。它读你的清单，用真签名向你的 `POST /relay` 端点逐项发信封，每项给出 **通过 / 失败 / 警告 / 未测**。没有失败项就算接入验收通过。

命令行和 Relay 供给方后台的「在线验收」按钮用的是同一个 `runConformance`，本机跑通了，后台也会是同样的结果（后台额外要求 HTTPS、拒绝私网地址）。

> 尚未发布到 npm。发布前在仓库里 `pnpm install && pnpm build`，然后在你的项目目录里用 `node <仓库路径>/packages/conformance/dist/cli.js ...` 运行，参数和下文一样。也可以用 `pnpm --filter @dreamcavy/ai-relay-conformance conformance ...`，但它在 `packages/conformance` 目录里执行，文件参数要写绝对路径。

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
| `--callback-port <端口>` | 本机起回调接收端，见下文「异步动作」。不给时不验回调，只靠 `task.poll` |
| `--callback-host <地址>` | 接收端监听的地址，默认 `127.0.0.1`；供给方在另一台机器上时用 `::`（监听所有地址） |
| `--callback-url <URL>` | 提示给供给方的回调根地址（比如内网穿透的公网地址），默认 `http://<地址>:<端口>` |
| `--binding-code <码>` | `user_binding=token` 的供给方：在你的产品里生成的一次性绑定码 |
| `--supplier-user-ref <账号>` | 不走绑定，直接用这个测试账号作为 `user.supplier_user_ref` 调用动作（给了绑定码且绑定成功时用绑定得到的账号） |
| `--async-timeout <秒>` | 每个异步动作等最终结果的上限，默认 120 |
| `--poll-interval <秒>` | `task.poll` 间隔，默认 3 |
| `--no-cancel` | 不测 `task.cancel`（默认每个异步动作额外下一单并立刻取消） |

退出码：`0` 通过（可以有警告和未测），`1` 有失败项，`2` 参数或文件错误。

**验收会真的调用你的动作。** 请接测试环境，或者让样例输入走一条可撤销的路径（比如先预约再取消）。

### 样例输入

`--inputs` 是一个 JSON 对象，键是动作名，值是这个动作的输入。动作按键的顺序执行，所以可以把「先查、再订、再取消」串起来。值如果整个是一个占位符，会被替换（保留原类型）：

| 占位符 | 替换成 |
|---|---|
| `{{动作名.路径}}` | 前面某个动作返回 `completed` 时 `output.data` 里的值，路径写法 `slots[0].slot_id` |
| `{{$today}}`、`{{$tomorrow}}` | 今天、明天的日期 `YYYY-MM-DD`，按 `--time-zone` 算 |

沙箱理发店的样例在 [`examples/sandbox-shop.inputs.json`](examples/sandbox-shop.inputs.json)（L2 的两家在 [`sandbox-publisher.inputs.json`](examples/sandbox-publisher.inputs.json)、[`sandbox-matching.inputs.json`](examples/sandbox-matching.inputs.json)）：

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

### 异步动作（L2）

`mode` 是 `async`、`async_multi` 的动作回 `accepted` 之后，验收会一直跟到最终结果：

1. 本机起一个回调接收端，路由和 Relay 一样是 `POST /v1/callbacks/{order_id}`。把你的产品发回调的根地址临时指到它：

   ```sh
   npx @dreamcavy/ai-relay-conformance --manifest manifest.json --endpoint http://127.0.0.1:8787/relay \
     --inputs inputs.json --callback-port 8788
   # 回调接收端：http://127.0.0.1:8788/v1/callbacks/{order_id}（请把供给方的回调地址指到这里）
   ```

   接收端按 Relay 的规则回 HTTP：验签失败 401（每笔订单只留前 5 条明细，其余计数；每笔最多记 200 条回调明细），事件不合 Schema 或路径和 `order_id` 不一致 422，终态之后的事件 409，重复的 `event_id` 200。
2. 每隔 `--poll-interval` 秒发一次 `task.poll`，直到回调或补拉给出 `completed` / `failed`，最长 `--async-timeout` 秒。拿到结果后再补拉一次，两边必须一致。
3. 多方案（`async_multi`）：收到第一个有效方案后，先用一个不存在的 `proposal_id` 发 `proposal.select`（必须回 `failed`），再选这个方案；已选的方案被撤回时换一个再选。
4. 再下一单同样的任务，立刻 `task.cancel`（reason `user_cancelled`）。回 `cancelled` 时再取消一次（应当仍是 `cancelled`），再补拉（不能再是 `completed`）；回 `cancel_failed` 也算通过。`--no-cancel` 跳过这一步。

没开回调接收端也能验：结果全靠 `task.poll`，回调检查标「未测」。一条回调都没收到时是警告，不是失败（规范第 7 节允许只实现补拉，但用户会多等 1–15 分钟）。

### 账号绑定

清单 `supplier.user_binding` 是 `token` 时，先用一个编造的绑定码发 `binding.verify`（必须回 `failed`）。给了 `--binding-code` 时再用它绑定（必须回 `bound`），之后所有 `action.invoke` 的 `user.supplier_user_ref` 都带上绑定得到的账号；最后换一个 `relay_uid` 用同一个码再绑一次（应当回 `failed`，绑定码一次性）。同一个用户重发同一个码可以再回 `bound`（Relay 网络重试时会这样）。

不方便每次生成绑定码时，可以用 `--supplier-user-ref` 直接给一个测试账号：动作调用都带上它，`binding.verify` 用例标「未测」。

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
| `output.<动作>` | `completed` 的 `output.data` 符合动作的 `output` Schema（第 8 节「应当」）；异步动作用最终结果校验 | 警告；没拿到 `completed` 时标「未测」 |
| `replay.<动作>` | 同一个 `idempotency_key` 再发一次，响应和第一次一致（第 10 节） | 失败；第一次是 `temporary`、`rate_limited` 时不比对 |
| `binding.invalid_code` | 编造的绑定码 `binding.verify` 回 `failed`（第 11 节） | 失败 |
| `binding.verify` | `--binding-code` 给的码回 `bound` 和 `supplier_user_ref` | 失败；没给码时「未测」 |
| `binding.reuse` | 换一个用户用同一个码回 `failed` | 警告 |
| `poll.<动作>` | 每次 `task.poll` 都是 HTTP 200 且通过响应 Schema；非多方案动作不回 `proposals` | 失败 |
| `async.<动作>` | 超时前拿到最终结果，回调、`task.poll`、`proposal.select` 给出的最终结果一致 | 失败；最终结果是 `failed` 时警告（样例输入没走通） |
| `proposal.<动作>` | 多方案：收到方案，选定有效方案时回 `selected` 或 `completed` | 失败 |
| `select_unknown.<动作>` | 多方案：选一个不存在的方案回 `failed` | 失败 |
| `cancel.<动作>` | `task.cancel` 响应合法；`cancelled` 之后重复取消仍是 `cancelled`、补拉不再是 `completed` | 失败；刚接单就取消却回 `failed` 时警告 |
| `callback.received` | 收到回调 | 警告（只靠补拉也能接入） |
| `callback.signature` | 回调用同一个 secret 对原始请求体签名（第 3、7 节） | 失败 |
| `callback.schema` | 回调符合 `upstream.json`，路径和请求体的 `order_id` 一致 | 失败 |
| `callback.dedupe` | 同一个 `event_id` 重发时内容和第一次一样（Relay 只认第一次） | 失败 |
| `callback.terminal` | 终态（含 `task.cancel` 回了 `cancelled`）之后不再发改状态的事件（第 12 节）；同样的结果再来一次不算 | 失败 |
| `callback.state` | 事件符合订单当前状态和模式：非多方案不发 `proposal.*`，没选定方案不发 `completed`，撤回的方案必须出现过 | 失败 |
| `callback.receiver` | 没开回调接收端 | 未测 |
| `transport.latency` | 所有请求都在 3 秒内响应（第 2 节「应当」） | 警告 |
| `envelope.extra_fields` | 响应用 `{ strict: true }` 校验没有 Schema 外的字段（第 6、14 节） | 警告 |

验签用例都发 `ping`，不会触发任何业务动作。重放用例请求体不变、重新签名，和 Relay 重试时完全一样。

异步检查里的每一单都是真实下单：一个异步动作会下两单（一单走完、一单测取消），多方案动作会真的选定一个方案。

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
| `callbacks?` | 回调接收端的订单存放处（`CallbackStore`）。命令行用 `startCallbackReceiver` 的 `store`；Relay 在线版用数据库实现。不给时不验回调 |
| `callbackUrl?` | 回调根地址，只用在报告的提示里 |
| `asyncTimeoutMs?` / `pollIntervalMs?` / `settleMs?` | 异步动作等结果的上限（默认 120000）、`task.poll` 间隔（默认 3000）、跑完后再等迟到回调的时间 |
| `totalTimeoutMs?` | 整次验收的时间预算，所有异步动作共用；用完后还没结果的判超时、取消用例标未测。默认不限，Relay 在线验收传 240000 |
| `bindingCode?` | 一次性绑定码，见「账号绑定」 |
| `supplierUserRef?` | 直接指定 `user.supplier_user_ref`，见「账号绑定」 |
| `testCancel?` | `false` 时不测 `task.cancel` |

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
  group: "transport" | "manifest" | "ping" | "auth" | "envelope" | "binding" | "action" | "async" | "callback";
  title: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail?: string;          // 为什么失败、实际收到了什么
  issues?: Issue[];         // Schema 错误，带 JSON 指针
  ms?: number;              // 这一项的 HTTP 往返耗时
}
```

其他导出：`formatReport`、`formatCheck`、`formatHeader`、`formatSummary`（终端文本），`resolveInput`（占位符替换），`firstDifference`（重放比对用的 JSON 差异定位）。

回调接收端：

| 导出 | 说明 |
|---|---|
| `startCallbackReceiver({ secrets, port?, host?, publicUrl? })` | 本机起 `POST /v1/callbacks/{order_id}`，返回 `{ url, store, strays(), close() }` |
| `memoryStore()` | 内存版 `CallbackStore` |
| `receiveCallback(store, { pathOrderId, rawBody, signature, secrets, now? })` | 收一条回调：不是验收订单返回 `null`，否则返回要回的 `{ http, body }`。自己写 HTTP 层时用它 |
| `judgeCallback(order, request)` | 纯函数：按 Relay 的规则判一条回调，返回响应和更新后的 `TestOrder`（可 JSON 序列化） |

```ts
interface CallbackStore {
  create(order: TestOrder): Promise<void>;
  get(orderId: string): Promise<TestOrder | undefined>;
  /** 原子地改一笔订单（数据库实现要加行锁）；没有这笔订单时返回 undefined。 */
  update(orderId: string, fn: (order: TestOrder) => TestOrder): Promise<TestOrder | undefined>;
}
```

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
