/**
 * 基线授予执行器(P1 范围:只有基线授予,没有审批流,§3.3/§9)。
 *
 * - applyBaseline:按预设生成 agent 的 grant manifest(grants 带
 *   source:"baseline"、ttl:null),并输出挂载意图(挂载执行属
 *   Provisioner/sidecar,本模块不做);
 * - grant / revoke 原语 + 按 agent 查询;
 * - granted / reclaimed 审计经注入 sink 发出(审计 = 事件日志,同一份);
 * - 协议硬底线为独立纯函数(hardline.ts),baseline 是人工把关的设计
 *   产物、不走 auto_rule 放行路径,故此处不做硬底线拦截(P2 审批流接线)。
 *
 * decision_source 取值说明:任务指示 baseline 场景填 "baseline",但
 * grant-manifest.schema.json 冻结了 pattern ^(auto_rule:...|manual:...)$,
 * 裸 "baseline" 不合法——按 schema 冻结物优先,默认填 "auto_rule:baseline"
 * (确定性规则:按预设置入基线),可经 options.decisionSource 覆盖。
 */
import {
  AgentIdInvalid,
  AgentUnknown,
  BaselineAlreadyApplied,
  CapUnknown,
  GrantDuplicate,
  ScopeNotGrantable,
} from './errors.ts';
import { AGENT_ID_RE } from './validation.ts';
import type {
  AuditEntry,
  BaselineApplyResult,
  EventSink,
  Grant,
  GrantConstraint,
  GrantManifest,
  LoadedRegistry,
  MountIntent,
  Preset,
  Scope,
} from './types.ts';

export const BASELINE_SOURCE = 'baseline';
export const DEFAULT_DECISION_SOURCE = 'auto_rule:baseline';

export interface GrantExecutorOptions {
  /** 审计 sink(granted/reclaimed 全量发出,自动放行同样入审计)。 */
  readonly sink?: EventSink;
  /** 可注入时钟(测试);默认系统时钟。 */
  readonly now?: () => Date;
  /** decision_source 覆盖(baseline 场景默认 auto_rule:baseline)。 */
  readonly decisionSource?: string;
  /** 操作主体(by 字段),默认 "daemon"。 */
  readonly actor?: string;
}

interface AgentState {
  grants: Grant[];
  readonly audit: AuditEntry[];
}

export class GrantExecutor {
  private readonly registry: LoadedRegistry;
  private readonly sink: EventSink | null;
  private readonly now: () => Date;
  private readonly decisionSource: string;
  private readonly actor: string;
  private readonly agents = new Map<string, AgentState>();

  constructor(registry: LoadedRegistry, options: GrantExecutorOptions = {}) {
    this.registry = registry;
    this.sink = options.sink ?? null;
    this.now = options.now ?? (() => new Date());
    this.decisionSource = options.decisionSource ?? DEFAULT_DECISION_SOURCE;
    this.actor = options.actor ?? 'daemon';
  }

  /**
   * 按预设置入基线授予:逐条校验 cap 存在、scope ∈ grantable_scopes、
   * 无重复,生成 manifest 快照与挂载意图,并发出 granted 审计。
   * 已有授予记录的 agent 重复调用 → 幂等报错(GrantDuplicate)。
   */
  async applyBaseline(agentId: string, preset: Preset): Promise<BaselineApplyResult> {
    assertAgentId(agentId);
    if (this.agents.has(agentId)) {
      throw new BaselineAlreadyApplied(agentId);
    }
    const state: AgentState = { grants: [], audit: [] };
    this.agents.set(agentId, state);
    const mountIntents: MountIntent[] = [];
    try {
      for (const spec of preset.baseline_grants) {
        const entry = this.registry.get(spec.cap);
        if (entry === undefined) throw new CapUnknown(spec.cap);
        if (!entry.grantable_scopes.includes(spec.scope)) {
          throw new ScopeNotGrantable(spec.cap, spec.scope, entry.grantable_scopes);
        }
        if (state.grants.some((g) => g.cap === spec.cap && g.scope === spec.scope)) {
          throw new GrantDuplicate(spec.cap, spec.scope);
        }
        const grant: Grant = {
          cap: spec.cap,
          scope: spec.scope,
          source: BASELINE_SOURCE,
          ttl: null,
        };
        state.grants.push(grant);
        mountIntents.push(this.mountIntent(entry, grant));
        await this.record(state, agentId, 'granted', grant.cap);
      }
    } catch (err) {
      this.agents.delete(agentId);
      throw err;
    }
    return { manifest: this.manifest(agentId) as GrantManifest, mountIntents };
  }

