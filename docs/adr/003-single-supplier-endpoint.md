# ADR-003 供给方只实现一个端点，信封按 type 分发

- 状态：已定
- 日期：2026-10-22

## 背景

接入成本是第一优先级：别人用自己的产品接我们有成本，要能快速对接，同时用上大部分产品功能。每个动作一个路由、每种回调一个地址，都会抬高接入成本。

## 决定

- 供给方只实现 `POST /relay`。Relay 发来的所有请求都是同一种信封，按 `type` 分发；`action.invoke` 再按 `action` 分发。
- 下行信封 6 种：`ping`、`action.invoke`、`task.poll`、`task.cancel`、`proposal.select`、`binding.verify`。
- 最初的设计只有前 5 种信封，但账号绑定要求 Relay 调供给方的 `binding.verify` 换回 `supplier_user_ref`。为了不让供给方为绑定再开一个地址，`binding.verify` 作为第 6 种信封走同一个端点，清单里只留 `binding.help_url`（用户去哪里拿绑定码）。
- 供给方遇到不认识的 `type` 必须返回错误码 `not_supported`，因此错误码表比方案多这一个。
- 回调方向也只有一个地址：`POST /v1/callbacks/{order_id}`，事件按 `type` 区分。

## 后果

- 最低接入（L1）只要处理 `ping` 和 `action.invoke` 两种信封。
- Relay 以后加信封类型不会破坏已接通的供给方。
- 供给方的一个端点承担全部流量，所以清单里允许声明 `max_concurrency`。
