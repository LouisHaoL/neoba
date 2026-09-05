/**
 * 任务内存态 + 事件重放构建(§6 状态与恢复:内存态 = 重放)。
 *
 * P1 的 task.create 是单节点闭环:node.started → grant.granted×n →
 * node.completed / node.failed。task 的业务字段(intent/preset/挂载意图)
 * 不在事件 payload 闭集内,经 EventPayloadBase.extra 携带(前向兼容位);
 * grants.of 的 manifest 也在重放中由 grant.granted / grant.revoked 重建。
 *
 * P2 扩展任务状态机:workflow.run 的任务按事件流推进
 *   created → running → (waiting_approval | paused)? → completed / failed / cancelled
 * 映射(重放与实时共用 applyTaskEvent,保证两态一致):
 *   node.started                → running(已有记录则只推进状态,不覆盖业务字段)
 *   node.completed              → completed(工作流任务须全部节点完成,见下)
 *   node.failed(budget_paused)  → paused(预算熔断挂起,续预算后 resume)
 *   node.failed(cancelled)      → cancelled
 *   node.failed(其它)           → failed
 *   approval.requested          → waiting_approval(有人工审批单挂着)
 *   budget.exceeded             → paused
 */
import type { Event } from '../events/index.ts';
import type { AuditEntry, Grant, GrantConstraint, GrantManifest, Scope } from '../capability/index.ts';

export type TaskStatus =
  | 'created'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskRecord {
  readonly taskId: string;
  readonly agentId: string;
  readonly tenant: string;
  readonly session: string | null;
  readonly intent: string;
  readonly preset: string;
  readonly createdAt: string;
  status: TaskStatus;
  error: string | null;
  mountIntents: readonly Record<string, unknown>[];
}

interface AgentGrantState {
  grants: Grant[];
  audit: AuditEntry[];
}

export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly manifests = new Map<string, GrantManifest>();
  private readonly doneNodes = new Map<string, Set<string>>();

  upsert(record: TaskRecord): void {
    this.tasks.set(record.taskId, record);
  }

  markRunning(taskId: string): void {
    const record = this.tasks.get(taskId);
    if (record !== undefined && isTransitional(record.status)) record.status = 'running';
  }

  markWaitingApproval(taskId: string): void {
    const record = this.tasks.get(taskId);
    if (record !== undefined && isTransitional(record.status)) record.status = 'waiting_approval';
  }

  markPaused(taskId: string): void {
    const record = this.tasks.get(taskId);
    if (record !== undefined && isTransitional(record.status)) record.status = 'paused';
  }

  markCompleted(taskId: string): void {
    const record = this.tasks.get(taskId);
    if (record !== undefined) record.status = 'completed';
  }

  markFailed(taskId: string, error: string): void {
    const record = this.tasks.get(taskId);
    if (record !== undefined) {
      record.status = 'failed';
      record.error = error;
    }
  }

  markCancelled(taskId: string, error: string | null = null): void {
    const record = this.tasks.get(taskId);
    if (record !== undefined) {
      record.status = 'cancelled';
      record.error = error;
    }
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  /** 已收到 node.completed 的 distinct 节点集(工作流任务按节点数判定整体完成)。 */
  completedNodes(taskId: string): Set<string> {
    let set = this.doneNodes.get(taskId);
    if (set === undefined) {
      set = new Set();
      this.doneNodes.set(taskId, set);
    }
    return set;
  }

  list(): readonly TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
  }

  setManifest(manifest: GrantManifest): void {
    this.manifests.set(manifest.agent_id, manifest);
  }

  /** 按 agent 查询 grant manifest;未注册返回 undefined。 */
  manifest(agentId: string): GrantManifest | undefined {
    return this.manifests.get(agentId);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * 从事件流重建 TaskStore(node.started/completed/failed + grant.granted/revoked,
 * 以及 P2 的 approval.requested / budget.exceeded)。
 * 未知事件类型已在 EventLog.replay 层跳过;未知字段按 §3.0 透传忽略。
 */
export function replayTasks(events: readonly Event[]): TaskStore {
  const store = new TaskStore();
  const grantStates = new Map<string, AgentGrantState>();

  for (const ev of events) {
    const principal = ev.principal;
    const agent = principal.agent;
    switch (ev.type) {
      case 'node.started':
      case 'node.completed':
      case 'node.failed':
      case 'approval.requested':
      case 'budget.exceeded':
        applyTaskEvent(store, ev);
        break;
      case 'grant.granted': {
        if (agent === null) break;
        const payload = asRecord(ev.payload);
        const state = grantStates.get(agent) ?? { grants: [], audit: [] };
        state.grants.push({
          cap: String(payload['cap'] ?? ''),
          scope: String(payload['scope'] ?? 'read') as Scope,
          source: String(payload['source'] ?? 'baseline'),
          ttl: typeof payload['ttl'] === 'string' ? payload['ttl'] : null,
          ...(payload['constraint'] !== undefined
            ? { constraint: payload['constraint'] as GrantConstraint }
            : {}),
        });
        state.audit.push({
          event: 'granted',
          cap: String(payload['cap'] ?? ''),
          by: 'daemon',
          decision_source: String(payload['decisionSource'] ?? 'auto_rule:baseline'),
          at: ev.ts,
        });
        grantStates.set(agent, state);
        break;
      }
      case 'grant.revoked': {
        if (agent === null) break;
        const payload = asRecord(ev.payload);
        const state = grantStates.get(agent);
        if (state === undefined) break;
        const cap = String(payload['cap'] ?? '');
        state.grants = state.grants.filter((grant) => grant.cap !== cap);
        state.audit.push({
          event: 'reclaimed',
          cap,
          by: 'daemon',
          decision_source: String(payload['decisionSource'] ?? 'manual:daemon'),
          at: ev.ts,
        });
        break;
      }
      default:
        break;
    }
  }

  for (const [agentId, state] of grantStates) {
    store.setManifest({
      protocol: '1.0',
      spec_version: '1.0',
      agent_id: agentId,
      grants: state.grants,
      audit: state.audit,
    });
  }
  return store;
}

/** 未终态(还允许推进)的状态集合;终态 completed/failed/cancelled 不可逆。 */
function isTransitional(status: TaskStatus): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
}

