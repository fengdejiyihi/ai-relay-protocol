# 起步模板

两份零依赖、现在就能跑的完整端点，已经按 RSP 1.0 写好验签、幂等、输入校验、错误码；L2 还写好了账号绑定、取消、选方案、回调发件箱和终态处理。拷一份到你的项目，只改标了 `TODO(业务)` 的几个函数，就能过接入验收。

| 模板 | 适合 | 包含 | 本机验收 |
|---|---|---|---|
| [node-l1](node-l1/) | 动作 3 秒内给结果：查询、预约、下单 | `ping`、`action.invoke`，不绑定账号 | 18 通过 0 失败 |
| [node-l2](node-l2/) | 要排队、人工处理，或者多家报价让用户选 | 异步单结果 `write_report` + 异步多方案 `find_vendor` + 一次性绑定码 | 35 通过 0 失败 |

只要 Node 22.13 以上，不用装任何包（SQLite 用 Node 自带的 `node:sqlite`），也不依赖还没发布的 SDK。用 Python 或别的语言的话，照着模板的结构改写就行，协议只有一个端点。

## 5 分钟在本机跑通

```sh
git clone https://github.com/fengdejiyihi/ai-relay-protocol.git && cd ai-relay-protocol
pnpm install && pnpm build          # 构建接入验收工具（npm 发布后可以跳过，改用 npx）
cp -r examples/starters/node-l2 ~/my-relay && cd ~/my-relay

# 终端 1：起端点，回调先指到验收工具的接收端
RELAY_SECRET=whsec_dev RELAY_CALLBACK_BASE=http://127.0.0.1:8788 npm start

# 终端 2：生成一个测试买家的绑定码，跑验收
CODE=$(npm run -s binding-code test_buyer)
RELAY_SECRET=whsec_dev node <公开仓库路径>/packages/conformance/dist/cli.js --manifest manifest.json \
  --endpoint http://127.0.0.1:8787/relay --inputs inputs.json --callback-port 8788 --binding-code "$CODE"
```

L1 模板不需要回调和绑定码：`RELAY_SECRET=whsec_dev npm start`，验收命令去掉 `--callback-port` 和 `--binding-code`。

「端点使用 HTTPS」「测的就是清单里的端点」两条警告在本机是预期的，部署到 HTTPS 后就没了。

## 改成你的业务

1. 改 `manifest.json`：供给方名字、说明、分类，动作的名字、说明、输入输出 Schema、风险、手续费。规则见 [L1 第 1 步](../../docs/integrate/l1.md#第-1-步写清单)。
2. 改 `server.mjs` 里标了 `TODO(业务)` 的函数，其余不用动：

| 模板 | 函数 | 做什么 |
|---|---|---|
| L1 | `listItems`、`placeOrder` | 查你的数据、真正下单；核对金额 |
| L2 | `doReport` | 异步单结果：真正去办事，返回 `output` |
| L2 | `findVendors` | 多方案：给出候选方案（真实产品通常陆续来，每来一个调一次 `enqueue(... proposal.add ...)`） |
| L2 | `deliverSelection` | 用户选定后交付，返回联系方式等结果 |
| L2 | `canCancel` | 还能不能撤回 |
| L2 | `newBindingCode` | 生成一次性绑定码；挪到你产品里用户登录后的页面，地址填进清单 `binding.help_url` |

3. 改 `inputs.json`：每个动作一份样例输入，在线验收也用它。
4. 再跑一遍本机验收到全绿。

每个函数都收到 `test` 参数：在线验收的订单和测试买家的订单为 `true`，这时请走测试数据，不发真实消息、不通知真实商家。规则见[测试隔离与检查清单](../../docs/integrate/testing.md)。

## 部署

| 环境变量 | 说明 |
|---|---|
| `RELAY_SECRET` | 后台注册时给的 `whsec_…`。轮换期写成 `新,旧` |
| `RELAY_CALLBACK_BASE` | L2 回调根地址，正式环境不用设（默认 `https://relay.newbeeai.online`） |
| `PORT`、`HOST` | 监听地址，默认 `127.0.0.1:8787`，前面放 nginx 或 Caddy 提供 HTTPS |
| `DB_FILE` | SQLite 文件位置，默认模板目录下的 `relay-starter.db`。测试和正式用不同的文件 |
| `TEST_ACCOUNTS`（L2）、`TEST_PHONES`（L1） | 哪些测试买家走测试数据，逗号分隔 |
| `WORK_DELAY_MS`（L2） | 模拟业务耗时，接好真实业务后删掉 |

部署前先确认三件事，能省掉大部分来回：能用 SSH 登录服务器；服务器能拉到你的代码（或者你能 `scp`/`rsync` 上传）；部署脚本中断后能从断点重跑。端点上线后在服务器上生成一个测试买家的绑定码（`npm run -s binding-code test_buyer`），填进后台在线验收。

## 一个服务接两个产品

一个账号接多个产品时，每个产品是一个单独的供给方，各有 `supplier_id`、secret 和清单（见[接入总览「一个账号接多个产品」](../../docs/integrate/README.md#一个账号接多个产品)）。Relay 的请求里不带 `supplier_id`，所以两个产品放在同一个服务里时按路径分：

1. **已上线的产品不动**：继续用 `/relay`、`RELAY_SECRET`、原来的 `manifest.json`。
2. **新产品用新路径和新变量**：比如 `/relay/booking`、`RELAY_SECRET_BOOKING`，清单单独一份（比如 `booking/manifest.json`），里面的 `endpoint.url` 写新路径。
3. **`server.mjs` 里按路径选配置**：把 `req.url !== "/relay"` 的判断换成「路径 → { secret, 清单, 动作 }」的表，验签、分发、回调签名都用这个路径自己的 secret。新变量没配时不要挂新路径，也不要退回用老产品的 secret。
4. **幂等表可以共用**：`idempotency_key` 等于 `order_id`，全局唯一。测试手机号、测试买家按产品分开配。
5. **分别验收**：对两个端点、两份清单各跑一次接入验收，都 0 失败。

## 模板没做的事

- 输入校验只覆盖常用的 Schema 关键字（类型、必填、长度、范围、枚举、正则）。清单里用了 `oneOf`、嵌套对象校验时，换成完整的 JSON Schema 校验器或 SDK。
- 「同一个订单正在处理」的判断在进程内存里。多进程或多台机器部署时，改成数据库行锁。
- SQLite 适合单机。换成你自己的数据库时，保留这几张表的含义：幂等结果至少留 8 天，回调发件箱和任务状态在同一个事务里写。
