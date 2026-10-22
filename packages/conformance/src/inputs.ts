/**
 * 样例输入里的占位符。值必须整个是一个占位符字符串，替换后保留原类型（数字还是数字）：
 *
 *   "{{list_slots.slots[0].slot_id}}"  前面某个动作 completed 的 output.data 里取值
 *   "{{$today}}" / "{{$tomorrow}}"     按 timeZone 算的日期，YYYY-MM-DD
 *
 * 动作按 inputs 文件里的键顺序执行，所以「先查后订、订完再取消」可以串起来。
 */

export type SampleInputs = Record<string, Record<string, unknown>>;

const PLACEHOLDER = /^\{\{\s*([^{}]+?)\s*\}\}$/;

export interface ResolveContext {
  /** 已完成动作的 output.data，键是动作名。 */
  outputs: ReadonlyMap<string, unknown>;
  nowMs: number;
  timeZone: string;
}

export type Resolved = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

export function resolveInput(input: Record<string, unknown>, ctx: ResolveContext): Resolved {
  try {
    return { ok: true, value: walk(input, ctx) as Record<string, unknown> };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

function walk(node: unknown, ctx: ResolveContext): unknown {
  if (typeof node === "string") {
    const m = PLACEHOLDER.exec(node);
    return m ? lookup(m[1]!, ctx) : node;
  }
  if (Array.isArray(node)) return node.map((v) => walk(v, ctx));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, ctx)]));
  }
  return node;
}

function lookup(expr: string, ctx: ResolveContext): unknown {
  if (expr === "$today") return dateIn(ctx.nowMs, ctx.timeZone);
  if (expr === "$tomorrow") return nextDay(dateIn(ctx.nowMs, ctx.timeZone));
  const [root, ...path] = parsePath(expr);
  if (!root || !ctx.outputs.has(root)) throw new Error(`占位符 {{${expr}}} 引用的动作 ${root ?? ""} 还没有成功的结果`);
  let value: unknown = ctx.outputs.get(root);
  for (const key of path) {
    if (value === null || typeof value !== "object" || !(key in value)) {
      throw new Error(`占位符 {{${expr}}} 在 ${root} 的 output.data 里取不到值`);
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** a.b[0].c → ["a", "b", "0", "c"] */
function parsePath(expr: string): string[] {
  return expr
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((s) => s.length > 0);
}

/** 按日历加一天；不能用「加 24 小时」，夏令时切换那天不是 24 小时。 */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function dateIn(ms: number, timeZone: string): string {
  // en-CA 的日期格式就是 YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}
