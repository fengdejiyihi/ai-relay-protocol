# AI Relay 供给方 Python SDK

用 [RSP 1.0](../../docs/protocol/rsp-1.0.md) 把你的产品接入 AI Relay。SDK 帮你做协议里容易写错的部分，你只写业务函数：

- **验签**：用原始字节算 HMAC-SHA256，5 分钟时间窗，常量时间比较，轮换期新旧两个 secret 都认，头部多个 `v1=` 任一匹配即通过。只用标准库。
- **分发**：`ping` 自动应答；`action.invoke` 按动作名分发并用清单里的 `input` Schema 校验输入；不认识的 `type` 自动回 `not_supported`；信封里不认识的字段、`1.x` 的小版本一律忽略（规范第 14 节）。
- **幂等**：同一个 `idempotency_key` 重发时直接返回第一次的结果，处理中再到达回 `temporary`，`temporary`、`rate_limited` 不缓存（规范第 10 节）。存储可换：内存、SQLite 或你自己的数据库。
- **回调**：异步动作完成后签名回调 Relay，5xx、429、超时自动退避重发，同一个 `event_id`。
- **框架**：FastAPI、Flask，或者不用框架（标准库 `wsgiref` / 任意 WSGI 服务器）。

Python 3.10+。唯一的运行时依赖是 `jsonschema`。协议的 JSON Schema 随包分发，和 [`packages/protocol/schemas/`](../protocol/schemas/) 保持一致。

## 安装

```sh
pip install "dreamcavy-ai-relay-sdk[fastapi]"   # 或 [flask]，不用框架就不加
```

> 还没有发布到 PyPI。发布前从源码安装：
> `pip install "git+https://github.com/fengdejiyihi/ai-relay-protocol.git#subdirectory=packages/sdk-python"`

## 五分钟接入（L1 同步）

1. 写清单：照 [`examples/bookshop.manifest.json`](examples/bookshop.manifest.json) 改。规则见规范第 4 节。
2. 每个动作写一个函数 `fn(input, ctx)`，返回 `completed(...)`，或者 `raise RelayError("not_available", "...")`：

```python
import os
from fastapi import FastAPI
from ai_relay_sdk import InvokeContext, RelayError, RelayHandler, completed, markdown
from ai_relay_sdk.fastapi import relay_router

def order_book(data: dict, ctx: InvokeContext) -> dict:
    # data 已按清单的 input Schema 校验过；同一个 order_id 重发不会再进到这里
    if out_of_stock(data["book_id"]):
        raise RelayError("not_available", "暂时缺货")
    order_no = create_order(data, relay_order=ctx.order_id)
    return completed({"order_no": order_no}, [markdown(f"已下单，订单号 {order_no}")])

relay = RelayHandler(
    secrets=os.environ["RELAY_SECRET"].split(","),   # 轮换期：新的,旧的
    manifest="manifest.json",
    actions={"order_book": order_book, "search_books": search_books},
)

app = FastAPI()
app.include_router(relay_router(relay))   # POST /relay
```

Flask：

```python
from flask import Flask
from ai_relay_sdk.flask import register_relay

app = Flask(__name__)
register_relay(app, relay)                 # POST /relay
```

不用框架：

```python
from wsgiref.simple_server import make_server
from ai_relay_sdk.wsgi import make_wsgi_app

make_server("127.0.0.1", 8080, make_wsgi_app(relay)).serve_forever()
```

3. 端点前面放 HTTPS（清单里 `endpoint.url` 必须是 `https://`）。
4. 自测：`pytest` 照 [`tests/test_examples.py`](tests/test_examples.py) 写，或用接入验收工具 `@dreamcavy/ai-relay-conformance` 对端点跑一遍。

完整可运行的例子：[`examples/bookshop.py`](examples/bookshop.py)（约 60 行，零框架），[`bookshop_fastapi.py`](examples/bookshop_fastapi.py)、[`bookshop_flask.py`](examples/bookshop_flask.py) 是同一套动作挂到框架上。

