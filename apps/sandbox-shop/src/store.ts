import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BOOKING_WINDOW_DAYS, SERVICE_IDS, SERVICES, type ServiceId } from "./catalog.js";
import { nextDays, shanghaiDate, shanghaiIso } from "./time.js";

export interface Slot {
  slot_id: string;
  date: string;
  start: string;
  start_ms: number;
  service: ServiceId;
  price_cents: number;
  booking_id: string | null;
}

export interface Booking {
  booking_id: string;
  slot_id: string;
  relay_uid: string;
  order_id: string;
  name: string;
  phone: string;
  status: "booked" | "cancelled";
  start: string;
  service: ServiceId;
  price_cents: number;
}

export interface StoredResponse {
  action: string;
  input_hash: string;
  response: string;
}

export type BookResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: "no_such_slot" | "slot_taken" | "slot_past" }
  | { ok: false; reason: "price_mismatch"; priceCents: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS slots (
  slot_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  start TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  service TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  booking_id TEXT
);
CREATE INDEX IF NOT EXISTS slots_date ON slots (date, start_ms);
CREATE TABLE IF NOT EXISTS bookings (
  booking_id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL,
  relay_uid TEXT NOT NULL,
  order_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER
);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/**
 * 门店数据。SQLite 单文件，同步 API；单进程里每个请求天然串行，
 * 写操作仍包在 BEGIN IMMEDIATE 里，防止多进程共用一个库文件时超卖。
 *
 * 数据每天（北京时间）滚动：第一次访问时发现营业日变了，就删掉已过去日期的时段和预约，
 * 补齐到今天起 7 天。未来日期的预约保留，用户今天约了明天，过零点后仍能查询和取消。
 */
export class ShopStore {
  private readonly db: DatabaseSync;
  private inTransaction = false;

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** 营业日变了就滚动窗口。每个读写入口都先调它。 */
  refresh(): void {
    const today = shanghaiDate(this.now());
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'business_date'").get() as { value: string } | undefined;
    if (row?.value === today) return;
    this.transaction(() => {
      this.db.prepare("DELETE FROM bookings WHERE slot_id IN (SELECT slot_id FROM slots WHERE date < ?)").run(today);
      this.db.prepare("DELETE FROM slots WHERE date < ?").run(today);
      // 幂等记录保留一个预约窗口那么久，跨零点的同键重试仍返回第一次的结果。
      this.db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(this.now() - BOOKING_WINDOW_DAYS * 24 * 3600 * 1000);
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO slots (slot_id, date, start, start_ms, service, price_cents) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const date of nextDays(today, BOOKING_WINDOW_DAYS)) {
        for (const service of SERVICE_IDS) {
          const { hours, priceCents } = SERVICES[service];
          for (const hour of hours) {
            const start = shanghaiIso(date, hour);
            insert.run(slotId(date, hour, service), date, start, Date.parse(start), service, priceCents);
          }
        }
      }
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('business_date', ?)").run(today);
    });
  }

  /** 当前可预约的日期范围（含首尾）。 */
  window(): { first: string; last: string } {
    const days = nextDays(shanghaiDate(this.now()), BOOKING_WINDOW_DAYS);
    return { first: days[0]!, last: days[days.length - 1]! };
  }

  /** 某天还没开始、也没被约走的时段。 */
  freeSlots(date: string, service?: ServiceId): Slot[] {
    this.refresh();
    const sql =
      "SELECT * FROM slots WHERE date = ? AND booking_id IS NULL AND start_ms > ?" +
      (service ? " AND service = ?" : "") +
      " ORDER BY start_ms, service";
    const params: (string | number)[] = [date, this.now()];
    if (service) params.push(service);
    return this.db.prepare(sql).all(...params) as unknown as Slot[];
  }

  book(input: { slotId: string; priceCents: number; name: string; phone: string; relayUid: string; orderId: string }): BookResult {
    this.refresh();
    return this.transaction(() => {
      const slot = this.db.prepare("SELECT * FROM slots WHERE slot_id = ?").get(input.slotId) as Slot | undefined;
      if (!slot) return { ok: false, reason: "no_such_slot" };
      // 用户确认页上看到的金额来自这个字段，必须和门店价格一致，否则不能下单。
      if (slot.price_cents !== input.priceCents) return { ok: false, reason: "price_mismatch", priceCents: slot.price_cents };
      if (slot.start_ms <= this.now()) return { ok: false, reason: "slot_past" };
      if (slot.booking_id) return { ok: false, reason: "slot_taken" };
      const bookingId = newBookingId();
      this.db
        .prepare(
          "INSERT INTO bookings (booking_id, slot_id, relay_uid, order_id, name, phone, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'booked', ?)",
        )
        .run(bookingId, slot.slot_id, input.relayUid, input.orderId, input.name, input.phone, this.now());
      this.db.prepare("UPDATE slots SET booking_id = ? WHERE slot_id = ?").run(bookingId, slot.slot_id);
      return { ok: true, booking: this.bookingRow(bookingId)! };
    });
  }

  /** 只返回该 relay_uid 自己的预约：别的用户猜到 booking_id 也查不到。 */
  booking(bookingId: string, relayUid?: string): Booking | undefined {
    this.refresh();
    const booking = this.bookingRow(bookingId);
    if (!booking || (relayUid !== undefined && booking.relay_uid !== relayUid)) return undefined;
    return booking;
  }

  /** 取消并释放时段。已取消的再取消，原样返回。 */
  cancel(bookingId: string, relayUid: string): Booking | undefined {
    this.refresh();
    return this.transaction(() => {
      const booking = this.booking(bookingId, relayUid);
      if (!booking || booking.status === "cancelled") return booking;
      this.db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE booking_id = ?").run(this.now(), bookingId);
      this.db.prepare("UPDATE slots SET booking_id = NULL WHERE slot_id = ? AND booking_id = ?").run(booking.slot_id, bookingId);
      return this.bookingRow(bookingId);
    });
  }

  storedResponse(key: string): StoredResponse | undefined {
    this.refresh();
    return this.db.prepare("SELECT action, input_hash, response FROM idempotency WHERE key = ?").get(key) as
      | StoredResponse
      | undefined;
  }

  saveResponse(key: string, value: StoredResponse): void {
    this.db
      .prepare("INSERT OR IGNORE INTO idempotency (key, action, input_hash, response, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, value.action, value.input_hash, value.response, this.now());
  }

  /** 嵌套调用时只有最外层开事务。 */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  private bookingRow(bookingId: string): Booking | undefined {
    return this.db
      .prepare(
        `SELECT b.booking_id, b.slot_id, b.relay_uid, b.order_id, b.name, b.phone, b.status, s.start, s.service, s.price_cents
         FROM bookings b JOIN slots s ON s.slot_id = b.slot_id WHERE b.booking_id = ?`,
      )
      .get(bookingId) as Booking | undefined;
  }
}

function slotId(date: string, hour: number, service: ServiceId): string {
  return `s_${date.replaceAll("-", "")}_${String(hour).padStart(2, "0")}00_${service}`;
}

function newBookingId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return "b_" + Array.from(randomBytes(12), (byte) => alphabet[byte & 31]).join("");
}
