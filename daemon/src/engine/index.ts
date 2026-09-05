/**
 * engine 模块出口(§3.5 编排执行引擎;§9 P1 执行链闭环 / P2 WorkflowSpec 引擎)。
 */
export { NodeExecutor, argsDigest, baselineScopeQueue } from './node-executor.ts';
export type { ExecuteNodeParams, NodeExecutorDeps, SecretInjector } from './node-executor.ts';
export type { PoolAcquireResult, PoolReleaseVerdict, SandboxPool } from '../provision/warm-pool.ts';
export { WarmPool } from '../provision/warm-pool.ts';
export type { WarmPoolOptions } from '../provision/warm-pool.ts';
export { WorkflowEngine, topoSort, downstreamOf } from './workflow-engine.ts';
export type { WorkflowEngineDeps, WorkflowRunParams } from './workflow-engine.ts';
export { makeExecRuntime } from './exec-runtime.ts';
export type { ExecRuntimeOptions } from './exec-runtime.ts';
export { EngineGate, GateAborted } from './gate.ts';
export type { GateState } from './gate.ts';
export {
  EngineError,
  PresetUnknown,
  RunDuplicate,
  RunNotPaused,
  RunUnknown,
  WorkflowCycle,
} from './errors.ts';
export type {
  EngineEmit,
  GrantAuditContext,
  NodeRunContext,
  NodeRuntime,
  PublishedOutput,
  RuntimeArtifact,
  RuntimeResult,
  WorkflowOutputRef,
  WorkflowRunResult,
  WorkflowRunStatus,
} from './types.ts';