/**
 * workflow.run 任务的节点数:任务 preset 由 workflowRun 编码为
 * `workflow:<p1>+<p2>+...`;非 workflow 任务(P1 task.create 单节点闭环)
 * 返回 undefined —— 节点完成即任务完成。
 */
function expectedWorkflowNodes(preset: string | undefined): number | undefined {
  if (preset === undefined || !preset.startsWith('workflow:')) return undefined;
  return preset.slice('workflow:'.length).split('+').length;
}

/**
 * 单事件 → 任务状态推进(重放与实时 emit 共用,内存态与重放态天然一致)。
 * node.started 首见建记录(P1 task.create 的 extra 携带业务字段);已存在的
 * 记录(workflow.run 先建了 task)只推进状态,不覆盖 intent/preset。
 */
export function applyTaskEvent(store: TaskStore, ev: Event): void {
  const principal = ev.principal;
  const task = principal.task;
  if (task === null) return;
  const payload = asRecord(ev.payload);
  const extra = asRecord(payload['extra']);
  switch (ev.type) {
    case 'node.started': {
      const existing = store.get(task);
      if (existing === undefined) {
        store.upsert({
          taskId: task,
          agentId: principal.agent ?? task,
          tenant: principal.tenant,
          session: principal.session,
          intent: typeof extra['intent'] === 'string' ? extra['intent'] : '',
          preset: typeof extra['preset'] === 'string' ? extra['preset'] : '',
          createdAt: ev.ts,
          status: 'running',
          error: null,
          mountIntents: Array.isArray(extra['mountIntents'])
            ? (extra['mountIntents'] as readonly Record<string, unknown>[])
            : [],
        });
      } else {
        store.markRunning(task);
      }
      break;
    }
    case 'node.completed': {
      const record = store.get(task);
      if (Array.isArray(extra['mountIntents']) && record !== undefined) {
        record.mountIntents = extra['mountIntents'] as readonly Record<string, unknown>[];
      }
      // 工作流任务只有全部节点完成才算整体完成(否则中途 completed 会顶掉
      // running,后续节点推进被终态不可逆闸卡死);单节点闭环(P1)完成即任务完成。
      const nodeId = typeof payload['nodeId'] === 'string' ? payload['nodeId'] : '';
      if (nodeId !== '') store.completedNodes(task).add(nodeId);
      const expected = expectedWorkflowNodes(record?.preset);
      if (expected === undefined || store.completedNodes(task).size >= expected) {
        store.markCompleted(task);
      }
      break;
    }
    case 'node.failed': {
      const reason = typeof payload['reason'] === 'string' ? payload['reason'] : 'crash';
      const detail = typeof payload['detail'] === 'string' ? payload['detail'] : 'unknown';
      if (reason === 'budget_paused') {
        store.markPaused(task);
      } else if (reason === 'cancelled') {
        store.markCancelled(task, detail);
      } else {
        store.markFailed(task, detail);
      }
      break;
    }
    case 'approval.requested': {
      store.markWaitingApproval(task);
      break;
    }
    case 'budget.exceeded': {
      store.markPaused(task);
      break;
    }
    default:
      break;
  }
}
