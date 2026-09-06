/**
 * #15 回归:escalation 授予/回收审计断链修复 ——
 *   1. auto-grant(approvals.submit 自动放行)的 escalation 授予落
 *      grant.granted 事件、grants.of 即时可见、重启重放后仍在;
 *   2. TTL 到期回收落 grant.revoked(带 scope),重放后授予消失,且同 cap
 *      多 scope 时只回收被回收的那个(baseline rw 保留);
 *   3. 申请的 cap+scope 已被 baseline 持有时幂等吞掉 GrantDuplicate,
 *      台账/事件标注 already_held(不再静默)。
 * in-process startDaemon + 真实 HTTP 面(与既有 daemon 测试同风格)。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { startDaemon } from '../../src/daemon/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';
import { replayTasks } from '../../src/daemon/tasks.ts';
import { minimalPresetDoc, parsePreset } from '../../src/capability/index.ts';
import type { Preset } from '../../src/capability/index.ts';
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

/** auto 放行预设:基线 fs:workdir rw,escalation 对 fs:workdir / mcp:playwright 自动放行。 */
function autoPreset(name = 'auto'): Preset {
  return parsePreset(
    minimalPresetDoc({
      name,
      baseline_grants: [{ cap: 'fs:workdir', scope: 'rw' }],
      escalation_policy: { auto_approve: ['fs:workdir', 'mcp:playwright'], require_approval: ['*'] },
    }),
  );
}

