export { runConformance, firstDifference } from "./run.js";
export { formatReport, formatCheck, formatHeader, formatSummary, type FormatOptions } from "./report.js";
export { resolveInput, type SampleInputs, type ResolveContext, type Resolved } from "./inputs.js";
export type { FetchLike } from "./transport.js";
export type {
  Check,
  CheckGroup,
  CheckStatus,
  ConformanceOptions,
  ConformanceReport,
  ConformanceSummary,
} from "./types.js";
