/**
 * WarmPool 测试(M7,§9 P4):
 * - 池命中(restore 回热)/ 池空冷拉 / 规格签名匹配(异规格不命中);
 * - release:健康回池(snapshot + destroy)、不健康销毁、池满销毁、
 *   snapshot 失败降级销毁(清理语义不因池化失败丢失);
 * - 与 M1 ResourceGate 共用同一信号量:gate 控并发上限,pool 在 gate 之内,
 *   空闲池条目不占槽;无 gate 时复用 sandbox.acquired/released 事件兜底;
 * - 不支持 snapshot 的后端(docker/memory)直通退化为冷拉 + 销毁。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResourceGate } from '../../src/provision/pool.ts';
import { WarmPool } from '../../src/provision/warm-pool.ts';
import type { GateEmit } from '../../src/provision/pool.ts';
import type { SandboxHandle, SandboxProvider, SandboxSpec } from '../../src/provision/index.ts';

/** 记录调用序 + snapshot 能力可开关的 provider 桩。 */
function fakeProvider(
  opts: {
    snapshotCapable?: boolean;
    snapshotFails?: boolean;
    unhealthy?: boolean;
    createFails?: boolean;
    restoreFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const restoredRefs: string[] = [];
  let n = 0;
  const provider: SandboxProvider & {
    calls: string[];
    restoredRefs: string[];
  } = {
    calls,
    restoredRefs,
    backend: 'fake',
    ...(opts.snapshotCapable === true ? { snapshotCapable: true } : {}),
    create: async (spec: SandboxSpec): Promise<SandboxHandle> => {
      calls.push(`create:${spec.labels?.['neoba.node'] ?? '?'}`);
      if (opts.createFails === true) throw new Error('create boom');
      n += 1;
      return {
        id: `sbx-${n}`,
        status: 'running',
        createdAt: '2026-01-01T00:00:00Z',
        name: `sbx-${n}`,
        labels: { ...(spec.labels ?? {}) },
      };
    },
    exec: async () =>
      opts.unhealthy === true ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' },
    logs: async () => '',
    destroy: async (h: SandboxHandle) => {
      calls.push(`destroy:${h.id}`);
    },
    list: async () => [],
    snapshot: async (h: SandboxHandle): Promise<string> => {
      if (opts.snapshotFails === true) throw new Error('snapshot boom');
      calls.push(`snapshot:${h.id}`);
      return `snap-${h.id}`;
    },
    restore: async (ref: string): Promise<SandboxHandle> => {
      calls.push(`restore:${ref}`);
      if (opts.restoreFails === true) throw new Error('restore boom');
      restoredRefs.push(ref);
      n += 1;
      return {
        id: `sbx-${n}`,
        status: 'running',
        createdAt: '2026-01-01T00:00:00Z',
        name: `sbx-${n}`,
        labels: { 'neoba.snapshot': ref },
      };
    },
    acquire: async () => {
      throw new Error('not supported');
    },
    release: async () => {
      throw new Error('not supported');
    },
  };
  return provider;
}

const SPEC_A: SandboxSpec = { image: 'neoba/sandbox:latest', labels: { 'neoba.task': 't1', 'neoba.node': 'n1' } };

function specOf(node: string): SandboxSpec {
  return { image: 'neoba/sandbox:latest', labels: { 'neoba.task': 't1', 'neoba.node': node } };
}

function gateOf(slots: number) {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const g = new ResourceGate({
    slots,
    emit: ((input) => {
      events.push({ type: input.type, payload: input.payload });
    }) as GateEmit,
  });
  return { g, events };
}

interface PoolEvent {
  type: string;
  payload: Record<string, unknown>;
}

function poolEmit(): { events: PoolEvent[]; emit: GateEmit } {
  const events: PoolEvent[] = [];
  return {
    events,
    emit: (input) => {
      events.push({ type: input.type, payload: input.payload });
    },
  };
}

describe('provision/WarmPool(支持 snapshot 的后端:真池化)', () => {
  it('池空冷拉;健康回池 = snapshot + destroy;再次 acquire 命中 restore 回热', async () => {
    const inner = fakeProvider({ snapshotCapable: true });
    const pool = new WarmPool({ provider: inner });

    const first = await pool.acquire(specOf('n1'));
    assert.equal(first.fromPool, false);
    assert.equal(pool.size, 0);

    const verdict = await pool.release(first.handle, { healthy: true });
    assert.equal(verdict, 'pooled');
    assert.equal(pool.size, 1);
    assert.deepEqual(inner.calls, ['create:n1', 'snapshot:sbx-1', 'destroy:sbx-1']);

    const second = await pool.acquire(specOf('n2'));
    assert.equal(second.fromPool, true);
    assert.equal(pool.size, 0);
    assert.deepEqual(inner.restoredRefs, [`snap-sbx-1`]);
    // 回热实例继承当前节点标签(事件留痕按当前任务记账)
    assert.equal(second.handle.labels['neoba.node'], 'n2');

    await pool.release(second.handle, { healthy: true });
    assert.equal(pool.size, 1);
  });

  it('规格签名:异规格(secret/config 挂载、env 差异)不命中,各自归池', async () => {
    const inner = fakeProvider({ snapshotCapable: true });
    const pool = new WarmPool({ provider: inner });
    const a = await pool.acquire(specOf('n1'));
    await pool.release(a.handle, { healthy: true });
    // 同 image 但挂载集不同(凭据挂载属 §4.4 硬规则)→ 不允许复用
    const b = await pool.acquire({
      ...specOf('n2'),
      mounts: [{ kind: 'config', source: 'cfg-1', target: '/etc/app', mode: 'ro' }],
    });
    assert.equal(b.fromPool, false);
    assert.equal(pool.size, 1); // a 的条目仍在池内
    // 同规格再次取用 → 命中
    const c = await pool.acquire(specOf('n3'));
    assert.equal(c.fromPool, true);
  });

  it('规格签名:workdir 挂载 source 归一化,不同 task/node 的相同规格同签名(#26)', async () => {
    const inner = fakeProvider({ snapshotCapable: true });
    const pool = new WarmPool({ provider: inner });
    // 模拟编排场景:task t1/node n1 与 task t2/node n2 规格相同,
    // 仅 workdir 挂载 source(per-node 唯一段)不同 → 允许跨节点命中
    const a = await pool.acquire({
      image: 'neoba/sandbox:latest',
      workdir: '/workspace',
      mounts: [{ kind: 'workdir', source: 'neoba-t1-n1', target: '/workspace', mode: 'rw' }],
      env: { FOO: 'bar' },
      labels: { 'neoba.task': 't1', 'neoba.node': 'n1' },
    });
    await pool.release(a.handle, { healthy: true });
    const b = await pool.acquire({
      image: 'neoba/sandbox:latest',
      workdir: '/workspace',
      mounts: [{ kind: 'workdir', source: 'neoba-t2-n2', target: '/workspace', mode: 'rw' }],
      env: { FOO: 'bar' },
      labels: { 'neoba.task': 't2', 'neoba.node': 'n2' },
    });
    assert.equal(b.fromPool, true); // 签名相同 → 跨节点回热命中
    // 回热实例继承当前节点标签(事件留痕按 task t2 记账)
    assert.equal(b.handle.labels['neoba.task'], 't2');
    assert.equal(b.handle.labels['neoba.node'], 'n2');
    assert.equal(pool.size, 0);
  });

  it('规格签名:env 或 network 不同 → 不同签名,不混池', async () => {
    const inner = fakeProvider({ snapshotCapable: true });
    const pool = new WarmPool({ provider: inner, capacity: 4 });
    const base = (node: string): SandboxSpec => ({
      image: 'neoba/sandbox:latest',
      workdir: '/workspace',
      mounts: [{ kind: 'workdir', source: `neoba-t1-${node}`, target: '/workspace', mode: 'rw' }],
      env: { FOO: 'bar' },
      labels: { 'neoba.task': 't1', 'neoba.node': node },
    });
    const a = await pool.acquire(base('n1'));
    await pool.release(a.handle, { healthy: true });
    // env 不同 → 冷拉(a 条目仍在池内)
    const b = await pool.acquire({ ...base('n2'), env: { FOO: 'baz' } });
    assert.equal(b.fromPool, false);
    assert.equal(pool.size, 1);
    // network 不同 → 冷拉(a/b 条目仍在池内)
    const c = await pool.acquire({ ...base('n3'), network: { mode: 'bridge' } });
    assert.equal(c.fromPool, false);
    // b/c 各自归池后,池内三个不同签名条目并存
    await pool.release(b.handle, { healthy: true });
    await pool.release(c.handle, { healthy: true });
    assert.equal(pool.size, 3);
    // 同 env/network 的节点 → 命中 a 的条目(findIndex 取最早入池的匹配条目)
    const d = await pool.acquire(base('n4'));
    assert.equal(d.fromPool, true);
    assert.equal(inner.restoredRefs[0], `snap-${a.handle.id}`);
  });

  it('池命中端到端:节点 A release 回池后,不同 task 的节点 B acquire 命中(#26)', async () => {
    const inner = fakeProvider({ snapshotCapable: true });
    const pool = new WarmPool({ provider: inner });
    const specOfTask = (taskId: string, node: string): SandboxSpec => ({
      image: 'neoba/sandbox:latest',
      workdir: '/workspace',
      mounts: [{ kind: 'workdir', source: `neoba-${taskId}-${node}`, target: '/workspace', mode: 'rw' }],
      labels: { 'neoba.task': taskId, 'neoba.node': node },
    });
    // 节点 A(task t1):冷拉 → 健康回池
    const a = await pool.acquire(specOfTask('t1', 'a'));
    assert.equal(a.fromPool, false);
    assert.equal(await pool.release(a.handle, { healthy: true }), 'pooled');
    assert.equal(pool.size, 1);
    // 节点 B(不同 task t2):acquire 命中池内条目,fromPool=true
    const b = await pool.acquire(specOfTask('t2', 'b'));
    assert.equal(b.fromPool, true);
    assert.deepEqual(inner.restoredRefs, [`snap-${a.handle.id}`]); // 走 restore 回热
    assert.equal(b.handle.labels['neoba.task'], 't2'); // 留痕归当前任务
    assert.equal(pool.size, 0);
  });

  it('不健康(release 探针失败)→ 销毁,不回池', async () => {
    const inner = fakeProvider({ snapshotCapable: true, unhealthy: true });
    const pool = new WarmPool({ provider: inner });
    const h = await pool.acquire(specOf('n1'));
    const verdict = await pool.release(h.handle); // 未显式 healthy → 缺省探针 exec true
    assert.equal(verdict, 'destroyed');
    assert.equal(pool.size, 0);
    assert.deepEqual(inner.calls, ['create:n1', 'destroy:sbx-1']);
  });

  it('健康但池满(capacity)→ 销毁;drain 清空条目', async () => {
    const inner = fakeProvider({ snapshotCapable: true });
    const pool = new WarmPool({ provider: inner, capacity: 1 });
    const h1 = await pool.acquire(specOf('n1'));
    const h2 = await pool.acquire(specOf('n2'));
    assert.equal(await pool.release(h1.handle, { healthy: true }), 'pooled');
    assert.equal(await pool.release(h2.handle, { healthy: true }), 'destroyed');
    assert.equal(pool.size, 1);
    assert.equal(pool.drain(), 1);
    assert.equal(pool.size, 0);
  });

  it('snapshot 失败 → 降级销毁(池化是优化,清理语义不丢)', async () => {
    const inner = fakeProvider({ snapshotCapable: true, snapshotFails: true });
    const pool = new WarmPool({ provider: inner });
    const h = await pool.acquire(specOf('n1'));
    const verdict = await pool.release(h.handle, { healthy: true });
    assert.equal(verdict, 'destroyed');
    assert.equal(pool.size, 0);
    assert.deepEqual(inner.calls, ['create:n1', 'destroy:sbx-1']);
  });

  it('与 M1 ResourceGate 共用同一信号量:占槽用满排队,release 后唤醒;空闲池条目不占槽', async () => {
    const inner = fakeProvider({ snapshotCapable: true });
    const { g, events } = gateOf(1);
    const pool = new WarmPool({ provider: inner, gate: g });

    const h1 = await pool.acquire(specOf('n1'));
    assert.equal(g.inUse, 1);
    const pending = pool.acquire(specOf('n2')); // 满员 → 排队
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(g.waiting, 1);

    await pool.release(h1.handle, { healthy: true });
    const h2 = await pending;
    assert.equal(g.inUse, 1);
    assert.equal(g.waiting, 0);
    assert.equal(h2.fromPool, true); // 同规格签名(h1 回池条目)→ 命中回热
    await pool.release(h2.handle, { healthy: true });
    assert.equal(g.inUse, 0); // 空闲池条目不占槽
    assert.equal(pool.size, 1);

    // gate 事件(queued/acquired/released)与池条目并存
    assert.deepEqual(
      events.map((e) => e.type),
      ['sandbox.acquired', 'sandbox.queued', 'sandbox.released', 'sandbox.acquired', 'sandbox.released'],
    );
  });

  it('无 gate:复用 sandbox.acquired/released 事件兜底(payload 带 pool 字段,纯增量)', async () => {
    const inner = fakeProvider({ snapshotCapable: true });
    const { events, emit } = poolEmit();
    const pool = new WarmPool({ provider: inner, emit });
    const h = await pool.acquire(specOf('n1'));
    assert.deepEqual(events.map((e) => e.type), ['sandbox.acquired']);
    await pool.release(h.handle, { healthy: true });
    assert.deepEqual(events.map((e) => e.type), ['sandbox.acquired', 'sandbox.released']);
    assert.equal(events[0]!.payload['pool'], true);
    assert.equal(events[1]!.payload['key'], 't1/n1');
  });

  it('acquire 冷拉后冷拉实例锚定规格签名(release 能正确归池)', async () => {
    const inner = fakeProvider({ snapshotCapable: true });
    const pool = new WarmPool({ provider: inner });
    const h1 = await pool.acquire(specOf('n1'));
    assert.ok(h1.handle.labels['neoba.pool-key']);
    const h2 = await pool.acquire(specOf('n2'));
    await pool.release(h1.handle, { healthy: true });
    const h3 = await pool.acquire(specOf('n3'));
    assert.equal(h3.fromPool, true); // 同规格签名 → 命中 h1 的条目
    void h2;
  });

  it('capacity <= 0 拒绝构造', () => {
    const inner = fakeProvider({ snapshotCapable: true });
    assert.throws(() => new WarmPool({ provider: inner, capacity: 0 }), /capacity 必须 > 0/);
  });
});

describe('provision/WarmPool(不支持 snapshot 的后端:直通退化)', () => {
  it('docker 类后端:acquire 恒冷拉、release 恒销毁,池层零行为', async () => {
    const inner = fakeProvider(); // 未声明 snapshotCapable
    const { g, events } = gateOf(2);
    const pool = new WarmPool({ provider: inner, gate: g });

    assert.equal(pool.pooling, false);
    const h1 = await pool.acquire(specOf('n1'));
    assert.equal(h1.fromPool, false);
    const verdict = await pool.release(h1.handle, { healthy: true });
    assert.equal(verdict, 'destroyed');
    assert.equal(pool.size, 0);
    assert.deepEqual(inner.calls, ['create:n1', 'destroy:sbx-1']);
    // gate 语义照常(池不改变闸门行为)
    assert.deepEqual(events.map((e) => e.type), ['sandbox.acquired', 'sandbox.released']);
  });

  it('直通退化路径:健康实例也不回池(无 snapshot 介质可固化)', async () => {
    const inner = fakeProvider();
    const pool = new WarmPool({ provider: inner });
    const h = await pool.acquire(specOf('n1'));
    await pool.release(h.handle); // 健康探针通过也一样销毁
    assert.deepEqual(inner.calls, ['create:n1', 'destroy:sbx-1']);
    assert.equal(pool.size, 0);
  });
});

describe('provision/WarmPool(acquire 失败路径:不泄漏 gate 槽位,#12)', () => {
  it('真池化冷拉 create 抛错 → 槽位归还,后续 acquire 仍能成功', async () => {
    const inner = fakeProvider({ snapshotCapable: true, createFails: true });
    const { g } = gateOf(1);
    const pool = new WarmPool({ provider: inner, gate: g });

    await assert.rejects(pool.acquire(specOf('n1')), /create boom/);
    assert.equal(g.inUse, 0); // 失败即归还,不再占槽
    assert.equal(g.waiting, 0);

    // 槽位恢复后 gate 不死锁:重建 provider 后续 acquire 正常走通
    const ok = new WarmPool({ provider: fakeProvider({ snapshotCapable: true }), gate: g });
    const h = await ok.acquire(specOf('n2'));
    assert.equal(g.inUse, 1);
    await ok.release(h.handle, { healthy: true });
    assert.equal(g.inUse, 0);
  });

  it('restore 回热抛错 → 槽位归还,孤儿 snapshot 引用不残留池内', async () => {
    const inner = fakeProvider({ snapshotCapable: true, restoreFails: true });
    const { g } = gateOf(1);
    const pool = new WarmPool({ provider: inner, gate: g });

    // 先正常回池一个条目,再让下一次 acquire 命中 restore 时抛错
    const h1 = await pool.acquire(specOf('n1'));
    await pool.release(h1.handle, { healthy: true });
    assert.equal(pool.size, 1);

    await assert.rejects(pool.acquire(specOf('n2')), /restore boom/);
    assert.equal(g.inUse, 0); // 失败即归还槽位
    assert.equal(pool.size, 0); // 已 splice 出池的条目不回填,池内无孤儿引用
    assert.deepEqual(inner.calls.slice(-2), ['destroy:sbx-1', 'restore:snap-sbx-1']); // 只尝试了一次 restore
  });

  it('直通退化路径(!pooling)create 抛错 → 槽位同样归还', async () => {
    const inner = fakeProvider({ createFails: true }); // 未声明 snapshotCapable
    const { g, events } = gateOf(1);
    const pool = new WarmPool({ provider: inner, gate: g });

    await assert.rejects(pool.acquire(specOf('n1')), /create boom/);
    assert.equal(g.inUse, 0);
    // 事件兜底路径同样收尾:acquired 后有 released
    assert.deepEqual(
      events.map((e) => e.type),
      ['sandbox.acquired', 'sandbox.released'],
    );
  });
});
