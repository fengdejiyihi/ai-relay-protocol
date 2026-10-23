# @dreamcavy/ai-relay-sdk

AI Relay 供给方 Node SDK。用一个函数接好 RSP 1.0 的 `POST /relay` 端点，用一个类发回调。

不用 SDK 也能接入：协议只要求一个端点和 HMAC 验签（见 [RSP 1.0](../../docs/protocol/rsp-1.0.md)）。SDK 把容易写错的部分做掉：

- **验签**：用收到的原始字节算 HMAC，5 分钟时间窗，常量时间比较；轮换期新旧两个 secret 都认，头部多个 `v1=` 任一匹配即可。
- **分发**：`ping` 自动应答；不认识的 `type` 自动回 `not_supported`；`action.invoke` 按动作名分给你的处理函数，没实现的 L2 信封回 `not_supported`。
- **输入校验**：按清单里动作的 `input` Schema 校验，不合格直接回 `invalid_input`，处理函数拿到的一定是合格输入。
- **幂等**（第 10 节）：同一个 `idempotency_key` 再来时返回第一次的结果，不重复执行；只缓存 `completed`、`accepted` 和不可重试的 `failed`；同键还在处理中回 `temporary`。存储可替换，默认进程内存。
- **宽松解析**（第 14 节）：信封里不认识的字段忽略，任何 `1.x` 都接受。
- **回调客户端**：签名、生成 `event_id`、5xx 和超时用同一个 `event_id` 按退避重发。

要求 Node.js 20 以上。

```sh
npm install @dreamcavy/ai-relay-sdk
```

## 最小例子

```ts
import { createServer } from "node:http";
import { completed, createRelayHandler, failed, toNodeHandler } from "@dreamcavy/ai-relay-sdk";
import manifest from "./manifest.json" with { type: "json" };

const relay = createRelayHandler({
  secrets: [process.env.RELAY_SECRET!], // 轮换期写成 [新, 旧]
  manifest,
  handlers: {
    list_products: (input: { category?: string }) => completed({ products: findProducts(input.category) }),
    place_order: async (input: { sku: string; quantity: number }, ctx) => {
      if (!(await inStock(input.sku, input.quantity))) return failed("not_available", "库存不足");
      const order = await createOrder(input, { externalId: ctx.orderId });
      return completed({ order_no: order.no, total_cents: order.total }, [{ type: "markdown", text: `已下单，订单号 ${order.no}` }]);
    },
  },
});

createServer(toNodeHandler(relay)).listen(8787);
```

完整可运行的例子在 [`examples/l1/`](examples/l1/)：一个约 60 行的花店，两个同步动作，过接入验收的全部检查项（见 `test/conformance.test.ts`）。

```sh
RELAY_SECRET=whsec_xxx PORT=8787 pnpm example
```

## 接到框架上

`createRelayHandler` 本身与框架无关：`relay.handle(rawBody, signatureHeader)` 返回 `{ status, headers, body }`。下面的适配器都只是把原始请求体交给它。

**关键点：验签要原始字节。** 不要让 JSON 中间件先解析 `/relay` 的请求体。

| 框架 | 写法 |
|---|---|
| Node `http` | `createServer(toNodeHandler(relay))` |
| Express 4 / 5 | `app.post("/relay", toNodeHandler(relay))` 挂在 `app.use(express.json())` **之前**；或 `app.post("/relay", express.raw({ type: "*/*" }), toNodeHandler(relay))`。顺序错了会回 500 并提示 |
| Fastify 4 / 5 | `app.register(fastifyRelay(relay, { path: "/relay" }))`。插件作用域内改成原始 Buffer，不影响其他路由 |
| Next.js App Router | `app/relay/route.ts`：`export const POST = toFetchHandler(relay)`。用默认的 Node.js 运行时（SDK 用了 `node:crypto`） |
| Hono / Bun 等 Fetch API 框架 | `toFetchHandler(relay)` 得到 `(Request) => Promise<Response>` |

适配器默认拒绝超过 1MB 的请求体（413），可用 `{ maxBodyBytes }` 调整。

## API

### `createRelayHandler(options)`

| 选项 | 说明 |
|---|---|
| `secrets` | 字符串或数组。轮换期新旧两个都放，新的在前。只放同一个供给方的 secret：一个服务接两个产品时，每个产品各建一个 handler，挂在各自的路径上 |
| `manifest` | 提交给 Relay 的清单对象。创建时用协议包的 `validateManifest` 校验，有错误直接抛异常 |
| `handlers` | `{ 动作名: (input, ctx) => 响应 }`。必须和清单里的动作一一对应，多了少了都抛异常 |
| `tasks` | 可选，L2 异步：`{ poll, cancel, select }`，分别处理 `task.poll`、`task.cancel`、`proposal.select` |
| `binding` | 可选，`user_binding: "token"` 时：`{ verify }` 处理 `binding.verify` |
| `idempotency` | 可选，幂等存储，默认 `new MemoryIdempotencyStore()` |
| `onError` | 可选，处理函数抛异常或返回不合协议的响应时调用，默认 `console.error` |

