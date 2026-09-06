/**
 * daemon 操作集(§6 daemon localhost API):
 *
 * P1:
 *   session.init / capabilities.list / task.create / task.status / task.list /
 *   artifacts.publish / artifacts.resolve / artifacts.read / grants.of
 * P2(workflow.run = task.create 的多节点形态;task.create 保持单节点闭环不变):
 *   workflow.run / task.pause / task.resume / task.cancel /
 *   approvals.list / approvals.submit / approvals.decide /
 *   budget.status / budget.raise / models.list / models.feedback
 * M4(观测线):
 *   events.list(读走 EventLog.readByPrincipal;admin 全量,session 身份
 *   锁死绑定命名空间)
 *
 * handler 抛模块层类型化错误(session/capability/artifacts/engine/approval)
 * 或 RpcError,由 http.ts 统一映射为 JSON-RPC error 结构。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import type {
  ArtifactRepository,
  ArtifactNamespace,
} from '../artifacts/index.ts';
import { EVENT_TYPES } from '../events/index.ts';
import type {
  EventLog,
  EventType,
  Principal,
  PrincipalFilter,
} from '../events/index.ts';
import type { GrantAuditEvent } from '../capability/index.ts';
import type { EventSink, GrantExecutor, LoadedRegistry, Preset, Scope } from '../capability/index.ts';
import type { DaemonProfile, SessionRegistry } from '../session/index.ts';
import { handleSessionInit } from '../session/index.ts';
import { checkWorkflow } from '../plancheck/index.ts';
import type { IntentDoc, WorkflowDoc } from '../plancheck/index.ts';
import { parseIntent, parseOutputBinding } from '../plancheck/index.ts';
import { WorkflowEngine, RunNotPaused, RunUnknown, baselineScopeQueue } from '../engine/index.ts';
import type { WorkflowRunResult } from '../engine/index.ts';
import { BudgetLedger } from '../budget/index.ts';
import { TIERS } from '../modelscore/index.ts';
import type { ModelFeedback, Tier } from '../modelscore/index.ts';
import { recordFeedback } from '../modelscore/index.ts';
import { ApprovalBoard } from '../approval/index.ts';
import { ADMIN_IDENTITY } from './identity.ts';
import type { RequestIdentity, TokenRegistry } from './identity.ts';
import {
  ApprovalForbidden,
  InvalidParams,
  PresetUnknown,
  SessionForbidden,
  SessionUnknown,
  TaskNotFound,
} from './errors.ts';
import { RpcError } from './errors.ts';
import { applyTaskEvent } from './tasks.ts';
import type { TaskRecord, TaskStore } from './tasks.ts';
import { makeBudgetEmit, emitEscalationGrants } from './wiring.ts';
import type { ModelRegistryStore } from './wiring.ts';

export const DEFAULT_TENANT = 'default';

/** 复杂字段名 → params 键(snake_case 入参,内部 camelCase)。 */
function requireString(params: Record<string, unknown>, key: string, method: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidParams(`${method}: params.${key} 必须是非空字符串`, { field: key });
  }
  return value;
}

function optionalString(
  params: Record<string, unknown>,
  key: string,
  method: string,
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidParams(`${method}: params.${key} 必须是非空字符串`, { field: key });
  }
  return value;
}

function requireObject(params: unknown, method: string): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new InvalidParams(`${method}: params 必须是对象`);
  }
  return params as Record<string, unknown>;
}

/** grant 审计 sink 的每次 applyBaseline 上下文(principal + cap→scope 队列)。 */
export interface ApplyContext {
  readonly principal: Principal;
  /** 同一 cap 可能授多个 scope,sink 事件只带 cap,按 FIFO 弹出。 */
  readonly scopeQueue: Map<string, string[]>;
}

export interface OperationsContext {
  readonly profile: DaemonProfile;
  readonly registry: LoadedRegistry;
  readonly sessions: SessionRegistry;
  /** per-session token 注册表(M3;缺省 = session.init 不签发 token)。 */
  readonly tokens?: TokenRegistry;
  readonly grants: GrantExecutor;
  readonly tasks: TaskStore;
  readonly events: EventLog;
  readonly artifacts: ArtifactRepository;
  readonly presets: Readonly<Record<string, Preset>>;
  readonly now?: () => Date;
  // ---- P2 执行面(未配置 = daemon 只提供 P1 操作面,行为不变) ----
  /** WorkflowSpec 执行引擎(workflow.run / pause / resume / cancel)。 */
  readonly engine?: WorkflowEngine;
  /** 审批台账(approvals.list / decide)。 */
  readonly board?: ApprovalBoard;
  /** 任务预算台账(taskId → ledger;workflow.run 建,budget.status/raise 查)。 */
  readonly budgets?: Map<string, BudgetLedger>;
  /** Model Score Registry(models.list / feedback)。 */
  readonly models?: ModelRegistryStore;
  /** modelscore 持久化文件(feedback 后回写;缺省 = 只驻内存)。 */
  readonly modelsPath?: string;
}

/**
 * 把 EventLog 包成 GrantExecutor 的审计 sink:granted/reclaimed 全量入事件日志
 * (§3.3 审计日志 = 事件日志同一份)。上下文经 AsyncLocalStorage 携带,
 * 并发 task.create 互不串线。
 */
