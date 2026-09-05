/**
 * NodeExecutor M7 增量测试:镜像经 deps 注入(缺省值零漂移)+ 预热池接线
 * (冷拉落 sandbox.created / 池命中不落;release 归池不落 sandbox.destroyed)。
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ArtifactRepository } from '../../src/artifacts/index.ts';
import { GrantExecutor } from '../../src/capability/index.ts';
import type { LoadedRegistry, Preset } from '../../src/capability/index.ts';
import type { Event, EventInput, EventType } from '../../src/events/index.ts';
import { MemoryProvider } from '../../src/provision/index.ts';
import type { SandboxHandle, SandboxSpec } from '../../src/provision/index.ts';
import type { PoolAcquireResult, PoolReleaseVerdict, SandboxPool } from '../../src/provision/warm-pool.ts';
import { NodeExecutor } from '../../src/engine/index.ts';
import type { NodeExecutorDeps, NodeRuntime, RuntimeResult } from '../../src/engine/index.ts';

const REGISTRY: LoadedRegistry = {
  protocol: '1.0',
  spec_version: '1.0',
  capabilities: [],
  get: () => undefined,
};

function preset(): Preset {
  return {
    api: 'preset/1.0',
    name: 'coder',
    description: 'coder',
    base: 'any',
    skills: [],
    idempotent: false,
    baseline_grants: [],
    io_contracts: { inputs: [], outputs: [{ name: 'code', type: 'text' }] },
    escalation_policy: { auto_approve: [], require_approval: [] },
  };
}

const RUNTIME: NodeRuntime = {
  async run(): Promise<RuntimeResult> {
    return { exitCode: 0, events: [], artifacts: [{ name: 'code', payload: 'out' }] };
  },
};

/** 记录 create 的 spec(断言镜像注入)与 destroy/pool 归还路径。 */
function fakePool() {
  const specs: SandboxSpec[] = [];
  const releases: { handle: SandboxHandle; healthy?: boolean }[] = [];
  let n = 0;
  const pool: SandboxPool = {
    async acquire(spec: SandboxSpec): Promise<PoolAcquireResult> {
      specs.push(spec);
      n += 1;
      return {
        handle: {
          id: `pool-${n}`,
          status: 'running',
          createdAt: '2026-01-01T00:00:00Z',
          name: `pool-${n}`,
          labels: { ...(spec.labels ?? {}) },
        },
        fromPool: n % 2 === 0, // 第二次 = 模拟池命中
      };
    },
    async release(handle: SandboxHandle, opts?: { healthy?: boolean }): Promise<PoolReleaseVerdict> {
      releases.push({ handle, healthy: opts?.healthy });
      return n % 2 === 0 ? 'pooled' : 'destroyed';
    },
  };
  return { pool, specs, releases };
}

async function makeExecutor(extra: Partial<NodeExecutorDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'neoba-exec-m7-'));
  const artifacts = await ArtifactRepository.open(dir);
  const grants = new GrantExecutor(REGISTRY, { sink: () => {} });
  const events: Event[] = [];
  const emit = async (input: EventInput<EventType>) => {
    const event = Object.freeze({
      v: '1.0',
      seq: events.length + 1,
      ts: new Date().toISOString(),
      ...input,
    }) as unknown as Event;
    events.push(event);
    return event;
  };
  const executor = new NodeExecutor({
    provider: new MemoryProvider(),
    runtime: RUNTIME,
    artifacts,
    grants,
    emit,
    ...extra,
  });
  const params = {
    tenant: 't1',
    session: null,
    taskId: 'task-m7',
    nodeId: 'n1',
    preset: preset(),
    instruction: 'do it',
    attempt: 1,
    inputArtifacts: [],
  };
  return { executor, events, params };
}

function typeCounts(events: readonly Event[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

describe('engine/NodeExecutor(M7 增量)', () => {
  it('镜像注入:deps.image 显式给出 → spec 携带;缺省保持 neoba/sandbox:latest(零漂移)', async () => {
    // spec 断言经池桩路径(provider.create 的 spec 不外露;池 acquire 原样收到)
    const { pool, specs } = fakePool();
    const b = await makeExecutor({ image: 'neoba/worker:v2', pool });
    await b.executor.execute(b.params);
    assert.equal(specs[0]!.image, 'neoba/worker:v2');

    const c = await makeExecutor({ pool });
    await c.executor.execute(c.params);
    assert.equal(specs[1]!.image, 'neoba/sandbox:latest');
  });

  it('无池路径:事件流零漂移(sandbox.created + sandbox.destroyed 各一次)', async () => {
    const { executor, events, params } = await makeExecutor();
    const outcome = await executor.execute(params);
    assert.equal(outcome.status, 'completed');
    assert.equal(typeCounts(events)['sandbox.created'], 1);
    assert.equal(typeCounts(events)['sandbox.destroyed'], 1);
  });

  it('有池冷拉:sandbox.created 照常;destroyed 按 release 裁决照常', async () => {
    const { pool, releases } = fakePool();
    const { executor, events, params } = await makeExecutor({ pool });
    const outcome = await executor.execute(params);
    assert.equal(outcome.status, 'completed');
    assert.equal(releases[0]!.healthy, true); // completed → 健康回池
    assert.equal(typeCounts(events)['sandbox.created'], 1);
    assert.equal(typeCounts(events)['sandbox.destroyed'], 1);
  });

  it('有池命中:不虚报 sandbox.created;release 归池 → 不落 sandbox.destroyed', async () => {
    const { pool, releases } = fakePool();
    const { executor, events, params } = await makeExecutor({ pool });
    await executor.execute(params); // 冷拉 + destroyed
    await executor.execute(params); // fromPool=true + pooled
    assert.equal(releases.length, 2);
    assert.equal(typeCounts(events)['sandbox.created'], 1);
    assert.equal(typeCounts(events)['sandbox.destroyed'], 1);
  });

  it('失败终态:release 收到 healthy=false(不健康不回池)', async () => {
    const { pool, releases } = fakePool();
    const failing: NodeRuntime = {
      async run() {
        return { exitCode: 1, events: [], artifacts: [] };
      },
    };
    const { executor, params } = await makeExecutor({ pool, runtime: failing });
    const outcome = await executor.execute(params);
    assert.equal(outcome.status, 'failed');
    assert.equal(releases[0]!.healthy, false);
  });
});
