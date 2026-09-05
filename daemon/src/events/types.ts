/**
 * 事件日志的对外类型(§6 状态与恢复:事件溯源;§3.6 统一事件 schema 的 daemon 超集;
 * §3.3 审计日志 = 事件日志同一份)。
 *
 * 与 protocol/schemas/runtime-api.schema.json 的关系:那边是容器侧(sidecar SSE)
 * 的五种统一事件(tool_call / message_delta / artifact_ready / usage / error),
 * 这边是 daemon 自身的事件溯源日志 —— 同一套 ts / agent / sha256 格式约定,
 * 事件类别是超集:容器生命周期、授权、工件、编排、基座运行事件
 * (§3.6 归一的 tool_inventory / usage)、预算、审批、correction、daemon。
 *
 * principal 四层命名空间(§2/§10.4):tenant → session → task → agent,
 * 按层级可空(daemon 级事件只有 tenant;task 级事件无 agent)。
 */

/** 四层 principal。tenant 恒非空(单人部署 "default");其余按层级可空。 */
export interface Principal {
  readonly tenant: string;
  readonly session: string | null;
  readonly task: string | null;
  readonly agent: string | null;
}

/** readByPrincipal 的过滤条件:出现的字段必须精确相等(含 null 匹配)。 */
export interface PrincipalFilter {
  readonly tenant?: string;
  readonly session?: string | null;
  readonly task?: string | null;
  readonly agent?: string | null;
  /** 可选:按事件类型过滤。 */
  readonly types?: readonly EventType[];
}

/**
 * 事件类型闭集(本期定义;字符串字面量联合,不用 enum)。
 * 运行时数组与类型同源,新增类型只改这一处。
 * 预留扩展:payload 一律带 `extra?: Record<string, unknown>` 字段位,
 * 重放对未知 type 宽容(忽略校验、原样透传),前向兼容。
 */
