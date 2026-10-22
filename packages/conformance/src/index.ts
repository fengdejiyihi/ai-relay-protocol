export { runConformance } from "./run.js";
export { firstDifference } from "./diff.js";
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
export { DEFAULT_ASYNC_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS } from "./run.js";
export {
  judgeCallback,
  newTestOrder,
  isTerminalStatus,
  CALLBACK_PROBLEMS,
  type CallbackRequest,
  type CallbackReply,
  type CallbackVerdict,
  type ReceivedCallback,
  type TestOrder,
  type TestOrderStatus,
  type TestProposal,
} from "./callbacks.js";
export { memoryStore, receiveCallback, startCallbackReceiver, type CallbackStore, type CallbackReceiver, type ReceiverOptions } from "./receiver.js";
