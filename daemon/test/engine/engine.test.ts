/**
 * 执行引擎测试(§3.5 / §9 P1 执行链、P2 WorkflowSpec 引擎):
 * 顺序推进与工件发布、crash 重试、timeout 仅幂等可重试、有界反馈回打与超限、
 * 预算熔断 pause→raise→resume、pause/cancel 状态机、证据双重校验、
 * 必需输出未解析、重复执行拒绝。
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ArtifactRepository } from '../../src/artifacts/index.ts';
import type { ArtifactNamespace } from '../../src/artifacts/index.ts';
import { GrantExecutor } from '../../src/capability/index.ts';
import type { LoadedRegistry, Preset } from '../../src/capability/index.ts';
import { BudgetLedger } from '../../src/budget/index.ts';
import type { Event, EventInput, EventType } from '../../src/events/index.ts';
import type { WorkflowDoc, WorkflowNodeSpec } from '../../src/plancheck/index.ts';
import { MemoryProvider } from '../../src/provision/index.ts';
import { NodeExecutor } from '../../src/engine/index.ts';
import { RunDuplicate } from '../../src/engine/index.ts';
import { WorkflowEngine } from '../../src/engine/index.ts';
import type { NodeRunContext, NodeRuntime, RuntimeResult } from '../../src/engine/index.ts';

// ---------------------------------------------------------------- 测试脚手架

const REGISTRY: LoadedRegistry = {
  protocol: '1.0',
  spec_version: '1.0',
  capabilities: [],
  get: () => undefined,
};

function preset(name: string, overrides: Partial<Preset> = {}): Preset {
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
    ...overrides,
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
  artifacts: ArtifactRepository;
  calls: ReadonlyMap<string, number>;
}

/** runtime 路由器:按 nodeId 分发,记录每节点调用次数。 */
function router(
  handlers: Record<string, (ctx: NodeRunContext, call: number) => RuntimeResult | Promise<RuntimeResult>>,
): NodeRuntime & { calls: ReadonlyMap<string, number> } {
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

function ok(ctx: NodeRunContext, artifactName = 'code'): RuntimeResult {
  return { exitCode: 0, events: [], artifacts: [{ name: artifactName, payload: `artifact of ${ctx.nodeId}` }] };
}

function crash(exitCode = 1): RuntimeResult {
  return { exitCode, events: [], artifacts: [] };
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

function inventoryEvent() {
  return {
    ts: new Date().toISOString(),
    agent: null,
    event: 'tool_inventory' as const,
    tools: ['Read', 'Write'],
    mcp_servers: ['playwright'],
    permission_mode: 'default',
    model: 'fake-model',
    session_id: 'fake-sess',
  };
}

async function setup(
  presets: Readonly<Record<string, Preset>>,
  runtime: NodeRuntime & { readonly calls?: ReadonlyMap<string, number> },
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'neoba-engine-'));
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
  return { engine, events, artifacts, calls: runtime.calls ?? new Map() };
}

