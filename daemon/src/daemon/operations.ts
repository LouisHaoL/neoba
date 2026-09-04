/**
 * P1 操作集(§6 daemon localhost API;审批流/编排明确不做):
 *
 *   session.init / capabilities.list / task.create / task.status / task.list /
 *   artifacts.publish / artifacts.resolve / artifacts.read / grants.of
 *
 * handler 抛模块层类型化错误(session/capability/artifacts)或 RpcError,
 * 由 http.ts 统一映射为 JSON-RPC error 结构。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ArtifactRepository,
  ArtifactNamespace,
} from '../artifacts/index.ts';
import type {
  EventLog,
  Principal,
} from '../events/index.ts';
import type { GrantAuditEvent } from '../capability/index.ts';
import type { EventSink, GrantExecutor, LoadedRegistry, Preset } from '../capability/index.ts';
import type { DaemonProfile, SessionRegistry } from '../session/index.ts';
import { handleSessionInit } from '../session/index.ts';
import { InvalidParams, PresetUnknown, SessionUnknown, TaskNotFound } from './errors.ts';
import type { TaskStore } from './tasks.ts';

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
  readonly grants: GrantExecutor;
  readonly tasks: TaskStore;
  readonly events: EventLog;
  readonly artifacts: ArtifactRepository;
  readonly presets: Readonly<Record<string, Preset>>;
  readonly now?: () => Date;
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

  /** 分发一个 P1 操作;未知 method 抛错由调用方处理。 */
  async call(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'session.init':
        return this.sessionInit(params);
      case 'capabilities.list':
        return { capabilities: this.#ctx.registry.capabilities };
      case 'task.create':
        return this.taskCreate(params);
      case 'task.status':
        return this.taskStatus(params);
      case 'task.list':
        return { tasks: this.#ctx.tasks.list() };
      case 'artifacts.publish':
        return this.artifactPublish(params);
      case 'artifacts.resolve':
        return this.artifactResolve(params);
      case 'artifacts.read':
        return this.artifactRead(params);
      case 'grants.of':
        return this.grantsOf(params);
      default:
        throw new InvalidParams(`未知操作: ${method}`, { method });
    }
  }

  /** 是否为已注册操作(未知 method 由 HTTP 层报 -32601)。 */
  static has(method: string): boolean {
    return OPERATIONS.includes(method);
  }

  async sessionInit(params: unknown): Promise<unknown> {
    // HTTP 层 params 只有 SessionInitParams;handleSessionInit 期望完整请求文档。
    const result = handleSessionInit(
      { method: 'session.init', params },
      this.#ctx.profile,
      this.#ctx.sessions,
      { now: this.#ctx.now?.() },
    );
    return { response: result.response, warnings: result.warnings, session: result.session };
  }

  /**
   * 解析 principal 前两层:声明了 session 必须在活跃会话表中;tenant 未显式
   * 给出时按 session 名在会话表中反查(单 tenant 部署为主,命中第一个)。
   */
  #resolvePrincipal(
    params: Record<string, unknown>,
    method: string,
  ): { tenant: string; session: string | null } {
    const tenantParam = optionalString(params, 'tenant', method);
    const sessionParam = optionalString(params, 'session', method);
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

  async taskCreate(params: unknown): Promise<unknown> {
    const p = requireObject(params, 'task.create');
    const intent = requireString(p, 'intent', 'task.create');
    const presetName = requireString(p, 'preset', 'task.create');
    const { tenant, session } = this.#resolvePrincipal(p, 'task.create');
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
      const scopeQueue = new Map<string, string[]>();
      for (const grant of preset.baseline_grants) {
        const list = scopeQueue.get(grant.cap) ?? [];
        list.push(grant.scope);
        scopeQueue.set(grant.cap, list);
      }
      const { manifest, mountIntents } = await this.#apply.run(
        { principal, scopeQueue },
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

  async taskStatus(params: unknown): Promise<unknown> {
    const p = requireObject(params, 'task.status');
    const taskId = requireString(p, 'task_id', 'task.status');
    const record = this.#ctx.tasks.get(taskId);
    if (record === undefined) throw new TaskNotFound(taskId);
    return { task: record };
  }

  /** 工件命名空间 = principal 前两层 + 显式 task 段。 */
  #resolveNamespace(
    params: Record<string, unknown>,
    method: string,
  ): { ns: ArtifactNamespace; sessionId: string | null } {
    const { tenant, session } = this.#resolvePrincipal(params, method);
    const task = requireString(params, 'task', method);
    return { ns: { tenant, task }, sessionId: session };
  }

  async artifactPublish(params: unknown): Promise<unknown> {
    const p = requireObject(params, 'artifacts.publish');
    const { ns } = this.#resolveNamespace(p, 'artifacts.publish');
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

  async artifactResolve(params: unknown): Promise<unknown> {
    const p = requireObject(params, 'artifacts.resolve');
    const { ns } = this.#resolveNamespace(p, 'artifacts.resolve');
    const node = requireString(p, 'node', 'artifacts.resolve');
    const name = requireString(p, 'name', 'artifacts.resolve');
    const ref = await this.#ctx.artifacts.resolve(ns, node, name);
    return ref;
  }

  async artifactRead(params: unknown): Promise<unknown> {
    const p = requireObject(params, 'artifacts.read');
    const { ns } = this.#resolveNamespace(p, 'artifacts.read');
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
}

const OPERATIONS: readonly string[] = [
  'session.init',
  'capabilities.list',
  'task.create',
  'task.status',
  'task.list',
  'artifacts.publish',
  'artifacts.resolve',
  'artifacts.read',
  'grants.of',
];

/** task id:`task-` + 时间戳基36 + 随机段,满足工件路径段与分片段约束。 */
function newTaskId(now?: () => Date): string {
  const t = (now?.() ?? new Date()).getTime().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `task-${t}-${r}`;
}
