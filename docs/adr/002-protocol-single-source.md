# ADR-002 JSON Schema 是协议的唯一真相源

- 状态：已定
- 日期：2026-10-22

## 背景

协议会被 Relay 应用、供给方网关、沙箱商家、两种语言的 SDK、在线验收工具同时使用，还会被外部供给方用任意语言实现。如果每处各写一份定义，迟早不一致。

## 决定

- 协议定义放在 `packages/protocol/schemas/`，是 JSON Schema 2020-12。线上 `$id` 前缀为 `https://relay.newbeeai.online/schemas/`。
- TypeScript 类型手写在 `src/types.ts`，由测试保证与 Schema 的枚举和结构一致；不一致时以 Schema 为准。
- 协议包只依赖 Ajv 和 ajv-formats，不依赖任何业务包。
- Schema 之外的规则（比如 low 必须只读）写成编号的语义规则（M-*），与平台审核策略（P-*）分开：前者决定协议是否有效，后者是 Relay 的商业规则，可以单独调整。
- 其他包一律从 `@ai-relay/protocol` 导入枚举、时限和上限，不得重新定义。
- 协议改动只在协议包里做，并配一份 ADR 或在规范里记修订。

## 后果

- 外部供给方拿到 Schema 就能用任何语言生成校验代码。
- 改协议要同时改 Schema、类型、测试和规范文档，门槛是故意的。
