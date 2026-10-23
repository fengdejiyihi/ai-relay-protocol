# AI Relay Protocol

让你的产品被用户的 AI 直接调用：Claude、ChatGPT、豆包等 AI 通过 [AI Relay](https://relay.newbeeai.online) 找到你的产品、替用户下单，你只需要实现**一个 HTTPS 端点**和**一份 JSON 清单**。

本仓库是 **RSP 1.0（Relay Supplier Protocol）** 的公开定义：规范、JSON Schema、TypeScript 协议包、参照实现。

| 你要找的 | 位置 |
|---|---|
| 接入指南：选档位、L0 / L1 / L2、账号绑定、计费 | [`docs/integrate/`](docs/integrate/README.md) |
| 协议规范（必读） | [`docs/protocol/rsp-1.0.md`](docs/protocol/rsp-1.0.md) |
| JSON Schema（机器可读定义，与规范不一致时以它为准） | [`packages/protocol/schemas/`](packages/protocol/schemas/) |
| TypeScript 协议包 `@dreamcavy/ai-relay-protocol`：校验、签名、常量 | [`packages/protocol/`](packages/protocol/) |
| 参照实现：沙箱理发店（L1，Node，零框架）+ 一步步接入教程 | [`apps/sandbox-shop/`](apps/sandbox-shop/) |
| 示例清单：同步 L1、异步 L2、多方案 L2 | [`examples/manifests/`](examples/manifests/) |
| 设计决定（为什么这样设计） | [`docs/adr/`](docs/adr/) |
| 供给方 Node SDK `@dreamcavy/ai-relay-sdk`：验签、分发、输入校验、幂等、回调 | [`packages/sdk-node/`](packages/sdk-node/) |
| 供给方 Python SDK `dreamcavy-ai-relay-sdk`：验签、分发、幂等、回调，适配 FastAPI / Flask | [`packages/sdk-python/`](packages/sdk-python/) |
| 接入验收工具 `@dreamcavy/ai-relay-conformance` | [`packages/conformance/`](packages/conformance/) |
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

## 一句话交给你的编码 AI

```text
请读 https://relay.newbeeai.online/llms.txt ，按里面的接入指南把我们的产品接入 AI Relay：先对照「开始前准备」确认信息齐全，从起步模板改起，实现 POST /relay，用接入验收工具跑到全绿，再部署、在线验收、提交审核。这个账号已经接过别的产品的话，先确认这次是新产品还是给已接入的产品加功能：新产品按「一个账号接多个产品」另开一个供给方，不要复用别的产品的 supplier_id、secret 和端点；加功能就改那个产品原来的清单。
```

在本仓库里工作的编码 AI 直接读 [`llms.txt`](llms.txt) 和 [`AGENTS.md`](AGENTS.md)。

## 三档接入

| 档位 | 你要实现 | 典型耗时 | 指南 |
|---|---|---|---|
| L0 零代码 | 导入 OpenAPI，由 Relay 托管适配器转发 | 1–2 小时 | [l0.md](docs/integrate/l0.md) |
| L1 一个端点 | `POST /relay`：`ping` + `action.invoke`，加一份清单 | 半天 | [l1.md](docs/integrate/l1.md) |
| L2 异步 | L1 + `accepted` + 回调；多方案再加 `proposal.*` | 1–2 天 | [l2.md](docs/integrate/l2.md) |

## 十分钟起步（L1）

1. 照 [`examples/manifests/sandbox-shop.json`](examples/manifests/sandbox-shop.json) 写你的清单。
2. 实现 `POST /relay`：验签 → 按 `type` 分发 → 同步返回 `{"status":"completed","output":{"data":…,"parts":[…]}}`。规范附录 B 有一份无依赖的 Node 骨架，任何语言都能照写。
3. 本地跑沙箱对照：`pnpm install && pnpm build && RELAY_SECRETS=whsec_dev pnpm --filter @ai-relay/sandbox-shop start`。
4. 用接入验收工具自测到没有失败项：发布到 npm 后是 `npx @dreamcavy/ai-relay-conformance`，发布前在本仓库里运行，见[接入总览](docs/integrate/README.md)。

Node 和 Python 有供给方 SDK（[`packages/sdk-node/`](packages/sdk-node/)、[`packages/sdk-python/`](packages/sdk-python/)），验签、分发、幂等都做好了，完整步骤见 [L1 指南](docs/integrate/l1.md)。其他语言不需要 SDK：Schema 在 `packages/protocol/schemas/`，签名约 15 行代码。

> 供给方入驻：用手机号登录 [供给方后台](https://relay.newbeeai.online/supplier) 注册，拿到 `supplier_id` 和 secret，在线验收全绿后提交审核，步骤见[接入总览](docs/integrate/README.md)「从注册到上线」。一个账号可以接多个产品，每个产品单独一个供给方。

## 关于本仓库

本仓库由 AI Relay 主仓库单向同步生成。欢迎提 issue；PR 也欢迎，我们会把它搬到主仓库合并，再随下一次同步出现在这里，提交作者会保留在说明里。详见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 许可证

[Apache-2.0](LICENSE)。「AI Relay」名称与标识不在许可范围内。