```sh
cd packages/sdk-python
RELAY_SECRET=whsec_dev python examples/bookshop.py           # http://127.0.0.1:8080/relay
RELAY_SECRET=whsec_dev uvicorn examples.bookshop_fastapi:app
RELAY_SECRET=whsec_dev flask --app examples.bookshop_flask run
```

## 异步动作（L2）

动作返回 `accepted(task_id)`，做完后用 `RelayCallbackClient` 回调；再实现 `task_poll` 和 `task_cancel`，Relay 收不到回调时会来补拉。完整例子：[`examples/summarizer.py`](examples/summarizer.py)。

```python
from ai_relay_sdk import RelayCallbackClient, CallbackDeliveryError, accepted, completed, pending, cancelled

callbacks = RelayCallbackClient(secret=os.environ["RELAY_SECRET"].split(",")[0])

def summarize(data, ctx):
    task_id = queue_job(ctx.order_id, data)
    return accepted(task_id, eta_seconds=60)

def on_job_done(order_id, summary):
    try:
        callbacks.completed(order_id, {"summary": summary})
    except CallbackDeliveryError as exc:
        save_for_later(exc.event)        # 稍后 callbacks.send(event) 原样重发，event_id 不变

relay = RelayHandler(
    secrets=[...], manifest="manifest.json",
    actions={"summarize": summarize},
    task_poll=lambda env: completed(...) if done(env["task_id"]) else pending(),
    task_cancel=lambda env: cancelled(),
)
```

多方案（`async_multi`）：`task_poll` 返回 `proposals([...])`，新方案用 `callbacks.proposal_add(order_id, proposal(...))` 推送，`proposal_select` 处理用户选定。需要账号绑定（`user_binding: "token"`）的产品实现 `binding_verify`，返回 `bound(supplier_user_ref)`。

## API

### `RelayHandler(*, secrets, manifest, actions, task_poll=None, task_cancel=None, proposal_select=None, binding_verify=None, idempotency_store=None, check_output=True)`

| 参数 | 说明 |
|---|---|
| `secrets` | Relay 后台给的 secret，字符串或列表。轮换期新旧两个都给，新的在前。只放同一个供给方的 secret：一个服务接两个产品时，每个产品各建一个 `RelayHandler`，挂在各自的路径上 |
| `manifest` | 清单 dict 或 JSON 文件路径。构造时按 Schema 校验，清单里每个动作都必须在 `actions` 里有函数 |
| `actions` | 动作名 → `fn(input: dict, ctx: InvokeContext) -> 响应`，可以是 `async def` |
| `task_poll` 等 | `fn(envelope: dict) -> 响应`。没给的信封类型回 `not_supported` |
| `idempotency_store` | 默认 `MemoryIdempotencyStore()`（单进程，结果保留 8 天）。只读动作也按键去重，与写动作一样。多进程部署用 `SqliteIdempotencyStore("relay.db")` 或实现 `IdempotencyStore` 接口（`acquire`、`get`、`save`、`release` 四个方法，见 [`idempotency.py`](src/ai_relay_sdk/idempotency.py)）。结果至少保留 8 天：异步任务最长 7 天，后台核对还可能用同一个键重新下发 |
| `check_output` | 动作声明了 `output` Schema 时检查 `completed` 的 `data`，不符只记警告日志 |

- `handle(body: bytes, signature: str | None) -> RelayReply`：同步入口。`body` 必须是收到的**原始字节**，不能解析后再序列化。
- `await handle_async(body, signature)`：异步入口，处理函数可以是 `async def`。
- `RelayReply`：`status_code`、`body`（dict）、`headers`、`body_bytes()`。

`InvokeContext`：`order_id`、`action`、`idempotency_key`、`manifest_version`、`user`（`relay_uid`、`display_name?`、`supplier_user_ref`）、`deadline_at`、`envelope`（完整信封）、`action_spec`（清单里这个动作）。

SDK 返回的 HTTP 状态：

