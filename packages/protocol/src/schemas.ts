// 静态 JSON import：任何打包器（Turbopack、webpack、esbuild）都能把 Schema 一起打包，不依赖运行时读文件。
import common from "../schemas/common.json" with { type: "json" };
import manifest from "../schemas/manifest.json" with { type: "json" };
import downstream from "../schemas/downstream.json" with { type: "json" };
import responses from "../schemas/responses.json" with { type: "json" };
import upstream from "../schemas/upstream.json" with { type: "json" };
import mcpTools from "../schemas/mcp/tools.json" with { type: "json" };
import mcpResults from "../schemas/mcp/results.json" with { type: "json" };

export const SCHEMA_BASE = "https://relay.newbeeai.online/schemas" as const;

type JsonSchema = Record<string, unknown>;

export const schemas: Readonly<Record<"common" | "manifest" | "downstream" | "responses" | "upstream" | "mcpTools" | "mcpResults", JsonSchema>> = {
  common,
  manifest,
  downstream,
  responses,
  upstream,
  mcpTools,
  mcpResults,
};
export const SCHEMA_IDS = {
  common: `${SCHEMA_BASE}/rsp/1.0/common.json`,
  manifest: `${SCHEMA_BASE}/rsp/1.0/manifest.json`,
  downstream: `${SCHEMA_BASE}/rsp/1.0/downstream.json`,
  responses: `${SCHEMA_BASE}/rsp/1.0/responses.json`,
  upstream: `${SCHEMA_BASE}/rsp/1.0/upstream.json`,
  mcpTools: `${SCHEMA_BASE}/mcp/1.0/tools.json`,
  mcpResults: `${SCHEMA_BASE}/mcp/1.0/results.json`,
} as const;
