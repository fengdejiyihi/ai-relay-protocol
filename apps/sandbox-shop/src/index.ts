import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { type Manifest, validateManifest } from "@dreamcavy/ai-relay-protocol";
import type { ShopConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { createL2, type FetchLike, type L2 } from "./l2/index.js";
import { createRelayHandler } from "./relay.js";
import { ShopStore } from "./store.js";

export { ACTIONS, type ActionHandler, type ActionContext } from "./actions.js";
export { loadConfig, L2_DEFAULTS, type L2ShopConfig, type ShopConfig } from "./config.js";
export { createRelayHandler, hashInput, type RelayHandlerOptions, type RelayReply } from "./relay.js";
export { createHttpServer, type ExtraRoute } from "./http.js";
export { ShopStore } from "./store.js";
export {
  BINDING_CODE_TTL_MS,
  CALLBACK_BACKOFF_SECONDS,
  createL2,
  FAULTS,
  L2_PREFIXES,
  L2Store,
  type Fault,
  type FetchLike,
  type L2,
  type L2Config,
  type L2Settings,
  type SupplierKey,
} from "./l2/index.js";

export interface Shop {
  server: Server;
  store: ShopStore;
  manifest: Manifest;
  /** 配了 L2 secret 时才有。 */
  l2?: L2;
}

export interface ShopOptions {
  /** 回调用的 fetch，测试里可以换掉。 */
  fetch?: FetchLike;
  /** 服务开始监听后自动每隔多久 tick 一次（毫秒）；false 不自动跑，测试里手动 await l2.tick()。默认 500。 */
  tickMs?: number | false;
  log?: (message: string) => void;
}

/** 读清单、开库、装好路由，不监听端口。 */
export function createShop(config: Omit<ShopConfig, "host" | "port">, now: () => number = Date.now, options: ShopOptions = {}): Shop {
  const manifest = loadManifest(config.manifestPath);
  const store = new ShopStore(config.dbPath, now);
  store.refresh();
  const relay = createRelayHandler({ manifest, store, secrets: config.secrets, publicBaseUrl: config.publicBaseUrl, now });

  const l2 = config.l2
    ? createL2(
        {
          secrets: config.l2.secrets,
          manifests: { publisher: loadManifest(config.l2.manifestPaths.publisher), match: loadManifest(config.l2.manifestPaths.match) },
          callbackBase: config.l2.callbackBase,
          publicBaseUrl: config.publicBaseUrl,
          settings: config.l2.settings,
          lateMs: config.l2.lateMs,
        },
        {
          dbPath: config.dbPath,
          now,
          log: options.log ?? ((m) => console.warn(m)),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        },
      )
    : undefined;

  const server = createHttpServer({ relay, store, now, ...(l2 ? { extra: l2.route } : {}) });
  const tickMs = options.tickMs ?? 500;
  if (l2 && tickMs !== false) server.on("listening", () => l2.start(tickMs));
  server.on("close", () => {
    l2?.close();
    store.close();
  });
  return { server, store, manifest, ...(l2 ? { l2 } : {}) };
}

export function loadManifest(path: string): Manifest {
  const result = validateManifest(JSON.parse(readFileSync(path, "utf8")));
  if (!result.ok) {
    throw new Error(`清单 ${path} 不合法：\n${result.errors.map((e) => `  ${e.path} ${e.message}（${e.rule}）`).join("\n")}`);
  }
  return result.manifest;
}
