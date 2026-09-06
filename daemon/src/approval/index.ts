/**
 * approval 模块出口(§3.3 能力升级审批流)。
 */
export { ApprovalBoard, ApprovalError, RequestDuplicate, RequestUnknown, durationMs } from './board.ts';
export type { ApprovalBoardOptions, ApprovalReplayReport } from './board.ts';
export { BUILTIN_LAYER, evaluateRequest, policyStack } from './policy.ts';
export type { EscalationPolicyLike } from './policy.ts';
export type {
  ApprovalEventInput,
  ApprovalRecord,
  ApprovalStatus,
  DecideResult,
  EscalationPolicy,
  PolicyLayer,
  PolicyOutcome,
  SubmitResult,
  ToolRequestSpec,
} from './types.ts';
export { presetPolicyLayer } from './types.ts';