| 情况 | 返回 |
|---|---|
| 验签失败 | 401 + `unauthorized` |
| 不是 JSON、信封不合法、没有这个动作、输入不符合 Schema | 200 + `invalid_input`（`details` 里有出错位置） |
| 不认识的 `type`，或没给处理函数的信封类型 | 200 + `not_supported` |
| 已过 `deadline_at`（这个键还没有缓存的结果时；有就照常返回第一次的结果） | 200 + `temporary`，不执行 |
| 同一个键正在处理 | 200 + `temporary` |
| 处理函数 `raise RelayError(...)` | 200 + `failed` |
| 处理函数抛出其他异常，或返回了不合法的响应 | **500**，不缓存。Relay 把这一笔当「结果未知」进待核对、不扣费，而不是当成明确失败 |

### 响应构造

`completed(data, parts=None)`、`failed(code, message=None, *, details=None, retry_after=None)`、`accepted(task_id, eta_seconds=None)`、`pending(eta_seconds=None)`、`proposals(items)`、`proposal(proposal_id, title, data, parts=None, *, price_cents=None, eta_days=None)`、`cancelled()`、`cancel_failed(reason=None)`、`selected()`、`bound(supplier_user_ref, display_name=None)`。

返回内容块：`text(...)`、`markdown(...)`、`image(url=... | base64=..., mime=...)`、`file(url, name)`、`link(url, title)`、`json_part(value)`。

`RelayError(code, message=None, *, details=None, retry_after=None)`：错误码是规范第 9 节的 7 个之一。`temporary`、`rate_limited` 表示「确认没有执行」，Relay 会用同一个幂等键重试。不确定有没有执行时，应当直接抛普通异常让 SDK 回 500，而不是回 `temporary`。

### `RelayCallbackClient(secret, *, base_url="https://relay.newbeeai.online", timeout=10, retry_delays=(1, 4, 16, 60, 300))`

`completed(order_id, data, parts=None)`、`failed(order_id, code, message=None)`、`proposal_add(order_id, proposal)`、`proposal_withdraw(order_id, proposal_id, reason=None)`、`dispute(order_id, reason)`、`cancel_failed(order_id, reason=None)`，都可以传 `event_id=` 固定事件号；`send(event)` 发任意事件，缺的 `rsp`、`event_id`、`occurred_at` 自动补。

| Relay 返回 | 客户端 |
|---|---|
| 200 | 返回 `CallbackResult`，`ok` 为真（重复事件也是 200） |
| 409 | 返回 `CallbackResult`，`order_terminal` 为真：订单已是终态，事件只记录 |
| 401 / 404 / 422 | 抛 `CallbackRejected`，不重发 |
| 5xx、429、连接失败、超时 | 按 `retry_delays` 退避重发（429 照 `Retry-After`），用完抛 `CallbackDeliveryError`，`exc.event` 可原样再发 |

客户端是同步的（标准库 `urllib`）。在 `async` 代码里用 `await asyncio.to_thread(callbacks.completed, ...)`。

### 底层函数

- `sign_body(secret, body, timestamp=None) -> str`、`verify_signature(secrets, header, body, *, now=None) -> VerifyResult`、`parse_signature_header(header)`。
- `validate_downstream(envelope, *, strict=False)`、`validate_response(type, response, *, strict=False)`、`validate_upstream(event, *, strict=False)`、`validate_manifest(manifest)`、`compile_action_input(schema)`：返回 `Issue` 列表，空列表表示通过。默认宽松（忽略多余字段、接受 `1.x`），`strict=True` 不允许 Schema 外的字段。
- `validate_manifest` 只查 Schema 和动作名重复；规范 4.4 的其他语义规则提交清单时由 Relay 检查，也可以用接入验收工具自查。

## 开发

```sh
cd packages/sdk-python
python -m venv .venv && . .venv/bin/activate
pip install -e ".[test]"
pytest
python scripts/sync_schemas.py --check   # 协议 Schema 改了以后去掉 --check 同步一次
```

许可证：Apache-2.0。
