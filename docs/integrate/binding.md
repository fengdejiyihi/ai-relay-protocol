# 账号绑定

你的产品要知道「这是我们哪个用户」才能办事时（用他的账号发文章、扣他的会员额度、看他的订单），在清单里打开账号绑定。不需要的话写 `"user_binding": "none"`，靠输入字段识别用户就行，比如手机号（标 `"x-pii": true`）。

| `supplier.user_binding` | 用户怎么绑 | 信封里的 `user.supplier_user_ref` |
|---|---|---|
| `none` | 不绑 | `null` |
| `token` | 在你的产品里生成一次性绑定码，粘贴到 Relay | 你在绑定时返回的账号标识 |
| `oauth` | 协议预留，目前不接受 | — |

## 你要做的两件事

1. **一个生成绑定码的页面**，在你的产品里，用户登录后能打开。地址填到清单的 `supplier.binding.help_url`（必须 `https://`），还可以在 `instructions` 里写一句给用户看的说明（500 字以内）。绑定码应当一次性、10 分钟内有效，库里只存哈希，长度 4–128 个字符。
2. **处理 `binding.verify` 信封**：核对绑定码，有效就记下 `relay_uid` 和你的账号的对应关系，回 `bound`；无效、过期、用过了回 `failed`（一般用 `unauthorized`）。

```json
{
  "supplier": {
    "user_binding": "token",
    "binding": {
      "help_url": "https://shop.example.com/settings/ai-relay",
      "instructions": "在「设置 → AI Relay」生成一次性绑定码，粘贴到 Relay。"
    }
  }
}
```

```jsonc
// Relay 发来
{ "type": "binding.verify", "rsp": "1.0", "issued_at": "…", "relay_uid": "u_…", "code": "K7Q2-M9XP" }
// 你返回
{ "status": "bound", "supplier_user_ref": "user_10086", "display_name": "小李" }
```

`supplier_user_ref` 是你那边的账号标识，最长 256 个字符，之后每次 `action.invoke` 都会原样带在 `user.supplier_user_ref` 里。`display_name` 可选，Relay 页面上显示「已绑定为小李」。

同一个用户重发同一个码时可以再回 `bound`（Relay 网络重试会这样）；别的用户拿同一个码来，回 `failed`。

## 用户那边发生什么

1. 用户让 AI 调你的动作，还没绑定时，AI 收到 `binding_required` 和一个 Relay 的绑定链接。
2. 用户打开链接，Relay 页面上有你的说明和「打开绑定页面」按钮（就是 `help_url`）。
3. 用户在你的产品里生成绑定码，粘贴回 Relay。Relay 发 `binding.verify`，你回 `bound`。
4. 用户回到 AI 重试，这次信封里带上了 `supplier_user_ref`。

用户随时可以在 Relay 的「账号绑定」页解绑。你这边解绑或账号失效时，对 `action.invoke` 回 `unauthorized`：Relay 把这个用户的绑定标为失效，这一笔 AI 收到 `binding_invalid`，下次调用重新走绑定。

`user.relay_uid` 是按供给方派生的假名：同一个用户在不同供给方看到的值不同，供给方之间拼不出用户画像。用它做绑定关系的键，别拿它当跨产品的用户 ID。

## 用 SDK

```ts
// Node
const relay = createRelayHandler({
  secrets, manifest, handlers,
  binding: {
    verify: async ({ relay_uid, code }) => {
      const account = await bindingCodes.consume(code, relay_uid);   // 一次性；同一个 relay_uid 重发可以再成功
      return account ? bound(account.id, account.nickname) : failed("unauthorized", "绑定码无效或已过期");
    },
  },
});
// 动作里：ctx.user.supplier_user_ref
```

```python
# Python
def binding_verify(envelope):
    account = binding_codes.consume(envelope["code"], envelope["relay_uid"])
    return bound(account.id, account.nickname) if account else failed("unauthorized", "绑定码无效或已过期")

relay = RelayHandler(secrets=..., manifest="manifest.json", actions=..., binding_verify=binding_verify)
# 动作里：ctx.user["supplier_user_ref"]
```

## 自测

接入验收工具先用一个编造的绑定码发 `binding.verify`（必须回 `failed`）。再在你的产品里生成一个真绑定码，用 `--binding-code` 传进去：工具用它绑定，之后所有动作都带着绑定得到的账号调用，最后换一个用户用同一个码再绑一次（应当回 `failed`）。

```sh
npx @dreamcavy/ai-relay-conformance --manifest manifest.json --endpoint http://127.0.0.1:8787/relay \
  --inputs inputs.json --binding-code K7Q2-M9XP
```

不方便每次生成绑定码时，用 `--supplier-user-ref user_test` 直接给一个测试账号。后台在线验收会让你填一个绑定码，用法相同，不保存。

规范原文见[第 11 节](../protocol/rsp-1.0.md#11-账号绑定)。