export const EVENT_TYPES = [
  // 容器生命周期(§5 SandboxProvider)
  'sandbox.created',
  'sandbox.started',
  'sandbox.execed',
  'sandbox.destroyed',
  // 资源池排队(§6 v0.2:并发容器数由 Provisioner 确定性排队,P3 落地)
  'sandbox.queued',
  'sandbox.acquired',
  'sandbox.released',
  // 授权(§3.3,审计 = 事件日志同一份)
  'grant.granted',
  'grant.revoked',
  // 工件(§3.7,发布 = 写屏障完成)
  'artifact.published',
  // 工件自动 GC(M5,daemon 侧行为:plan/collect 分离,见 artifacts/gc.ts)
  'artifact.gc',
  // 编排(§3.5,本期只定义结构,引擎未实现)
  'node.started',
  'node.completed',
  'node.failed',
  // 基座运行事件(§3.6 归一事件入账;§6 审计日志 = 事件日志同一份)
  'tool_inventory',
  'usage',
  // 预算(§3.5f,占位:P2 落地)
  'budget.warning',
  'budget.exceeded',
  // 审批(§3.3,占位:P2 落地;decision_source 全量审计)
  'approval.requested',
  'approval.decided',
  // 恢复对账(§6:重放后与实态不一致时记 correction)
  'correction',
  // daemon 自身生命周期
  'daemon.started',
  'daemon.recovered',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** 所有 payload 的公共扩展字段位(协议兼容规则:接收方忽略未知字段,§3.0)。 */
export interface EventPayloadBase {
  /** 预留扩展字段位:未进本期闭集的附加信息。 */
  readonly extra?: Record<string, unknown>;
}

/** 携带 TTL 语义的 payload(grant / sandbox):绝对到期时间或相对时长二选一。 */
export interface TtlCarrier extends EventPayloadBase {
  /** 绝对到期时间(ISO 8601),如 grant manifest 的 ttl。 */
  readonly ttl?: string | null;
  /** 相对时长,格式 ^\d+[smhd]$(如 "2h");恢复时从落盘时间戳(ts)重推导。 */
  readonly duration?: string | null;
}

// ---------------------------------------------------------------- 容器生命周期

export interface SandboxCreatedPayload extends TtlCarrier {
  readonly sandboxId: string;
  readonly image?: string;
  readonly backend?: string;
  /** 基座(claude-code / codex / opencode / …)。 */
  readonly base?: string;
}

export interface SandboxStartedPayload extends EventPayloadBase {
  readonly sandboxId: string;
  /** supervisor sidecar 暴露的 Runtime API 地址(§3.6),对账时查 /status 用。 */
  readonly endpoint?: string;
}

export interface SandboxExecedPayload extends EventPayloadBase {
  readonly sandboxId: string;
  /** 参数摘要(事件流不回传全量参数;凭据值强制脱敏,§3.8)。 */
  readonly argsDigest: string;
}

export type SandboxDestroyReason =
  | 'completed'
  | 'failed'
  | 'ttl_expired'
  | 'reconciled'
  | 'manual';

export interface SandboxDestroyedPayload extends EventPayloadBase {
  readonly sandboxId: string;
  readonly reason: SandboxDestroyReason;
}

// ---------------------------------------------------------------- 资源池排队(§6)

/** 资源槽事件(§6):排队/占用/释放,acquire 与 release 按 key 成对出现。 */
export interface SandboxQueuedPayload extends EventPayloadBase {
  readonly key: string;
  /** 入队后的等待队列长度。 */
  readonly waiting: number;
  readonly limit: number | null;
}

export interface SandboxAcquiredPayload extends EventPayloadBase {
  readonly key: string;
  /** 获得槽位后的占用数。 */
  readonly inUse: number;
  readonly limit: number | null;
}

export interface SandboxReleasedPayload extends EventPayloadBase {
  readonly key: string;
  /** 释放后的占用数。 */
  readonly inUse: number;
  readonly limit: number | null;
}

// ---------------------------------------------------------------- 授权(§3.3)

export type DecisionSource = string; // 'auto_rule:{id}' | 'manual:{principal}'

export interface GrantGrantedPayload extends TtlCarrier {
  readonly cap: string;
  readonly scope: string;
  /** 'baseline' | 'escalation:{reqId}'。 */
  readonly source: string;
  /** decision_source 审计:自动放行同样全量入账(§3.3)。 */
  readonly decisionSource: DecisionSource;
}

export interface GrantRevokedPayload extends EventPayloadBase {
  readonly cap: string;
  readonly reason: string;
  readonly decisionSource?: DecisionSource;
  /** 对应 grant.granted 事件的 seq(可回链审计)。 */
  readonly grantedSeq?: number;
}

// ---------------------------------------------------------------- 工件(§3.7)

export interface ArtifactPublishedPayload extends EventPayloadBase {
  readonly node: string;
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
  readonly kind: 'file' | 'tree';
}

/**
 * 工件自动 GC 一轮执行的 plan 摘要(M5)。对象删除只清孤儿;
 * manifest 删除仅限 retention days 到期且任务终态(artifacts/gc.ts)。
 */
export interface ArtifactGcPayload extends EventPayloadBase {
  /** 扫描到的 manifest 指针数(损坏指针不计)。 */
  readonly scanned: number;
  /** 扫描到的在盘 CAS 对象数。 */
  readonly scannedObjects: number;
  /** in-use 对象数(全部指针可达集)。 */
  readonly inUseObjects: number;
  /** 孤儿对象数(本轮将被清扫)。 */
  readonly orphaned: number;
  /** 实际删除的 manifest 数(retention 到期且任务终态)。 */
  readonly removedManifests: number;
  /** 实际删除的孤儿对象数。 */
  readonly removedObjects: number;
  /** 本轮判定到期的 manifest id('{tenant}/{task}/{node}/{name}')。 */
  readonly expiredManifests?: readonly string[];
}

// ---------------------------------------------------------------- 编排(§3.5)

export interface NodeStartedPayload extends EventPayloadBase {
  readonly nodeId: string;
  readonly attempt: number;
}

export interface NodeCompletedPayload extends EventPayloadBase {
  readonly nodeId: string;
  readonly attempt: number;
  readonly outputs: readonly { readonly name: string; readonly sha256: string }[];
}

export type NodeFailReason = 'crash' | 'timeout' | 'feedback_limit' | string;

export interface NodeFailedPayload extends EventPayloadBase {
  readonly nodeId: string;
  readonly attempt: number;
  readonly reason: NodeFailReason;
  readonly detail?: string;
}

// ---------------------------------------------------------------- 基座运行事件(§3.6)

/**
 * §3.6 tool_inventory 归一事件落账(§6:审计日志 = 事件日志同一份)。
 * nodeId/attempt 是 daemon 侧节点上下文(与 node.* 事件同形);
 * 清单本体是 harness adapter 归一后的权威清单(§3.6 唯一事实源),
 * 字段按 daemon payload 惯例转写为 camelCase。
 */
export interface ToolInventoryPayload extends EventPayloadBase {
  readonly nodeId: string;
  readonly attempt: number;
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly permissionMode: string | null;
  readonly model: string | null;
  readonly sessionId: string | null;
}

/**
 * §3.6 usage 归一事件落账:用量事实恒入事件日志(审计),预算台账
 * (§3.5f)是独立的消费方 —— 无 budget 配置时只跳过记账,不丢事实。
 */
export interface UsagePayload extends EventPayloadBase {
  readonly nodeId: string;
  readonly attempt: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** 订阅制基座(无计费信息)为 null,与 §3.6 统一事件同语义。 */
  readonly costEstimate: number | null;
}

// ---------------------------------------------------------------- 预算(§3.5f 占位)

export interface BudgetPayload extends EventPayloadBase {
  readonly level: 'soft' | 'hard';
  readonly limitTokens: number;
  readonly observedTokens: number;
  /** hard limit 触发的动作:pause 节点 + 升级主控(续预算或终止)。 */
  readonly action?: 'paused' | 'terminated';
}

// ---------------------------------------------------------------- 审批(§3.3 占位)

export interface ApprovalRequestedPayload extends EventPayloadBase {
  readonly reqId: string;
  readonly cap: string;
  readonly scope: string;
  readonly reason: string;
}

export interface ApprovalDecidedPayload extends EventPayloadBase {
  readonly reqId: string;
  readonly decision: 'granted' | 'denied';
  readonly decisionSource: DecisionSource;
  /** 授权可窄于申请:申请 fs:rw 只授 workdir 子目录。 */
  readonly narrowedTo?: string;
}

// ---------------------------------------------------------------- 恢复对账(§6)

export interface CorrectionPayload extends EventPayloadBase {
  /** 被对账的 in-flight 事件 seq。 */
  readonly refSeq: number;
  /** 对账目标标识,如 'sandbox:<id>' / 'grant:<cap>@<agent>' / 'node:<id>'。 */
  readonly target: string;
  readonly reason: string;
  readonly expected?: unknown;
  readonly observed?: unknown;
  readonly detail?: string;
}

// ---------------------------------------------------------------- daemon 自身

export interface DaemonStartedPayload extends EventPayloadBase {
  readonly pid: number;
  readonly version?: string;
}

export interface DaemonRecoveredPayload extends EventPayloadBase {
  readonly replayed: number;
  readonly inFlight: number;
  readonly corrected: number;
  readonly expired: number;
}

/** 事件 payload 按 type 的映射(闭集)。 */
export interface EventPayloads {
  'sandbox.created': SandboxCreatedPayload;
  'sandbox.started': SandboxStartedPayload;
  'sandbox.execed': SandboxExecedPayload;
  'sandbox.destroyed': SandboxDestroyedPayload;
  'sandbox.queued': SandboxQueuedPayload;
  'sandbox.acquired': SandboxAcquiredPayload;
  'sandbox.released': SandboxReleasedPayload;
  'grant.granted': GrantGrantedPayload;
  'grant.revoked': GrantRevokedPayload;
  'artifact.published': ArtifactPublishedPayload;
  'artifact.gc': ArtifactGcPayload;
  'node.started': NodeStartedPayload;
  'node.completed': NodeCompletedPayload;
  'node.failed': NodeFailedPayload;
  'tool_inventory': ToolInventoryPayload;
  usage: UsagePayload;
  'budget.warning': BudgetPayload;
  'budget.exceeded': BudgetPayload;
  'approval.requested': ApprovalRequestedPayload;
  'approval.decided': ApprovalDecidedPayload;
  correction: CorrectionPayload;
  'daemon.started': DaemonStartedPayload;
  'daemon.recovered': DaemonRecoveredPayload;
}

/** 落盘事件:一行一个 JSON,seq 单调递增,ts 为 ISO 8601,v 为日志格式版本。 */
export interface Event<P extends EventType = EventType> {
  /** 日志格式版本(§6 v0.2 补充),本期常量 "1.0";重放按 §3.0 前向兼容。 */
  readonly v: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: P;
  readonly principal: Principal;
  readonly payload: EventPayloads[P];
}

/** append 的输入:v / seq 由日志回填;ts 缺省取当前时间(可注入时钟)。 */
export interface EventInput<P extends EventType = EventType> {
  readonly type: P;
  readonly principal: Principal;
  readonly payload: EventPayloads[P];
  readonly ts?: string;
}
