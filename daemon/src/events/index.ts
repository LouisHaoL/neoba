/**
 * 事件日志模块(§6 状态与恢复:事件溯源 / §3.3 审计日志=事件日志同一份 /
 * §3.6 统一事件 schema 的 daemon 超集)。
 *
 * JSONL 追加写 + fsync;崩溃半行检测与修剪;seq 单调;principal 四层命名空间;
 * 并发 append 串行化;可选按 tenant/session/task 分片;
 * 恢复 = 重放 + 对账(注入 reconciler),TTL 从落盘时间戳重推导。
 * 运行时零第三方依赖,仅用 node 内置模块。
 */
export { EventLog, EVENT_LOG_VERSION, shardByTask } from './log.ts';
export type {
  EventLogOptions,
  ReplayOptions,
  ShardStrategy,
  SkippedRecord,
} from './log.ts';
export {
  EventCorrupt,
  EventLogClosed,
  EventLogError,
  InvalidEvent,
  InvalidPrincipal,
} from './errors.ts';
export { EVENT_TYPES } from './types.ts';
export type {
  ApprovalDecidedPayload,
  ApprovalRequestedPayload,
  ArtifactPublishedPayload,
  BudgetPayload,
  CorrectionPayload,
  DaemonRecoveredPayload,
  DaemonStartedPayload,
  DecisionSource,
  Event,
  EventInput,
  EventPayloadBase,
  EventPayloads,
  EventType,
  GrantGrantedPayload,
  GrantRevokedPayload,
  NodeCompletedPayload,
  NodeFailedPayload,
  NodeStartedPayload,
  NodeFailReason,
  Principal,
  PrincipalFilter,
  SandboxCreatedPayload,
  SandboxDestroyReason,
  SandboxDestroyedPayload,
  SandboxExecedPayload,
  SandboxStartedPayload,
  TtlCarrier,
} from './types.ts';
export {
  collectInFlight,
  findExpired,
  recover,
  recoverFromLog,
  ttlDeadline,
} from './recover.ts';
export type {
  CorrectionSpec,
  InFlightResource,
  ReconcileContext,
  Reconciler,
  ReconcilerResult,
  RecoverOptions,
  RecoverReport,
} from './recover.ts';
