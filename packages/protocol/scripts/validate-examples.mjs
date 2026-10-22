// 校验 examples/manifests 下全部清单：协议有效性 + 平台策略。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { checkPlatformPolicy, validateManifest } from "../dist/index.js";

const root = new URL("../../../examples/manifests/", import.meta.url).pathname;
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".json")) files.push(p);
  }
})(root);

let failed = 0;
for (const p of files) {
  const name = relative(root, p);
  const r = validateManifest(JSON.parse(readFileSync(p, "utf8")));
  if (!r.ok) {
    failed++;
    console.error(`✗ ${name}`);
    for (const e of r.errors) console.error(`    ${e.rule} ${e.path} ${e.message}`);
    continue;
  }
  const policy = checkPlatformPolicy(r.manifest, { allowZeroFee: name === "sandbox-shop.json" });
  const notes = [...r.warnings, ...policy.warnings].map((w) => `${w.rule} ${w.path} ${w.message}`);
  if (policy.errors.length) {
    failed++;
    console.error(`✗ ${name}（平台策略）`);
    for (const e of policy.errors) console.error(`    ${e.rule} ${e.path} ${e.message}`);
  } else {
    console.log(`✓ ${name}${notes.length ? `\n    ${notes.join("\n    ")}` : ""}`);
  }
}
process.exit(failed ? 1 : 0);
