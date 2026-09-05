/**
 * 并行编排测试(§3.5 / §9 P3):parallel 批真并发、max_parallel 上限与退化、
 * 批内失败的确定性排空、budget_paused 排空收尾、feedback 回打前排空在飞、
 * pause 生效于派发边界、并行批取消。
 *
 * 断言约定:并发重叠用双节点互等栅栏(串行引擎会死锁超时,天然判伪);
 * 失败语义用集合级/事件级断言,不依赖交错时序。
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ArtifactRepository } from '../../src/artifacts/index.ts';
import { GrantExecutor } from '../../src/capability/index.ts';
import type { LoadedRegistry, Preset } from '../../src/capability/index.ts';
import { BudgetLedger } from '../../src/budget/index.ts';
import type { Event, EventInput, EventType } from '../../src/events/index.ts';
import type { WorkflowDoc, WorkflowNodeSpec } from '../../src/plancheck/index.ts';
import { MemoryProvider } from '../../src/provision/index.ts';
import { NodeExecutor, WorkflowEngine } from '../../src/engine/index.ts';
import type { NodeRunContext, NodeRuntime, RuntimeResult, WorkflowRunResult } from '../../src/engine/index.ts';

const REGISTRY: LoadedRegistry = {
  protocol: '1.0',
  spec_version: '1.0',
  capabilities: [],
  get: () => undefined,
};

function preset(name: string): Preset {
  return {
    api: 'preset/1.0',
    name,
    description: name,
    base: 'any',
    skills: [],
    idempotent: false,
    baseline_grants: [],
    io_contracts: { inputs: [], outputs: [{ name: 'code', type: 'text' }] },
    escalation_policy: { auto_approve: [], require_approval: [] },
  };
}

function workflow(nodes: readonly WorkflowNodeSpec[], overrides: Partial<WorkflowDoc> = {}): WorkflowDoc {
  return {
    api: 'workflow/1.0',
    intent_ref: 'intent-1',
    nodes,
    outputs: [],
    feedback: [],
    evidence: [],
    ...overrides,
  };
}

interface Harness {
  engine: WorkflowEngine;
  events: Event[];
}

async function setup(
  presets: Readonly<Record<string, Preset>>,
  runtime: NodeRuntime,
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'neoba-parallel-'));
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
  const provider = new MemoryProvider();
  const executor = new NodeExecutor({ provider, runtime, artifacts, grants, emit });
  const engine = new WorkflowEngine({ executor, artifacts, presets });
  return { engine, events };
}

function router(
  handlers: Record<string, (ctx: NodeRunContext, call: number) => RuntimeResult | Promise<RuntimeResult>>,
): NodeRuntime & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  return {
    calls,
    async run(ctx): Promise<RuntimeResult> {
      const call = (calls.get(ctx.nodeId) ?? 0) + 1;
      calls.set(ctx.nodeId, call);
      const handler = handlers[ctx.nodeId];
      if (handler === undefined) throw new Error(`无 runtime 处理器: ${ctx.nodeId}`);
      return handler(ctx, call);
    },
  };
}

function ok(ctx: NodeRunContext): RuntimeResult {
  return { exitCode: 0, events: [], artifacts: [{ name: 'code', payload: `artifact of ${ctx.nodeId}` }] };
}

function crash(): RuntimeResult {
  return { exitCode: 1, events: [], artifacts: [] };
}

function usageEvent(tokensIn: number, tokensOut: number) {
  return {
    ts: new Date().toISOString(),
    agent: null,
    event: 'usage' as const,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_estimate: null,
  };
}

function eventsOf(events: readonly Event[], type: EventType, nodeId?: string): Event[] {
  return events.filter((ev) => {
    if (ev.type !== type) return false;
    if (nodeId === undefined) return true;
    return (ev.payload as unknown as Record<string, unknown>)['nodeId'] === nodeId;
  });
}

function nodeIds(events: readonly Event[], type: EventType): string[] {
  return eventsOf(events, type).map((e) => (e.payload as { nodeId: string }).nodeId);
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const AB: readonly WorkflowNodeSpec[] = [
  { id: 'a', preset: 'coder', parallel: true },
  { id: 'b', preset: 'coder', parallel: true },
];

function runParams(
  engine: WorkflowEngine,
  taskId: string,
  wf: WorkflowDoc,
  opts: { maxParallel?: number; budget?: BudgetLedger } = {},
): Promise<WorkflowRunResult> {
  return engine.run({
    tenant: 't1',
    session: null,
    taskId,
    workflow: wf,
    ...(opts.maxParallel !== undefined ? { maxParallel: opts.maxParallel } : {}),
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  });
}

describe('engine/WorkflowEngine 并行(P3)', () => {
  it('并发重叠:同批 parallel 节点真并发(互等栅栏,串行会超时)', async () => {
    let entered = 0;
    let release!: () => void;
    const bothIn = new Promise<void>((r) => {
      release = r;
    });
    const runtime = router({
      a: async (ctx) => {
        entered += 1;
        if (entered === 2) release();
        await bothIn;
        return ok(ctx);
      },
      b: async (ctx) => {
        entered += 1;
        if (entered === 2) release();
        await bothIn;
        return ok(ctx);
      },
    });
    const { engine, events } = await setup({ coder: preset('coder') }, runtime);
    const result = await runParams(engine, 'task-par', workflow(AB));
    assert.equal(result.status, 'completed');
    assert.equal(entered, 2);
    // 两个节点都在对方启动前未结束 → 必然并发
    assert.deepEqual(nodeIds(events, 'node.started').sort(), ['a', 'b']);
    assert.equal(eventsOf(events, 'node.completed').length, 2);
  });

  it('max_parallel=1:parallel 节点退化为串行,独占派发', async () => {
    let active = 0;
    let peak = 0;
    const runtime = router({
      a: async (ctx) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 15));
        active -= 1;
        return ok(ctx);
      },
      b: async (ctx) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 15));
        active -= 1;
        return ok(ctx);
      },
    });
    const { engine, events } = await setup({ coder: preset('coder') }, runtime);
    const result = await runParams(engine, 'task-par1', workflow(AB), { maxParallel: 1 });
    assert.equal(result.status, 'completed');
    assert.equal(peak, 1);
    // 串行派发序 = 拓扑序(文档序)
    assert.deepEqual(nodeIds(events, 'node.started'), ['a', 'b']);
  });

  it('批内失败:在飞节点照常跑完(排空),再按拓扑序终态失败', async () => {
    const runtime = router({
      a: async (ctx) => {
        await new Promise((r) => setTimeout(r, 20)); // b 立即 crash,a 慢完成
        return ok(ctx);
      },
      b: () => crash(),
    });
    const { engine, events } = await setup({ coder: preset('coder') }, runtime);
    const result = await runParams(engine, 'task-parfail', workflow(AB));
    assert.equal(result.status, 'failed');
    assert.equal(result.failedNode, 'b');
    assert.equal(result.failReason, 'crash');
    // 排空语义:a 不被撕裂,照常完成入账
    assert.equal(eventsOf(events, 'node.completed', 'a').length, 1);
  });

  it('budget_paused:并行批排空后 paused 收尾,续预算 resume 完成', async () => {
    const ledger = new BudgetLedger({ limitTokens: 100 }, { emit: () => {} });
    const runtime = router({
      a: () => ({ exitCode: 0, events: [usageEvent(150, 0)], artifacts: [{ name: 'code', payload: 'x' }] }),
      b: async (ctx) => {
        await new Promise((r) => setTimeout(r, 20)); // 慢于 a 的结算
        return ok(ctx);
      },
    });
    const { engine, events } = await setup({ coder: preset('coder') }, runtime);
    const first = await runParams(engine, 'task-parbudget', workflow(AB), { budget: ledger });
    assert.equal(first.status, 'paused');
    assert.equal(first.failedNode, 'a');
    assert.equal(first.failReason, 'budget_paused');
    // 排空:b 在挂起前照常完成
    assert.equal(eventsOf(events, 'node.completed', 'b').length, 1);

    ledger.raise(1000);
    const second = await engine.resume('task-parbudget');
    assert.equal(second.status, 'completed');
  });

  it('feedback 回打:先排空在飞,再重置 target 及下游重跑', async () => {
    const runtime = router({
      u: (ctx) => ok(ctx),
      a: async (ctx) => {
        if ((runtime.calls.get('a') ?? 0) === 1) {
          await new Promise((r) => setTimeout(r, 20)); // attempt1 慢,b 先 crash
        }
        return ok(ctx);
      },
      b: (_ctx, call) => (call === 1 ? crash() : ok(_ctx)),
    });
    const { engine, events } = await setup({ coder: preset('coder') }, runtime);
    const result = await runParams(
      engine,
      'task-parfb',
      workflow(
        [
          { id: 'u', preset: 'coder' },
          { id: 'a', preset: 'coder', parallel: true, inputs: [{ from: 'u' }] },
          { id: 'b', preset: 'coder', parallel: true, inputs: [{ from: 'u' }], retry: { max: 0, on: ['crash'] } },
        ],
        { feedback: [{ from: 'b', to: 'u', max_traversals: 1 }] },
      ),
    );
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.feedbackTraversals, { 'b->u': 1 });
    // 回打重置了 u/a/b:a 重跑(attempt 2),u 重跑
    assert.equal(eventsOf(events, 'node.started', 'a').length, 2);
    assert.equal(eventsOf(events, 'node.started', 'u').length, 2);
    // attempt1 的 a 在回打前被排空入账,attempt2 再完成一次
    assert.equal(eventsOf(events, 'node.completed', 'a').length, 2);
  });

  it('pause 边界:并行批跑完后停在下一派发边界,resume 续跑', async () => {
    let engineRef: WorkflowEngine | null = null;
    const runtime = router({
      a: (ctx) => {
        engineRef?.pause('task-parpause');
        return ok(ctx);
      },
      b: (ctx) => ok(ctx),
      c: (ctx) => ok(ctx),
    });
    const harness = await setup({ coder: preset('coder') }, runtime);
    engineRef = harness.engine;
    const wf = workflow([
      { id: 'a', preset: 'coder', parallel: true },
      { id: 'b', preset: 'coder', parallel: true },
      { id: 'c', preset: 'coder' },
    ]);
    const runP = runParams(harness.engine, 'task-parpause', wf);
    await waitFor(
      () => eventsOf(harness.events, 'node.completed').length === 2,
      '并行批 a/b 完成',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // c 未派发:批后派发边界被 pause 拦住
    assert.equal(eventsOf(harness.events, 'node.started', 'c').length, 0);

    const resumed = await harness.engine.resume('task-parpause');
    assert.equal(resumed.status, 'completed');
    const final = await runP;
    assert.equal(final.status, 'completed');
    assert.equal(eventsOf(harness.events, 'node.completed', 'c').length, 1);
  });

  it('并行批取消:协作终止在飞节点,failedNode 取拓扑序首个', async () => {
    const runtime: NodeRuntime = {
      run(ctx) {
        return new Promise<RuntimeResult>((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
    const { engine, events } = await setup({ coder: preset('coder') }, runtime);
    const runP = runParams(engine, 'task-parcancel', workflow(AB));
    setTimeout(() => engine.cancel('task-parcancel'), 10);
    const result = await runP;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.failedNode, 'a');
    assert.equal(eventsOf(events, 'sandbox.destroyed').length, 2);
  });
});
