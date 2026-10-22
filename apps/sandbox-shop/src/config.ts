import { fileURLToPath } from "node:url";
import { FAULTS, type Fault, type SupplierKey } from "./l2/store.js";
import type { L2Settings } from "./l2/supplier.js";

export interface ShopConfig {
  host: string;
  port: number;
  /** 新 secret 在前；轮换期内用逗号隔开放两个。 */
  secrets: string[];
  dbPath: string;
  publicBaseUrl: string;
  manifestPath: string;
  /** 两家 L2 供给方。不配 secret 就不挂，沙箱只跑 L1。 */
  l2?: L2ShopConfig;
}

export interface L2ShopConfig {
  secrets: Partial<Record<SupplierKey, string[]>>;
  manifestPaths: Record<SupplierKey, string>;
  callbackBase: string;
  settings: L2Settings;
  lateMs: number;
}

/** 仓库里的示例清单，src/ 和 dist/ 到仓库根都是三级。 */
const manifestFile = (name: string) => fileURLToPath(new URL(`../../../examples/manifests/${name}`, import.meta.url));
const DEFAULT_MANIFEST = manifestFile("sandbox-shop.json");

export const L2_DEFAULTS = {
  publishDelayMs: 5_000,
  proposalIntervalMs: 2_000,
  selectDelayMs: 3_000,
  lateMs: 90_000,
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ShopConfig {
  const secrets = list(env.RELAY_SECRETS);
  if (secrets.length === 0) throw new Error("缺少 RELAY_SECRETS：填 Relay 后台给这家供给方的 secret");
  const port = Number(env.PORT ?? 8787);
  const config: ShopConfig = {
    host: env.HOST ?? "127.0.0.1",
    port,
    secrets,
    dbPath: env.DB_PATH ?? "./data/sandbox-shop.db",
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    manifestPath: env.MANIFEST_PATH ?? DEFAULT_MANIFEST,
  };

  const l2Secrets = { publisher: list(env.PUBLISHER_SECRETS), match: list(env.MATCH_SECRETS) };
  if (l2Secrets.publisher.length + l2Secrets.match.length === 0) return config;
  const callbackBase = env.RELAY_CALLBACK_BASE?.replace(/\/+$/, "");
  if (!callbackBase) throw new Error("配了 L2 供给方的 secret 就要配 RELAY_CALLBACK_BASE：回调发到 {RELAY_CALLBACK_BASE}/v1/callbacks/{order_id}");
  const faults = list(env.CALLBACK_FAULTS);
  const unknown = faults.filter((f) => !(FAULTS as readonly string[]).includes(f));
  if (unknown.length) throw new Error(`CALLBACK_FAULTS 里有不认识的开关：${unknown.join(", ")}（可选 ${FAULTS.join(", ")}）`);
  config.l2 = {
    secrets: l2Secrets,
    manifestPaths: {
      publisher: env.PUBLISHER_MANIFEST_PATH ?? manifestFile("l2-publisher.json"),
      match: env.MATCH_MANIFEST_PATH ?? manifestFile("l2-matching.json"),
    },
    callbackBase,
    settings: {
      publishDelayMs: ms(env.L2_PUBLISH_DELAY_MS, L2_DEFAULTS.publishDelayMs),
      proposalIntervalMs: ms(env.L2_PROPOSAL_INTERVAL_MS, L2_DEFAULTS.proposalIntervalMs),
      selectDelayMs: ms(env.L2_SELECT_DELAY_MS, L2_DEFAULTS.selectDelayMs),
      faults: faults as Fault[],
    },
    lateMs: ms(env.CALLBACK_LATE_MS, L2_DEFAULTS.lateMs),
  };
  return config;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ms(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`毫秒数不合法：${value}`);
  return n;
}
