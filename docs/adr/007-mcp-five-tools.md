# ADR-007 MCP 固定 5 个工具，无状态，OAuth 2.1

- 状态：已定
- 日期：2026-10-22

## 背景

如果每个供给方的每个动作都注册成一个 MCP 工具，工具列表会随供给方增长，挤爆模型上下文，也无法在不重连的情况下上新。

## 决定

- 工具固定 5 个：`relay_search`、`relay_describe`、`relay_invoke`、`relay_status`、`relay_choose`。动作通过搜索和描述动态发现。
- 工具名用下划线，因为 Anthropic 和 OpenAI 的工具名正则都不允许点号。
- `relay_invoke` 带可选 `request_id`，按 `(ai_client_id, request_id)` 24 小时去重；同步动作在 20 秒总预算内直接返回，超出返回 `pending`。
- `relay_status` 不带 id 时返回最近 20 笔进行中或待选订单，第二天新开对话也能找回。V1 不做 MCP 主动通知。
- 传输用 Streamable HTTP 无状态模式，多实例不需要粘性会话。
- 鉴权用 OAuth 2.1 授权码 + PKCE + 动态客户端注册（Better Auth 的 OAuth provider 插件），claude.ai 和 ChatGPT 的连接器只支持 OAuth；自建 agent 用 API key。
- 地址：`https://relay.newbeeai.online/mcp`。

## 后果

- 每次调用多一到两轮搜索和描述，换来工具列表永远不变。
- 搜索质量直接决定体验，中文要用 jieba 分词（ADR-009）。
