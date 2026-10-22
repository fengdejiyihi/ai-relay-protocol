# @ai-relay/conformance（占位）

RSP 1.0 接入验收工具，正在开发，实现前不发布到 npm。

目标用法：

```sh
npx @ai-relay/conformance --url https://your-product.example.com/relay --secret whsec_… --manifest manifest.json
```

它会读取你的清单，用真签名向你的端点逐项发信封，检查：

- 清单通过 `validateManifest` 和平台策略
- `ping` 原样回 `challenge`
- 验签：缺头、错 secret、过期、篡改都被拒绝；轮换期旧 secret 仍通过
- 不认识的 `type` 回 `not_supported`，非法输入回 `invalid_input`
- 每个动作的响应符合清单里的 `output` Schema
- 同一个 `idempotency_key` 重放返回同一结果

全部通过就算接入完成。在它发布之前，可以照 [`apps/sandbox-shop/test/relay.e2e.test.ts`](../../apps/sandbox-shop/test/relay.e2e.test.ts) 的清单给自己的产品写测试。
