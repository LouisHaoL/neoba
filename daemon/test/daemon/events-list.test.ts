/**
 * M4 观测线:events.list RPC —— 读走 EventLog.readByPrincipal;
 * admin 全量与逐层收窄(tenant/session/task/type/limit)、session 身份
 * 锁死绑定命名空间(越界 SESSION_FORBIDDEN,未激活 SESSION_UNKNOWN)、
 * params 校验。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { startDaemon } from '../../src/daemon/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';
import type { Event } from '../../src/events/index.ts';

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

async function start(): Promise<DaemonHandle> {
  const stateDir = await mkdtemp(join(tmpdir(), 'neoba-events-list-'));
  roots.push(stateDir);
  const handle = await startDaemon({ port: 0, stateDir });
  handles.push(handle);
  return handle;
}

async function rpc(
  handle: DaemonHandle,
  token: string,
  method: string,
  params: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${handle.baseUrl}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function eventsOf(body: Record<string, unknown>): Event[] {
  return ((body['result'] as Record<string, unknown>)?.['events'] ?? []) as Event[];
}

describe('events.list(M4 观测线)', () => {
  it('admin 全量:含 daemon 级与任务级事件;type 收窄生效', async () => {
    const handle = await start();
    await rpc(handle, handle.token, 'task.create', { intent: '观测任务', preset: 'minimal' });

    const all = await rpc(handle, handle.token, 'events.list', {});
    assert.equal(all.status, 200);
    const events = eventsOf(all.body);
    assert.ok(events.some((e) => e.type === 'daemon.started'));
    assert.ok(events.some((e) => e.type === 'node.started'));
    assert.ok(events.some((e) => e.principal.session === null), 'admin 全量保留 daemon 级(session=null)事件');

    const started = await rpc(handle, handle.token, 'events.list', { type: 'daemon.started' });
    const narrowed = eventsOf(started.body);
    assert.ok(narrowed.length >= 1);
    assert.ok(narrowed.every((e) => e.type === 'daemon.started'));
  });

  it('admin 按 task 收窄:只回该任务命名空间的事件', async () => {
    const handle = await start();
    const created = await rpc(handle, handle.token, 'task.create', { intent: '过滤目标', preset: 'minimal' });
    const taskId = ((created.body['result'] as Record<string, unknown>)['task_id']) as string;
    await rpc(handle, handle.token, 'task.create', { intent: '噪声任务', preset: 'minimal' });

    const res = await rpc(handle, handle.token, 'events.list', { task: taskId });
    const events = eventsOf(res.body);
    assert.ok(events.length >= 2);
    assert.ok(events.every((e) => e.principal.task === taskId));
    assert.ok(events.some((e) => e.type === 'node.completed'));
  });

  it('admin 按 session 收窄(不误伤 daemon 级事件的条件查询)', async () => {
    const handle = await start();
    await rpc(handle, handle.token, 'session.init', {
      protocol: '1.0',
      role: 'orchestrator',
      principal: { tenant: 'acme', session: 'dev-1' },
      harness: 'test',
      capabilities: {},
    });
    await rpc(handle, handle.token, 'task.create', {
      intent: '会话任务', preset: 'minimal', tenant: 'acme', session: 'dev-1',
    });

    const res = await rpc(handle, handle.token, 'events.list', { session: 'dev-1' });
    const events = eventsOf(res.body);
    assert.ok(events.length >= 1);
    assert.ok(events.every((e) => e.principal.session === 'dev-1' && e.principal.tenant === 'acme'));
  });

  it('session 身份锁死绑定命名空间:省略 params = 绑定值;越界显式 session → SESSION_FORBIDDEN(403/-32014)', async () => {
    const handle = await start();
    const init = await rpc(handle, handle.token, 'session.init', {
      protocol: '1.0',
      role: 'orchestrator',
      principal: { tenant: 'acme', session: 'dev-1' },
      harness: 'test',
      capabilities: {},
    });
    const sessionToken = (((init.body['result'] as Record<string, unknown>)['token']) as string);
    await rpc(handle, sessionToken, 'task.create', { intent: '本人任务', preset: 'minimal' });
    await rpc(handle, handle.token, 'task.create', { intent: '他人任务', preset: 'minimal' });

    const own = await rpc(handle, sessionToken, 'events.list', {});
    assert.equal(own.status, 200);
    const ownEvents = eventsOf(own.body);
    assert.ok(ownEvents.length >= 1);
    assert.ok(ownEvents.every((e) => e.principal.tenant === 'acme' && e.principal.session === 'dev-1'),
      'session 身份只见绑定 (tenant, session) 命名空间');

    const forbidden = await rpc(handle, sessionToken, 'events.list', { session: 'other' });
    assert.equal(forbidden.status, 403);
    assert.equal((forbidden.body['error'] as Record<string, unknown>)['code'], -32014);
    assert.equal(((forbidden.body['error'] as Record<string, unknown>)['data'] as Record<string, unknown>)['code'], 'SESSION_FORBIDDEN');

    const forbiddenTenant = await rpc(handle, sessionToken, 'events.list', { tenant: 'other-tenant' });
    assert.equal(forbiddenTenant.status, 403);
  });

  it('会话未激活(重启后)→ SESSION_UNKNOWN(404/-32011)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-events-list-'));
    roots.push(stateDir);
    const first = await startDaemon({ port: 0, stateDir });
    handles.push(first);
    const init = await rpc(first, first.token, 'session.init', {
      protocol: '1.0',
      role: 'orchestrator',
      principal: { tenant: 'acme', session: 'dev-1' },
      harness: 'test',
      capabilities: {},
    });
    const sessionToken = ((init.body['result'] as Record<string, unknown>)['token']) as string;
    await first.stop();

    const second = await startDaemon({ port: 0, stateDir });
    handles.push(second);
    const res = await rpc(second, sessionToken, 'events.list', {});
    assert.equal(res.status, 404);
    assert.equal((res.body['error'] as Record<string, unknown>)['code'], -32011);
  });

  it('limit = 时间序最近 N 条;非法 type / 负 limit → -32602', async () => {
    const handle = await start();
    await rpc(handle, handle.token, 'task.create', { intent: '分页样本', preset: 'minimal' });

    const all = eventsOf(await rpc(handle, handle.token, 'events.list', {}).then((r) => r.body));
    assert.ok(all.length >= 3);
    const tail2 = await rpc(handle, handle.token, 'events.list', { limit: 2 });
    const sliced = eventsOf(tail2.body);
    assert.deepEqual(sliced.map((e) => e.seq), all.slice(-2).map((e) => e.seq));
    assert.equal((tail2.body['result'] as Record<string, unknown>)['count'], 2);

    const badType = await rpc(handle, handle.token, 'events.list', { type: 'not.an.event' });
    assert.equal(badType.status, 400);
    assert.equal((badType.body['error'] as Record<string, unknown>)['code'], -32602);

    const badLimit = await rpc(handle, handle.token, 'events.list', { limit: -1 });
    assert.equal(badLimit.status, 400);
    assert.equal((badLimit.body['error'] as Record<string, unknown>)['code'], -32602);
  });
});
