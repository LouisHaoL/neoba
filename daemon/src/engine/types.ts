/**
 * engine 模块对外类型(§3.5 编排执行 / §9 P1 执行链、P2 WorkflowSpec 引擎)。
 *
 * 分两层:
 * - NodeRuntime:节点内"跑基座"的抽象 —— 引擎不关心容器里跑的是真 CLI 还是
 *   测试桩,只认统一的 RuntimeResult(退出码 + §3.6 统一事件 + 产物);
 * - NodeExecutor / WorkflowEngine:供给 → 基线授予 → 跑 → usage 记账 →
 *   工件发布(CAS 写屏障)→ 销毁;上层按依赖序顺序推进(§3.5a)。
 *
 * 事件全部经注入的 emit 落事件日志(EventLog.append 同构签名),
 * 内存态 = 重放;引擎自身不持持久状态。
 */
import type { EventInput, EventType, NodeFailReason, Principal } from '../events/types.ts';
import type { UnifiedEvent } from '../harness/types.ts';
import type { ArtifactPayload } from '../artifacts/repository.ts';
import type { SandboxHandle } from '../provision/types.ts';
import type { Preset } from '../capability/types.ts';

/** 事件出口(daemon 接 EventLog.append;测试接数组)。 */
export type EngineEmit = <P extends EventType>(
  input: EventInput<P>,
) => Promise<unknown> | unknown;

/**
 * 基线授予审计上下文(与 daemon 侧 ApplyContext 同形:principal 带 task/agent
 * 两层 + cap→scope 队列)。grant 审计 sink 据此决定事件归属与 scope ——
 * task.create 路径经 AsyncLocalStorage 携带,引擎路径由 NodeExecutor 显式给出,
 * 引擎模块不反向依赖 daemon 的 ALS 装配(结构同形,两边各自演进)。
 */
export interface GrantAuditContext {
  readonly principal: Principal;
  /** 同一 cap 可能授多个 scope,sink 事件只带 cap,按 FIFO 弹出。 */
  readonly scopeQueue: Map<string, string[]>;
}

// ---------------------------------------------------------------- NodeRuntime

/** 节点产物(runtime 上报,引擎负责发布进 CAS —— 写屏障在 daemon 侧,§3.7)。 */
export interface RuntimeArtifact {
  /** 与 preset.io_contracts.outputs 的端口名对应。 */
  readonly name: string;
  readonly payload: ArtifactPayload;
}

/** NodeRuntime.run 的入参。 */
export interface NodeRunContext {
  readonly agentId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly preset: Preset;
  /** 指令文本(intent.goal + 上游工件清单)。 */
  readonly instruction: string;
  /** 上游工件引用(已发布进 CAS 的 sha256;内容交付由 runtime/挂载负责)。 */
  readonly inputArtifacts: readonly {
    readonly from: string;
    readonly name: string;
    readonly sha256: string;
  }[];
  readonly handle: SandboxHandle;
  /** 取消信号(pause/cancel/超时都走这里;runtime 应尽快终止)。 */
  readonly signal: AbortSignal;
}

/** runtime 结果:退出码 + 统一事件流 + 产物。 */
export interface RuntimeResult {
  readonly exitCode: number;
  readonly events: readonly UnifiedEvent[];
  readonly artifacts: readonly RuntimeArtifact[];
}

/**
 * 节点内执行抽象:在给定沙箱里把该节点跑到终态。
 * 抛错 = crash(引擎按节点失败处理);取消经 ctx.signal 协作。
 */
export interface NodeRuntime {
  run(ctx: NodeRunContext): Promise<RuntimeResult>;
}

// ---------------------------------------------------------------- 执行结果

export interface PublishedOutput {
  readonly name: string;
  readonly sha256: string;
}

export type NodeExecutionResult =
  | { readonly status: 'completed'; readonly outputs: readonly PublishedOutput[] }
  | {
      readonly status: 'failed';
      readonly reason: NodeFailReason | 'budget_paused' | 'output_missing';
      readonly detail: string | null;
    };

export interface WorkflowOutputRef {
  readonly node: string;
  readonly name: string;
  readonly sha256: string;
}

export type WorkflowRunStatus = 'completed' | 'failed' | 'paused' | 'cancelled';

/** 一次工作流执行的终态(挂起 = paused,经 resume 续跑后产生新终态)。 */
export interface WorkflowRunResult {
  readonly status: WorkflowRunStatus;
  /** failed / paused / cancelled 时的定位信息。 */
  readonly failedNode?: string;
  readonly failReason?: string;
  readonly detail?: string | null;
  /** 工作流级输出(workflow.outputs 声明的节点 → 已发布产物)。 */
  readonly outputs: Readonly<Record<string, readonly WorkflowOutputRef[]>>;
  /** 反馈边实测回打次数(§3.5b 有界反馈审计)。 */
  readonly feedbackTraversals: Readonly<Record<string, number>>;
}
