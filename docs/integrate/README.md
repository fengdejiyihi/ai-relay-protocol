# 接入 AI Relay

让用户的 AI（Claude、ChatGPT、豆包等）直接调用你的产品：AI 通过 AI Relay 找到你的动作，替用户下单，Relay 负责确认、授权和记账，你只管把事办好。

## 一句话交给你的编码 AI

先把下面「开始前准备」收齐，再把这句话发给 Cursor、Claude Code、Codex 等编码 AI。签名 secret 自己填进环境变量，不要贴给 AI，也不要提交进代码仓库。

```text
请读 https://relay.newbeeai.online/llms.txt ，按里面的接入指南把我们的产品接入 AI Relay：先对照「开始前准备」确认信息齐全，从起步模板改起，实现 POST /relay，用接入验收工具跑到全绿，再部署、在线验收、提交审核。
```

## 开始前准备

接入时间大多花在中途才发现缺东西、来回补。动手前花 5 分钟把这张表填完：

| 要准备的 | 为什么 | 怎么算准备好 |
|---|---|---|
| 代码仓库地址和改代码的权限 | 端点要加进你的产品 | 编码 AI 能读写这个仓库 |
| 部署通道 | 端点要上线才能在线验收 | 能 SSH 登录服务器；服务器能拉到代码，或者能 `scp`/`rsync` 上传；部署脚本中断后能从断点重跑。**先验证这一条**，别靠网页控制台来回上传 |
| 公网 HTTPS 地址 | Relay 只调 `https://` 端点 | 有域名和证书，确定端点路径，比如 `https://api.example.com/relay` |
| 签名 secret 放哪 | 注册时只显示一次 | 服务器上的环境变量或密钥管理里留好位置，比如 `RELAY_SECRET` |
| 测试买家（多方案再加测试商家） | 验收会真的下单 | 建好测试账号；需要账号绑定的，知道怎么用它生成绑定码。见[测试隔离](testing.md) |
| 能不能做真实业务操作 | 「不计费」不等于「不产生数据」：验收照样会建单、发消息、公开发布 | 定好测试单怎么认、走哪套数据（[测试隔离](testing.md)） |
| 上线余额 | 收费动作要预付手续费才会出现在搜索里 | 首次审核通过会送 ¥100 体验额度；手续费高、单量大的，提前联系管理员充值（看下面「钱的事」） |

## 最短路线

