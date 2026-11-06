import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import * as addFormatsModule from "ajv-formats";
import { schemas } from "./schemas.js";

type AddFormats = (ajv: Ajv2020) => Ajv2020;
const addFormats: AddFormats =
  ((addFormatsModule as unknown as { default?: unknown }).default as { default?: AddFormats })?.default ??
  ((addFormatsModule as unknown as { default?: AddFormats }).default as AddFormats);

/** 产品在 Schema 里可用的扩展关键字。x-pii：该字段是个人信息，日志与后台列表脱敏。 */
export const VENDOR_KEYWORDS = ["x-pii"] as const;

export type SchemaFlavor = "strict" | "tolerant";

/**
 * 供给方视角的宽松版（RSP 1.0 第 14 节）：去掉所有 additionalProperties/unevaluatedProperties: false，
 * rsp 接受任何 1.x。Relay 在 1.x 内给信封加字段或升小版本时，已接入的供给方不受影响。
 */
function tolerant(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tolerant);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if ((key === "additionalProperties" || key === "unevaluatedProperties") && value === false) continue;
    out[key] = tolerant(value);
  }
  return out;
}

function sourceSchemas(flavor: SchemaFlavor): Record<string, unknown>[] {
  if (flavor === "strict") return Object.values(schemas);
  return Object.entries(schemas).map(([name, schema]) => {
    const copy = tolerant(schema) as Record<string, unknown>;
    if (name === "common") {
      (copy.$defs as Record<string, unknown>).rsp_version = { type: "string", pattern: "^1\\.\\d+$" };
    }
    return copy;
  });
}

function createAjv(flavor: SchemaFlavor): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  for (const keyword of VENDOR_KEYWORDS) ajv.addKeyword({ keyword, schemaType: "boolean" });
  for (const schema of sourceSchemas(flavor)) ajv.addSchema(schema);
  return ajv;
}

const shared = new Map<SchemaFlavor, Ajv2020>();
export function protocolAjv(flavor: SchemaFlavor = "strict"): Ajv2020 {
  let ajv = shared.get(flavor);
  if (!ajv) {
    ajv = createAjv(flavor);
    shared.set(flavor, ajv);
  }
  return ajv;
}

/** 供给方动作 Schema 用独立实例编译，避免与协议 Schema 的 $id 冲突。 */
export function actionAjv(options: { validateSchema?: boolean } = {}): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true, ...options });
  addFormats(ajv);
  for (const keyword of VENDOR_KEYWORDS) ajv.addKeyword({ keyword, schemaType: "boolean" });
  return ajv;
}

const META_2020 = "https://json-schema.org/draft/2020-12/schema";
/** 只用来按 2020-12 元 Schema 检查动作 Schema，不往里加任何 Schema。 */
let metaChecker: Ajv2020 | undefined;

/**
 * 编译一个供给方动作 Schema。每个 Schema 仍在自己的新实例里编译（不同动作的 $id 互不影响），按元 Schema 的检查放到一个
 * 共用实例上做：新实例第一次检查都要先编译 2020-12 元 Schema（约 10 ms），一份 100 个动作的清单有 200 个 Schema，
 * 光这一步就 2 秒多，校验期间事件循环被占住。检查本身和 Ajv 编译时自己做的一样（同一个方法，报错文字也一样）。
 * `$schema` 写成 2020-12 带不带末尾 `#` 都算（两种写法 Ajv 解析到同一个元 Schema，OpenAPI 转来的常带 `#`）。
 * 写了别的 $schema 的（可能指向这份 Schema 里自己定义的 $id）照旧在新实例里连同检查一起编译。
 */
export function compileActionSchema(schema: Record<string, unknown>): ValidateFunction {
  if (schema.$schema !== undefined && schema.$schema !== META_2020 && schema.$schema !== `${META_2020}#`) return actionAjv().compile(schema);
  (metaChecker ??= actionAjv()).validateSchema(schema, true);
  return actionAjv({ validateSchema: false }).compile(schema);
}

const cache = new Map<string, ValidateFunction>();
export function validatorFor(ref: string, flavor: SchemaFlavor = "strict"): ValidateFunction {
  const key = `${flavor} ${ref}`;
  let fn = cache.get(key);
  if (!fn) {
    const found = protocolAjv(flavor).getSchema(ref);
    if (!found) throw new Error(`schema not found: ${ref}`);
    fn = found;
    cache.set(key, fn);
  }
  return fn;
}

export interface Issue {
  /** JSON Pointer，指向出错的位置。 */
  path: string;
  message: string;
  /** 语义规则编号，Schema 层错误为 "schema"。 */
  rule: string;
}

export function toIssues(errors: ErrorObject[] | null | undefined): Issue[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath || "/",
    message: `${e.message ?? "invalid"}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ""}`,
    rule: "schema",
  }));
}
