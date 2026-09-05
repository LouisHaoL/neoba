/**
 * ResourceGate + withResourceGate 测试(§6 资源池:P3 落地):
 * - FIFO 信号量:满员排队、release 唤醒队首、多余 release 幂等;
 * - 事件留痕:sandbox.queued / acquired / released 按序落账;
 * - 装饰器:create 前 acquire、create 失败或 destroy 后 release,槽位不泄漏。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResourceGate, withResourceGate } from '../../src/provision/pool.ts';
import { MemoryProvider } from '../../src/provision/memory-provider.ts';
import type { SandboxProvider, SandboxSpec, SandboxHandle } from '../../src/provision/types.ts';
import type { Principal } from '../../src/events/types.ts';

interface GateEvent {
  readonly type: string;
  readonly principal: Principal;
  readonly payload: Record<string, unknown>;
}

function gate(slots: number) {
  const events: GateEvent[] = [];
  const g = new ResourceGate({
    slots,
    emit: (input) => {
      events.push(input);
    },
  });
  return { g, events };
}

function spec(labels?: Record<string, string>): SandboxSpec {
  return { image: 'test:latest', ...(labels !== undefined ? { labels } : {}) };
}

describe('provision/ResourceGate', () => {
  it('空槽立即 acquire,limit/inUse/waiting 视图正确', async () => {
    const { g } = gate(2);
    assert.equal(g.limit, 2);
    assert.equal(g.inUse, 0);
    assert.equal(await g.acquire('a'), true);
    assert.equal(await g.acquire('b'), true);
    assert.equal(g.inUse, 2);
    assert.equal(g.waiting, 0);
  });

  it('满员 FIFO 排队,release 唤醒队首', async () => {
    const { g } = gate(1);
    await g.acquire('first');
    let woken = 0;
    const p1 = g.acquire('second').then((v) => {
      woken += 1;
      return v;
    });
    const p2 = g.acquire('third').then((v) => {
      woken += 1;
      return v;
    });
    await new Promise<void>((r) => setImmediate(r)); // 让排队分支落地(跨多个微任务)
    assert.equal(g.waiting, 2);
    assert.equal(g.inUse, 1);

    await g.release('first');
    await p1;
    assert.equal(woken, 1); // 只有队首被唤醒
    assert.equal(g.inUse, 1);
    assert.equal(g.waiting, 1);

    await g.release('second');
    await p2;
    assert.equal(g.inUse, 1);
    assert.equal(g.waiting, 0);

    await g.release('third');
    assert.equal(g.inUse, 0);
  });

  it('多余 release 幂等忽略', async () => {
    const { g } = gate(1);
    await g.release('nobody');
    assert.equal(g.inUse, 0);
    await g.acquire('a');
    await g.release('a');
    await g.release('a'); // 重复释放不再下探
    assert.equal(g.inUse, 0);
  });

  it('slots <= 0 拒绝构造', () => {
    assert.throws(() => gate(0), /slots 必须 > 0/);
    assert.throws(() => gate(-1), /slots 必须 > 0/);
  });

  it('queued/acquired/released 事件按序落账,principal 缺省兜底', async () => {
    const { g, events } = gate(1);
    await g.acquire('t1/n1');
    const p = g.acquire('t1/n2'); // 排队 → queued 事件
    await g.release('t1/n1');
    await p;
    await g.release('t1/n2');
    assert.deepEqual(
      events.map((e) => e.type),
      ['sandbox.acquired', 'sandbox.queued', 'sandbox.released', 'sandbox.acquired', 'sandbox.released'],
    );
    const queued = events[1]!;
    assert.equal(queued.payload['key'], 't1/n2');
    assert.equal(queued.payload['waiting'], 1);
    assert.equal(queued.payload['limit'], 1);
    // 未传 principal:tenant 兜底 default,层级可空
    assert.deepEqual(queued.principal, { tenant: 'default', session: null, task: null, agent: null });
  });

  it('Infinity 槽位:limit 报 null,acquire 永不排队', async () => {
    const { g, events } = gate(Infinity);
    assert.equal(g.limit, null);
    for (let i = 0; i < 50; i++) assert.equal(await g.acquire(`k${i}`), true);
    assert.equal(g.waiting, 0);
    assert.equal(events.every((e) => e.type !== 'sandbox.queued'), true);
  });
});

/** 记录 create/destroy 调用序的最小 provider 桩。 */
function fakeProvider(): SandboxProvider & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    backend: 'fake',
    create: async (s: SandboxSpec): Promise<SandboxHandle> => {
      calls.push(`create:${s.labels?.['neoba.node'] ?? '?'}`);
      if (s.labels?.['neoba.node'] === 'boom') throw new Error('create failed');
      n += 1;
      return {
        id: `sbx-${n}`,
        status: 'running',
        createdAt: '2026-01-01T00:00:00Z',
        name: `sbx-${n}`,
        labels: { ...(s.labels ?? {}) },
      };
    },
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    logs: async () => '',
    destroy: async (h: SandboxHandle) => {
      calls.push(`destroy:${h.labels['neoba.node'] ?? h.id}`);
    },
    list: async () => [],
    snapshot: async () => 'snap',
    restore: async () => {
      throw new Error('not supported');
    },
    acquire: async () => {
      throw new Error('not supported');
    },
    release: async () => {
      throw new Error('not supported');
    },
  };
}

