import { fileURLToPath } from "node:url";

export interface ShopConfig {
  host: string;
  port: number;
  /** 新 secret 在前；轮换期内用逗号隔开放两个。 */
  secrets: string[];
  dbPath: string;
  publicBaseUrl: string;
  manifestPath: string;
}

/** 仓库里的沙箱清单，src/ 和 dist/ 到仓库根都是三级。 */
const DEFAULT_MANIFEST = fileURLToPath(new URL("../../../examples/manifests/sandbox-shop.json", import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ShopConfig {
  const secrets = (env.RELAY_SECRETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (secrets.length === 0) throw new Error("缺少 RELAY_SECRETS：填 Relay 后台给这家供给方的 secret");
  const port = Number(env.PORT ?? 8787);
  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    secrets,
    dbPath: env.DB_PATH ?? "./data/sandbox-shop.db",
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    manifestPath: env.MANIFEST_PATH ?? DEFAULT_MANIFEST,
  };
}