async function start(
  stateDir: string,
  opts: { now?: () => Date } = {},
): Promise<DaemonHandle> {
  const handle = await startDaemon({
    port: 0,
    stateDir,
    presets: { minimal: parsePreset(minimalPresetDoc({})), auto: autoPreset() },
    reclaimIntervalMs: 0, // TTL 回收由用例手动触发,不等钟。
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  handles.push(handle);
  return handle;
}

async function rpc(
  handle: DaemonHandle,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${handle.baseUrl}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${handle.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as Record<string, unknown>;
}

function resultOf(body: Record<string, unknown>): Record<string, unknown> {
  return body['result'] as Record<string, unknown>;
}

async function createTask(handle: DaemonHandle): Promise<{ taskId: string; agentId: string }> {
  const created = resultOf(await rpc(handle, 'task.create', { intent: '#15 回归', preset: 'auto' }));
  return { taskId: created['task_id'] as string, agentId: created['agent_id'] as string };
}

async function grantsOf(handle: DaemonHandle, agentId: string): Promise<Record<string, unknown>[]> {
  const of = resultOf(await rpc(handle, 'grants.of', { agent_id: agentId }));
  const manifest = of['manifest'] as Record<string, unknown> | null;
  return (manifest?.['grants'] as Record<string, unknown>[] | undefined) ?? [];
}

async function allEvents(handle: DaemonHandle): Promise<Event[]> {
  return handle.events.readByPrincipal({ tenant: 'default' });
}

describe('auto-grant 全量入审计(#15 回归)', () => {
  it('approvals.submit 自动放行 → grant.granted 落盘 + grants.of 可见 + 重启重放仍在', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-issue15-grant-'));
    roots.push(stateDir);
    // 固定时钟:TTL 断言需要确定性(2026-09-05T00:00:00Z + 2h)。
    const first = await start(stateDir, { now: () => new Date(Date.parse('2026-09-05T00:00:00Z')) });
    const { taskId, agentId } = await createTask(first);

    const submitted = resultOf(await rpc(first, 'approvals.submit', {
      task_id: taskId,
      cap: 'mcp:playwright',
      scope: 'write',
      duration: '2h',
      reason: '需要浏览器验证',
      req_id: 'req-auto-1',
    }));
    assert.equal(submitted['status'], 'auto_granted', JSON.stringify(submitted));

    // grant.granted 事件落盘(escalation source + decision_source + ttl)。
    const events = await allEvents(first);
    const granted = events.filter((e) => e.type === 'grant.granted') as unknown as Array<{
      payload: Record<string, unknown>;
    }>;
    const escalation = granted.find(
      (e) => String(e.payload['source']) === 'escalation:req-auto-1',
    );
    assert.ok(escalation, JSON.stringify(granted.map((e) => e.payload)));
    assert.equal(escalation.payload['cap'], 'mcp:playwright');
    assert.equal(escalation.payload['scope'], 'write');
    assert.equal(escalation.payload['decisionSource'], 'auto_rule:preset:auto');
    assert.equal(escalation.payload['ttl'], '2026-09-05T02:00:00.000Z');

    // grants.of 即时可见(TaskStore manifest 快照同步)。
    const grants = await grantsOf(first, agentId);
    const escalated = grants.find((g) => g['cap'] === 'mcp:playwright');
    assert.equal(escalated?.['source'], 'escalation:req-auto-1');

    await first.stop();
    handles.pop();

    // 重启重放:恢复循环只认 grant.granted 事件,授予仍在(TTL 保留)。
    const second = await start(stateDir);
    const after = await grantsOf(second, agentId);
    const restored = after.find((g) => g['cap'] === 'mcp:playwright');
    assert.ok(restored, JSON.stringify(after));
    assert.equal(restored?.['source'], 'escalation:req-auto-1');
    assert.equal(restored?.['ttl'], '2026-09-05T02:00:00.000Z');
  });

  it('申请的 cap+scope 已被 baseline 持有:auto_granted + already_held 标注,无新授予', async () => {
    const handle = await start(await mkdtemp(join(tmpdir(), 'neoba-issue15-held-')).then((d) => {
      roots.push(d);
      return d;
    }));
    const { taskId, agentId } = await createTask(handle);
    const before = await grantsOf(handle, agentId);
    assert.equal(before.length, 1); // baseline fs:workdir rw

    const submitted = resultOf(await rpc(handle, 'approvals.submit', {
      task_id: taskId,
      cap: 'fs:workdir',
      scope: 'rw', // 与 baseline 同 cap 同 scope → GrantDuplicate 幂等
      duration: '1h',
      req_id: 'req-held-1',
    }));
    assert.equal(submitted['status'], 'auto_granted');
    const record = submitted['record'] as Record<string, unknown>;
    assert.equal(record['alreadyHeld'], true);

    // decided 事件标注 already_held;不产生新的 escalation grant.granted。
    const events = await allEvents(handle);
    const decided = events.find(
      (e) => e.type === 'approval.decided' &&
        (e.payload as unknown as Record<string, unknown>)['reqId'] === 'req-held-1',
    );
    assert.ok(decided);
    assert.equal(
      (decided.payload as unknown as Record<string, unknown>)['already_held'],
      true,
    );
    const escalationGranted = (await allEvents(handle)).filter(
      (e) => e.type === 'grant.granted' &&
        String((e.payload as unknown as Record<string, unknown>)['source']).startsWith('escalation:'),
    );
    assert.equal(escalationGranted.length, 0);
    // 授予不变:仍只有 baseline 一条,无 TTL。
    const after = await grantsOf(handle, agentId);
    assert.equal(after.length, 1);
    assert.equal(after[0]?.['source'], 'baseline');
  });
});

describe('TTL 回收落盘与精确重放(#15 回归)', () => {
  it('到期回收落 grant.revoked(带 scope);同 cap 双 scope 只回收一个,重放后 baseline 保留', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-issue15-ttl-'));
    roots.push(stateDir);
    let nowMs = Date.parse('2026-09-05T00:00:00Z');
    const first = await start(stateDir, { now: () => new Date(nowMs) });
    const { taskId, agentId } = await createTask(first);

    // escalation:fs:workdir ro(与 baseline rw 同 cap 不同 scope)。
    const submitted = resultOf(await rpc(first, 'approvals.submit', {
      task_id: taskId,
      cap: 'fs:workdir',
      scope: 'ro',
      duration: '1h',
      req_id: 'req-ttl-1',
    }));
    assert.equal(submitted['status'], 'auto_granted', JSON.stringify(submitted));
    const mid = await grantsOf(first, agentId);
    assert.deepEqual(
      mid.map((g) => `${g['cap']}:${g['scope']}`).sort(),
      ['fs:workdir:ro', 'fs:workdir:rw'],
    );

    // 未到期:回收 0。
    nowMs += 30 * 60_000;
    assert.equal(await first.board.reclaimExpired(), 0);
    // 到期:回收 1(ro),rw(baseline)保留 —— 内存态即时同步。
    nowMs += 31 * 60_000;
    assert.equal(await first.board.reclaimExpired(), 1);
    const afterReclaim = await grantsOf(first, agentId);
    assert.deepEqual(
      afterReclaim.map((g) => `${g['cap']}:${g['scope']}`),
      ['fs:workdir:rw'],
    );

    // grant.revoked 落盘,payload 带 scope(精确回收的依据)。
    const events = await allEvents(first);
    const revoked = events.filter((e) => e.type === 'grant.revoked') as unknown as Array<{
      payload: Record<string, unknown>;
    }>;
    assert.equal(revoked.length, 1, JSON.stringify(revoked));
    const revokedEntry = revoked[0];
    assert.ok(revokedEntry);
    assert.equal(revokedEntry.payload['cap'], 'fs:workdir');
    assert.equal(revokedEntry.payload['scope'], 'ro');
    assert.equal(revokedEntry.payload['reason'], 'reclaimed');

    await first.stop();
    handles.pop();

    // 重启重放:按 (cap, scope) 精确过滤,ro 消失、rw 保留(不再被按 cap 全删)。
    const second = await start(stateDir, { now: () => new Date(nowMs) });
    const replayed = await grantsOf(second, agentId);
    assert.deepEqual(
      replayed.map((g) => `${g['cap']}:${g['scope']}`),
      ['fs:workdir:rw'],
    );
  });
});

describe('replayTasks 的 grant.revoked 精确重放(#15 单元)', () => {
  const principal = { tenant: 'default', session: null, task: 'task-1', agent: 'worker-01' };
  const mk = (type: Event['type'], payload: Record<string, unknown>, seq: number): Event =>
    ({
      v: '1.0',
      seq,
      ts: '2026-09-05T00:00:00.000Z',
      type,
      principal,
      payload,
    }) as unknown as Event;
  const baseline = mk('grant.granted', { cap: 'fs:workdir', scope: 'rw', source: 'baseline' }, 1);
  const escalation = mk(
    'grant.granted',
    { cap: 'fs:workdir', scope: 'ro', source: 'escalation:req-1', ttl: '2026-09-05T01:00:00.000Z' },
    2,
  );

  it('带 scope 的 revoked 只回收该 scope,另一 scope 保留', () => {
    const store = replayTasks([
      baseline,
      escalation,
      mk('grant.revoked', { cap: 'fs:workdir', scope: 'ro', reason: 'reclaimed' }, 3),
    ]);
    const grants = store.manifest('worker-01')?.grants ?? [];
    assert.deepEqual(grants.map((g) => g.scope), ['rw']);
  });

  it('旧事件缺 scope 向前兼容:保持按 cap 全删的既有行为', () => {
    const store = replayTasks([
      baseline,
      escalation,
      mk('grant.revoked', { cap: 'fs:workdir', reason: 'reclaimed' }, 3),
    ]);
    assert.equal(store.manifest('worker-01')?.grants.length, 0);
  });
});
