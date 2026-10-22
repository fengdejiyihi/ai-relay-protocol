"""action.invoke 的幂等缓存（规范第 10 节）。

规则：
- 同一个 ``idempotency_key`` 再次到达时返回第一次的最终结果，不重复执行。
- 只缓存 ``completed``、``accepted`` 和不可重试的 ``failed``；``temporary``、``rate_limited`` 不缓存。
- 同一个键还在处理中又到达时返回 ``temporary``，不并行再执行一次。
- 只读动作同样按键去重：Relay 核对时重放同一个键，应当拿到第一次的结果。

默认的 :class:`MemoryIdempotencyStore` 只适合单进程；多进程（gunicorn 多 worker）或要扛重启时用
:class:`SqliteIdempotencyStore`，或者照 :class:`IdempotencyStore` 接口接自己的数据库。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class StoredResponse:
    action: str
    #: 动作名 + 规范化输入的 sha256，用来识别「同一个键、不同请求」。
    input_hash: str
    response: dict[str, Any]


class IdempotencyStore(Protocol):
    def acquire(self, key: str) -> bool:
        """占住这个键准备执行。已被别的请求占住（处理中）时返回 False。"""

    def get(self, key: str) -> StoredResponse | None:
        """取已缓存的最终结果。"""

    def save(self, key: str, record: StoredResponse) -> None:
        """缓存最终结果。之后应当紧接着 release。"""

    def release(self, key: str) -> None:
        """放开占用。没有 save 就 release 表示这次没有最终结果（可重试的失败或异常）。"""


#: 结果至少保留 8 天：异步任务最长 7 天，后台核对还可能用同一个键重新下发。
DEFAULT_TTL_SECONDS = 8 * 24 * 3600


class MemoryIdempotencyStore:
    """进程内存实现，线程安全。结果默认保留 8 天，过期的在写入时顺带清掉；``ttl_seconds=None`` 表示一直保留。"""

    def __init__(self, ttl_seconds: float | None = DEFAULT_TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        self._saves = 0
        self._lock = threading.Lock()
        self._done: dict[str, tuple[float, StoredResponse]] = {}
        self._busy: set[str] = set()

    def acquire(self, key: str) -> bool:
        with self._lock:
            if key in self._busy:
                return False
            self._busy.add(key)
            return True

    def get(self, key: str) -> StoredResponse | None:
        with self._lock:
            hit = self._done.get(key)
            if hit is None:
                return None
            if self._ttl is not None and time.monotonic() - hit[0] > self._ttl:
                del self._done[key]
                return None
            return hit[1]

    def save(self, key: str, record: StoredResponse) -> None:
        with self._lock:
            now = time.monotonic()
            self._done[key] = (now, record)
            self._saves += 1
            if self._ttl is not None and self._saves % 1000 == 0:
                ttl = self._ttl
                for stale in [k for k, (at, _) in self._done.items() if now - at > ttl]:
                    del self._done[stale]

    def release(self, key: str) -> None:
        with self._lock:
            self._busy.discard(key)


class SqliteIdempotencyStore:
    """SQLite 实现，只用标准库。同一个文件可以被多个进程共用，重启后结果还在。

    ``lease_seconds``：处理中的占用超过这个时间视为进程已崩溃，允许别的请求接手。
    应当大于动作最长的执行时间；默认 120 秒（同步调用的硬超时是 60 秒）。
    """

    def __init__(self, path: str, *, lease_seconds: float = 120) -> None:
        self._path = path
        self._lease = lease_seconds
        self._local = threading.local()
        with self._conn() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS relay_idempotency ("
                " key TEXT PRIMARY KEY,"
                " locked_at REAL,"
                " action TEXT,"
                " input_hash TEXT,"
                " response TEXT)"
            )

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self._path, timeout=30, isolation_level=None, check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL")
            self._local.conn = conn
        return conn

    def acquire(self, key: str) -> bool:
        conn = self._conn()
        now = time.time()
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute("SELECT locked_at FROM relay_idempotency WHERE key = ?", (key,)).fetchone()
            if row is not None and row[0] is not None and now - row[0] < self._lease:
                conn.execute("COMMIT")
                return False
            conn.execute(
                "INSERT INTO relay_idempotency (key, locked_at) VALUES (?, ?)"
                " ON CONFLICT(key) DO UPDATE SET locked_at = excluded.locked_at",
                (key, now),
            )
            conn.execute("COMMIT")
            return True
        except BaseException:
            conn.execute("ROLLBACK")
            raise

    def get(self, key: str) -> StoredResponse | None:
        row = self._conn().execute(
            "SELECT action, input_hash, response FROM relay_idempotency WHERE key = ? AND response IS NOT NULL", (key,)
        ).fetchone()
        return None if row is None else StoredResponse(row[0], row[1], json.loads(row[2]))

    def save(self, key: str, record: StoredResponse) -> None:
        self._conn().execute(
            "UPDATE relay_idempotency SET action = ?, input_hash = ?, response = ? WHERE key = ?",
            (record.action, record.input_hash, json.dumps(record.response, ensure_ascii=False), key),
        )

    def release(self, key: str) -> None:
        conn = self._conn()
        conn.execute("UPDATE relay_idempotency SET locked_at = NULL WHERE key = ?", (key,))
        conn.execute("DELETE FROM relay_idempotency WHERE key = ? AND response IS NULL AND locked_at IS NULL", (key,))