function eventsOf(events: readonly Event[], type: EventType, nodeId?: string): Event[] {
  return events.filter((ev) => {
    if (ev.type !== type) return false;
    if (nodeId === undefined) return true;
    return (ev.payload as unknown as Record<string, unknown>)['nodeId'] === nodeId;
  });
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const TWO_NODES: readonly WorkflowNodeSpec[] = [
  { id: 'impl', preset: 'coder' },
  { id: 'test', preset: 'coder', inputs: [{ from: 'impl' }] },
];

// ---------------------------------------------------------------- 用例

describe('engine/WorkflowEngine', () => {
  it('顺序推进:依赖序执行、上游工件经 sha256 传递、产物发布进 CAS', async () => {
    const captured: NodeRunContext[] = [];
    const runtime = router({
      impl: (ctx) => {
        captured.push(ctx);
        return ok(ctx);
      },
      test: (ctx) => {
        captured.push(ctx);
        return ok(ctx);
      },
    });
    const { engine, events, artifacts } = await setup({ coder: preset('coder') }, runtime);
    const taskId = 'task-seq';
    const result = await engine.run({
      tenant: 't1',
      session: 's1',
      taskId,
      workflow: workflow(TWO_NODES, { outputs: [{ from: 'test', required: true }] }),
      intent: { api: 'intent/1.0', goal: '做一个东西', acceptance: [], constraints: {} },
    });

    assert.equal(result.status, 'completed');
    // 上游 sha256 传给下游 runtime
    const ns = { tenant: 't1', task: taskId };
    const implSha = (await artifacts.resolve(ns, 'impl', 'code'))?.rootSha256;
    const testSha = (await artifacts.resolve(ns, 'test', 'code'))?.rootSha256;
    assert.ok(implSha);
    assert.ok(testSha);
    const testCtx = captured[1];
    assert.ok(testCtx);
    assert.deepEqual(testCtx.inputArtifacts, [{ from: 'impl', name: 'code', sha256: implSha }]);
    // 工作流输出映射(test 节点自己的产物哈希)
    assert.equal(result.outputs['test']?.[0]?.sha256, testSha);
    // 事件顺序:impl 先于 test,生命周期齐全
    const started = eventsOf(events, 'node.started');
    assert.deepEqual(started.map((e) => (e.payload as { nodeId: string }).nodeId), ['impl', 'test']);
    assert.equal(eventsOf(events, 'node.completed').length, 2);
    assert.equal(eventsOf(events, 'sandbox.created').length, 2);
    assert.equal(eventsOf(events, 'sandbox.destroyed').length, 2);
    // 指令含目标与上游引用
    assert.match(testCtx.instruction, /做一个东西/);
    assert.match(testCtx.instruction, /impl\/code/);
  });

  it('crash 重试:按 retry.on 重跑,attempt 递增入事件', async () => {
    const runtime = router({
      n1: (_ctx, call) => (call === 1 ? crash() : ok(_ctx)),
    });
    const { engine, events } = await setup(
      { coder: preset('coder') },
      runtime,
    );
    const result = await engine.run({
      tenant: 't1',
      session: null,
      taskId: 'task-retry',
      workflow: workflow([{ id: 'n1', preset: 'coder', retry: { max: 1, on: ['crash'] } }]),
    });
    assert.equal(result.status, 'completed');
    const started = eventsOf(events, 'node.started', 'n1');
    assert.deepEqual(
      started.map((e) => (e.payload as { attempt: number }).attempt),
      [1, 2],
    );
    const failed = eventsOf(events, 'node.failed', 'n1');
    assert.equal(failed.length, 1);
    assert.equal((failed[0]?.payload as { reason: string }).reason, 'crash');
  });

  it('timeout:非幂等预设不重试直接失败;幂等预设按 on 重试后成功', async () => {
    const hang = () => new Promise<RuntimeResult>(() => {});
    const runtime = router({
      a: hang, // attempt 1 挂起,由超时收割
    });
    const { engine } = await setup({ coder: preset('coder') }, runtime);
    const runP = engine.run({
      tenant: 't1',
      session: null,
      taskId: 'task-timeout',
      workflow: workflow([
        { id: 'a', preset: 'coder', timeout: 0.05, retry: { max: 1, on: ['timeout'] } },
      ]),
    });
    const result = await runP;
    assert.equal(result.status, 'failed');
    assert.equal(result.failReason, 'timeout');
    assert.equal(result.failedNode, 'a');

    // 幂等预设:超时重试,第二次成功
    let calls = 0;
    const runtime2: NodeRuntime = {
      async run() {
        calls += 1;
        if (calls === 1) return hang();
        return { exitCode: 0, events: [], artifacts: [{ name: 'code', payload: 'x' }] };
      },
    };
    const { engine: engine2 } = await setup(
      { coder: preset('coder', { idempotent: true }) },
      runtime2,
    );
    const result2 = await engine2.run({
      tenant: 't1',
      session: null,
      taskId: 'task-timeout2',
      workflow: workflow([
        { id: 'a', preset: 'coder', timeout: 0.05, retry: { max: 1, on: ['timeout'] } },
      ]),
    });
    assert.equal(result2.status, 'completed');
  });

  it('有界反馈:test 失败回打 impl(下游重置重跑),计数入终态', async () => {
    const runtime = router({
      impl: (ctx) => ok(ctx),
      test: (_ctx, call) => (call === 1 ? crash() : ok(_ctx)),
    });
    const { engine, events } = await setup({ coder: preset('coder') }, runtime);
    const result = await engine.run({
      tenant: 't1',
      session: null,
      taskId: 'task-fb',
      workflow: workflow(TWO_NODES, {
        feedback: [{ from: 'test', to: 'impl', max_traversals: 1 }],
      }),
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.feedbackTraversals, { 'test->impl': 1 });
    // impl 被重跑(attempt 2),test 也在 attempt 2 成功
    assert.deepEqual(
      eventsOf(events, 'node.started', 'impl').map((e) => (e.payload as { attempt: number }).attempt),
      [1, 2],
    );
    assert.equal(eventsOf(events, 'node.completed', 'test').length, 1);
  });

  it('反馈超限:回打次数用尽后升级为终态失败', async () => {
    const runtime = router({
      impl: (ctx) => ok(ctx),
      test: () => crash(),
    });
    const { engine } = await setup({ coder: preset('coder') }, runtime);
    const result = await engine.run({
      tenant: 't1',
      session: null,
      taskId: 'task-fb-limit',
      workflow: workflow(TWO_NODES, {
        feedback: [{ from: 'test', to: 'impl', max_traversals: 1 }],
      }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.failedNode, 'test');
    assert.equal(result.failReason, 'crash');
    assert.match(result.detail ?? '', /超限/);
    assert.deepEqual(result.feedbackTraversals, { 'test->impl': 1 });
  });

  it('预算熔断:usage 超 hard → budget_paused 挂起;raise 后 resume 完成', async () => {
    const budgetEvents: unknown[] = [];
    const ledger = new BudgetLedger({ limitTokens: 100 }, {
      emit: (e) => {
        budgetEvents.push(e);
      },
    });
    const runtime = router({
      n1: () => ({ exitCode: 0, events: [usageEvent(150, 0)], artifacts: [{ name: 'code', payload: 'x' }] }),
    });
    const { engine, events } = await setup({ coder: preset('coder') }, runtime);
    const first = await engine.run({
      tenant: 't1',
      session: null,
      taskId: 'task-budget',
      workflow: workflow([{ id: 'n1', preset: 'coder' }]),
      budget: ledger,
    });
    assert.equal(first.status, 'paused');
    assert.equal(first.failedNode, 'n1');
    assert.equal(first.failReason, 'budget_paused');
    // 落账先于记账:触发熔断的 usage 事实本身已入事件日志(§6 审计同一份)。
    assert.equal(eventsOf(events, 'usage', 'n1').length, 1);
    const failed = eventsOf(events, 'node.failed', 'n1');
    assert.equal((failed[0]?.payload as { reason: string }).reason, 'budget_paused');
    assert.equal(engine.pause('task-budget'), false); // paused 状态由 budget 挂起,pause 不重复

    ledger.raise(1000);
    const second = await engine.resume('task-budget');
    assert.equal(second.status, 'completed');
    assert.ok(budgetEvents.some((e) => (e as { type: string }).type === 'budget.exceeded'));
  });

  it('§3.6 运行事件落账:tool_inventory / usage 随节点入事件日志(无 budget 也落)', async () => {
    const runtime = router({
      n1: () => ({
        exitCode: 0,
        events: [inventoryEvent(), usageEvent(12, 3)],
        artifacts: [{ name: 'code', payload: 'x' }],
      }),
    });
    const { engine, events } = await setup({ coder: preset('coder') }, runtime);
    const result = await engine.run({
      tenant: 't1',
      session: 's1',
      taskId: 'task-run-events',
      workflow: workflow([{ id: 'n1', preset: 'coder' }]),
    });
    assert.equal(result.status, 'completed');

    // 清单事件:节点上下文 + 归一清单本体
    const inventories = eventsOf(events, 'tool_inventory', 'n1');
    assert.equal(inventories.length, 1);
    const inv = inventories[0]!;
    assert.deepEqual(inv.payload, {
      nodeId: 'n1',
      attempt: 1,
      tools: ['Read', 'Write'],
      mcpServers: ['playwright'],
      permissionMode: 'default',
      model: 'fake-model',
      sessionId: 'fake-sess',
    });
    assert.equal(inv.principal.task, 'task-run-events');
    assert.equal(inv.principal.agent, 'task-run-events/n1');

    // 用量事件:无 budget 配置也落账(记账是独立环节,不丢事实)
    const usages = eventsOf(events, 'usage', 'n1');
    assert.equal(usages.length, 1);
    assert.deepEqual(usages[0]!.payload, {
      nodeId: 'n1',
      attempt: 1,
      tokensIn: 12,
      tokensOut: 3,
      costEstimate: null,
    });

    // 顺序:归一事件在 node.started 之后、node.completed 之前
    const order = events.map((e) => e.type);
    assert.ok(order.indexOf('node.started') < order.indexOf('tool_inventory'));
    assert.ok(order.indexOf('usage') < order.indexOf('node.completed'));
  });

  it('pause/resume:当前节点跑完后停在派发边界,resume 续跑', async () => {
    let engineRef: WorkflowEngine | null = null;
    const runtime = router({
      impl: (ctx) => {
        engineRef?.pause('task-pause');
        return ok(ctx);
      },
      test: (ctx) => ok(ctx),
    });
    const harness = await setup({ coder: preset('coder') }, runtime);
    engineRef = harness.engine;
    const runP = harness.engine.run({
      tenant: 't1',
      session: null,
      taskId: 'task-pause',
      workflow: workflow(TWO_NODES),
    });
    // impl 完成(pause 生效于 impl→test 的派发边界)
    await waitFor(
      () => eventsOf(harness.events, 'node.completed', 'impl').length === 1,
      'impl 完成',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(eventsOf(harness.events, 'node.started', 'test').length, 0);

    const resumed = await harness.engine.resume('task-pause');
    assert.equal(resumed.status, 'completed');
    // run() 与 resume 送达同一终态
    const final = await runP;
    assert.equal(final.status, 'completed');
    assert.equal(eventsOf(harness.events, 'node.completed', 'test').length, 1);
  });

  it('cancel:执行中节点协作终止,终态 cancelled,沙箱销毁', async () => {
    const runtime: NodeRuntime & { calls: ReadonlyMap<string, number> } = {
      calls: new Map(),
      run(ctx) {
        return new Promise<RuntimeResult>((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
    const { engine, events } = await setup({ coder: preset('coder') }, runtime);
    const runP = engine.run({
      tenant: 't1',
      session: null,
      taskId: 'task-cancel',
      workflow: workflow([{ id: 'n1', preset: 'coder' }]),
    });
    setTimeout(() => engine.cancel('task-cancel'), 10);
    const result = await runP;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.failedNode, 'n1');
    assert.equal(eventsOf(events, 'sandbox.destroyed').length, 1);
    assert.equal(engine.cancel('task-cancel'), false); // 终态出表,再取消无目标
  });

  it('重复执行拒绝:同 taskId 未终态时再 run 抛 RunDuplicate', async () => {
    const runtime: NodeRuntime = {
      run: (ctx) => new Promise<RuntimeResult>((_, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    };
    const { engine } = await setup({ coder: preset('coder') }, runtime);
    const runP = engine.run({
      tenant: 't1',
      session: null,
      taskId: 'task-dup',
      workflow: workflow([{ id: 'n1', preset: 'coder' }]),
    });
    await assert.rejects(
      () =>
        engine.run({
          tenant: 't1',
          session: null,
          taskId: 'task-dup',
          workflow: workflow([{ id: 'n1', preset: 'coder' }]),
        }),
      RunDuplicate,
    );
    engine.cancel('task-dup');
    await runP;
  });

  it('证据校验:must_exist 缺失 → evidence_missing;齐备时通过', async () => {
    const runtime = router({ n1: (ctx) => ok(ctx) });
    const { engine } = await setup({ coder: preset('coder') }, runtime);
    const missing = await engine.run({
      tenant: 't1',
      session: null,
      taskId: 'task-ev1',
      workflow: workflow([{ id: 'n1', preset: 'coder' }], {
        evidence: [{ node: 'n1', artifact: 'nope', must_exist: true, sha256_recorded: true }],
      }),
    });
    assert.equal(missing.status, 'failed');
    assert.equal(missing.failReason, 'evidence_missing');

    const present = await engine.run({
      tenant: 't1',
      session: null,
      taskId: 'task-ev2',
      workflow: workflow([{ id: 'n1', preset: 'coder' }], {
        evidence: [{ node: 'n1', artifact: 'code', must_exist: true, sha256_recorded: true }],
      }),
    });
    assert.equal(present.status, 'completed');
  });

  it('必需输出未解析:节点无产物声明时 required 输出失败', async () => {
    const runtime = router({ n1: (ctx) => ok(ctx) });
    const { engine } = await setup({ coder: preset('coder', { io_contracts: { inputs: [], outputs: [] } }) }, runtime);
    const result = await engine.run({
      tenant: 't1',
      session: null,
      taskId: 'task-out',
      workflow: workflow([{ id: 'n1', preset: 'coder' }], {
        outputs: [{ from: 'n1', required: true }],
      }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.failReason, 'output_unresolved');
  });

  it('契约产物缺失:runtime 未交付端口产物 → output_missing', async () => {
    const runtime = router({ n1: () => ({ exitCode: 0, events: [], artifacts: [] }) });
    const { engine, events } = await setup({ coder: preset('coder') }, runtime);
    const result = await engine.run({
      tenant: 't1',
      session: null,
      taskId: 'task-gap',
      workflow: workflow([{ id: 'n1', preset: 'coder' }]),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.failReason, 'output_missing');
    const failed = eventsOf(events, 'node.failed', 'n1');
    assert.equal((failed[0]?.payload as { reason: string }).reason, 'output_missing');
  });
});
