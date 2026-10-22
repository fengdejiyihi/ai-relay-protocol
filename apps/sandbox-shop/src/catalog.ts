/** 沙箱门店的服务项目与排班。改这里就能换一家店，Manifest 里的 enum 要同步。 */
export const SERVICES = {
  haircut: { title: "剪发", priceCents: 6800, hours: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19] },
  wash: { title: "洗吹", priceCents: 3000, hours: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19] },
  color: { title: "染发", priceCents: 28800, hours: [10, 13, 16] },
} as const;

export type ServiceId = keyof typeof SERVICES;
export const SERVICE_IDS = Object.keys(SERVICES) as ServiceId[];

/** 预置多少天的时段（含今天）。 */
export const BOOKING_WINDOW_DAYS = 7;
