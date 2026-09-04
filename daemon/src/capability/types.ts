/**
 * capability 模块对外类型。字段名严格按 protocol/schemas 的
 * capability-registry / preset / grant-manifest schema(P0 冻结物),
 * 枚举值按 common.schema.json。
 */

// ---------------------------------------------------------------- 枚举(common.schema.json)

export type Scope = 'read' | 'write' | 'admin' | 'ro' | 'rw';
export type RiskLevel = 'low' | 'medium' | 'high';
export type CapKind = 'mcp_server' | 'skill' | 'fs_path' | 'model';
export type Tier = 'fast' | 'standard' | 'heavy';
export type Base = 'any' | 'claude-code' | 'codex' | 'opencode';

// ---------------------------------------------------------------- 注册表

/** 注册表中的一条能力(schema capability;required = id/kind/description/grantable_scopes)。 */
export interface CapabilityEntry {
  readonly id: string;
  readonly kind: CapKind;
  readonly description: string;
  /** 仅 mcp_server 示例给出;其余 kind 可省略(schema README 模糊点 7)。 */
  readonly tools?: readonly string[];
  /** schema 中可选;硬底线判定依赖它,缺失 → unknown_risk(fail-closed)。 */
  readonly risk_level?: RiskLevel;
  readonly grantable_scopes: readonly Scope[];
  /** fs_path 必有(schema if/then)。 */
  readonly path_template?: string;
}

/** 注册表文档本体(schema 顶层)。 */
export interface CapabilityRegistryDoc {
  readonly protocol: '1.0';
  readonly spec_version: string;
  readonly capabilities: readonly CapabilityEntry[];
}

/** 加载并校验后的注册表(带索引查询)。 */
export interface LoadedRegistry {
  readonly protocol: '1.0';
  readonly spec_version: string;
  readonly capabilities: readonly CapabilityEntry[];
  /** 按 id 查询;不存在返回 undefined。 */
  get(id: string): CapabilityEntry | undefined;
}

// ---------------------------------------------------------------- 预设

export interface ModelPreset {
  readonly tier: Tier;
  readonly fallback?: readonly Tier[];
}

export interface BaselineGrantSpec {
  readonly cap: string;
  readonly scope: Scope;
}

export interface IoPort {
  readonly name: string;
  readonly type: string;
}

export interface EscalationPolicy {
  readonly auto_approve: readonly string[];
  readonly require_approval: readonly string[];
}

/** Agent 预设(§3.2,含 v0.2 的 idempotent)。根类型 = 文档类:首层只用
 *  api(§3 总则决议),禁止 protocol/spec_version。 */
export interface Preset {
  readonly api: 'preset/1.0';
  readonly name: string;
  readonly description: string;
  readonly base: Base;
  readonly model?: ModelPreset;
  readonly skills: readonly string[];
  /** 未声明时按 schema default = false。 */
  readonly idempotent: boolean;
  readonly baseline_grants: readonly BaselineGrantSpec[];
  readonly io_contracts: { readonly inputs: readonly IoPort[]; readonly outputs: readonly IoPort[] };
  readonly escalation_policy: EscalationPolicy;
}

// ---------------------------------------------------------------- 授予清单

export type AuditEventKind =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'granted'
  | 'mounted'
  | 'unmounted'
  | 'expired'
  | 'reclaimed';

/** 审计条目(schema auditEntry)。 */
export interface AuditEntry {
  readonly event: AuditEventKind;
  readonly cap: string;
  readonly by: string;
  /** schema 冻结格式 auto_rule:{id} | manual:{principal};P1 baseline 默认
   *  "auto_rule:baseline"(裸 "baseline" 不满足 schema pattern)。 */
  readonly decision_source: string;
  readonly at: string;
  readonly req_id?: string;
}

export interface GrantConstraint {
  readonly fs_scope_narrowed_to?: string;
  readonly secret_ids?: readonly string[];
  /** schema constraint additionalProperties:true(键名开放)。 */
  readonly [key: string]: unknown;
}

/** 单条授予(schema grant)。 */
export interface Grant {
  readonly cap: string;
  readonly scope: Scope;
  readonly source: string;
  readonly ttl: string | null;
  readonly constraint?: GrantConstraint;
}

/** 授予清单(schema grantManifest)。 */
export interface GrantManifest {
  readonly protocol: '1.0';
  readonly spec_version: string;
  readonly agent_id: string;
  readonly grants: readonly Grant[];
  readonly audit: readonly AuditEntry[];
}

/** 挂载意图:P1 只输出意图,不执行挂载(挂载属 Provisioner/sidecar)。 */
export interface MountIntent {
  readonly cap: string;
  readonly scope: Scope;
  readonly kind: CapKind;
  /** kind = fs_path 时为路径模板,否则 null。 */
  readonly pathTemplate: string | null;
  /** kind = mcp_server 且注册表给出 tools 时为工具清单,否则 null。 */
  readonly tools: readonly string[] | null;
}

/** 经注入 sink 发出的审计事件 = 审计条目 + agent 归属。 */
export interface GrantAuditEvent extends AuditEntry {
  readonly agentId: string;
}

/** 最小事件 sink 接口(附录:src/events 模块由另一 Agent 并行实现,
 *  本模块只依赖这个函数形状,不 import 其文件)。 */
export type EventSink = (event: GrantAuditEvent) => void | Promise<void>;

export interface BaselineApplyResult {
  readonly manifest: GrantManifest;
  readonly mountIntents: readonly MountIntent[];
}
