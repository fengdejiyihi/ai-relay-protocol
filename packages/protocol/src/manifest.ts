import { PLATFORM_POLICY } from "./constants.js";
import { actionAjv, type Issue, toIssues, validatorFor } from "./ajv.js";
import { SCHEMA_IDS } from "./schemas.js";
import type { AmountSpec, Confirm, Manifest, ManifestAction, Risk } from "./types.js";

export type ManifestResult =
  | { ok: true; manifest: Manifest; errors: []; warnings: Issue[] }
  | { ok: false; errors: Issue[]; warnings: Issue[] };

/**
 * 校验一份 Manifest：先 JSON Schema，再协议语义规则（RSP 1.0 第 4 节）。
 * 只要有 error 就不能激活；warning 不阻塞，但会在后台和 Conformance 报告里显示。
 */
export function validateManifest(input: unknown): ManifestResult {
  const validate = validatorFor(SCHEMA_IDS.manifest);
  if (!validate(input)) return { ok: false, errors: toIssues(validate.errors), warnings: [] };
  const manifest = input as Manifest;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const seen = new Set<string>();

  const { supplier } = manifest;
  if (supplier.user_binding !== "none" && !supplier.binding) {
    errors.push({ path: "/supplier/binding", rule: "M-BIND-1", message: "user_binding 为 token 或 oauth 时必须提供 binding.help_url" });
  }

  manifest.actions.forEach((action, i) => {
    const at = `/actions/${i}`;
    if (seen.has(action.name)) errors.push({ path: `${at}/name`, rule: "M-NAME-1", message: `动作名重复：${action.name}` });
    seen.add(action.name);

    if (action.risk === "low" && !(action.readonly === true && action.billing === "none")) {
      errors.push({ path: `${at}/risk`, rule: "M-RISK-1", message: "risk=low 只允许 readonly: true 且 billing=none 的动作" });
    }
    if (action.billing === "none" && action.fee !== 0) {
      errors.push({ path: `${at}/fee`, rule: "M-FEE-1", message: "billing=none 时 fee 必须为 0" });
    }
    if (action.billing === "on_accept" && action.mode === "sync") {
      errors.push({ path: `${at}/billing`, rule: "M-BILL-1", message: "on_accept 只适用于异步动作；同步动作用 on_complete" });
    }
    if (action.readonly === true && action.billing !== "none") {
      warnings.push({ path: `${at}/readonly`, rule: "M-BILL-2", message: "只读动作通常不应计费" });
    }
    if (action.mode === "sync" && action.timeout_seconds !== undefined) {
      warnings.push({ path: `${at}/timeout_seconds`, rule: "M-MODE-1", message: "同步动作由 20 秒总预算控制，timeout_seconds 会被忽略" });
    }

    const props = propertiesOf(action.input);
    if (typeof action.amount === "object") {
      const field = action.amount.from.slice("input.".length);
      const prop = Object.hasOwn(props, field) ? props[field] : undefined;
      if (!prop) {
        errors.push({ path: `${at}/amount`, rule: "M-AMT-1", message: `amount 指向的输入字段不存在：${field}` });
      } else if (!isIntegerField(action.input, prop)) {
        errors.push({
          path: `${at}/amount`,
          rule: "M-AMT-2",
          message: `amount 指向的字段 ${field} 必须写明 type: "integer"（单位：分），可直接写或经本地 $ref 指到写了它的定义；allOf、const 等组合写法不认`,
        });
      } else if (!(action.input.required as string[] | undefined)?.includes(field)) {
        errors.push({ path: `${at}/amount`, rule: "M-AMT-3", message: `amount 指向的字段 ${field} 必须列在 input 根的 required 里` });
      }
    }
    for (const [j, f] of (action.display_fields ?? []).entries()) {
      if (!Object.hasOwn(props, f)) errors.push({ path: `${at}/display_fields/${j}`, rule: "M-DISP-1", message: `display_fields 引用了不存在的输入字段：${f}` });
    }

    for (const key of ["input", "output"] as const) {
      const schema = action[key];
      if (!schema) continue;
      try {
        actionAjv().compile(schema);
      } catch (err) {
        errors.push({ path: `${at}/${key}`, rule: "M-SCHEMA-1", message: `不是合法的 JSON Schema 2020-12：${(err as Error).message}` });
      }
    }
  });

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, manifest, errors: [], warnings };
}

