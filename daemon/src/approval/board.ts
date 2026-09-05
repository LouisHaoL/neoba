/**
 * ApprovalBoard(§3.3 审批流执行器):
 *
 *   submit(tool.request) → 硬底线 + 分层策略评估 →
 *     auto → 即刻授予(source = escalation:{req_id},TTL 到期时刻,审计
 *            decision_source = auto_rule:{层 id},§3.3"自动放行同样全量入审计")
 *     require → 挂 pending,等人机入口(CLI / 主控)decide
 *
 *   decide(reqId, granted|denied, by) → 审批事件 + 授予(可窄化,constraint.
 *   fs_scope_narrowed_to)或拒绝;decision_source = manual:{by}
 *   reclaimExpired(now) → TTL 到期的 escalation 授予自动回收(reclaimed 审计)
 *
 * 审计事实:申请/定案经注入的 emit 落事件日志(approval.requested / decided),
 * 授予/回收经 GrantExecutor 的 sink 走同一份日志 —— §3.3"审计日志 = 事件
 * 日志,同一份"。内存台账(list)只是查询视图,不是事实源。
 */
import {
  AgentUnknown,
  CapUnknown,
  GrantDuplicate,
  ScopeNotGrantable,
} from '../capability/index.ts';
import type { GrantExecutor, GrantManifest, LoadedRegistry } from '../capability/index.ts';
import { BUILTIN_LAYER, evaluateRequest } from './policy.ts';
import type { PolicyLayer } from './types.ts';
import type { ApprovalEventInput, ApprovalRecord, DecideResult, SubmitResult, ToolRequestSpec } from './types.ts';

export class ApprovalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** req_id 重复(同 id 已提交过)。 */
export class RequestDuplicate extends ApprovalError {
  readonly reqId: string;
  constructor(reqId: string) {
    super('REQ_DUPLICATE', `审批单 req_id 已存在: ${reqId}`);
    this.reqId = reqId;
  }
}

/** req_id 不存在或已定案。 */
export class RequestUnknown extends ApprovalError {
  readonly reqId: string;
  constructor(reqId: string) {
    super('REQ_UNKNOWN', `审批单不存在或已定案: ${reqId}`);
    this.reqId = reqId;
  }
}

export interface ApprovalBoardOptions {
  readonly registry: LoadedRegistry;
  readonly grants: GrantExecutor;
  /** 审批事件出口(daemon 接 EventLog.append;测试接数组)。 */
  readonly emit: (event: ApprovalEventInput) => Promise<void> | void;
  /** 提交时的层栈快照工厂(低 → 高,不含 builtin)。 */
  readonly layers: (agentId: string) => readonly PolicyLayer[];
  readonly now?: () => Date;
}

