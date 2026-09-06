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
 * 日志,同一份"。内存台账(list)只是查询视图,不是事实源:
 * 重启后经 restoreFromEvents 从事件日志重放重建(issue #14)。
 */
import {
  AgentUnknown,
  CapUnknown,
  GrantDuplicate,
  ScopeNotGrantable,
} from '../capability/index.ts';
import type { GrantExecutor, GrantManifest, LoadedRegistry, Scope } from '../capability/index.ts';
import type { ApprovalDecidedPayload, ApprovalRequestedPayload, Event } from '../events/index.ts';
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

/** restoreFromEvents 的重放报告:重建条数 + 无法重建而跳过的残缺事件数。 */
export interface ApprovalReplayReport {
  /** 从 requested 事件重建的审批单数(含随后被 decided 事件闭合的)。 */
  readonly restored: number;
  /** 无法重建而跳过的事件数(principal 残缺的 requested / 无主 decided)。 */
  readonly skipped: number;
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
    // req_id 同步占位(issue #14):在首个 await 前同步写入台账,并发同
    // reqId 的第二次 submit 在上方校验期即撞 RequestDuplicate,消除
    // "校验与写入跨 await"的 TOCTOU(曾产生重复审批事件 / auto 路径双授予)。
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
    this.#records.set(request.reqId, base);
    try {
      // duration 随事件落盘(issue #14):重放重建台账需要它推授权到期时刻。
      await this.#emit({
        type: 'approval.requested',
        agentId: request.from,
        payload: {
          reqId: request.reqId,
          cap: request.cap,
          scope: request.scope,
          reason: request.reason,
          duration: request.duration,
        },
      });
    } catch (err) {
      // 事件落盘失败:回滚同步占位,单子视为未提交(可重新提交同 reqId)。
      this.#records.delete(request.reqId);
      throw err;
    }

    const { outcome, ruleId } = evaluateRequest(
      withBuiltin(this.#layers(request.from)),
      request.cap,
      request.scope,
      entry.risk_level,
    );
    if (outcome === 'auto') {
      const decisionSource = `auto_rule:${ruleId ?? 'unknown'}`;
      // 与人工定案同序(issue #14):先授予成功,再置 granted 状态并落 decided
      // 事件 —— 授予失败时台账保持 pending(重启重放后同样回到 pending),
      // 不会出现"事件已批、实际未授权且不可重试"的断态。
      const { manifest, alreadyHeld } = await this.#grant(request, decisionSource);
      const record: ApprovalRecord = {
        ...base,
        status: 'granted',
        decidedAt: now,
        decidedBy: 'daemon',
        decisionSource,
        ...(alreadyHeld ? { alreadyHeld: true } : {}),
      };
      this.#records.set(request.reqId, record);
      await this.#emit({
        type: 'approval.decided',
        agentId: request.from,
        payload: {
          reqId: request.reqId,
          decision: 'granted',
          decisionSource,
          ...(alreadyHeld ? { already_held: true } : {}),
        },
      });
      return { status: 'auto_granted', record, manifest };
    }
    this.#records.set(request.reqId, base);
    return { status: 'pending', record: base };
  }

  /**
   * 人工定案(人机入口/主控):granted 可带 narrowedTo 窄化授权。
   * issue #14:先授予成功,再置状态并落 decided 事件 —— 授予侧校验失败
   * (AgentIdInvalid / AgentUnknown 等)时单子保持 pending,可重试定案,
   * 不会出现"已批未授权且不可重试"的断态;denied 无授予,直接定案。
   */
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
    if (decision === 'denied') {
      const decided: ApprovalRecord = {
        ...record,
        status: 'denied',
        decidedAt: now,
        decidedBy: by,
        decisionSource,
      };
      this.#records.set(reqId, decided);
      await this.#emit({
        type: 'approval.decided',
        agentId: decided.agentId,
        payload: { reqId, decision, decisionSource },
      });
      return { status: 'denied', record: decided };
    }
    // 先授予(失败原样抛出,record 未动,仍是 pending 可重试)。
    const { manifest, alreadyHeld } = await this.#grant(
      {
        from: record.agentId,
        reqId: record.reqId,
        cap: record.cap,
        reason: record.reason,
        scope: record.scope,
        duration: record.duration,
      },
      decisionSource,
      options.narrowedTo,
    );
    const decided: ApprovalRecord = {
      ...record,
      status: 'granted',
      decidedAt: now,
      decidedBy: by,
      decisionSource,
      ...(options.narrowedTo !== undefined ? { narrowedTo: options.narrowedTo } : {}),
      ...(alreadyHeld ? { alreadyHeld: true } : {}),
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
        ...(alreadyHeld ? { already_held: true } : {}),
      },
    });
    return { status: 'granted', record: decided, manifest };
  }

  /**
   * 启动重放(issue #14):从事件日志的 approval.requested / approval.decided
   * 重建内存台账,重启后 pending 单仍可 decide(任务不再永久卡
   * waiting_approval)。事件日志是审计事实源,台账只是重建的查询视图。
   *
   * 向前兼容:旧事件 payload 缺 duration 时按保守缺省 "1h" 重建(保证旧
   * pending 单可定案;真实到期由 grant.granted 的 ttl 语义另行守护)。
   * principal.agent 残缺的 requested 与无主 decided 无法重建,保守跳过并计数。
   */
  restoreFromEvents(events: readonly Event[]): ApprovalReplayReport {
    let restored = 0;
    let skipped = 0;
    for (const ev of events) {
      if (ev.type === 'approval.requested') {
        const p = ev.payload as ApprovalRequestedPayload;
        const agent = ev.principal.agent;
        // principal.agent 残缺(旧事件 / 手写日志)无法归属申请人 → 跳过。
        if (agent === null || p.reqId === '') {
          skipped += 1;
          continue;
        }
        // 与 makeApprovalEmit 的 principalFromAgentId 对偶:principal 拆存
        // task 段与实例段,这里重组完整 agentId('<task>/<实例>')。
        const agentId = ev.principal.task !== null ? `${ev.principal.task}/${agent}` : agent;
        const duration = typeof p.duration === 'string' && durationMs(p.duration) !== null
          ? p.duration
          : '1h';
        this.#records.set(p.reqId, {
          reqId: p.reqId,
          agentId,
          cap: p.cap,
          scope: p.scope as Scope,
          reason: p.reason,
          duration,
          status: 'pending',
          submittedAt: ev.ts,
          decidedAt: null,
          decidedBy: null,
          decisionSource: null,
          narrowedTo: null,
        });
        restored += 1;
      } else if (ev.type === 'approval.decided') {
        const p = ev.payload as ApprovalDecidedPayload;
        const record = this.#records.get(p.reqId);
        // 无主 decided(requested 已丢 / 日志裁剪)→ 跳过。
        if (record === undefined) {
          skipped += 1;
          continue;
        }
        this.#records.set(p.reqId, {
          ...record,
          status: p.decision === 'granted' ? 'granted' : 'denied',
          decidedAt: ev.ts,
          // decision_source 反推定案人:auto_rule:* 为 daemon 自动放行,
          // manual:{by} 剥前缀;缺省 decisionSource 时保守记 unknown。
          decidedBy: p.decisionSource.startsWith('auto_rule:')
            ? 'daemon'
            : p.decisionSource.startsWith('manual:')
              ? p.decisionSource.slice('manual:'.length) || 'unknown'
              : 'unknown',
          decisionSource: p.decisionSource,
          ...(p.narrowedTo !== undefined ? { narrowedTo: p.narrowedTo } : {}),
          // issue #15:already_held 标注随事件重放还原(旧事件缺省 = 未标注)。
          ...(p.already_held === true ? { alreadyHeld: true } : {}),
        });
      }
    }
    return { restored, skipped };
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
  ): Promise<{ readonly manifest: GrantManifest; readonly alreadyHeld: boolean }> {
    const ttl = new Date(
      this.#now().getTime() + (durationMs(request.duration) as number),
    ).toISOString();
    let alreadyHeld = false;
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
      // issue #15:不再纯静默 —— alreadyHeld 标注进台账与 decided 事件,
      // "未新建授予、无新 TTL(授权到期即回收失效)"在审计里可见。
      if (!(err instanceof GrantDuplicate)) throw err;
      alreadyHeld = true;
    }
    const manifest = this.#grants.manifest(request.from);
    if (manifest === undefined) throw new AgentUnknown(request.from);
    return { manifest, alreadyHeld };
  }
}

/** 层栈兜底:调用方给的层不含 builtin 时补在栈底(恒存在、恒最低)。 */
function withBuiltin(layers: readonly PolicyLayer[]): readonly PolicyLayer[] {
  return layers.some((l) => l.id === BUILTIN_LAYER.id) ? layers : [BUILTIN_LAYER, ...layers];
}