处理函数的 `ctx`：`orderId`、`idempotencyKey`（等于 `orderId`）、`user`（`relay_uid`、`display_name`、`supplier_user_ref`）、`manifestVersion`、`deadlineAt`、`action`（清单里的定义）、`envelope`（原始信封）。

处理函数的返回值和异常：

| 处理函数 | SDK 的回复 | 幂等缓存 |
|---|---|---|
| `return completed(...)` / `accepted(...)` | 200 + 该响应 | 缓存 |
| `return failed(code)`，code 不是 `temporary`、`rate_limited` | 200 + 该响应 | 缓存 |
| `return failed("temporary" \| "rate_limited")` | 200 + 该响应 | 不缓存，Relay 用同一个键重试时会再执行 |
| `throw new RelayError(code, message)` | 同 `return failed(code, message)` | 同上 |
| 抛其他异常 | 500：结果未知，Relay 不重试、不扣费，订单进待核对 | 不缓存 |
| 返回不合协议的响应（比如 `action.invoke` 回 `pending`） | 500，并调用 `onError` | 不缓存 |

`temporary` 的含义是「确认没有执行」。不确定有没有执行时，应当抛异常让 SDK 回 500，而不是回 `temporary`。

另外两种情况也回 `temporary`、不调处理函数：信封的 `deadline_at` 已过；同一个键的上一次请求还在处理中。

### 响应辅助

```ts
completed(data, parts?)                 // { status: "completed", output: { data, parts } }
failed(code, message?, { retryAfter, details })
accepted(taskId, etaSeconds?)           // 异步接单
pending(etaSeconds?)                    // task.poll：还在处理
proposals([proposal(id, title, data, { priceCents, etaDays, parts })])  // task.poll：多方案
cancelled() / cancelFailed(reason?)     // task.cancel
selected()                              // proposal.select
bound(supplierUserRef, displayName?)    // binding.verify
```

### 幂等存储

多实例部署要换成共享存储（Redis、数据库），实现三个方法：

```ts
interface IdempotencyStore {
  // 原子操作：键不存在时占住并返回 { state: "acquired" }；处理中返回 { state: "in_progress" }；
  // 已有结果返回 { state: "done", record }。
  begin(key: string, fingerprint: string): BeginResult | Promise<BeginResult>;
  finish(key: string, record: { fingerprint: string; response: InvokeResponse }): void | Promise<void>;
  abandon(key: string): void | Promise<void>; // 只释放占用，不记结果
}
```

`fingerprint` 是动作名加规范化输入的 sha256。同一个键带着不同的请求再来时，SDK 回 `invalid_input`。结果至少保留 8 天：异步任务最长 7 天，后台核对还可能用同一个键重新下发。Redis 实现可以用 `SET key in_progress NX PX 120000` 做 `begin`。

### `RelayCallbackClient`

```ts
import { RelayCallbackClient, completed } from "@dreamcavy/ai-relay-sdk";

const callbacks = new RelayCallbackClient({ secret: process.env.RELAY_SECRET! });

await callbacks.completed(orderId, completed({ url: article.url }).output);
await callbacks.failed(orderId, { code: "permanent", message: "审核未通过" });
await callbacks.addProposal(orderId, proposal("p1", "方案一", { ... }, { priceCents: 300000 }));
await callbacks.withdrawProposal(orderId, "p1", "对方已撤回");
await callbacks.cancelFailed(orderId, "文章已发出");
await callbacks.dispute(orderId, "用户未到店");
await callbacks.send({ type: "completed", order_id, output, event_id: "evt_自定义" }); // 通用写法
```

| 选项 | 默认 |
|---|---|
| `baseUrl` | `https://relay.newbeeai.online` |
| `timeoutMs` | 10000 |
| `retryDelaysMs` | `[1000, 4000, 16000, 60000, 300000]`，数组长度就是最多重发几次 |

- 发之前按协议 Schema 严格校验，不合格抛 `TypeError`，不发请求。
- `event_id` 不传时自动生成（`evt_` + 32 位十六进制）。同一件事在进程重启后要重发，自己存下并传同一个 `event_id`，Relay 才能去重。
- 5xx、429（按 `Retry-After`）、超时、连接失败时重发，请求体不变，每次重新签名。
- Relay 回 200 时 `ok: true`；401、404、409、422 不重发，原样返回 `status` 和 `body`（409 表示订单已是终态，事件只记录）。
- 重发次数用完抛 `RelayCallbackError`，带 `eventId`、`attempts`、`lastStatus`。

## 开发

```sh
pnpm --filter @dreamcavy/ai-relay-sdk build
pnpm --filter @dreamcavy/ai-relay-sdk test
```

## 许可

Apache-2.0
