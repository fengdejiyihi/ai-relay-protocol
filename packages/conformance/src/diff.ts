/** 两个 JSON 值第一处不同的位置（JSON 指针），相同返回 null。对象键的顺序不算差异。 */
export function firstDifference(a: unknown, b: unknown, path = ""): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path || "/"} 长度 ${a.length} → ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}/${i}`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}/${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path || "/"}：${short(a)} → ${short(b)}`;
}

function short(v: unknown): string {
  const s = v === undefined ? "（无）" : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
