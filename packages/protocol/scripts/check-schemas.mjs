// 用严格模式编译全部协议 Schema，并检查 $id 前缀。CI 的 lint 步骤。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const addFormats = addFormatsModule.default ?? addFormatsModule;
const dir = new URL("../schemas/", import.meta.url).pathname;
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".json")) files.push(p);
  }
})(dir);

const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
addFormats(ajv);
ajv.addKeyword({ keyword: "x-pii", schemaType: "boolean" });
let failed = 0;
const loaded = files.map((p) => ({ p, s: JSON.parse(readFileSync(p, "utf8")) }));
for (const { p, s } of loaded) {
  if (!String(s.$id ?? "").startsWith("https://relay.newbeeai.online/schemas/")) {
    console.error(`✗ ${p}: $id 必须以 https://relay.newbeeai.online/schemas/ 开头`);
    failed++;
  }
  ajv.addSchema(s);
}
for (const { p, s } of loaded) {
  try {
    ajv.compile({ $ref: s.$id });
    for (const def of Object.keys(s.$defs ?? {})) ajv.getSchema(`${s.$id}#/$defs/${def}`);
    console.log(`✓ ${p.slice(dir.length)}`);
  } catch (err) {
    console.error(`✗ ${p}: ${err.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