按顺序做，前 8 步都是必做，其余检查放到[出问题再看](testing.md#选做出问题再看)：

| # | 做什么 | 在哪 |
|---|---|---|
| 1 | 收齐上面的准备 | — |
| 2 | 选档位（L0 / L1 / L2，见下文） | — |
| 3 | 从[起步模板](../../examples/starters/README.md)拷一份，改清单和标了 `TODO(业务)` 的函数 | 你的仓库 |
| 4 | 本机接入验收全绿 | 你的电脑 |
| 5 | 注册供给方，拿到 `supplier_id` 和 secret | [供给方后台](https://relay.newbeeai.online/supplier) |
| 6 | 部署到 HTTPS，配好 secret；准备测试买家的绑定码 | 你的服务器 |
| 7 | 保存清单、填样例输入，点「在线验收」到全绿，提交审核 | 供给方后台 |
| 8 | 审核通过后，确认后台首页「上线状态」5 项全绿 | 供给方后台 |

**完成的标准是第 8 步，不是「审核通过」。**「代码部署完成」「审核通过」「AI 能搜到并调用」是三个不同的状态，只有下面 5 项同时满足，用户的 AI 才能找到你：

| 条件 | 没满足时 |
|---|---|
| 接口可达：Relay 能 `ping` 通你的端点 | 后台「立即检测」看具体错误 |
| 在线验收通过 | 看红项，改完重新验收 |
| 审核通过，清单在线上 | 等管理员处理；被驳回会写原因 |
| 余额够付一笔手续费（免费动作不要求） | 收费动作搜不到、也不能下单。首次审核通过送的体验额度用完后，联系管理员充值 |
| 能被搜到：供给方没被暂停，动作没被下架 | 后台显示原因；可以在「试搜一下」里用用户会说的话搜一次 |

## 钱的事

动手前先知道这几条，详细规则见[计费与结算](billing.md)：

- **谁付钱**：你付给 Relay 手续费，每笔成交 ¥1–¥100，自己在清单里定（`fee`）。用户付给你的钱照旧走你自己的收款渠道，Relay 不经手。
- **什么算成交、什么时候扣**：默认收到 `completed`（同步响应或回调）时扣。失败、取消、过期、结果未知的单都不扣。
- **测试扣不扣**：本机验收和后台在线验收不扣。你自己用 Claude、ChatGPT 试，成交了照常扣。
- **余额不够会怎样**：收费动作从搜索里隐藏，也不能下新单；免费动作、进行中的订单不受影响。
- **怎么充值**：首次审核通过时自动送 ¥100 体验额度（每个供给方一次），够上线后先跑起来；之后联系管理员手工入账。

## 选档位

| 档位 | 适合 | 你要实现 | 典型耗时 | 指南 |
|---|---|---|---|---|
| L0 零代码 | 已经有 OpenAPI 文档的 REST 接口，动作都能当场给结果 | 在后台导入 OpenAPI，勾选要开放的接口 | 1–2 小时 | [L0：从 OpenAPI 导入](l0.md) |
| L1 一个端点 | 动作 3 秒内能给结果：查询、预约、下单 | `POST /relay` 处理 `ping` 和 `action.invoke` | 半天 | [L1：一个端点](l1.md) |
| L2 异步单结果 | 要排队、人工处理、等第三方 | L1 加上接单、回调、补拉、取消 | 1 天 | [L2：异步与多方案](l2.md) |
| L2 异步多方案 | 多家报价、撮合，让用户选一个 | 再加方案推送、选定、撤回，通常还要账号绑定 | 1–2 天 | [L2：多方案要处理的事](l2.md#多方案要处理的事) |

拿不准就先做 L1。产品要知道「这是我们哪个用户」时，在所在档位之上再做[账号绑定](binding.md)。

## 你要做什么

| 你做 | Relay 做 |
|---|---|
| 一份 JSON 清单：有哪些动作，输入输出长什么样，风险多高，收不收费 | 让 AI 搜到你的动作，按清单校验输入 |
| 一个 HTTPS 端点 `POST /relay`：验签，按动作办事，如实返回结果 | 按用户给 AI 的授权判定要不要确认，要确认就让用户在网页上点 |
| （异步才要）办完后签名回调 Relay | 下发、重试、补拉、超时取消，到计费点扣手续费 |

你的代码不碰计费、不做确认、不判断授权。

## 从注册到上线

供给方后台在 `https://relay.newbeeai.online/supplier`，首页的「上线状态」和上面最短路线的第 5–8 步对应。

1. **注册**：用手机号登录 Relay，在[供给方后台](https://relay.newbeeai.online/supplier)填产品名（1–100 字）、一句话介绍（1–200 字）、端点地址（`https://`）、联系人和邮箱。拿到 `supplier_id` 和签名 secret（`whsec_` 开头，**只显示一次**，Relay 加密保存，后台也看不到明文）。端点还没部署好可以先填计划的地址，审核以清单为准。
2. **写清单**：在「动作清单」里用表单填，或直接粘贴 JSON；L0 在「从 OpenAPI 导入」里生成。每个动作填一份样例输入，在线验收要用。
3. **在线验收**：打开清单版本页，点「开始在线验收」。Relay 用真签名调用你的端点，逐项给出红绿。每个动作都会真的下单：同步动作一单，异步动作两单（一单走完、另一单验取消），订单号以 `ord_cf` 开头，不计费。需要账号绑定的，填一个测试买家刚生成的绑定码。全绿才能提交审核。
4. **提交审核**：管理员一般 1 个工作日内处理。审核标准：动作描述人能看懂；风险等级不低于平台规则（对外发布、代付款必须是 `high`）；收费动作的手续费在 ¥1–¥100 每笔；不是违法业务。驳回会写原因，结果发邮件到联系邮箱。
5. **确认上线状态**：审核通过后看后台首页「上线状态」，5 项全绿才算能用。

上线后还可以在后台看订单、流水、争议和质量指标。改清单要另存一个新版本，重新验收、提交审核；在途订单按下单时的版本走。

## 接入验收工具

`@dreamcavy/ai-relay-conformance` 读你的清单，用真签名逐项调用你的端点：验签、`ping`、每个动作、同键重放、未知类型、响应 Schema，异步动作还跟到最终结果，多方案会选一次方案、测一次取消。后台的「在线验收」用的是同一套检查，本机全绿，后台也会全绿。用法和全部检查项见 [Conformance README](../../packages/conformance/README.md)。

## 包的发布状态

四个包都还**没有发布**到 npm 和 PyPI，`npx @dreamcavy/ai-relay-conformance` 现在跑不了。下面这组命令现在就能跑：

```sh
git clone https://github.com/fengdejiyihi/ai-relay-protocol.git && cd ai-relay-protocol
pnpm install && pnpm build        # 要 Node 22 以上和 pnpm 10

# 接入验收：回到你的项目目录运行
RELAY_SECRET=whsec_dev node <公开仓库路径>/packages/conformance/dist/cli.js --manifest manifest.json \
  --endpoint http://127.0.0.1:8787/relay --inputs inputs.json

# Node SDK（可选）：打成 tgz 装到你的项目
pnpm --filter @dreamcavy/ai-relay-protocol --filter @dreamcavy/ai-relay-sdk pack --pack-destination /tmp/relay-pkgs
npm install /tmp/relay-pkgs/*.tgz

# Python SDK（可选）
pip install "git+https://github.com/fengdejiyihi/ai-relay-protocol.git#subdirectory=packages/sdk-python"
```

`pnpm install` 时提示 `Failed to create bin … sandbox-shop` 是因为还没构建，可以忽略。装好的 SDK 在 Node 20 以上就能跑。[起步模板](../../examples/starters/README.md)不依赖任何包，只要 Node 22.13 以上。

| 包 | 用途 | 状态 |
|---|---|---|
| `@dreamcavy/ai-relay-sdk`（npm） | Node 供给方 SDK：验签、分发、输入校验、幂等、回调 | 准备发布 |
| `dreamcavy-ai-relay-sdk`（PyPI） | Python 供给方 SDK，适配 FastAPI、Flask、WSGI | 准备发布 |
| `@dreamcavy/ai-relay-conformance`（npm） | 接入验收工具 | 准备发布 |
| `@dreamcavy/ai-relay-protocol`（npm） | 协议包：Schema、校验、签名 | 准备发布 |

发布之后，文档里的 `node <公开仓库路径>/packages/conformance/dist/cli.js` 都可以换成 `npx @dreamcavy/ai-relay-conformance`。不用 SDK 也能接：协议只要一个端点和约 15 行的 HMAC 验签，任何语言都能写，见[规范附录 B](../protocol/rsp-1.0.md)。

## 文档目录

- [起步模板](../../examples/starters/README.md)：零依赖、现在就能跑的 L1 和 L2 完整端点
- [测试隔离与检查清单](testing.md)：测试买家、绑定码、必做和选做的检查
- [L0：从 OpenAPI 导入](l0.md)
- [L1：一个端点（同步）](l1.md)
- [L2：异步与多方案](l2.md)
- [账号绑定](binding.md)
- [计费与结算](billing.md)
- [RSP 1.0 规范](../protocol/rsp-1.0.md)：信封、响应、错误码、签名的完整定义。规范第 15 节是 AI 侧的 MCP，供给方跳过。
- [JSON Schema](../../packages/protocol/schemas/)：机器可读定义，和文字不一致时以它为准