export function makeGrantSink(
  apply: AsyncLocalStorage<ApplyContext>,
  log: EventLog,
): EventSink {
  return (entry: GrantAuditEvent) => {
    const ctx = apply.getStore();
    if (ctx === undefined) return Promise.resolve();
    const type = entry.event === 'granted' ? ('grant.granted' as const) : ('grant.revoked' as const);
    const payload =
      type === 'grant.granted'
        ? {
            cap: entry.cap,
            scope: ctx.scopeQueue.get(entry.cap)?.shift() ?? 'read',
            source: 'baseline',
            decisionSource: entry.decision_source,
          }
        : {
            cap: entry.cap,
            reason: 'reclaimed',
            decisionSource: entry.decision_source,
          };
    return log.append({
      type,
      principal: ctx.principal,
      payload: payload as never,
    }).then(() => undefined);
  };
}

export class Operations {
  readonly #ctx: OperationsContext;
  readonly #apply: AsyncLocalStorage<ApplyContext>;

  constructor(ctx: OperationsContext, apply: AsyncLocalStorage<ApplyContext>) {
    this.#ctx = ctx;
    this.#apply = apply;
  }

  /**
   * 分发一个 P1/P2 操作;未知 method 抛错由调用方处理。
   * identity 缺省 = admin(bootstrap token 路径,现语义);http 绑定解析出的
   * session 身份透传进来,principal 与审批权按绑定二元组收窄(M3)。
   */
  async call(method: string, params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    switch (method) {
      case 'session.init':
        return this.sessionInit(params, identity);
      case 'capabilities.list':
        return { capabilities: this.#ctx.registry.capabilities };
      case 'task.create':
        return this.taskCreate(params, identity);
      case 'task.status':
        return this.taskStatus(params, identity);
      case 'task.list':
        return { tasks: this.#listTasks(identity) };
      case 'artifacts.publish':
        return this.artifactPublish(params, identity);
      case 'artifacts.resolve':
        return this.artifactResolve(params, identity);
      case 'artifacts.read':
        return this.artifactRead(params, identity);
      case 'grants.of':
        return this.grantsOf(params);
      case 'workflow.run':
        return this.workflowRun(params, identity);
      case 'task.pause':
        return this.taskPause(params, identity);
      case 'task.resume':
        return this.taskResume(params, identity);
      case 'task.cancel':
        return this.taskCancel(params, identity);
      case 'approvals.list':
        return this.approvalsList(params, identity);
      case 'approvals.submit':
        return this.approvalsSubmit(params, identity);
      case 'approvals.decide':
        return this.approvalsDecide(params, identity);
      case 'budget.status':
        return this.budgetStatus(params, identity);
      case 'budget.raise':
        return this.budgetRaise(params, identity);
      case 'models.list':
        return this.modelsList();
      case 'models.feedback':
        return this.modelsFeedback(params);
      case 'events.list':
        return this.eventsList(params, identity);
      default:
        throw new InvalidParams(`未知操作: ${method}`, { method });
    }
  }

  /** 是否为已注册操作(未知 method 由 HTTP 层报 -32601)。 */
  static has(method: string): boolean {
    return OPERATIONS.includes(method);
  }

  /**
   * 会话握手(#9):session token 调用方只能在本人绑定的 tenant 下登记会话
   * (principal.tenant 与绑定值不一致 → SESSION_FORBIDDEN,session 名可自选);
   * admin(bootstrap token)不受限,可为任意 tenant 签发。缺省 identity =
   * admin(现语义:直连 handleSessionInit 的单元测试与内部调用零漂移)。
   */
  async sessionInit(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    if (identity.kind === 'session') {
      const boundTenant = identity.tenant ?? DEFAULT_TENANT;
      const principal = (typeof params === 'object' && params !== null
        ? (params as Record<string, unknown>)['principal']
        : undefined) as unknown;
      const declared = typeof principal === 'object' && principal !== null && !Array.isArray(principal)
        ? (principal as Record<string, unknown>)['tenant']
        : undefined;
      if (typeof declared === 'string' && declared !== boundTenant) {
        // 显式异值在此按越权拒绝,不给跨租户探测空间;缺失/类型不符的
        // tenant 交由 parseSessionInit 报 InvalidHandshake(同样不放行)。
        throw new SessionForbidden(boundTenant, identity.session ?? '');
      }
    }
    // HTTP 层 params 只有 SessionInitParams;handleSessionInit 期望完整请求文档。
    const result = handleSessionInit(
      { method: 'session.init', params },
      this.#ctx.profile,
      this.#ctx.sessions,
      { now: this.#ctx.now?.() },
    );
    const base = { response: result.response, warnings: result.warnings, session: result.session };
    // M3 双 token 模型:配置了注册表才签发会话 token;明文只在本次应答出现
    // 一次,注册表只落 sha256。缺省注册表 = 现语义(应答无 token 字段)。
    if (this.#ctx.tokens === undefined) return base;
    const token = await this.#ctx.tokens.issue(
      result.session.tenant,
      result.session.session,
      ...(this.#ctx.now !== undefined ? [this.#ctx.now] : []),
    );
    return { ...base, token };
  }

  /**
   * 解析 principal 前两层:声明了 session 必须在活跃会话表中;tenant 未显式
   * 给出时按 session 名在会话表中反查(单 tenant 部署为主,命中第一个)。
   *
   * M3:session token 身份的 principal 锁死在签发时绑定的 (tenant, session):
   * params 省略 = 取绑定值;显式传值必须与绑定值一致,否则 SESSION_FORBIDDEN;
   * 且会话必须仍活跃(重启后会话表清空,token 虽在注册表也不可用)。
   */
  #resolvePrincipal(
    params: Record<string, unknown>,
    method: string,
    identity: RequestIdentity = ADMIN_IDENTITY,
  ): { tenant: string; session: string | null } {
    const tenantParam = optionalString(params, 'tenant', method);
    const sessionParam = optionalString(params, 'session', method);
    if (identity.kind === 'session') {
      const tenant = identity.tenant ?? DEFAULT_TENANT;
      const session = identity.session ?? '';
      if (
        (tenantParam !== undefined && tenantParam !== tenant) ||
        (sessionParam !== undefined && sessionParam !== session)
      ) {
        throw new SessionForbidden(tenant, session);
      }
      if (session === '' || this.#ctx.sessions.lookup(tenant, session) === undefined) {
        throw new SessionUnknown(tenant, session);
      }
      return { tenant, session };
    }
    if (sessionParam === undefined) {
      return { tenant: tenantParam ?? DEFAULT_TENANT, session: null };
    }
    const record =
      (tenantParam !== undefined ? this.#ctx.sessions.lookup(tenantParam, sessionParam) : undefined) ??
      this.#ctx.sessions.list().find((s) => s.session === sessionParam);
    if (record === undefined) {
      throw new SessionUnknown(tenantParam ?? DEFAULT_TENANT, sessionParam);
    }
    return { tenant: record.tenant, session: record.session };
  }

  /**
   * task.list 按 identity 收窄:admin 全量(现语义);session 身份只见本人
   * 会话名下的任务。
   */
  #listTasks(identity: RequestIdentity): readonly TaskRecord[] {
    const all = this.#ctx.tasks.list();
    if (identity.kind !== 'session') return all;
    const tenant = identity.tenant ?? DEFAULT_TENANT;
    const session = identity.session ?? '';
    return all.filter((t) => t.tenant === tenant && t.session === session);
  }

  async taskCreate(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const p = requireObject(params, 'task.create');
    const intent = requireString(p, 'intent', 'task.create');
    const presetName = requireString(p, 'preset', 'task.create');
    const { tenant, session } = this.#resolvePrincipal(p, 'task.create', identity);
    const preset = this.#ctx.presets[presetName];
    if (preset === undefined) {
      throw new PresetUnknown(presetName, Object.keys(this.#ctx.presets));
    }
    const taskId = newTaskId(this.#ctx.now);
    const agentId = `${taskId}/worker-01`;
    const principal: Principal = {
      tenant,
      session,
      task: taskId,
      agent: agentId,
    };
    const record = {
      taskId,
      agentId,
      tenant,
      session,
      intent,
      preset: presetName,
      createdAt: (this.#ctx.now?.() ?? new Date()).toISOString(),
      status: 'created' as const,
      error: null,
      mountIntents: [] as readonly Record<string, unknown>[],
    };
    this.#ctx.tasks.upsert(record);

    // 任务级 failure domain(§6):单 task 抛错 → 记 node.failed + 标 failed,
    // 不影响 daemon 与其他任务。
    try {
      await this.#ctx.events.append({
        type: 'node.started',
        principal,
        payload: {
          nodeId: agentId,
          attempt: 1,
          extra: { intent, preset: presetName },
        },
      });
      const { manifest, mountIntents } = await this.#apply.run(
        { principal, scopeQueue: baselineScopeQueue(preset) },
        () => this.#ctx.grants.applyBaseline(agentId, preset),
      );
      this.#ctx.tasks.setManifest(manifest);
      record.mountIntents = mountIntents as unknown as readonly Record<string, unknown>[];
      // 状态闭包:completed 的 extra 携带挂载意图(重放时随任务恢复)。
      await this.#ctx.events.append({
        type: 'node.completed',
        principal,
        payload: {
          nodeId: agentId,
          attempt: 1,
          outputs: [],
          extra: { mountIntents: mountIntents as unknown as Record<string, unknown>[] },
        },
      });
      this.#ctx.tasks.markCompleted(taskId);
      return {
        task_id: taskId,
        agent_id: agentId,
        status: 'completed',
        manifest,
        mount_intents: mountIntents,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#ctx.tasks.markFailed(taskId, message);
      try {
        await this.#ctx.events.append({
          type: 'node.failed',
          principal,
          payload: { nodeId: agentId, attempt: 1, reason: 'crash', detail: message },
        });
      } catch {
        // 事件落盘失败不掩盖原始错误。
      }
      throw err;
    }
  }

  async taskStatus(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const p = requireObject(params, 'task.status');
    const taskId = requireString(p, 'task_id', 'task.status');
    return { task: this.#requireTask(taskId, identity) };
  }

  /** 工件命名空间 = principal 前两层 + 显式 task 段。 */
  #resolveNamespace(
    params: Record<string, unknown>,
    method: string,
    identity: RequestIdentity = ADMIN_IDENTITY,
  ): { ns: ArtifactNamespace; sessionId: string | null } {
    const { tenant, session } = this.#resolvePrincipal(params, method, identity);
    const task = requireString(params, 'task', method);
    return { ns: { tenant, task }, sessionId: session };
  }

  async artifactPublish(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const p = requireObject(params, 'artifacts.publish');
    const { ns } = this.#resolveNamespace(p, 'artifacts.publish', identity);
    const node = requireString(p, 'node', 'artifacts.publish');
    const name = requireString(p, 'name', 'artifacts.publish');
    const encoder = new TextEncoder();
    let payload;
    let kind: 'file' | 'tree';
    if (p['content'] !== undefined) {
      if (typeof p['content'] !== 'string') {
        throw new InvalidParams('artifacts.publish: params.content 必须是字符串', { field: 'content' });
      }
      payload = encoder.encode(p['content']);
      kind = 'file';
    } else if (Array.isArray(p['files'])) {
      payload = (p['files'] as unknown[]).map((file) => {
        if (typeof file !== 'object' || file === null) {
          throw new InvalidParams('artifacts.publish: files 成员必须是对象', { field: 'files' });
        }
        const f = file as Record<string, unknown>;
        if (typeof f['path'] !== 'string' || typeof f['content'] !== 'string') {
          throw new InvalidParams('artifacts.publish: files 成员必须含 path/content 字符串', {
            field: 'files',
          });
        }
        return { path: f['path'], content: encoder.encode(f['content']) };
      });
      kind = 'tree';
    } else {
      throw new InvalidParams('artifacts.publish: 需要 content 或 files', { field: 'content' });
    }
    const result = await this.#ctx.artifacts.publish(ns, node, name, payload);
    const agent = this.#currentAgent(ns);
    await this.#ctx.events.append({
      type: 'artifact.published',
      principal: { tenant: ns.tenant, session: null, task: ns.task, agent },
      payload: { node, name, sha256: result.rootSha256, size: result.size, kind },
    });
    return {
      tenant: ns.tenant,
      task: ns.task,
      node,
      name,
      version: result.version,
      root_sha256: result.rootSha256,
      size: result.size,
      kind,
    };
  }

  /** principal.agent 从当前活跃会话推导不可行(无调用上下文),事件里保持 null。 */
  #currentAgent(_ns: ArtifactNamespace): string | null {
    return null;
  }

  async artifactResolve(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const p = requireObject(params, 'artifacts.resolve');
    const { ns } = this.#resolveNamespace(p, 'artifacts.resolve', identity);
    const node = requireString(p, 'node', 'artifacts.resolve');
    const name = requireString(p, 'name', 'artifacts.resolve');
    const ref = await this.#ctx.artifacts.resolve(ns, node, name);
    return ref;
  }

  async artifactRead(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const p = requireObject(params, 'artifacts.read');
    const { ns } = this.#resolveNamespace(p, 'artifacts.read', identity);
    const node = requireString(p, 'node', 'artifacts.read');
    const name = requireString(p, 'name', 'artifacts.read');
    const entryPath = optionalString(p, 'entry_path', 'artifacts.read');
    const bytes = entryPath === undefined
      ? await this.#ctx.artifacts.read(ns, node, name)
      : await this.#ctx.artifacts.readEntry(ns, node, name, entryPath);
    const base64 = Buffer.from(bytes).toString('base64');
    let utf8: string | null = null;
    try {
      utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      utf8 = null;
    }
    return utf8 === null
      ? { encoding: 'base64', data: base64, size: bytes.byteLength }
      : { encoding: 'utf8', data: utf8, size: bytes.byteLength };
  }

  async grantsOf(params: unknown): Promise<unknown> {
    const p = requireObject(params, 'grants.of');
    const agentId = requireString(p, 'agent_id', 'grants.of');
    return { manifest: this.#ctx.tasks.manifest(agentId) ?? null };
  }

  // ---------------------------------------------------------------- P2:编排与执行面

  #requireEngine(method: string): WorkflowEngine {
    if (this.#ctx.engine === undefined) {
      throw new RpcError(-32020, `${method}: daemon 未配置执行引擎`, {
        data: { code: 'ENGINE_NOT_WIRED' },
        httpStatus: 501,
      });
    }
    return this.#ctx.engine;
  }

  #requireTask(taskId: string, identity: RequestIdentity = ADMIN_IDENTITY): TaskRecord {
    const record = this.#ctx.tasks.get(taskId);
    if (record === undefined) throw new TaskNotFound(taskId);
    // M3:session 身份只能触达本人会话名下的任务(admin 不限,现语义)。
    if (identity.kind === 'session') {
      const tenant = identity.tenant ?? DEFAULT_TENANT;
      const session = identity.session ?? '';
      if (record.tenant !== tenant || record.session !== session) {
        throw new SessionForbidden(tenant, session);
      }
    }
    return record;
  }

  /**
   * P2 主入口:提交 WorkflowSpec 异步执行。handler 立即返回 task_id,
   * 终态经 task.status / 事件流观察;任务状态机由引擎事件(node.* 等)
   * 经 makeEngineEmit 落日志并同步 TaskStore(重放同构)。
   * workflow 与 intent 均先过 PlanCheck(结构 + 语义),问题一次回全。
   */
  async workflowRun(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const engine = this.#requireEngine('workflow.run');
    const p = requireObject(params, 'workflow.run');
    const { tenant, session } = this.#resolvePrincipal(p, 'workflow.run', identity);

    const check = checkWorkflow(p['workflow'], {
      presets: this.#ctx.presets,
      registry: this.#ctx.registry,
      ...(this.#ctx.models !== undefined ? { models: this.#ctx.models.registry } : {}),
    });
    if (!check.ok || check.doc === null) {
      throw new RpcError(-32013, `WorkflowSpec 校验失败(${check.issues.length} 处)`, {
        data: {
          code: 'WORKFLOW_INVALID',
          issues: check.issues.map((i) => ({ code: i.code, field: i.field, message: i.message })),
        },
      });
    }
    const workflow = toEngineWorkflow(check.doc);

    let intent: IntentDoc | undefined;
    if (p['intent'] !== undefined && p['intent'] !== null) {
      intent = parseIntent(p['intent']);
    }

    let secretIds: string[] | undefined;
    if (p['secret_ids'] !== undefined && p['secret_ids'] !== null) {
      if (!Array.isArray(p['secret_ids']) || (p['secret_ids'] as unknown[]).some((s) => typeof s !== 'string' || s.length === 0)) {
        throw new InvalidParams('workflow.run: params.secret_ids 必须是非空字符串数组', { field: 'secret_ids' });
      }
      secretIds = [...(p['secret_ids'] as string[])];
    }

    const taskId = newTaskId(this.#ctx.now);
    // 任务级 agentId 统一 <task>/<实例> 形态(协议 §3.3 冻结格式,capability/
    // messenger 的 AGENT_ID_RE 同源):workflow 任务的实例段固定为 `workflow`
    // (与 preset 前缀 `workflow:` 同源)。裸 <taskId> 会让拿着 task.status 的
    // agent_id 去 approvals.submit 的调用方在 decide→grant 撞 AGENT_ID_INVALID
    // (issue #4)。各节点的 agent 仍是引擎派的 <task>/<nodeId>,互不冲突。
    const record: TaskRecord = {
      taskId,
      agentId: `${taskId}/workflow`,
      tenant,
      session,
      intent: intent?.goal ?? workflow.intent_ref,
      preset: `workflow:${workflow.nodes.map((n) => n.preset).join('+')}`,
      createdAt: (this.#ctx.now?.() ?? new Date()).toISOString(),
      status: 'created',
      error: null,
      mountIntents: [],
    };
    this.#ctx.tasks.upsert(record);

    // 预算台账(可选):hard 触发 → 引擎 budget_paused → 任务 paused。
    let budget: BudgetLedger | null = null;
    const rawBudget = p['budget'];
    if (rawBudget !== undefined && rawBudget !== null) {
      if (typeof rawBudget !== 'object' || Array.isArray(rawBudget)) {
        throw new InvalidParams('workflow.run: params.budget 必须是对象', { field: 'budget' });
      }
      const b = rawBudget as Record<string, unknown>;
      const limitTokens = b['limit_tokens'];
      if (!Number.isInteger(limitTokens) || (limitTokens as number) < 0) {
        throw new InvalidParams('workflow.run: params.budget.limit_tokens 必须是非负整数', {
          field: 'budget.limit_tokens',
        });
      }
      const softRatio = b['soft_ratio'];
      if (softRatio !== undefined && (typeof softRatio !== 'number' || softRatio <= 0 || softRatio > 1)) {
        throw new InvalidParams('workflow.run: params.budget.soft_ratio 必须在 (0,1] 内', {
          field: 'budget.soft_ratio',
        });
      }
      budget = new BudgetLedger(
        { limitTokens: limitTokens as number, ...(softRatio !== undefined ? { softRatio } : {}) },
        { emit: makeBudgetEmit(this.#ctx.events, this.#ctx.tasks, taskId) },
      );
      this.#ctx.budgets?.set(taskId, budget);
    }

    const runP = engine.run({
      tenant,
      session,
      taskId,
      workflow,
      ...(intent !== undefined ? { intent } : {}),
      ...(budget !== null ? { budget } : {}),
      ...(secretIds !== undefined ? { secretIds } : {}),
      // intent.constraints.max_parallel → 引擎并行派发上限(§3.5,P3)。
      ...(intent?.constraints?.max_parallel !== undefined ? { maxParallel: intent.constraints.max_parallel } : {}),
    });
    // 非事件终态的引擎异常(内部错误):补落 node.failed(重放可重建)再标 failed。
    void runP.catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      void this.#ctx.events
        .append({
          type: 'node.failed',
          principal: { tenant, session, task: taskId, agent: null },
          payload: { nodeId: '(engine)', attempt: 0, reason: 'crash', detail },
        })
        .then(() => this.#ctx.tasks.markFailed(taskId, detail))
        .catch(() => this.#ctx.tasks.markFailed(taskId, detail));
    });
    return { task_id: taskId, status: record.status };
  }

  async taskPause(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const engine = this.#requireEngine('task.pause');
    const p = requireObject(params, 'task.pause');
    const taskId = requireString(p, 'task_id', 'task.pause');
    this.#requireTask(taskId, identity);
    return { task_id: taskId, paused: engine.pause(taskId) };
  }

  /**
   * 恢复执行:校验类错误(RunUnknown/RunNotPaused)等首个 tick 内同步回给
   * 调用方;续跑本身异步推进,终态经 task.status / 事件流观察。
   */
  async taskResume(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const engine = this.#requireEngine('task.resume');
    const p = requireObject(params, 'task.resume');
    const taskId = requireString(p, 'task_id', 'task.resume');
    const record = this.#requireTask(taskId, identity);
    const runP = engine.resume(taskId);
    const settled = await Promise.race([
      runP.then(
        () => null,
        (err: unknown) => err,
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
    ]);
    if (settled !== null) throw settled;
    void runP.catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      void this.#ctx.events
        .append({
          type: 'node.failed',
          principal: { tenant: record.tenant, session: record.session, task: taskId, agent: null },
          payload: { nodeId: '(engine)', attempt: 0, reason: 'crash', detail },
        })
        .then(() => this.#ctx.tasks.markFailed(taskId, detail))
        .catch(() => this.#ctx.tasks.markFailed(taskId, detail));
    });
    const status = this.#ctx.tasks.get(taskId)?.status ?? 'running';
    return { task_id: taskId, status };
  }

  async taskCancel(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const engine = this.#requireEngine('task.cancel');
    const p = requireObject(params, 'task.cancel');
    const taskId = requireString(p, 'task_id', 'task.cancel');
    this.#requireTask(taskId, identity);
    return { task_id: taskId, cancelled: engine.cancel(taskId) };
  }

  // ---------------------------------------------------------------- P2:审批人机入口

  async approvalsList(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const board = this.#ctx.board;
    if (board === undefined) {
      throw new RpcError(-32020, 'approvals.list: daemon 未配置审批台账', {
        data: { code: 'BOARD_NOT_WIRED' },
        httpStatus: 501,
      });
    }
    const p = requireObject(params, 'approvals.list');
    const status = optionalString(p, 'status', 'approvals.list');
    const approvals = status === undefined || status === 'all'
      ? board.listAll()
      : status === 'pending'
        ? board.listPending()
        : (() => {
            throw new InvalidParams('approvals.list: params.status 必须是 pending/all', { field: 'status' });
          })();
    // M3:session 身份只见本人会话任务的审批单(admin 全量,现语义)。
    const visible = identity.kind !== 'session'
      ? approvals
      : approvals.filter((r) => {
          const idx = r.agentId.indexOf('/');
          const record = idx > 0 ? this.#ctx.tasks.get(r.agentId.slice(0, idx)) : undefined;
          return record !== undefined &&
            record.tenant === (identity.tenant ?? DEFAULT_TENANT) &&
            record.session === (identity.session ?? '');
        });
    return { approvals: visible };
  }

  /**
   * 提交审批单(§3.3 tool.request 的公面入口):外部编排者/主控可据此发起
   * 审批闭环 —— v0.x 引擎不因 escalation.require_approval 自动挂起(已知
   * 边界),pending 单一律经本操作显式产生,复用 ApprovalBoard.submit 的
   * 校验(cap/scope/duration)与台账语义,不另起炉灶。
   *
   * 申请人 agent 取任务记录的 agent_id(task.create 任务 = <task>/worker-01,
   * workflow 任务 = <task>);会话鉴权与现有写操作一致(#requireTask:session
   * token 只能为本会话名下任务提交,异主 → SESSION_FORBIDDEN 403)。
   */
  async approvalsSubmit(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const board = this.#ctx.board;
    if (board === undefined) {
      throw new RpcError(-32020, 'approvals.submit: daemon 未配置审批台账', {
        data: { code: 'BOARD_NOT_WIRED' },
        httpStatus: 501,
      });
    }
    const p = requireObject(params, 'approvals.submit');
    const taskId = requireString(p, 'task_id', 'approvals.submit');
    const task = this.#requireTask(taskId, identity);
    const cap = requireString(p, 'cap', 'approvals.submit');
    const scope = requireString(p, 'scope', 'approvals.submit');
    const duration = requireString(p, 'duration', 'approvals.submit');
    const reason = optionalString(p, 'reason', 'approvals.submit') ?? '';
    const reqId = optionalString(p, 'req_id', 'approvals.submit') ?? newReqId(this.#ctx.now);
    const result = await board.submit({
      from: task.agentId,
      reqId,
      cap,
      reason,
      scope: scope as Scope,
      duration,
    });
    return result.status === 'auto_granted'
      ? { req_id: result.record.reqId, status: result.status, record: result.record, manifest: result.manifest }
      : { req_id: result.record.reqId, status: result.status, record: result.record };
  }

  async approvalsDecide(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const board = this.#ctx.board;
    if (board === undefined) {
      throw new RpcError(-32020, 'approvals.decide: daemon 未配置审批台账', {
        data: { code: 'BOARD_NOT_WIRED' },
        httpStatus: 501,
      });
    }
    const p = requireObject(params, 'approvals.decide');
    const reqId = requireString(p, 'req_id', 'approvals.decide');
    const decision = requireString(p, 'decision', 'approvals.decide');
    if (decision !== 'granted' && decision !== 'denied') {
      throw new InvalidParams('approvals.decide: params.decision 必须是 granted/denied', { field: 'decision' });
    }
    let by = optionalString(p, 'by', 'approvals.decide') ?? 'cli';
    // M3 审批权绑定:session 身份只能定案本人会话任务的审批单(agentId 的
    // task 段 → TaskRecord 前两层比对),定案人强制记为会话身份;admin 保持
    // 自由 by(现语义)。审批单不存在时同样按越权拒绝,不给探测空间。
    if (identity.kind === 'session') {
      const tenant = identity.tenant ?? DEFAULT_TENANT;
      const session = identity.session ?? '';
      const target = board.listAll().find((r) => r.reqId === reqId);
      if (target === undefined) throw new ApprovalForbidden(reqId, tenant, session);
      const idx = target.agentId.indexOf('/');
      const taskId = idx > 0 ? target.agentId.slice(0, idx) : target.agentId;
      const task = this.#ctx.tasks.get(taskId);
      if (task === undefined || task.tenant !== tenant || task.session !== session) {
        throw new ApprovalForbidden(reqId, tenant, session);
      }
      by = `${tenant}/${session}`;
    }
    const narrowedTo = optionalString(p, 'narrowed_to', 'approvals.decide');
    // 定案前快照该 agent 的 manifest(差量落 grant.granted 事件用)。
    const record = board.listAll().find((r) => r.reqId === reqId);
    const beforeManifest = record !== undefined
      ? this.#ctx.tasks.manifest(record.agentId)
      : undefined;
    const result = await board.decide(
      reqId,
      decision,
      by,
      ...(narrowedTo !== undefined ? [{ narrowedTo }] : []),
    );
    if (result.status === 'granted' && result.manifest !== undefined) {
      // escalation 授予补进事件流 + TaskStore 快照(GrantExecutor 的审计 sink
      // 只覆盖基线 apply 上下文,审批授予从这里入账)。
      await emitEscalationGrants(
        this.#ctx.events,
        this.#ctx.tasks,
        result.record.agentId,
        result.manifest,
        beforeManifest?.grants ?? [],
        `manual:${by}`,
      );
    }
    return { decision: result.status, record: result.record };
  }

  // ---------------------------------------------------------------- P2:预算人机入口

  async budgetStatus(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const p = requireObject(params, 'budget.status');
    const taskId = requireString(p, 'task_id', 'budget.status');
    this.#requireTask(taskId, identity);
    const ledger = this.#ctx.budgets?.get(taskId);
    return { task_id: taskId, budget: ledger === undefined ? null : budgetSnapshot(ledger) };
  }

  /** 续预算(§3.5f hard 处置):抬 limit 后调用方 task.resume 续跑。 */
  async budgetRaise(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const p = requireObject(params, 'budget.raise');
    const taskId = requireString(p, 'task_id', 'budget.raise');
    this.#requireTask(taskId, identity);
    const limitTokens = p['limit_tokens'];
    if (!Number.isInteger(limitTokens) || (limitTokens as number) < 0) {
      throw new InvalidParams('budget.raise: params.limit_tokens 必须是非负整数', { field: 'limit_tokens' });
    }
    const ledger = this.#ctx.budgets?.get(taskId);
    if (ledger === undefined) {
      throw new RpcError(-32015, `task 无预算台账(未配置预算或已终态): ${taskId}`, {
        data: { code: 'BUDGET_UNKNOWN', task_id: taskId },
        httpStatus: 404,
      });
    }
    const result = ledger.raise(limitTokens as number);
    return { task_id: taskId, raised: true, re_armed: result.reArmed, ...budgetSnapshot(ledger) };
  }

  // ---------------------------------------------------------------- P2:模型评分

  async modelsList(): Promise<unknown> {
    return { models: this.#ctx.models?.registry.entries ?? [] };
  }

  /** 人工/主控反馈(§3.9 EMA);registry 不可变替换后回写持久化文件。 */
  async modelsFeedback(params: unknown): Promise<unknown> {
    const store = this.#ctx.models;
    if (store === undefined) {
      throw new RpcError(-32020, 'models.feedback: daemon 未配置模型评分注册表', {
        data: { code: 'MODELS_NOT_WIRED' },
        httpStatus: 501,
      });
    }
    const p = requireObject(params, 'models.feedback');
    const model = requireString(p, 'model', 'models.feedback');
    const tierValue = requireString(p, 'tier', 'models.feedback');
    if (!(TIERS as readonly string[]).includes(tierValue)) {
      throw new InvalidParams(`models.feedback: params.tier 必须是 ${TIERS.join('/')}`, { field: 'tier' });
    }
    const tier = tierValue as Tier;
    const success = p['success'];
    if (typeof success !== 'boolean') {
      throw new InvalidParams('models.feedback: params.success 必须是布尔值', { field: 'success' });
    }
    const quality = p['quality'];
    if (quality !== undefined && quality !== null && (typeof quality !== 'number' || quality < 0 || quality > 1)) {
      throw new InvalidParams('models.feedback: params.quality 必须在 [0,1] 内', { field: 'quality' });
    }
    const traversals = p['traversals'];
    if (traversals !== undefined && traversals !== null && (!Number.isInteger(traversals) || (traversals as number) < 0)) {
      throw new InvalidParams('models.feedback: params.traversals 必须是 ≥0 的整数', { field: 'traversals' });
    }
    const feedback: ModelFeedback = {
      model,
      tier,
      success,
      ...(typeof quality === 'number' ? { quality } : {}),
      taskType: optionalString(p, 'task_type', 'models.feedback') ?? 'unknown',
      budgetTier: optionalString(p, 'budget_tier', 'models.feedback') ?? 'unknown',
      traversals: typeof traversals === 'number' ? traversals : 0,
    };
    const result = recordFeedback(
      store.registry,
      feedback,
      ...(this.#ctx.now !== undefined ? [{ now: this.#ctx.now }] : []),
    );
    store.apply(result.entry);
    if (this.#ctx.modelsPath !== undefined) {
      await persistModels(this.#ctx.modelsPath, store.registry.entries);
    }
    return {
      model,
      tier,
      observed: result.entry.score.observed[tier],
      samples: result.entry.score.samples[tier],
      alpha_applied: result.alphaApplied,
    };
  }

  // ---------------------------------------------------------------- M4:观测线

  /**
   * events.list(M4 观测线):读走 EventLog.readByPrincipal(§6 事件日志 =
   * 唯一事实源,查询与审计同一份)。
   *
   * 过滤语义:
   *   - session 身份:principal 锁死签发时绑定的 (tenant, session) 命名空间
   *     (#resolvePrincipal 同款语义 —— 省略 = 取绑定值,显式异值 →
   *     SESSION_FORBIDDEN,会话未激活 → SESSION_UNKNOWN);可再叠加 task/type;
   *   - admin:全量(不带 tenant/session = 全部 tenant,含 daemon 级
   *     session 为 null 的事件);传 tenant/session/task/type 逐层收窄;
   *   - limit:非负整数,返回时间序最近的 N 条;缺省全量。
   */
  async eventsList(params: unknown, identity: RequestIdentity = ADMIN_IDENTITY): Promise<unknown> {
    const p = requireObject(params, 'events.list');
    const task = optionalString(p, 'task', 'events.list');
    const type = optionalString(p, 'type', 'events.list');
    if (type !== undefined && !(EVENT_TYPES as readonly string[]).includes(type)) {
      throw new InvalidParams(
        `events.list: params.type 必须是已知事件类型(闭集,如 ${EVENT_TYPES.slice(0, 4).join('/')})`,
        { field: 'type' },
      );
    }
    const limit = p['limit'];
    if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || (limit as number) < 0)) {
      throw new InvalidParams('events.list: params.limit 必须是非负整数', { field: 'limit' });
    }
    const sessionParam = optionalString(p, 'session', 'events.list');
    let filter: PrincipalFilter;
    if (identity.kind === 'session' || sessionParam !== undefined) {
      const { tenant, session } = this.#resolvePrincipal(p, 'events.list', identity);
      filter = { tenant, session };
    } else {
      const tenant = optionalString(p, 'tenant', 'events.list');
      // admin 未点名 session:不按该层过滤(保留 daemon 级 session=null 事件)。
      filter = { ...(tenant !== undefined ? { tenant } : {}) };
    }
    if (task !== undefined) filter = { ...filter, task };
    if (type !== undefined) filter = { ...filter, types: [type as EventType] };
    const events = await this.#ctx.events.readByPrincipal(filter);
    const sliced = typeof limit === 'number' && limit < events.length
      ? events.slice(-limit)
      : events;
    return { events: sliced, count: sliced.length };
  }
}

/**
 * 已注册操作闭集(方法表;`Operations.has` 判未知 method,api-doc.ts 的
 * 操作描述符表与本表同源对照,一致性测试防漂移)。
 */
export const OPERATIONS: readonly string[] = [
  'session.init',
  'capabilities.list',
  'task.create',
  'task.status',
  'task.list',
  'artifacts.publish',
  'artifacts.resolve',
  'artifacts.read',
  'grants.of',
  'workflow.run',
  'task.pause',
  'task.resume',
  'task.cancel',
  'approvals.list',
  'approvals.submit',
  'approvals.decide',
  'budget.status',
  'budget.raise',
  'models.list',
  'models.feedback',
  'events.list',
];

/** task id:`task-` + 时间戳基36 + 随机段,满足工件路径段与分片段约束。 */
function newTaskId(now?: () => Date): string {
  const t = (now?.() ?? new Date()).getTime().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `task-${t}-${r}`;
}

/** 审批单 id 缺省生成:`req-` + 时间戳基36 + 随机段(approvals.submit 未显式给 req_id 时)。 */
function newReqId(now?: () => Date): string {
  const t = (now?.() ?? new Date()).getTime().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `req-${t}-${r}`;
}

function budgetSnapshot(ledger: BudgetLedger): Record<string, unknown> {
  return {
    limit_tokens: ledger.limitTokens,
    soft_tokens: ledger.softTokens,
    observed_tokens: ledger.observedTokens,
    level: ledger.level,
  };
}

/**
 * 绑定形式 → 引擎形式的适配:WorkflowSpec 里 inputs/outputs 用
 * `<节点>.outputs.<工件>` 绑定(PlanCheck 据此校验端口与证据);引擎内部
 * outputs 表按节点 id 索引(collectInputs/topoSort/输出解析),这里把绑定
 * 降为节点 id。端口合法性已由 PlanCheck 保证,工件集合由引擎整体透传。
 */
function toEngineWorkflow(doc: WorkflowDoc): WorkflowDoc {
  const nodeOf = (binding: string): string => parseOutputBinding(binding)?.node ?? binding;
  return {
    ...doc,
    nodes: doc.nodes.map((n) => ({
      ...n,
      ...(n.inputs !== undefined ? { inputs: n.inputs.map((i) => ({ from: nodeOf(i.from) })) } : {}),
    })),
    outputs: doc.outputs.map((o) => ({ ...o, from: nodeOf(o.from) })),
  };
}

/** modelscore 注册表回写(原子写,modelscore/1.0 容器格式)。 */
async function persistModels(path: string, entries: readonly unknown[]): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  const body = JSON.stringify({ api: 'modelscore/1.0', models: entries }, null, 2) + '\n';
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}
