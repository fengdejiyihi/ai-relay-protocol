# AGENTS.md

给编码 AI（Codex、Claude Code、Cursor、Copilot 等）的说明。分两种情况。

## 情况一：你在帮一个产品接入 AI Relay

你的产品是**供给方**。目标是实现 `POST /relay` 和一份清单，并通过验收。

先读 [`llms.txt`](llms.txt) 列出的文件，从[接入总览](docs/integrate/README.md)开始。规范第 15 节是 AI 侧的 MCP，**跳过**。

工作清单：

0. **先问是不是新产品**。一个账号可以接多个产品，每个产品单独一个供给方，各用各的 `supplier_id`、secret、端点地址和清单。账号接过别的产品时：新产品请用户在供给方后台另开一个，给已接入的产品加功能就改它原来的清单；不要复用、也不要改别的产品的 secret 和端点。见接入总览「一个账号接多个产品」。
1. **定档位**。3 秒内能给结果的动作用 L1 同步；要排队、人工处理或多方报价的用 L2（`accepted` + 回调）。拿不准先做 L1。
2. **写清单**。从[起步模板](examples/starters/README.md)的 `manifest.json` 改，示例见 [`examples/manifests/sandbox-shop.json`](examples/manifests/sandbox-shop.json)。每个动作要有输入输出 JSON Schema 和 6 个通用元数据。`low` 风险只能用于 `billing: "none"` 且 `readonly: true` 的动作。个人信息字段标 `"x-pii": true`。
3. **验签用原始字节**。先把请求体完整读成字节，对字节算 `HMAC-SHA256(secret, t + "." + body)`，常量时间比较，时间窗 5 分钟。不要先解析 JSON 再序列化。轮换期有两个 secret，依次尝试。规范附录 A 的样例可以用来核对你的实现。
4. **向前兼容**。忽略信封里不认识的字段，接受任何 `1.x` 的 `rsp`。不要直接用 `downstream.json` 做严格校验来拒绝请求。不认识的 `type` 回 `{"status":"failed","error":{"code":"not_supported"}}`，其他非法输入回 `invalid_input`。
5. **一律 HTTP 200**。业务失败也是 200 加 `{"status":"failed",…}`。
6. **幂等**。同一个 `idempotency_key` 重放必须返回同一结果，不能重复办事。
7. **不做计费**。扣费、确认、授权都由 Relay 判定，你的代码只办事并如实返回结果。如果动作有用户金额（`amount`），收到后核对它和你的真实价格一致，对不上回 `invalid_input`。
8. **返回 data + parts**。`data` 按清单 `output` Schema；`parts` 可选，给用户看的 markdown、链接、图片。
9. **完成标准**：`@dreamcavy/ai-relay-conformance` 没有失败项。包还没发布到 npm 时，在本仓库 `pnpm install && pnpm build` 之后用 `node <本仓库路径>/packages/conformance/dist/cli.js ...` 运行，见[接入总览](docs/integrate/README.md)的「包的发布状态」。

Node 项目用 [`@dreamcavy/ai-relay-sdk`](packages/sdk-node/README.md)，Python 项目用 [`dreamcavy-ai-relay-sdk`](packages/sdk-python/README.md)，验签、分发、幂等都做好了。其他语言不需要 SDK，照规范附录 B 写。

## 情况二：你在修改本仓库

- 本仓库由主仓库同步生成，PR 会被搬到主仓库合并。改动照常提 PR 即可。
- 协议的唯一真相源是 `packages/protocol/schemas/`。改协议要同时改 Schema、`src/types.ts`、测试和 `docs/protocol/rsp-1.0.md`，并说明是否破坏兼容。1.x 内只加不删。
- 提交前跑 `pnpm install && pnpm check`（构建、类型检查、Schema 检查、测试、示例清单校验）。
- 文档用中文，句子短，给具体数字。
