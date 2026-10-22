# @ai-relay/protocol

RSP 1.0（Relay Supplier Protocol）与 Relay MCP 1.0 的单一真相源。供给方 SDK、沙箱商家、Relay 应用都引用这里，不各自定义。

| 内容 | 位置 |
|---|---|
| JSON Schema（线上真相源） | `schemas/`：common、manifest、downstream、responses、upstream、mcp/tools、mcp/results |
| TypeScript 类型 | `src/types.ts` |
| 常量（枚举、时限、上限） | `src/constants.ts` |
| 清单校验 + 语义规则 + 平台策略 | `validateManifest`、`checkPlatformPolicy` |
| 信封 / 响应 / 回调 / 工具输入校验 | `validateDownstream`、`validateResponse`、`validateUpstream`、`validateToolInput` |
| MCP 结果校验 | `validateOrderResult`、`validateStatusList`（`relay_status` 不带 `order_id` 时）、`validateSearchResult`、`validateDescribeResult` |
| 签名 | `signBody`、`verifySignature`（HMAC-SHA256，`t=<ts>,v1=<hex>`，5 分钟窗口，支持轮换） |
| 判定辅助 | `effectiveConfirm`、`effectiveRisk`、`resolveAmount`、`piiFields` |

```ts
import { validateManifest, verifySignature } from "@ai-relay/protocol";
```

`validateDownstream`、`validateResponse`、`validateUpstream` 默认按收方视角向前兼容（RSP 1.0 第 14 节）：忽略不认识的字段，接受任何 `1.x` 的 `rsp`；必填字段、类型和 type、status、错误码枚举照样严格。传 `{ strict: true }` 则不允许未定义字段、`rsp` 必须是 `1.0`，给 Relay 自测发出的信封和 Conformance 的多余字段警告用。`validateDownstream` 遇到不认识的 `type` 返回规则 `D-TYPE-1`，供给方应回 `not_supported`，其他错误回 `invalid_input`。

MCP 结果的错误码是供给方的 7 个加上 Relay 自己拒绝的 6 个（`RELAY_ERROR_CODES`）。

签名校验的 `body` 直接传收到的原始字节（`Buffer.concat(chunks)`）。不要逐块解码再拼字符串，多字节字符会被切坏。

语义规则编号（M-*）与平台策略编号（P-*）的含义见 [RSP 1.0 规范第 4 节](https://github.com/fengdejiyihi/ai-relay-protocol/blob/main/docs/protocol/rsp-1.0.md)。
