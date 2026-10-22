import type { ActionInvokeEnvelope, CompletedResponse, ErrorCode, FailedResponse, Part } from "@ai-relay/protocol";
import { SERVICES, type ServiceId } from "./catalog.js";
import type { Booking, ShopStore } from "./store.js";
import { humanTime } from "./time.js";

export type ActionResponse = CompletedResponse | FailedResponse;

export interface ActionContext {
  envelope: ActionInvokeEnvelope;
  store: ShopStore;
  /** 门店网页的根地址，用来拼 link 内容块。 */
  publicBaseUrl: string;
  /** 当前时刻（毫秒），测试里可注入。 */
  now: () => number;
}

/** 输入已按 Manifest 里该动作的 input Schema 校验过，这里可以直接取字段。 */
export type ActionHandler = (input: Record<string, unknown>, ctx: ActionContext) => ActionResponse;

export const ACTIONS: Record<string, ActionHandler> = {
  list_slots(input, { store, publicBaseUrl }) {
    const date = input.date as string;
    const service = input.service as ServiceId | undefined;
    const { first, last } = store.window();
    const slots = date >= first && date <= last ? store.freeSlots(date, service) : [];
    const data = {
      slots: slots.map(({ slot_id, start, service, price_cents }) => ({ slot_id, start, service, price_cents })),
    };
    const lines =
      slots.length > 0
        ? slots.map((s) => `- ${s.start.slice(11, 16)} ${SERVICES[s.service].title} ¥${yuan(s.price_cents)}（${s.slot_id}）`)
        : [date < first || date > last ? `只能预约 ${first} 到 ${last} 的时段。` : "这一天没有空闲时段了。"];
    return completed(data, [
      { type: "markdown", text: [`**${date} 可预约时段**`, "", ...lines].join("\n") },
      { type: "link", url: `${publicBaseUrl}/?date=${date}`, title: "在网页查看当天时段" },
    ]);
  },

  book_slot(input, { envelope, store, publicBaseUrl }) {
    const result = store.book({
      slotId: input.slot_id as string,
      priceCents: input.price_cents as number,
      name: input.name as string,
      phone: input.phone as string,
      relayUid: envelope.user.relay_uid,
      orderId: envelope.order_id,
    });
    if (!result.ok && result.reason === "price_mismatch") {
      return failed("invalid_input", `price_cents 与时段价格不符：该时段价格是 ${result.priceCents} 分，请按 list_slots 返回的 price_cents 填写`);
    }
    if (!result.ok) {
      const message = {
        no_such_slot: "没有这个时段，请先用 list_slots 查询",
        slot_taken: "这个时段刚被约走了，请换一个",
        slot_past: "这个时段已经开始或已过去",
      }[result.reason];
      return failed("not_available", message);
    }
    const b = result.booking;
    return completed(
      { booking_id: b.booking_id, start: b.start, service: b.service, price_cents: b.price_cents },
      [
        {
          type: "markdown",
          text: `已为 ${b.name} 预约 **${humanTime(b.start)} ${SERVICES[b.service].title}**，到店付款 ¥${yuan(b.price_cents)}，报预约号 ${b.booking_id}。门店会打 ${maskPhone(b.phone)} 联系您。`,
        },
        bookingLink(publicBaseUrl, b),
      ],
    );
  },

  get_booking(input, { envelope, store, publicBaseUrl }) {
    const b = store.booking(input.booking_id as string, envelope.user.relay_uid);
    if (!b) return failed("not_available", "没有找到这个预约");
    return completed({ booking_id: b.booking_id, status: b.status, start: b.start }, [
      {
        type: "markdown",
        text: `预约 ${b.booking_id}：${humanTime(b.start)} ${SERVICES[b.service].title}，${b.status === "booked" ? "已预约" : "已取消"}。`,
      },
      bookingLink(publicBaseUrl, b),
    ]);
  },

  cancel_booking(input, { envelope, store, publicBaseUrl, now }) {
    const bookingId = input.booking_id as string;
    const existing = store.booking(bookingId, envelope.user.relay_uid);
    if (!existing) return failed("not_available", "没有找到这个预约");
    if (existing.status === "booked" && Date.parse(existing.start) <= now()) {
      return failed("not_available", "预约时间已到，不能再取消");
    }
    const b = store.cancel(bookingId, envelope.user.relay_uid)!;
    return completed({ booking_id: b.booking_id, status: "cancelled" }, [
      { type: "markdown", text: `已取消 ${humanTime(b.start)} 的${SERVICES[b.service].title}预约（${b.booking_id}）。` },
      bookingLink(publicBaseUrl, b),
    ]);
  },
};

export function completed(data: Record<string, unknown>, parts: Part[]): CompletedResponse {
  return { status: "completed", output: { data, parts } };
}

export function failed(code: ErrorCode, message: string, details?: unknown): FailedResponse {
  return { status: "failed", error: details === undefined ? { code, message } : { code, message, details } };
}

function bookingLink(base: string, b: Booking): Part {
  return { type: "link", url: `${base}/b/${b.booking_id}`, title: "在网页查看预约" };
}

export function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function yuan(cents: number): string {
  return (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
}
