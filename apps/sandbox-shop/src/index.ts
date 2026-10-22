import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { type Manifest, validateManifest } from "@ai-relay/protocol";
import type { ShopConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { createRelayHandler } from "./relay.js";
import { ShopStore } from "./store.js";

export { ACTIONS, type ActionHandler, type ActionContext } from "./actions.js";
export { loadConfig, type ShopConfig } from "./config.js";
export { createRelayHandler, hashInput, type RelayHandlerOptions, type RelayReply } from "./relay.js";
export { createHttpServer } from "./http.js";
export { ShopStore } from "./store.js";

export interface Shop {
  server: Server;
  store: ShopStore;
  manifest: Manifest;
}

/** 读清单、开库、装好路由，不监听端口。 */
export function createShop(config: Omit<ShopConfig, "host" | "port">, now: () => number = Date.now): Shop {
  const manifest = loadManifest(config.manifestPath);
  const store = new ShopStore(config.dbPath, now);
  store.refresh();
  const relay = createRelayHandler({ manifest, store, secrets: config.secrets, publicBaseUrl: config.publicBaseUrl, now });
  const server = createHttpServer({ relay, store, now });
  server.on("close", () => store.close());
  return { server, store, manifest };
}

export function loadManifest(path: string): Manifest {
  const result = validateManifest(JSON.parse(readFileSync(path, "utf8")));
  if (!result.ok) {
    throw new Error(`清单 ${path} 不合法：\n${result.errors.map((e) => `  ${e.path} ${e.message}（${e.rule}）`).join("\n")}`);
  }
  return result.manifest;
}
