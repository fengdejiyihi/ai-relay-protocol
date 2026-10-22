# @ai-relay/sandbox-shop

Relay 沙箱理发店：AI Relay 自营的到店预约商家，也是 **RSP 1.0 L1 接入的参照实现**。

- 一个 `POST /relay` 端点，处理 `ping` 和 `action.invoke`
- 实现 [`examples/manifests/sandbox-shop.json`](../../examples/manifests/sandbox-shop.json) 的 4 个同步动作：`list_slots`、`book_slot`、`get_booking`、`cancel_booking`
- 验签（支持轮换期两个 secret）、按 `idempotency_key` 幂等
- SQLite 单文件，预置 7 天时段，每天滚动（北京时间零点后第一次访问时删掉过去的日期、补上新的一天，未来的预约保留）
- 每个结果返回 `data` + `parts`（markdown + link）

不依赖任何 Web 框架，运行时依赖只有 `@dreamcavy/ai-relay-protocol`。SQLite 用 Node 自带的 `node:sqlite`（Node ≥ 22.13 无需开关），不需要编译原生模块。

如果你是要接入 Relay 的产品方，下面的教程就是给你的：照着沙箱的代码走一遍，一个下午能把自己的产品接成 L1。

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

### 路由

| 路由 | 说明 |
|---|---|
| `POST /relay` | RSP 1.0 唯一入口 |
| `GET /healthz` | 健康检查 |
| `GET /?date=YYYY-MM-DD` | 当天空闲时段网页（`list_slots` 的 link 指向这里） |
| `GET /b/:booking_id` | 预约详情网页，手机号脱敏（`book_slot` 等的 link 指向这里） |

---

## 对外 API

包入口 `@ai-relay/sandbox-shop`（`src/index.ts`），给 Relay 应用的端到端测试嵌入用：

| 导出 | 说明 |
|---|---|
| `createShop(config, now?)` | 读清单、开库、装好路由，返回 `{ server, store, manifest }`，不监听端口 |
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
