"""把协议的 JSON Schema 复制进 SDK 包里。

协议 Schema 的唯一来源是 packages/protocol/schemas/，SDK 打包时需要一份随包分发的副本。
改了协议 Schema 之后运行一次：

    python scripts/sync_schemas.py          # 复制
    python scripts/sync_schemas.py --check  # 只检查是否一致，不一致退出码 1（CI 用）
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / "protocol" / "schemas"
TARGET = HERE.parent / "src" / "ai_relay_sdk" / "schemas"
FILES = ["common.json", "downstream.json", "responses.json", "upstream.json", "manifest.json"]


def main() -> int:
    check = "--check" in sys.argv[1:]
    stale = []
    for name in FILES:
        source = (SOURCE / name).read_bytes()
        target = TARGET / name
        if target.exists() and target.read_bytes() == source:
            continue
        stale.append(name)
        if not check:
            TARGET.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source)
    if check and stale:
        print(f"SDK 里的 Schema 与 packages/protocol/schemas 不一致：{', '.join(stale)}。运行 python scripts/sync_schemas.py")
        return 1
    print("已同步：" + (", ".join(stale) if stale else "无变化"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
