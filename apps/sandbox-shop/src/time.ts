/**
 * 门店在北京时间营业。中国不实行夏令时，固定 +08:00 即可，不需要时区库。
 */
const OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** 某一时刻在北京时间是哪一天，YYYY-MM-DD。 */
export function shanghaiDate(epochMs: number): string {
  return new Date(epochMs + OFFSET_MS).toISOString().slice(0, 10);
}

/** 从 date 起往后 n 天（含当天），YYYY-MM-DD。 */
export function nextDays(date: string, n: number): string[] {
  const start = Date.parse(`${date}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
}

/** 北京时间 date 当天 hour:minute 的 ISO 8601 字符串（带 +08:00）。 */
export function shanghaiIso(date: string, hour: number, minute = 0): string {
  return `${date}T${pad(hour)}:${pad(minute)}:00+08:00`;
}

/** 给人看的时间：10 月 23 日 15:00。 */
export function humanTime(iso: string): string {
  const [, month, day, hh, mm] = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso) ?? [];
  return `${Number(month)} 月 ${Number(day)} 日 ${hh}:${mm}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
