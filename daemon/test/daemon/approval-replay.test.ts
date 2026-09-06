/**
 * #14 回归:审批台账自事件重放重建 —— 重启后 pending 审批单仍可
 * approvals.decide(含 session 身份鉴权经 listAll 查台账,重启后不再
 * ApprovalForbidden);decide 授予与事件经重放恢复的接线端到端验证。
 * in-process startDaemon + 真实 HTTP 面(与前述 daemon 测试同风格)。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { startDaemon } from '../../src/daemon/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';
import { DEFAULT_TENANT } from '../../src/daemon/operations.ts';

const roots: string[] = [];
const handles: DaemonHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle === undefined) break;
    await handle.stop().catch(() => {});
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function start(stateDir: string): Promise<DaemonHandle> {
  const handle = await startDaemon({ port: 0, stateDir });
  handles.push(handle); // afterEach 统一停服,否则 HTTP server 挂住事件循环。
  return handle;
}

async function rpc(
  handle: DaemonHandle,
  method: string,
  params: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${handle.baseUrl}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token ?? handle.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function result(body: Record<string, unknown>): Record<string, unknown> {
  return body['result'] as Record<string, unknown>;
}

describe('审批台账重启重放(#14 回归)', () => {
  it('重启后 pending 单可被 session 身份 decide,授予入 manifest', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-issue14-'));
    roots.push(stateDir);
    const first = await start(stateDir);

    // 会话登记 + 会话名下任务。
    const init = await rpc(first, 'session.init', {
      protocol: '1.0',
      role: 'orchestrator',
      principal: { tenant: DEFAULT_TENANT, session: 'dev-1' },
      harness: 'issue14-harness',
      capabilities: {},
    });
    const sessionToken = result(init.body)['token'] as string;

    const created = await rpc(first, 'task.create', { intent: '审批回归', preset: 'minimal' }, sessionToken);
    assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300));
    const agentId = result(created.body)['agent_id'] as string;
    const taskId = result(created.body)['task_id'] as string;

    // 提交审批单(缺省策略:builtin 全 require → pending)。
    const submitted = await rpc(
      first,
      'approvals.submit',
      { task_id: taskId, cap: 'fs:workdir', scope: 'rw', duration: '2h', reason: '需要写工作目录', req_id: 'req-r1' },
      sessionToken,
    );
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body).slice(0, 300));
    assert.equal(result(submitted.body)['status'], 'pending');

    await first.stop();
    handles.pop();

    // 重启:台账从 approval.requested 事件重建,session 鉴权(listAll)可命中。
    const second = await start(stateDir);
    const list = await rpc(second, 'approvals.list', { status: 'pending' }, sessionToken);
    assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300));
    const pending = result(list.body)['approvals'] as Record<string, unknown>[];
    assert.deepEqual(pending.map((r) => r['reqId']), ['req-r1']);

    // 重启前这里一律 ApprovalForbidden —— 现在可正常定案。
    const decided = await rpc(
      second,
      'approvals.decide',
      { req_id: 'req-r1', decision: 'granted' },
      sessionToken,
    );
    assert.equal(decided.status, 200, JSON.stringify(decided.body).slice(0, 300));
    assert.equal(result(decided.body)['decision'], 'granted');
    const record = result(decided.body)['record'] as Record<string, unknown>;
    assert.equal(record['decidedBy'], `${DEFAULT_TENANT}/dev-1`); // session 身份强制记为会话

    // 授予入 manifest 快照(grant.granted 事件 + TaskStore)。
    const of = await rpc(second, 'grants.of', { agent_id: agentId }, sessionToken);
    assert.equal(of.status, 200, JSON.stringify(of.body).slice(0, 300));
    const manifest = result(of.body)['manifest'] as Record<string, unknown>;
    const grants = manifest['grants'] as Record<string, unknown>[];
    assert.ok(
      grants.some((g) => g['cap'] === 'fs:workdir' && String(g['source']).startsWith('escalation:')),
      JSON.stringify(manifest),
    );
    // decided 事件已落同一份日志(重启前后两次会话可读)。
    const events = await second.events.readByPrincipal({ tenant: DEFAULT_TENANT, task: taskId });
    assert.equal(events.filter((e) => e.type === 'approval.decided').length, 1);
  });
});
