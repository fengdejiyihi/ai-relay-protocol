import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DOWNSTREAM_TYPES,
  ERROR_CODES,
  RELAY_ERROR_CODES,
  RESPONSE_STATUSES_BY_TYPE,
  schemas,
  UPSTREAM_TYPES,
  type DownstreamType,
  type Manifest,
  type UpstreamType,
} from "../src/index.js";
import { example } from "./helpers.js";

describe("常量与 Schema 一致", () => {
  const defs = (s: Record<string, unknown>) => Object.keys((s.$defs as Record<string, unknown>) ?? {});

  it("下行信封类型", () => {
    expect(defs(schemas.downstream).filter((k) => k !== "base").sort()).toEqual([...DOWNSTREAM_TYPES].sort());
    expect(Object.keys(RESPONSE_STATUSES_BY_TYPE).sort()).toEqual([...DOWNSTREAM_TYPES].sort());
  });

  it("上行事件类型", () => {
    expect(defs(schemas.upstream).filter((k) => k !== "base").sort()).toEqual([...UPSTREAM_TYPES].sort());
  });

  it("错误码", () => {
    const common = schemas.common.$defs as Record<string, { enum: string[] }>;
    expect(common.error_code?.enum).toEqual([...ERROR_CODES]);
    const mcp = schemas.mcpResults.$defs as Record<string, { enum: string[] }>;
    expect(mcp.relay_error_code?.enum).toEqual([...RELAY_ERROR_CODES]);
    expect(RELAY_ERROR_CODES.filter((c) => (ERROR_CODES as readonly string[]).includes(c))).toEqual([]);
  });

  it("响应 status 都有对应 Schema", () => {
    const names = defs(schemas.responses);
    for (const statuses of Object.values(RESPONSE_STATUSES_BY_TYPE)) {
      for (const s of statuses) expect(names).toContain(s === "ok" ? "ping" : s);
    }
  });
});

describe("类型", () => {
  it("示例清单满足 Manifest 类型", () => {
    const m: Manifest = example("sandbox-shop.json") as Manifest;
    expectTypeOf(m.actions[0]!.risk).toEqualTypeOf<"low" | "medium" | "high">();
    expectTypeOf<DownstreamType>().toEqualTypeOf<(typeof DOWNSTREAM_TYPES)[number]>();
    expectTypeOf<UpstreamType>().toEqualTypeOf<(typeof UPSTREAM_TYPES)[number]>();
  });
});
