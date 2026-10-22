# @ai-relay/sandbox-shop

Relay 沙箱商家：AI Relay 自营的演示供给方，是 **RSP 1.0 L1 和 L2 接入的参照实现**。同一个进程里有三家：

| 供给方 | 档位 | 清单 | 端点 |
|---|---|---|---|
| 沙箱理发店 | L1 同步 | [`sandbox-shop.json`](../../examples/manifests/sandbox-shop.json) | `POST /relay` |
| 文章发布 | L2 异步单结果 + 账号绑定 | [`l2-publisher.json`](../../examples/manifests/l2-publisher.json) | `POST /publisher/relay` |
| 外包撮合 | L2 多方案 + 账号绑定 | [`l2-matching.json`](../../examples/manifests/l2-matching.json) | `POST /match/relay` |

三家各用各的 secret，互不通用。下面先讲理发店（L1），L2 见[「再花一天接入 L2」](#再花一天接入-l2)。

理发店：

- 一个 `POST /relay` 端点，处理 `ping` 和 `action.invoke`
- 实现 [`examples/manifests/sandbox-shop.json`](../../examples/manifests/sandbox-shop.json) 的 4 个同步动作：`list_slots`、`book_slot`、`get_booking`、`cancel_booking`
- 验签（支持轮换期两个 secret）、按 `idempotency_key` 幂等
- SQLite 单文件，预置 7 天时段，每天滚动（北京时间零点后第一次访问时删掉过去的日期、补上新的一天，未来的预约保留）
- 每个结果返回 `data` + `parts`（markdown + link）

不依赖任何 Web 框架，运行时依赖只有 `@dreamcavy/ai-relay-protocol`。SQLite 用 Node 自带的 `node:sqlite`（Node ≥ 22.13 无需开关），不需要编译原生模块。

如果你是要接入 Relay 的产品方，下面的教程就是给你的：照着沙箱的代码走一遍，一个下午能把自己的产品接成 L1，再花一天接成 L2。

---

## 一个下午接入 L1

L1 = 一个端点 + 一份清单，能接全部同步动作（RSP 1.0 第 13 节）。你要做的事一共五步。

### 第 1 步：写清单（30 分钟）

把你想开放给 AI 的能力写成动作。每个动作是一对 JSON Schema（输入、输出）加 6 个通用元数据。照抄 [`sandbox-shop.json`](../../examples/manifests/sandbox-shop.json) 改：

| 元数据 | 沙箱怎么填 | 你怎么想 |
|---|---|---|
| `risk` | 查询 `low`，预约/取消 `medium` | 会不会花用户的钱、改用户的数据 |
| `confirm` | 查询 `never`，其余 `by_grant` | 一般按风险让 Relay 决定 |
| `mode` | 全部 `sync` | 3 秒内能给结果就是 sync |
| `billing` | 预约成功 `on_complete`，其余 `none` | 哪一步算你给用户办成了一件事 |
| `fee` / `amount` | `book_slot` 的 `amount` 是 `{"from": "input.price_cents"}`：用户确认页按这个字段显示到店要付多少钱 | 用户付给你的钱从哪个输入字段来；收到后要核对它和你的真实价格一致，对不上回 `invalid_input`（沙箱见 `src/store.ts` 的 `book`） |

`low` 风险只能用于 `billing: "none"` 且 `readonly: true` 的动作。手机号这类个人信息在 Schema 里标 `"x-pii": true`。写完用协议包校验：

```ts
import { validateManifest } from "@dreamcavy/ai-relay-protocol";
const result = validateManifest(JSON.parse(readFileSync("manifest.json", "utf8")));
if (!result.ok) console.error(result.errors);
```

沙箱启动时也这样做（[`src/index.ts`](src/index.ts) 的 `loadManifest`），清单不合法就不启动；清单里的动作没实现也不启动。

### 第 2 步：验签（20 分钟）

Relay 发来的每个请求都带 `X-Relay-Signature: t=<秒>,v1=<hex>`。**用收到的原始请求体字节验**（`Buffer.concat` 拼好直接传），不要逐块解码，也不要先 `JSON.parse` 再序列化。

```ts
import { verifySignature } from "@dreamcavy/ai-relay-protocol";
const verified = verifySignature({ secrets: [newSecret, oldSecret], header, body: rawBody });
if (!verified.ok) return reply(401, { status: "failed", error: { code: "unauthorized" } });
```

沙箱的写法见 [`src/relay.ts`](src/relay.ts) 开头和 [`src/http.ts`](src/http.ts) 的 `readBody`。不用协议包也行，算法见 RSP 1.0 第 3 节和附录 A。

### 第 3 步：按 type 和 action 分发（1 小时）

```
ping           → { status: "ok", challenge: <原样带回>, rsp: "1.0" }
action.invoke  → 按 action 找处理函数，先用清单里的 input Schema 校验输入
其他 type      → { status: "failed", error: { code: "not_supported" } }
```

除了验签失败回 401，**其余结果一律 HTTP 200 + 响应体**，业务失败也是 200（`{"status":"failed","error":{...}}`）。Relay 把非 200 当成传输问题：5xx 意味着「不知道你做没做」，订单会进人工核对。

错误码只用这几个（RSP 1.0 第 9 节）：

| 情况 | 沙箱的例子 | code |
|---|---|---|
| 输入不合法 | 手机号格式错 | `invalid_input` |
| 没货、没位 | 时段被约走、预约不存在 | `not_available` |
| 临时故障且**确定没执行** | 超过 `deadline_at` 没处理 | `temporary`（Relay 会重试） |
| 其他不可重试的失败 | — | `permanent` |

处理函数见 [`src/actions.ts`](src/actions.ts)，每个都不到 30 行。

### 第 4 步：幂等（30 分钟）

Relay 在网络失败、`temporary`、`rate_limited` 时会用**同一个 `idempotency_key`** 重发。你必须保证同一个键只执行一次，再来就返回第一次的结果。沙箱的做法（[`src/relay.ts`](src/relay.ts) 的 `invoke`）：

1. 只读动作不记，重放没有副作用。
2. 写动作在同一个数据库事务里：查键 → 没有就执行并把响应存下 → 有就原样返回存下的响应。
3. 成功和不可重试的失败都存；`temporary` / `rate_limited` 不存，这样重试真的会再试一次。
4. 同一个键带了不同的输入（按键排序后的 JSON 求 sha256 比较），回 `invalid_input`，不执行。

### 第 5 步：返回 data + parts（30 分钟）

```json
{
  "status": "completed",
  "output": {
    "data": { "booking_id": "b_…", "start": "2026-10-23T15:00:00+08:00", "service": "haircut", "price_cents": 6800 },
    "parts": [
      { "type": "markdown", "text": "已为张三预约 **10 月 23 日 15:00 剪发**，到店付款 ¥68……" },
      { "type": "link", "url": "https://sandbox.relay.newbeeai.online/b/b_…", "title": "在网页查看预约" }
    ]
  }
}
```

- `data` 必须符合动作的 `output` Schema，AI 靠它做判断。
- `parts` 给人看，可以放 markdown、图片、文件、链接、JSON。返回给用户的文字里别放完整的个人信息，沙箱把手机号脱敏成 `138****8000`。
- 写完用 `validateResponse("action.invoke", body)` 自检，沙箱的测试对每个响应都这样做。

### 自测

沙箱的测试 [`test/relay.e2e.test.ts`](test/relay.e2e.test.ts) 起一个真实 HTTP 服务，用真签名发信封，覆盖：ping、验签（缺头、错 secret、过期、篡改、旧 secret）、非法信封、不认识的 type、每个动作的正常与非法输入、同键重放、同键异输入、跨天滚动（明天的预约过零点后仍在，同键重试仍返回原预约）、别的用户看不到你的预约。你的产品照这个清单写一遍测试，接入验收（Conformance）基本就能过。
---

## 再花一天接入 L2

L2 = L1 + 异步任务（`accepted` 之后回调）+ 需要时的多方案和账号绑定（RSP 1.0 第 7、11、13 节）。沙箱的两家 L2 在 [`src/l2/`](src/l2/)：

| 文件 | 内容 |
|---|---|
| [`supplier.ts`](src/l2/supplier.ts) | 每家都一样的部分：验签、信封校验、绑定检查、幂等，按 `type` 分发到下面两家 |
| [`publisher.ts`](src/l2/publisher.ts) | 发文：接单、定时「发出」、补拉、取消 |
| [`matching.ts`](src/l2/matching.ts) | 撮合：陆续来方案、撤回、选定、交换联系方式 |
| [`outbox.ts`](src/l2/outbox.ts) | 回调发件箱：签名、5xx 退避重发、故障开关 |
| [`store.ts`](src/l2/store.ts) | SQLite：账号、绑定码、任务、方案、定时动作、发件箱 |

### 第 1 步：接单就回 accepted（1 小时）

异步动作（清单里 `mode: "async"` 或 `"async_multi"`）收到 `action.invoke` 不要等干完，建一个任务、记下 `order_id`，马上回：

```json
{ "status": "accepted", "task_id": "t_…", "eta_seconds": 5 }
```

`accepted` 和 `completed` 一样要按 `idempotency_key` 缓存：Relay 重发同一个键时回同一个 `task_id`，不能再建一个任务（[`supplier.ts`](src/l2/supplier.ts) 的 `invoke`）。

### 第 2 步：干完了发回调（2 小时）

```
POST {Relay 根地址}/v1/callbacks/{order_id}
X-Relay-Signature: t=…,v1=…      ← 和下行同一个 secret、同一个算法，签的是你发出的原始请求体
```

```json
{ "type": "completed", "rsp": "1.0", "order_id": "ord_…", "event_id": "evt_…", "occurred_at": 1792800000,
  "output": { "data": { "article_url": "https://…" }, "parts": [ … ] } }
```

要点（[`outbox.ts`](src/l2/outbox.ts)）：

- **先落库再发**。事件和业务状态在同一个事务里写进发件箱，后台循环去发。进程重启不丢回调。
- **`event_id` 生成一次就不变**。重发用同一个 `event_id`、同一个请求体，Relay 按 `(order_id, type, event_id)` 去重。
- **只有 5xx、超时、连不上才重发**，沙箱按 1、4、16、60、300、900 秒退避，之后放弃（Relay 会用 `task.poll` 补拉）。4xx 是 Relay 明确的答复：409 是订单已终态、422 是当前状态不接受，记下来就好，不要重发。
- 签名时间戳用**发送时刻**，每次重发重新签（时间窗只有 5 分钟）。

### 第 3 步：task.poll 和 task.cancel（1 小时）

回调可能丢，Relay 会按 1、2、5、15 分钟退避发 `task.poll` 补拉。`task.poll` 回任务的当前结果：

| 任务状态 | 回 |
|---|---|
| 还在做 | `{"status":"pending","eta_seconds":…}` |
| 多方案、已有方案 | `{"status":"proposals","proposals":[…]}`，**只列有效方案**，Relay 把列表里没有的当作已撤回 |
| 完成 / 失败 | 和回调里一样的 `completed` / `failed` |

`task.cancel`（`reason` 是 `user_cancelled`、`expired` 或 `no_selection`）：还能撤回就停下并回 `cancelled`，之后不能再发这一单的结果；已经不可撤回（文章已发出）回 `cancel_failed` 带 `reason`。重复取消回同一个结果。`task_id` 和 `order_id` 对不上时当作没有这个任务。

### 第 4 步：多方案（半天）

撮合的需求接单后，每来一个服务商报价就发一个 `proposal.add` 回调；服务商不做了发 `proposal.withdraw`。用户选定后 Relay 发 `proposal.select`：

- 方案有效 → 回 `selected`，交换完联系方式再发 `completed` 回调（也可以当场回 `completed`）。
- 方案已撤回或不存在 → `failed` + `invalid_input`；已选了别的 → `failed` + `not_available`。同一个方案重复选，回同一个结果。
- **已选的方案被撤回**：发 `proposal.withdraw`，任务回到待选，Relay 那边订单回到「方案待选」，用户可以再选。

### 第 5 步：账号绑定（半天）

清单 `user_binding: "token"` 时，Relay 需要知道用户在你那边是谁（RSP 1.0 第 11 节）。你要做两样：

1. **绑定码页面**（地址填 `binding.help_url`）：已登录的用户点一下生成一次性绑定码，10 分钟有效。沙箱没有登录，填个称呼就建一个账号。
2. **`binding.verify`**：码有效就标为已用，回 `{"status":"bound","supplier_user_ref":"acct_…","display_name":"…"}`；码无效、已用、过期回 `failed` + `invalid_input`（沙箱在 `details.reason` 里写 `unknown`、`used`、`expired`）。同一个 `relay_uid` 重发同一个码应回同一个结果。

之后 `action.invoke` 的 `user.supplier_user_ref` 就是你的账号标识。没有、不认识或已作废时回 `failed` + `unauthorized`：Relay 会把绑定标失效，让用户重新绑。

### 自测

[`test/l2.e2e.test.ts`](test/l2.e2e.test.ts) 起一个真实沙箱和一个假 Relay 回调端点（验签、严格校验事件 Schema、核对路径里的 `order_id`），用可注入的时钟推进，覆盖：两家 secret 互不通用；绑定成功、幂等、码无效 / 已用 / 过期、跨家无效、未绑 / 作废后 `unauthorized`、重新绑定；发文接单 → 补拉 → 回调 → 发出后取消失败、发出前取消、`#fail`；5xx 退避重发、4xx 不重发、重发用尽后放弃仍可补拉；丢回调、迟到回调、重复回调；撮合三个方案 → 选定 → 完成、撤回、选定后被撤回再选、网页撤回、选定前取消、同键重放。

### 故障开关

给 Relay 测补拉和去重用，正式产品没有这些：

| 开关 | 效果 |
|---|---|
| `drop` | 回调不发（发件箱记为 dropped），只能靠 `task.poll` 拿结果 |
| `late` | 回调推迟 `CALLBACK_LATE_MS`（默认 90 秒）才发 |
| `dup` | 同一个事件（同一个 `event_id`、同一个请求体）发两次 |
| `fail` | 发文以 `failed` 回调结束 |
| `withdraw` | 撮合第 3 个方案到后撤回第 2 个 |
| `withdraw-selected` | 撮合选定后撤回被选的方案（只一次），不发 `completed`，回到待选 |

环境变量 `CALLBACK_FAULTS=drop,dup` 对所有单子生效；在文章标题或需求标题里写 `#drop`、`#late` 等只影响这一单。

---

## 运行

```sh
pnpm install
pnpm --filter @ai-relay/sandbox-shop build
RELAY_SECRETS=whsec_local_dev pnpm --filter @ai-relay/sandbox-shop start
```

本地发一个 ping（签名用协议包算）：

```sh
node --input-type=module -e '
const { signBody } = await import("@dreamcavy/ai-relay-protocol");
const body = JSON.stringify({ type: "ping", rsp: "1.0", issued_at: Math.floor(Date.now()/1000), challenge: "hello-relay-sandbox" });
const res = await fetch("http://127.0.0.1:8787/relay", { method: "POST", body, headers: { "X-Relay-Signature": signBody("whsec_local_dev", body) } });
console.log(res.status, await res.text());
'
```

（在 `apps/sandbox-shop` 目录下执行，才能解析到 `@dreamcavy/ai-relay-protocol`。）

### 配置

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `RELAY_SECRETS` | 必填 | Relay 后台给的 secret。轮换期内写两个，新的在前，逗号隔开 |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 监听地址，前面放 nginx |
| `DB_PATH` | `./data/sandbox-shop.db` | SQLite 文件，目录不存在会自动创建；`:memory:` 用于测试 |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | 门店网页的根地址，拼进 link 内容块 |
| `MANIFEST_PATH` | 仓库里的 `examples/manifests/sandbox-shop.json` | 清单文件 |
| `PUBLISHER_SECRETS` / `MATCH_SECRETS` | 空 | 发文、撮合两家 L2 的 secret，写法同 `RELAY_SECRETS`。不填就不挂这一家 |
| `RELAY_CALLBACK_BASE` | 配了 L2 就必填 | Relay 根地址，回调发到 `{RELAY_CALLBACK_BASE}/v1/callbacks/{order_id}` |
| `L2_PUBLISH_DELAY_MS` | `5000` | 发文接单后多久「发出」 |
| `L2_PROPOSAL_INTERVAL_MS` | `2000` | 撮合每隔多久来一个方案（共 3 个） |
| `L2_SELECT_DELAY_MS` | `3000` | 选定后多久交换联系方式并回调 `completed` |
| `CALLBACK_FAULTS` / `CALLBACK_LATE_MS` | 空 / `90000` | 故障开关，见上 |
| `PUBLISHER_MANIFEST_PATH` / `MATCH_MANIFEST_PATH` | 仓库里的两个 L2 示例清单 | 清单文件 |

### 路由

| 路由 | 说明 |
|---|---|
| `POST /relay` | RSP 1.0 唯一入口 |
| `GET /healthz` | 健康检查 |
| `GET /?date=YYYY-MM-DD` | 当天空闲时段网页（`list_slots` 的 link 指向这里） |
| `GET /b/:booking_id` | 预约详情网页，手机号脱敏（`book_slot` 等的 link 指向这里） |
| `POST /publisher/relay`、`POST /match/relay` | 两家 L2 的 RSP 入口 |
| `GET/POST /publisher/settings/relay-binding`、`/match/settings/relay` | 绑定码页面（清单 `binding.help_url` 的路径）。POST 带 `Accept: application/json` 时回 `{code, supplier_user_ref, expires_at, display_name}`，方便脚本化 |
| `POST …/revoke`（上面两个路径后面加） | 表单字段 `ref`，作废账号，测「绑定失效」 |
| `GET /publisher/a/:task_id` | 已发出的文章（`article_url` 指向这里） |
| `GET /match/t/:task_id`、`POST /match/t/:task_id/withdraw/:proposal_id` | 需求和方案列表，服务商在这里撤回方案 |

清单里的 `https://publisher.example.com`、`https://match.example.com` 在 Relay 登记时换成 `{PUBLIC_BASE_URL}/publisher`、`{PUBLIC_BASE_URL}/match`，示例文件本身不改。

---

## 对外 API

包入口 `@ai-relay/sandbox-shop`（`src/index.ts`），给 Relay 应用的端到端测试嵌入用：

| 导出 | 说明 |
|---|---|
| `createShop(config, now?, options?)` | 读清单、开库、装好路由，返回 `{ server, store, manifest, l2? }`，不监听端口。`options.tickMs` 默认 500（开始监听后自动跑定时动作和回调），传 `false` 由测试手动 `await l2.tick()`；`options.fetch` 换掉发回调的 fetch |
| `l2.tick()` / `l2.store.nextWakeAt()` | 跑掉到点的定时动作并发出到点的回调 / 下一个到点时刻，测试快进时钟用 |
| `l2.issueBindingCode(supplier, name)` | 新建账号并生成绑定码 `{ code, supplier_user_ref, expires_at }`，`supplier` 是 `"publisher"` 或 `"match"` |
| `l2.store.revokeAccount(supplier, ref)` | 作废账号，之后的 `action.invoke` 回 `unauthorized` |
| `l2.withdrawProposal(proposal_id)` | 服务商撤回方案 |
| `l2.store.events(order_id)` | 这一单发件箱里的回调和投递状态 |
| `l2.handlers.publisher` / `.match` | 与框架无关的 `(rawBody, signature) => { httpStatus, body }` |
| `createRelayHandler(options)` | 与框架无关的 `(rawBody, signature) => { httpStatus, body }`，可以挂到任何 HTTP 框架上 |
| `createHttpServer(options)` | 基于 `node:http` 的路由 |
| `ShopStore` | SQLite 门店数据：时段、预约、幂等记录、每日滚动 |
| `ACTIONS` | 4 个动作的处理函数 |
| `loadConfig(env)` / `loadManifest(path)` | 读环境变量 / 读并校验清单 |
| `hashInput(action, input)` | 幂等比较用的输入摘要 |

## 门店数据

| 项目 | 价格 | 时段（北京时间） |
|---|---|---|
| 剪发 `haircut` | ¥68 | 10:00–19:00 每小时 |
| 洗吹 `wash` | ¥30 | 10:00–19:00 每小时 |
| 染发 `color` | ¥288 | 10:00、13:00、16:00 |

改 [`src/catalog.ts`](src/catalog.ts) 就能换一家店；清单里 `service` 的 enum 要同步。
