/**
 * approval 模块对外类型(§3.3 能力升级审批流)。
 */

import type { Grant, GrantManifest, LoadedRegistry, Preset, Scope } from '../capability/index.ts';

/** 策略层内容(与 preset.escalation_policy 同构)。 */
export interface EscalationPolicy {
  readonly auto_approve: readonly string[];
  readonly require_approval: readonly string[];
}

/**
 * 策略层(带稳定 id,作 decision_source 的 auto_rule:{id} 来源)。
 * 合并语义(§3.3 分层):从高到低逐层看,先查 require_approval 再查
 * auto_approve,首层命中即定;全不命中 → require(从严缺省)。
 * 协议硬底线在此之前:high+write/admin(及 risk 缺失 fail-closed)
 * 一律 require,任何层级不可豁免。
 */
export interface PolicyLayer {
  /** 稳定标识,如 "builtin:default" / "global" / "preset:e2e-tester" / "session:<name>"。 */
  readonly id: string;
  readonly policy: EscalationPolicy;
}

/** 评估结论。 */
export type PolicyOutcome = 'auto' | 'require';

/** 升级申请(§3.3 tool.request 的协议内语义字段;信封字段由消息层承载)。 */
export interface ToolRequestSpec {
  /** 申请人 agent 实例 id(<task>/<实例名>)。 */
  readonly from: string;
  readonly reqId: string;
  readonly cap: string;
  readonly reason: string;
  readonly scope: Scope;
  /** 相对时长 ^\d+[smhd]$(授权到期即回收)。 */
  readonly duration: string;
}

/** 审批单状态。 */
export type ApprovalStatus = 'pending' | 'granted' | 'denied';

/** 审批单(内存台账;审计事实以事件日志为准)。 */
export interface ApprovalRecord {
  readonly reqId: string;
  readonly agentId: string;
  readonly cap: string;
  readonly scope: Scope;
  readonly reason: string;
  /** 授权时长(到期时刻由 submit 时的 now + duration 推得)。 */
  readonly duration: string;
  readonly status: ApprovalStatus;
  /** 提交时刻(ISO 8601)。 */
  readonly submittedAt: string;
  /** 定案时刻;pending 为 null。 */
  readonly decidedAt: string | null;
  /** 定案人;pending 为 null。 */
  readonly decidedBy: string | null;
  /** 定案时的 decision_source;pending 为 null。 */
  readonly decisionSource: string | null;
  /** 授权可窄于申请(申请 fs:rw 只授 workdir 子目录)。 */
  readonly narrowedTo: string | null;
}

/** submit 的三态结果。 */
export type SubmitResult =
  | { readonly status: 'auto_granted'; readonly record: ApprovalRecord; readonly manifest: GrantManifest }
  | { readonly status: 'pending'; readonly record: ApprovalRecord }
  | { readonly status: 'auto_denied'; readonly record: ApprovalRecord };

/** decide 结果。 */
export type DecideResult =
  | { readonly status: 'granted'; readonly record: ApprovalRecord; readonly manifest: GrantManifest }
  | { readonly status: 'denied'; readonly record: ApprovalRecord };

/** 审批事件(经注入的 emit 落入事件日志,daemon 接线处同一份审计)。 */
export interface ApprovalEventInput {
  readonly type: 'approval.requested' | 'approval.decided';
  readonly agentId: string;
  readonly payload:
    | {
        readonly reqId: string;
        readonly cap: string;
        readonly scope: string;
        readonly reason: string;
      }
    | {
        readonly reqId: string;
        readonly decision: 'granted' | 'denied';
        readonly decisionSource: string;
        readonly narrowedTo?: string;
      };
}

// ---------------------------------------------------------------- 组装辅助

/** 从预设抽策略层(id 约定 preset:<name>,与 decision_source 审计对齐)。 */
export function presetPolicyLayer(name: string, preset: Preset): PolicyLayer {
  return { id: `preset:${name}`, policy: preset.escalation_policy };
}

// ---------------------------------------------------------------- 重导出的最小依赖形状(避免模块环)

export type { Grant, GrantManifest, LoadedRegistry, Scope };