  /** 授予原语(P2 审批流也用它):校验 cap/scope,发出 granted 审计。
   *  decisionSource / by 可按条覆盖(P2 审批:自动放行 auto_rule:{id}、
   *  人工批准 manual:{principal});缺省用构造时的实例级默认。 */
  async grant(
    agentId: string,
    request: {
      cap: string;
      scope: Scope;
      source: string;
      ttl?: string | null;
      constraint?: GrantConstraint;
      reqId?: string;
      decisionSource?: string;
      by?: string;
    },
  ): Promise<Grant> {
    assertAgentId(agentId);
    const entry = this.registry.get(request.cap);
    if (entry === undefined) throw new CapUnknown(request.cap);
    if (!entry.grantable_scopes.includes(request.scope)) {
      throw new ScopeNotGrantable(request.cap, request.scope, entry.grantable_scopes);
    }
    const state = this.agents.get(agentId) ?? { grants: [], audit: [] };
    this.agents.set(agentId, state);
    if (
      state.grants.some((g) => g.cap === request.cap && g.scope === request.scope)
    ) {
      throw new GrantDuplicate(request.cap, request.scope);
    }
    const grant: Grant = {
      cap: request.cap,
      scope: request.scope,
      source: request.source,
      ttl: request.ttl ?? null,
      ...(request.constraint !== undefined ? { constraint: request.constraint } : {}),
    };
    state.grants.push(grant);
    await this.record(state, agentId, 'granted', grant.cap, request.reqId, request.decisionSource, request.by);
    return grant;
  }

  /**
   * 回收原语:移除该 agent 的指定 cap 授予(scope 省略 = 该 cap 全部 scope),
   * 每条移除发出 reclaimed 审计;返回移除条数。agent 未注册 → AgentUnknown。
   */
  async revoke(agentId: string, cap: string, scope?: Scope): Promise<number> {
    const state = this.agents.get(agentId);
    if (state === undefined) throw new AgentUnknown(agentId);
    const kept: Grant[] = [];
    const removed: Grant[] = [];
    for (const grant of state.grants) {
      if (grant.cap === cap && (scope === undefined || grant.scope === scope)) {
        removed.push(grant);
      } else {
        kept.push(grant);
      }
    }
    state.grants = kept;
    for (const grant of removed) {
      await this.record(state, agentId, 'reclaimed', grant.cap);
    }
    return removed.length;
  }

  /** 按 agent 查询当前 manifest;未注册返回 undefined。 */
  manifest(agentId: string): GrantManifest | undefined {
    const state = this.agents.get(agentId);
    if (state === undefined) return undefined;
    return {
      protocol: '1.0',
      spec_version: '1.0',
      agent_id: agentId,
      grants: [...state.grants],
      audit: [...state.audit],
    };
  }

  /** 按 agent 查询当前授予条目;未注册返回空数组。 */
  grantsOf(agentId: string): readonly Grant[] {
    return this.agents.get(agentId)?.grants ?? [];
  }

  /** 全量授予视图(TTL 到期回收等守护扫描用,P2 审批流)。 */
  allGrants(): readonly { readonly agentId: string; readonly grant: Grant }[] {
    const out: { agentId: string; grant: Grant }[] = [];
    for (const [agentId, state] of this.agents) {
      for (const grant of state.grants) out.push({ agentId, grant });
    }
    return out;
  }

  private mountIntent(
    entry: NonNullable<ReturnType<LoadedRegistry['get']>>,
    grant: Grant,
  ): MountIntent {
    return {
      cap: grant.cap,
      scope: grant.scope,
      kind: entry.kind,
      pathTemplate: entry.path_template ?? null,
      tools: entry.tools ?? null,
    };
  }

  private async record(
    state: AgentState,
    agentId: string,
    event: AuditEntry['event'],
    cap: string,
    reqId?: string,
    decisionSource?: string,
    by?: string,
  ): Promise<void> {
    const entry: AuditEntry = {
      event,
      cap,
      by: by ?? this.actor,
      decision_source: decisionSource ?? this.decisionSource,
      at: this.now().toISOString(),
      ...(reqId !== undefined ? { req_id: reqId } : {}),
    };
    state.audit.push(entry);
    if (this.sink !== null) {
      await this.sink({ ...entry, agentId });
    }
  }
}

function assertAgentId(agentId: string): void {
  if (!AGENT_ID_RE.test(agentId)) throw new AgentIdInvalid(agentId);
}