export interface PolicyOptions {
  /** Relay 自营的沙箱等供给方允许 fee=0 的收费动作。 */
  allowZeroFee?: boolean;
}

/**
 * 平台审核策略。不影响协议有效性，管理员审核时作为参考，
 * errors 表示按当前策略不予通过。
 */
export function checkPlatformPolicy(manifest: Manifest, options: PolicyOptions = {}): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (manifest.supplier.user_binding === "oauth") {
    errors.push({ path: "/supplier/user_binding", rule: "P-BIND-1", message: "V1 暂不支持 oauth 绑定（后续版本支持），请先用 token" });
  }
  manifest.actions.forEach((action, i) => {
    const at = `/actions/${i}/fee`;
    if (action.billing === "none") return;
    if (action.fee === 0) {
      if (!options.allowZeroFee) warnings.push({ path: at, rule: "P-FEE-0", message: "收费动作 fee=0，账本会记 0 元流水" });
      return;
    }
    if (action.fee < PLATFORM_POLICY.feeMinCents || action.fee > PLATFORM_POLICY.feeMaxCents) {
      errors.push({ path: at, rule: "P-FEE-1", message: `fee 超出平台定价范围 ¥${PLATFORM_POLICY.feeMinCents / 100}–¥${PLATFORM_POLICY.feeMaxCents / 100}` });
    }
  });
  return { errors, warnings };
}

const CONFIRM_ORDER: Record<Confirm, number> = { never: 0, by_grant: 1, always: 2 };
const RISK_FLOOR: Record<Risk, Confirm> = { low: "never", medium: "by_grant", high: "always" };

/** 实际确认强度 = 风险等级对应的下限与产品自报 confirm 取更严者（2.2）。 */
export function effectiveConfirm(risk: Risk, confirm: Confirm): Confirm {
  const floor = RISK_FLOOR[risk];
  return CONFIRM_ORDER[confirm] >= CONFIRM_ORDER[floor] ? confirm : floor;
}

/** 风险只能上调（risk_override）。 */
export function effectiveRisk(risk: Risk, override?: Risk | null): Risk {
  const order: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
  return override && order[override] > order[risk] ? override : risk;
}

/**
 * 按 amount 规则算出这笔交易的用户金额（分）。none 返回 null；
 * 取自输入字段但输入不合法时抛错，调用方应先用动作 input Schema 校验输入。
 */
export function resolveAmount(spec: AmountSpec, input: Record<string, unknown>): number | null {
  if (spec === "none") return null;
  if (typeof spec === "number") return spec;
  const field = spec.from.slice("input.".length);
  const value = Object.hasOwn(input, field) ? input[field] : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`amount 字段 ${field} 不是非负整数`);
  }
  return value;
}

/** 列出动作输入里标了 x-pii 的顶层字段。 */
export function piiFields(action: Pick<ManifestAction, "input">): string[] {
  return Object.entries(propertiesOf(action.input))
    .filter(([, prop]) => prop["x-pii"] === true)
    .map(([name]) => name);
}

/**
 * amount 字段的类型判定（M-AMT-2）。接受的写法：字段上直接写 type: "integer"，或用本地 $ref（"#/..."）
 * 指到写了 type: "integer" 的定义（可多层）。allOf、const 等组合不做推导，规范第 4.4 节写明了这一点。
 */
function isIntegerField(root: Record<string, unknown>, node: unknown): boolean {
  let current = node;
  for (let hops = 0; hops < 8; hops++) {
    if (!current || typeof current !== "object") return false;
    const schema = current as Record<string, unknown>;
    if (schema.type === "integer") return true;
    if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return false;
    current = resolvePointer(root, schema.$ref.slice(1));
  }
  return false;
}

function resolvePointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const raw of pointer.split("/").slice(1)) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function propertiesOf(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const props = schema.properties;
  return props && typeof props === "object" ? (props as Record<string, Record<string, unknown>>) : {};
}
