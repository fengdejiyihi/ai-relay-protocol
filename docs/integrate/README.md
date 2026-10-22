# 接入 AI Relay

让用户的 AI（Claude、ChatGPT、豆包等）直接调用你的产品：AI 通过 AI Relay 找到你的动作，替用户下单，Relay 负责确认、授权和记账，你只管把事办好。

## 一句话交给你的编码 AI

把下面这句话发给 Cursor、Claude Code、Codex 等编码 AI，它会照着本文档接入。签名 secret 自己填进环境变量，不要贴给 AI，也不要提交进代码仓库。

```text
请读 https://relay.newbeeai.online/llms.txt ，按里面的接入指南把我们的产品接入 AI Relay：先选档位、写清单，再实现 POST /relay，最后用接入验收工具跑到全绿。
```

## 你要做什么

| 你做 | Relay 做 |
|---|---|
| 一份 JSON 清单：有哪些动作，输入输出长什么样，风险多高，收不收费 | 让 AI 搜到你的动作，按清单校验输入 |
| 一个 HTTPS 端点 `POST /relay`：验签，按动作办事，如实返回结果 | 按用户给 AI 的授权判定要不要确认，要确认就让用户在网页上点 |
| （异步才要）办完后签名回调 Relay | 下发、重试、补拉、超时取消，到计费点扣手续费 |

你的代码不碰计费、不做确认、不判断授权。用户付给你的钱照旧走你自己的收款渠道，Relay 不经手。

## 选档位

| 档位 | 适合 | 你要实现 | 典型耗时 | 指南 |
|---|---|---|---|---|
| L0 零代码 | 已经有 OpenAPI 文档的 REST 接口，动作都能当场给结果 | 在后台导入 OpenAPI，勾选要开放的接口 | 1–2 小时 | [L0：从 OpenAPI 导入](l0.md) |
| L1 一个端点 | 动作 3 秒内能给结果：查询、预约、下单 | `POST /relay` 处理 `ping` 和 `action.invoke` | 半天 | [L1：一个端点](l1.md) |
| L2 异步 | 要排队、人工处理，或者多家报价让用户选 | L1 加上接单、回调、补拉、取消；多方案再加方案推送和选定 | 1–2 天 | [L2：异步与多方案](l2.md) |

拿不准就先做 L1。产品要知道「这是我们哪个用户」时，在所在档位之上再做[账号绑定](binding.md)。收费规则见[计费与结算](billing.md)。

## 从注册到上线

供给方后台在 `https://relay.newbeeai.online/supplier`。后台首页的「入驻进度」和下面 6 步一一对应。

1. **注册**：注册账号时选「供给方」，填产品名（1–100 字）、一句话介绍（1–200 字）、端点地址（`https://`）、联系人和邮箱。拿到 `supplier_id` 和签名 secret（`whsec_` 开头，**只显示一次**，Relay 加密保存，后台也看不到明文）。
2. **写清单**：在「动作清单」里用表单填，或直接粘贴 JSON；L0 在「从 OpenAPI 导入」里生成。每个动作顺手填一份样例输入，在线验收要用。
3. **实现端点**：按所选档位的指南写，本机用接入验收工具自测到全绿。
4. **在线验收**：打开清单版本页，点「开始在线验收」。Relay 用真签名调用你的端点，逐项给出红绿。每个动作都会真的下单：同步动作一单，异步动作（`async`、`async_multi`）两单（一单走完、另一单验取消）。请接测试环境或用可撤销的样例。全绿才能提交审核。
5. **提交审核**：管理员一般 1 个工作日内处理。审核标准：动作描述人能看懂；风险等级不低于平台规则（对外发布、代付款必须是 `high`）；收费动作的手续费在 ¥1–¥100 每笔；不是违法业务。驳回会写原因，结果发邮件到联系邮箱。
6. **充值，进入搜索**：手续费从预付余额里扣。余额不低于你最高的单笔手续费时，收费动作才出现在搜索里。目前由管理员手工入账，见[计费与结算](billing.md)。

上线后还可以在后台看订单、流水、争议和质量指标。改清单要另存一个新版本，重新验收、提交审核；在途订单按下单时的版本走。

## 接入验收工具

`@dreamcavy/ai-relay-conformance` 读你的清单，用真签名逐项调用你的端点：验签、`ping`、每个动作、同键重放、未知类型、响应 Schema，异步动作还跟到最终结果。后台的「在线验收」用的是同一套检查，本机全绿，后台也会全绿。用法和全部检查项见 [Conformance README](../../packages/conformance/README.md)。

```sh
npx @dreamcavy/ai-relay-conformance --manifest manifest.json \
  --endpoint http://127.0.0.1:8787/relay --secret "$RELAY_SECRET" --inputs inputs.json
```

## 包的发布状态

| 包 | 用途 | 状态 |
|---|---|---|
| `@dreamcavy/ai-relay-sdk`（npm） | Node 供给方 SDK：验签、分发、输入校验、幂等、回调 | 准备发布 |
| `dreamcavy-ai-relay-sdk`（PyPI） | Python 供给方 SDK，适配 FastAPI、Flask、WSGI | 准备发布 |
| `@dreamcavy/ai-relay-conformance`（npm） | 接入验收工具 | 准备发布 |
| `@dreamcavy/ai-relay-protocol`（npm） | 协议包：Schema、校验、签名 | 准备发布 |

发布之前，从公开仓库 [fengdejiyihi/ai-relay-protocol](https://github.com/fengdejiyihi/ai-relay-protocol) 使用。构建公开仓库要 Node 22 以上和 pnpm 10（仓库开了 `engine-strict`）；装好的 SDK 在 Node 20 以上就能跑。`pnpm install` 时提示 `Failed to create bin … sandbox-shop` 是因为还没构建，可以忽略。

```sh
git clone https://github.com/fengdejiyihi/ai-relay-protocol.git && cd ai-relay-protocol
pnpm install && pnpm build

# 接入验收：回到你的项目目录运行，参数和 npx 一样
RELAY_SECRET=whsec_dev node <公开仓库路径>/packages/conformance/dist/cli.js --manifest manifest.json \
  --endpoint http://127.0.0.1:8787/relay --inputs inputs.json

# Node SDK：打成 tgz 装到你的项目
pnpm --filter @dreamcavy/ai-relay-protocol --filter @dreamcavy/ai-relay-sdk pack --pack-destination /tmp/relay-pkgs
npm install /tmp/relay-pkgs/*.tgz

# Python SDK
pip install "git+https://github.com/fengdejiyihi/ai-relay-protocol.git#subdirectory=packages/sdk-python"
```

不用 SDK 也能接：协议只要一个端点和约 15 行的 HMAC 验签，任何语言都能写，见[规范附录 B](../protocol/rsp-1.0.md)。

## 文档目录

- [L0：从 OpenAPI 导入](l0.md)
- [L1：一个端点（同步）](l1.md)
- [L2：异步与多方案](l2.md)
- [账号绑定](binding.md)
- [计费与结算](billing.md)
- [RSP 1.0 规范](../protocol/rsp-1.0.md)：信封、响应、错误码、签名的完整定义。规范第 15 节是 AI 侧的 MCP，供给方跳过。
- [JSON Schema](../../packages/protocol/schemas/)：机器可读定义，和文字不一致时以它为准