describe('provision/withResourceGate', () => {
  it('create 前 acquire、destroy 后 release(事件对齐)', async () => {
    const { g, events } = gate(1);
    const inner = fakeProvider();
    const provider = withResourceGate(inner, g);
    const h = await provider.create(spec({ 'neoba.task': 't1', 'neoba.node': 'n1' }));
    assert.equal(g.inUse, 1);
    await provider.destroy(h);
    assert.equal(g.inUse, 0);
    assert.deepEqual(inner.calls, ['create:n1', 'destroy:n1']);
    assert.deepEqual(
      events.map((e) => e.type),
      ['sandbox.acquired', 'sandbox.released'],
    );
    // principal 从标签还原:agent = task/node
    assert.equal(events[0]!.principal.agent, 't1/n1');
    assert.equal(events[0]!.principal.task, 't1');
  });

  it('create 抛错即释放槽位(不泄漏)', async () => {
    const { g, events } = gate(1);
    const provider = withResourceGate(fakeProvider(), g);
    await assert.rejects(provider.create(spec({ 'neoba.node': 'boom' })), /create failed/);
    assert.equal(g.inUse, 0);
    // acquired(release 因失败产生)→ 两事件
    assert.deepEqual(
      events.map((e) => e.type),
      ['sandbox.acquired', 'sandbox.released'],
    );
    // 释放后同一闸门可继续供给
    const h = await provider.create(spec({ 'neoba.node': 'ok' }));
    assert.equal(g.inUse, 1);
    await provider.destroy(h);
  });

  it('满员时 create 排队等待前一个 destroy 释放', async () => {
    const { g } = gate(1);
    const inner = fakeProvider();
    const provider = withResourceGate(inner, g);
    const h1 = provider.create(spec({ 'neoba.task': 't', 'neoba.node': 'a' }));
    const h2 = provider.create(spec({ 'neoba.task': 't', 'neoba.node': 'b' }));
    const first = await h1;
    assert.equal(g.inUse, 1);
    assert.equal(g.waiting, 1);
    await provider.destroy(first);
    const second = await h2; // 排队者被唤醒
    assert.equal(g.inUse, 1);
    assert.equal(g.waiting, 0);
    await provider.destroy(second);
    assert.equal(g.inUse, 0);
    assert.deepEqual(inner.calls, ['create:a', 'destroy:a', 'create:b', 'destroy:b']);
  });

  it('exec/logs/list 透传内层 provider', async () => {
    const { g } = gate(2);
    const mem = new MemoryProvider();
    const provider = withResourceGate(mem, g);
    const h = await provider.create(spec({ 'neoba.node': 'n' }));
    const r = await provider.exec(h, ['echo', 'hi']);
    assert.equal(r.exitCode, 0);
    assert.equal(await provider.logs(h), '[neoba] exec(exit 0): echo hi');
    assert.equal((await provider.list({ 'neoba.node': 'n' })).length, 1);
    await provider.destroy(h);
  });
});
