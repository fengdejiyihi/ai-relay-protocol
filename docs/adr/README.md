# 架构决策记录（ADR）

每份记录一个已定的协议设计决定：背景、决定、后果。推翻一个决定时新写一份 ADR 并把旧的标为「已取代」，不改旧文。编号与 AI Relay 内部记录一致，所以这里有空号：不涉及协议的内部架构决定没有收录。

| 编号 | 决定 | 状态 |
|---|---|---|
| [002](002-protocol-single-source.md) | JSON Schema 是协议的唯一真相源 | 已定 |
| [003](003-single-supplier-endpoint.md) | 供给方只实现一个端点，信封按 type 分发 | 已定 |
| [004](004-hmac-signature.md) | HMAC-SHA256 签名 | 已定 |
| [005](005-billing-on-complete.md) | 计费点为 completed，72 小时争议 | 已定 |
| [006](006-server-side-confirmation.md) | 确认在服务端判定并绑定参数 | 已定 |
| [007](007-mcp-five-tools.md) | MCP 固定 5 个工具，无状态，OAuth 2.1 | 已定 |
| [008](008-fee-and-amount.md) | 手续费 fee 与用户金额 amount 分开 | 已定 |