/** duration ^\d+[smhd]$ → 毫秒;非法返回 null。 */
export function durationMs(duration: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(duration);
  if (m === null) return null;
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

export class ApprovalBoard {
  readonly #registry: LoadedRegistry;
  readonly #grants: GrantExecutor;
  readonly #emit: (event: ApprovalEventInput) => Promise<void> | void;
  readonly #layers: (agentId: string) => readonly PolicyLayer[];
  readonly #now: () => Date;
  readonly #records = new Map<string, ApprovalRecord>();

  constructor(options: ApprovalBoardOptions) {
    this.#registry = options.registry;
    this.#grants = options.grants;
    this.#emit = options.emit;
    this.#layers = options.layers;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * 提交升级申请。授道路径的校验错误(cap 不存在 / scope 不可授)在评估前
   * 直接抛出(fail-fast,申请本身不合法);自动授予时的 GrantDuplicate 视为
   * 已持有 → 幂等返回 granted 记录。
   */
  async submit(request: ToolRequestSpec): Promise<SubmitResult> {
    const entry = this.#registry.get(request.cap);
    if (entry === undefined) throw new CapUnknown(request.cap);
    if (!entry.grantable_scopes.includes(request.scope)) {
      throw new ScopeNotGrantable(request.cap, request.scope, entry.grantable_scopes);
    }
    if (this.#records.has(request.reqId)) throw new RequestDuplicate(request.reqId);
    if (durationMs(request.duration) === null) {
      throw new ApprovalError('DURATION_INVALID', `duration 非法: ${request.duration}(须匹配 ^\\d+[smhd]$)`);
    }

    const now = this.#now().toISOString();
    const base: ApprovalRecord = {
      reqId: request.reqId,
      agentId: request.from,
      cap: request.cap,
      scope: request.scope,
      reason: request.reason,
      duration: request.duration,
      status: 'pending',
      submittedAt: now,
      decidedAt: null,
      decidedBy: null,
      decisionSource: null,
      narrowedTo: null,
    };
    await this.#emit({
      type: 'approval.requested',
      agentId: request.from,
      payload: {
        reqId: request.reqId,
        cap: request.cap,
        scope: request.scope,
        reason: request.reason,
      },
    });

    const { outcome, ruleId } = evaluateRequest(
      withBuiltin(this.#layers(request.from)),
      request.cap,
      request.scope,
      entry.risk_level,
    );
    if (outcome === 'auto') {
      const decisionSource = `auto_rule:${ruleId ?? 'unknown'}`;
      const record: ApprovalRecord = {
        ...base,
        status: 'granted',
        decidedAt: now,
        decidedBy: 'daemon',
        decisionSource,
      };
      this.#records.set(request.reqId, record);
      await this.#emit({
        type: 'approval.decided',
        agentId: request.from,
        payload: { reqId: request.reqId, decision: 'granted', decisionSource },
      });
      const manifest = await this.#grant(request, decisionSource);
      return { status: 'auto_granted', record, manifest };
    }
    this.#records.set(request.reqId, base);
    return { status: 'pending', record: base };
  }

  /** 人工定案(人机入口/主控):granted 可带 narrowedTo 窄化授权。 */
  async decide(
    reqId: string,
    decision: 'granted' | 'denied',
    by: string,
    options: { readonly narrowedTo?: string } = {},
  ): Promise<DecideResult> {
    const record = this.#records.get(reqId);
    if (record === undefined || record.status !== 'pending') throw new RequestUnknown(reqId);
    const decisionSource = `manual:${by}`;
    const now = this.#now().toISOString();
    const decided: ApprovalRecord = {
      ...record,
      status: decision === 'granted' ? 'granted' : 'denied',
      decidedAt: now,
      decidedBy: by,
      decisionSource,
      ...(options.narrowedTo !== undefined ? { narrowedTo: options.narrowedTo } : {}),
    };
    this.#records.set(reqId, decided);
    await this.#emit({
      type: 'approval.decided',
      agentId: decided.agentId,
      payload: {
        reqId,
        decision,
        decisionSource,
        ...(options.narrowedTo !== undefined ? { narrowedTo: options.narrowedTo } : {}),
      },
    });
    if (decision === 'denied') {
      return { status: 'denied', record: decided };
    }
    const manifest = await this.#grant(
      {
        from: decided.agentId,
        reqId: decided.reqId,
        cap: decided.cap,
        reason: decided.reason,
        scope: decided.scope,
        duration: decided.duration,
      },
      decisionSource,
      options.narrowedTo,
    );
    return { status: 'granted', record: decided, manifest };
  }

  /** TTL 守护:回收全部到期的 escalation 授予;返回回收条数。 */
  async reclaimExpired(): Promise<number> {
    const now = this.#now().toISOString();
    let reclaimed = 0;
    for (const { agentId, grant } of this.#grants.allGrants()) {
      if (!grant.source.startsWith('escalation:')) continue;
      if (grant.ttl === null || grant.ttl > now) continue;
      reclaimed += await this.#grants.revoke(agentId, grant.cap, grant.scope);
    }
    return reclaimed;
  }

  /** 台账查询视图(pending 过滤)。 */
  listPending(): readonly ApprovalRecord[] {
    return [...this.#records.values()].filter((r) => r.status === 'pending');
  }

  /** 全量台账(含已定案,审计查询用)。 */
  listAll(): readonly ApprovalRecord[] {
    return [...this.#records.values()].sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
  }

  async #grant(
    request: ToolRequestSpec,
    decisionSource: string,
    narrowedTo?: string,
  ): Promise<GrantManifest> {
    const ttl = new Date(
      this.#now().getTime() + (durationMs(request.duration) as number),
    ).toISOString();
    try {
      await this.#grants.grant(request.from, {
        cap: request.cap,
        scope: request.scope,
        source: `escalation:${request.reqId}`,
        ttl,
        reqId: request.reqId,
        decisionSource,
        ...(narrowedTo !== undefined
          ? { constraint: { fs_scope_narrowed_to: narrowedTo } }
          : {}),
      });
    } catch (err) {
      // 已持有同 cap+scope 授予:幂等视为成功(授予已在,无需重复)。
      if (!(err instanceof GrantDuplicate)) throw err;
    }
    const manifest = this.#grants.manifest(request.from);
    if (manifest === undefined) throw new AgentUnknown(request.from);
    return manifest;
  }
}

/** 层栈兜底:调用方给的层不含 builtin 时补在栈底(恒存在、恒最低)。 */
function withBuiltin(layers: readonly PolicyLayer[]): readonly PolicyLayer[] {
  return layers.some((l) => l.id === BUILTIN_LAYER.id) ? layers : [BUILTIN_LAYER, ...layers];
}
