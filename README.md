# AI Relay Protocol

让你的产品被用户的 AI 直接调用：Claude、ChatGPT、豆包等 AI 通过 [AI Relay](https://relay.newbeeai.online) 找到你的产品、替用户下单，你只需要实现**一个 HTTPS 端点**和**一份 JSON 清单**。

本仓库是 **RSP 1.0（Relay Supplier Protocol）** 的公开定义：规范、JSON Schema、TypeScript 协议包、参照实现。

| 你要找的 | 位置 |
|---|---|
| 协议规范（必读） | [`docs/protocol/rsp-1.0.md`](docs/protocol/rsp-1.0.md) |
| JSON Schema（机器可读定义，与规范不一致时以它为准） | [`packages/protocol/schemas/`](packages/protocol/schemas/) |
| TypeScript 协议包 `@ai-relay/protocol`：校验、签名、常量 | [`packages/protocol/`](packages/protocol/) |
| 参照实现：沙箱理发店（L1，Node，零框架）+ 一步步接入教程 | [`apps/sandbox-shop/`](apps/sandbox-shop/) |
| 示例清单：同步 L1、异步 L2、多方案 L2 | [`examples/manifests/`](examples/manifests/) |
| 设计决定（为什么这样设计） | [`docs/adr/`](docs/adr/) |
| 接入验收工具 `@ai-relay/conformance` | [`packages/conformance/`](packages/conformance/)（开发中） |
| 给 AI 读的入口 | [`llms.txt`](llms.txt)、[`llms-full.txt`](llms-full.txt)、[`AGENTS.md`](AGENTS.md) |

## 它怎么工作

```
用户的 AI ──MCP──▶ AI Relay ──RSP 信封（HMAC 签名）──▶ 你的产品 POST /relay
                     ▲                                        │
                     └────────────── 回调（仅异步）───────────┘
```

- 所有动作走同一个 `POST /relay`，按信封的 `type`、`action` 分发。
- 动作的输入输出用 JSON Schema 描述，业务含义由你定；Relay 只看 6 个通用字段（风险、确认、模式、计费、手续费、用户金额）。
- 要不要用户确认、扣不扣费，都由 Relay 服务端判定。你的代码不做计费。
- 签名与 Stripe Webhook 同款：`HMAC-SHA256(secret, t + "." + 原始请求体)`。

## 三档接入

| 档位 | 你要实现 | 典型耗时 |
|---|---|---|
| L0 零代码 | 导入 OpenAPI，由 Relay 托管适配器转发 | 1–2 小时 |
| L1 一个端点 | `POST /relay`：`ping` + `action.invoke`，加一份清单 | 半天 |
| L2 异步 | L1 + `accepted` + 回调；多方案再加 `proposal.*` | 1–2 天 |

## 十分钟起步（L1）

1. 照 [`examples/manifests/sandbox-shop.json`](examples/manifests/sandbox-shop.json) 写你的清单。
2. 实现 `POST /relay`：验签 → 按 `type` 分发 → 同步返回 `{"status":"completed","output":{"data":…,"parts":[…]}}`。规范附录 B 有一份无依赖的 Node 骨架，任何语言都能照写。
3. 本地跑沙箱对照：`pnpm install && pnpm build && RELAY_SECRETS=whsec_dev pnpm --filter @ai-relay/sandbox-shop start`。
4. 自测到全部通过。验收工具发布前，照 [`apps/sandbox-shop/test/relay.e2e.test.ts`](apps/sandbox-shop/test/relay.e2e.test.ts) 的清单写测试；发布后跑 `npx @ai-relay/conformance` 到全绿即完成。

用 TypeScript 的话可以直接装协议包：

```sh
npm install @ai-relay/protocol
```

其他语言不需要 SDK：Schema 在 `packages/protocol/schemas/`，签名约 15 行代码。

> 供给方入驻（在 Relay 后台注册、拿 secret、上架）尚未开放。想抢先接入，请开一个 issue。

## 关于本仓库

本仓库由 AI Relay 主仓库单向同步生成。欢迎提 issue；PR 也欢迎，我们会把它搬到主仓库合并，再随下一次同步出现在这里，提交作者会保留在说明里。详见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 许可证

[Apache-2.0](LICENSE)。「AI Relay」名称与标识不在许可范围内。
