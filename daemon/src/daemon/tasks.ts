/**
 * 任务内存态 + 事件重放构建(§6 状态与恢复:内存态 = 重放)。
 *
 * P1 的 task.create 是单节点闭环:node.started → grant.granted×n →
 * node.completed / node.failed。task 的业务字段(intent/preset/挂载意图)
 * 不在事件 payload 闭集内,经 EventPayloadBase.extra 携带(前向兼容位);
 * grants.of 的 manifest 也在重放中由 grant.granted / grant.revoked 重建。
 */
import type { Event } from '../events/index.ts';
import type { AuditEntry, Grant, GrantManifest, Scope } from '../capability/index.ts';

export type TaskStatus = 'created' | 'completed' | 'failed';

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

  upsert(record: TaskRecord): void {
    this.tasks.set(record.taskId, record);
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

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
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
 * 从事件流重建 TaskStore(node.started/completed/failed + grant.granted/revoked)。
 * 未知事件类型已在 EventLog.replay 层跳过;未知字段按 §3.0 透传忽略。
 */
export function replayTasks(events: readonly Event[]): TaskStore {
  const store = new TaskStore();
  const grantStates = new Map<string, AgentGrantState>();

  for (const ev of events) {
    const principal = ev.principal;
    const agent = principal.agent;
    switch (ev.type) {
      case 'node.started': {
        if (principal.task === null) break;
        const extra = asRecord(asRecord(ev.payload)['extra']);
        const intent = typeof extra['intent'] === 'string' ? extra['intent'] : '';
        const preset = typeof extra['preset'] === 'string' ? extra['preset'] : '';
        const mountIntents = Array.isArray(extra['mountIntents'])
          ? (extra['mountIntents'] as readonly Record<string, unknown>[])
          : [];
        store.upsert({
          taskId: principal.task,
          agentId: agent ?? principal.task,
          tenant: principal.tenant,
          session: principal.session,
          intent,
          preset,
          createdAt: ev.ts,
          status: 'created',
          error: null,
          mountIntents,
        });
        break;
      }
      case 'node.completed': {
        if (principal.task === null) break;
        const extra = asRecord(asRecord(ev.payload)['extra']);
        if (Array.isArray(extra['mountIntents'])) {
          const record = store.get(principal.task);
          if (record !== undefined) {
            record.mountIntents = extra['mountIntents'] as readonly Record<string, unknown>[];
          }
        }
        store.markCompleted(principal.task);
        break;
      }
      case 'node.failed': {
        if (principal.task === null) break;
        const payload = asRecord(ev.payload);
        const detail = typeof payload['detail'] === 'string' ? payload['detail'] : 'unknown';
        store.markFailed(principal.task, detail);
        break;
      }
      case 'grant.granted': {
        if (agent === null) break;
        const payload = asRecord(ev.payload);
        const state = grantStates.get(agent) ?? { grants: [], audit: [] };
        state.grants.push({
          cap: String(payload['cap'] ?? ''),
          scope: String(payload['scope'] ?? 'read') as Scope,
          source: String(payload['source'] ?? 'baseline'),
          ttl: typeof payload['ttl'] === 'string' ? payload['ttl'] : null,
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
