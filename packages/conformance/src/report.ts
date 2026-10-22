import type { Check, CheckStatus, ConformanceReport } from "./types.js";

const LABEL: Record<CheckStatus, string> = { pass: "✓ 通过", fail: "✗ 失败", warn: "! 警告", skip: "- 未测" };

export interface FormatOptions {
  /** 用 ANSI 颜色。默认 false。 */
  color?: boolean;
}

/** 一行检查结果（命令行边跑边打印用）。 */
export function formatCheck(check: Check, options: FormatOptions = {}): string {
  const label = paint(LABEL[check.status], check.status, options.color);
  const ms = check.ms === undefined ? "" : `  ${check.ms}ms`;
  const lines = [`${label}  ${check.title}${ms}`];
  if (check.detail) lines.push(`         ${check.detail}`);
  for (const issue of check.issues ?? []) lines.push(`         · ${issue.path} ${issue.message}${issue.rule === "schema" ? "" : `（${issue.rule}）`}`);
  return lines.join("\n");
}

/** 整份报告的终端文本：按检查顺序逐行列出，最后一行汇总。 */
export function formatReport(report: ConformanceReport, options: FormatOptions = {}): string {
  return [formatHeader(report), "", ...report.checks.map((c) => formatCheck(c, options)), "", formatSummary(report, options)].join("\n");
}

export function formatHeader(report: Pick<ConformanceReport, "tool" | "rsp" | "endpoint">): string {
  return `${report.tool.name} ${report.tool.version} · RSP ${report.rsp} · ${report.endpoint}`;
}

export function formatSummary(report: ConformanceReport, options: FormatOptions = {}): string {
  const { pass, fail, warn, skip } = report.summary;
  const verdict = report.ok
    ? paint("验收通过", "pass", options.color)
    : paint("验收未通过", "fail", options.color);
  return `${verdict}：${pass} 通过，${fail} 失败，${warn} 警告，${skip} 未测（${(report.durationMs / 1000).toFixed(1)} 秒）`;
}

function paint(text: string, status: CheckStatus, color = false): string {
  if (!color) return text;
  const code = { pass: 32, fail: 31, warn: 33, skip: 90 }[status];
  return `\u001b[${code}m${text}\u001b[0m`;
}
