/**
 * P1/P2 daemon 接线测试(§6 + §9):
 * workflow.run 全链路(执行 → 工件 → 任务终态)、pause/resume/cancel 状态机、
 * 预算熔断 budget.status/raise → resume 续跑、审批 RPC(list/decide/grants.of)、
 * models 反馈与持久化、PlanCheck 前置拦截、重启对账(孤儿沙箱 correction)。
 * runtime 全部用桩(NodeRuntime),不依赖真实基座。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { startDaemon } from '../../src/daemon/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';
import { minimalPresetDoc, parsePreset } from '../../src/capability/index.ts';
import type { Preset } from '../../src/capability/index.ts';
import { loadModelRegistry } from '../../src/modelscore/index.ts';
import type { NodeRunContext, NodeRuntime, RuntimeResult } from '../../src/engine/index.ts';

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

async function start(opts: Parameters<typeof startDaemon>[0] = {}): Promise<DaemonHandle> {
  const stateDir = opts.stateDir ?? (await mkdtemp(join(tmpdir(), 'neoba-p2-')));
  if (opts.stateDir === undefined) roots.push(stateDir);
  const handle = await startDaemon({ port: 0, ...opts, stateDir });
  handles.push(handle);
  return handle;
}

async function rpc(handle: DaemonHandle, method: string, params: unknown): Promise<Record<string, unknown>> {
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

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10000;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function taskStatus(handle: DaemonHandle, taskId: string): Promise<Record<string, unknown>> {
  const body = await rpc(handle, 'task.status', { task_id: taskId });
  return ((body['result'] as Record<string, unknown>)?.['task'] ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------- 脚手架

function coderPreset(name = 'coder'): Preset {
  return parsePreset(
    minimalPresetDoc({
      name,
      io_contracts: {
        inputs: [{ name: 'code', type: 'text' }],
        outputs: [{ name: 'code', type: 'text' }],
      },
    }),
  );
}

type Handler = (ctx: NodeRunContext, call: number) => RuntimeResult | Promise<RuntimeResult>;

function stubRuntime(handlers: Record<string, Handler> = {}): NodeRuntime & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  return {
    calls,
    run(ctx): Promise<RuntimeResult> {
      const call = (calls.get(ctx.nodeId) ?? 0) + 1;
      calls.set(ctx.nodeId, call);
      const handler = handlers[ctx.nodeId];
      const outcome: RuntimeResult = handler === undefined
        ? { exitCode: 0, events: [], artifacts: [{ name: 'code', payload: `artifact of ${ctx.nodeId}` }] }
        : (handler(ctx, call) as RuntimeResult);
      return Promise.resolve(outcome);
    },
  };
}

const TWO_NODES = {
  api: 'workflow/1.0',
  intent_ref: 'wf-1',
  nodes: [
    { id: 'impl', preset: 'coder' },
    { id: 'test', preset: 'coder', inputs: [{ from: 'impl.outputs.code' }] },
  ],
  outputs: [{ from: 'test.outputs.code', required: true }],
  feedback: [],
  evidence: [{ node: 'test', artifact: 'code', must_exist: true, sha256_recorded: true }],
};

const INTENT = { api: 'intent/1.0', goal: '做一个东西', acceptance: ['能用'], constraints: {} };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function allEvents(handle: DaemonHandle) {
  return handle.events.readByPrincipal({ tenant: 'default' });
}

// ---------------------------------------------------------------- 用例

describe('P2 接线:workflow.run 全链路', () => {
  it('顺序执行两节点 → 任务 completed,工件发布,输出可 resolve', async () => {
    const runtime = stubRuntime();
    const handle = await start({ presets: { coder: coderPreset() }, runtime });
    const res = await rpc(handle, 'workflow.run', { workflow: TWO_NODES, intent: INTENT });
    const taskId = resultOf(res)['task_id'] as string;
    assert.ok(taskId?.startsWith('task-'));

    await waitFor(async () => (await taskStatus(handle, taskId))['status'] === 'completed', '任务完成');
    const task = await taskStatus(handle, taskId);
    assert.equal(task['preset'], 'workflow:coder+coder');

    // 工件已发布进 CAS,下游节点收到上游 sha256(指令内可查)
    const ref = await handle.artifacts.resolve({ tenant: 'default', task: taskId }, 'test', 'code');
    assert.ok(ref);
    const events = await allEvents(handle);
    assert.ok(events.some((e) => e.type === 'sandbox.created'));
    assert.equal(events.filter((e) => e.type === 'sandbox.destroyed').length, 2);
    assert.ok(events.some((e) => e.type === 'artifact.published'));
  });

  it('PlanCheck 前置拦截:未知预设 → -32013 WORKFLOW_INVALID,问题清单回全', async () => {
    const handle = await start({ presets: { coder: coderPreset() }, runtime: stubRuntime() });
    const res = await rpc(handle, 'workflow.run', {
      workflow: { ...TWO_NODES, nodes: [{ id: 'impl', preset: 'nope' }] },
    });
    const error = res['error'] as Record<string, unknown>;
    assert.equal(error['code'], -32013);
    assert.equal((error['data'] as Record<string, unknown>)['code'], 'WORKFLOW_INVALID');
    assert.ok(((error['data'] as Record<string, unknown>)['issues'] as unknown[]).length >= 1);
  });

  it('task.pause / task.resume:暂停后 test 节点不启动,resume 续跑完成', async () => {
    // impl 节点故意挂住:入口/放行都由测试控制 —— 保证 pause 落在 impl 执行中
    // (pause 不打断在跑节点,闸门在 impl→test 的派发边界生效)。
    const implEntered = deferred();
    const releaseImpl = deferred();
    const runtime = stubRuntime({
      impl: () => {
        implEntered.resolve();
        return releaseImpl.promise.then(
          (): RuntimeResult => ({ exitCode: 0, events: [], artifacts: [{ name: 'code', payload: 'impl' }] }),
        );
      },
    });
    const handle = await start({ presets: { coder: coderPreset() }, runtime });
    const taskId = resultOf(await rpc(handle, 'workflow.run', { workflow: TWO_NODES }))['task_id'] as string;

    await implEntered.promise;
    assert.equal(resultOf(await rpc(handle, 'task.pause', { task_id: taskId }))['paused'], true);
    releaseImpl.resolve(); // 放行 impl;闸门已 paused,引擎停在下一派发边界

    await waitFor(async () => {
      const events = await allEvents(handle);
      return events.some((e) => e.type === 'node.completed' && (e.payload as { nodeId?: string }).nodeId === 'impl');
    }, 'impl 完成');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const events = await allEvents(handle);
    assert.equal(
      events.filter((e) => e.type === 'node.started' && (e.payload as { nodeId?: string }).nodeId === 'test').length,
      0,
      '暂停后 test 节点不应启动',
    );

    const resumed = resultOf(await rpc(handle, 'task.resume', { task_id: taskId }));
    assert.equal(resumed['task_id'], taskId);
    await waitFor(async () => (await taskStatus(handle, taskId))['status'] === 'completed', 'resume 后完成');
  });

  it('task.cancel:执行中取消 → 终态 cancelled,重启重放仍 cancelled', async () => {
    const runtime: NodeRuntime = {
      run: (ctx) =>
        new Promise<RuntimeResult>((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    };
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-p2-cancel-'));
    roots.push(stateDir);
    const first = await start({ stateDir, presets: { coder: coderPreset() }, runtime });
    const taskId = resultOf(
      await rpc(first, 'workflow.run', {
        workflow: { api: 'workflow/1.0', intent_ref: 'wf', nodes: [{ id: 'n1', preset: 'coder' }], outputs: [], feedback: [], evidence: [] },
      }),
    )['task_id'] as string;
    await waitFor(async () => (await allEvents(first)).some((e) => e.type === 'sandbox.created'), '沙箱拉起');
    assert.equal(resultOf(await rpc(first, 'task.cancel', { task_id: taskId }))['cancelled'], true);
    await waitFor(async () => (await taskStatus(first, taskId))['status'] === 'cancelled', '取消落定');
    await first.stop();
    handles.pop();

    const second = await start({ stateDir, presets: { coder: coderPreset() }, runtime });
    handles.pop();
    handles.push(second);
    assert.equal((await taskStatus(second, taskId))['status'], 'cancelled', '重放后仍 cancelled');
  });

  it('预算熔断:hard → paused;budget.raise + task.resume 续跑完成', async () => {
    const usage = {
      ts: new Date().toISOString(),
      agent: null,
      event: 'usage' as const,
      tokens_in: 150,
      tokens_out: 0,
      cost_estimate: null,
    };
    const runtime = stubRuntime({
      n1: () => ({ exitCode: 0, events: [usage], artifacts: [{ name: 'code', payload: 'x' }] }),
    });
    const handle = await start({ presets: { coder: coderPreset() }, runtime });
    const taskId = resultOf(
      await rpc(handle, 'workflow.run', {
        workflow: { api: 'workflow/1.0', intent_ref: 'wf', nodes: [{ id: 'n1', preset: 'coder' }], outputs: [], feedback: [], evidence: [] },
        budget: { limit_tokens: 100 },
      }),
    )['task_id'] as string;

    await waitFor(async () => (await taskStatus(handle, taskId))['status'] === 'paused', '预算挂起');
    const status = resultOf(await rpc(handle, 'budget.status', { task_id: taskId }));
    assert.equal((status['budget'] as Record<string, unknown>)['level'], 'hard');
    assert.equal((status['budget'] as Record<string, unknown>)['observed_tokens'], 150);

    const raised = resultOf(await rpc(handle, 'budget.raise', { task_id: taskId, limit_tokens: 1000 }));
    assert.equal(raised['raised'], true);
    await rpc(handle, 'task.resume', { task_id: taskId });
    await waitFor(async () => (await taskStatus(handle, taskId))['status'] === 'completed', '续跑完成');
  });
});

describe('P2 接线:审批 RPC(人机入口)', () => {
  it('pending 单经 approvals.list 可见,decide 授予(窄化)后 grants.of 可查', async () => {
    const handle = await start();
    await handle.board.submit({
      from: 'task-42/worker-01',
      reqId: 'req-1',
      cap: 'mcp:playwright',
      reason: '需要截图验证',
      scope: 'write',
      duration: '2h',
    });
    const list = resultOf(await rpc(handle, 'approvals.list', { status: 'pending' }));
    assert.equal((list['approvals'] as Record<string, unknown>[])[0]?.['reqId'], 'req-1');

    const decided = resultOf(
      await rpc(handle, 'approvals.decide', {
        req_id: 'req-1',
        decision: 'granted',
        by: 'ops-1',
        narrowed_to: '${task.workdir}/shots',
      }),
    );
    assert.equal(decided['decision'], 'granted');
    const pending = resultOf(await rpc(handle, 'approvals.list', { status: 'pending' }));
    assert.equal((pending['approvals'] as unknown[]).length, 0);

    // 授予落 grant manifest(source=escalation,窄化 constraint)
    const manifest = resultOf(await rpc(handle, 'grants.of', { agent_id: 'task-42/worker-01' }));
    const grants = (manifest['manifest'] as Record<string, unknown>)['grants'] as Record<string, unknown>[];
    assert.equal(grants[0]?.['source'], 'escalation:req-1');
    assert.equal(
      ((grants[0]?.['constraint'] as Record<string, unknown>) ?? {})['fs_scope_narrowed_to'],
      '${task.workdir}/shots',
    );

    // 审批事件落了日志(approval.requested/decided)
    const events = await allEvents(handle);
    assert.ok(events.some((e) => e.type === 'approval.requested'));
    assert.ok(events.some((e) => e.type === 'approval.decided'));
  });

  it('重复定案 → REQ_UNKNOWN 域错误(-32000)', async () => {
    const handle = await start();
    await handle.board.submit({
      from: 'task-42/worker-01',
      reqId: 'req-2',
      cap: 'mcp:playwright',
      reason: '需要截图验证',
      scope: 'read',
      duration: '1h',
    });
    await rpc(handle, 'approvals.decide', { req_id: 'req-2', decision: 'granted', by: 'ops-1' });
    const res = await rpc(handle, 'approvals.decide', { req_id: 'req-2', decision: 'denied', by: 'ops-1' });
    const error = res['error'] as Record<string, unknown>;
    assert.equal(error['code'], -32000);
    assert.equal((error['data'] as Record<string, unknown>)['code'], 'REQ_UNKNOWN');
  });
});

describe('P2 接线:模型评分 RPC 与持久化', () => {
  function entryDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      protocol: '1.0',
      spec_version: '1.0',
      model: 'glm-4.7-air',
      tier_fit: { fast: 0.91, standard: 0.62, heavy: 0.3 },
      score: {
        prior: { fast: 0.88, standard: 0.55, heavy: 0.2 },
        observed: { fast: null, standard: null, heavy: null },
        samples: { fast: 0, standard: 0, heavy: 0 },
        dimensions: { quality: 0.8, success_rate: 0.85, cost_efficiency: 0.74 },
      },
      updated_at: '2026-09-05T00:00:00Z',
      ...overrides,
    };
  }

  it('models.feedback 更新 EMA 并回写 modelscore.json;重启后仍在', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-p2-models-'));
    roots.push(stateDir);
    const first = await start({ stateDir, models: loadModelRegistry(entryDoc()) });
    const fed = resultOf(
      await rpc(first, 'models.feedback', {
        model: 'glm-4.7-air',
        tier: 'fast',
        success: true,
        quality: 0.9,
        task_type: 'bugfix',
        traversals: 0,
      }),
    );
    assert.equal(fed['observed'], 0.95);
    assert.equal(fed['samples'], 1);
    await first.stop();
    handles.pop();

    // 持久化文件已回写
    const persisted = JSON.parse(await readFile(join(stateDir, 'modelscore.json'), 'utf8')) as {
      models: { model: string; score: { samples: { fast: number } } }[];
    };
    assert.equal(persisted['models'][0]?.['score']['samples']['fast'], 1);

    // 重启(不注入 registry,从文件加载)
    const second = await start({ stateDir });
    handles.pop();
    handles.push(second);
    const list = resultOf(await rpc(second, 'models.list', {}));
    const models = list['models'] as { model: string; score: { samples: { fast: number } } }[];
    assert.equal(models.length, 1);
    assert.equal(models[0]?.['score']['samples']['fast'], 1);
  });

  it('未知模型 → ModelUnknown 域错误', async () => {
    const handle = await start();
    const res = await rpc(handle, 'models.feedback', { model: 'nope', tier: 'fast', success: true });
    assert.equal(((res['error'] as Record<string, unknown>)['data'] as Record<string, unknown>)['code'], 'MODEL_UNKNOWN');
  });
});

describe('P1 接线:重启对账(孤儿沙箱 correction)', () => {
  it('在飞沙箱重启后查实态缺失 → correction 落盘 + recovered 计数', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-p2-recover-'));
    roots.push(stateDir);
    const first = await start({ stateDir });
    await first.events.append({
      type: 'sandbox.created',
      principal: { tenant: 'default', session: null, task: 'task-x', agent: 'task-x/worker-01' },
      payload: { sandboxId: 'sbx-orphan', backend: 'memory' },
    });
    await first.stop();
    handles.pop();

    const second = await start({ stateDir });
    handles.pop();
    handles.push(second);
    assert.equal(second.recovered.corrected, 1);
    assert.ok(second.recovered.inFlight >= 1);
    const events = await second.events.readByPrincipal({ tenant: 'default' });
    const correction = events.find((e) => e.type === 'correction');
    assert.ok(correction);
    assert.equal((correction.payload as { target?: string })['target'], 'sandbox:sbx-orphan');
    const recovered = events.filter((e) => e.type === 'daemon.recovered');
    assert.equal((recovered.at(-1)?.payload as { corrected?: number })['corrected'], 1);
  });
});

// ---------------------------------------------------------------- M3:per-session token

/** 以任意 Bearer token 调 RPC(session token 流用;admin 走上面的 rpc)。 */
async function rpcAs(
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

async function sessionToken(
  handle: DaemonHandle,
  tenant: string,
  session: string,
): Promise<string> {
  const init = resultOf(
    await rpc(handle, 'session.init', {
      protocol: '1.0',
      role: 'orchestrator',
      principal: { tenant, session },
      harness: 'p2-test',
      capabilities: {},
    }),
  );
  const token = init['token'];
  assert.equal(typeof token, 'string', 'session.init 应签发会话 token');
  return token as string;
}

describe('M3 接线:per-session token 与越权', () => {
  it('session.init 签发 token;绑定 principal 内可操作;显式异 principal → 403/-32014', async () => {
    const handle = await start();
    const token = await sessionToken(handle, 'acme', 'dev-1');

    // 省略 principal = 取绑定值
    const created = await rpcAs(handle, token, 'task.create', {
      intent: '会话内任务',
      preset: 'minimal',
    });
    assert.equal(created.status, 200);
    const taskId = (created.body['result'] as Record<string, unknown>)['task_id'];
    assert.match(taskId as string, /^task-/);

    // 显式一致放行
    const explicit = await rpcAs(handle, token, 'task.create', {
      intent: '显式一致',
      preset: 'minimal',
      tenant: 'acme',
      session: 'dev-1',
    });
    assert.equal(explicit.status, 200);

    // 显式异 session → SESSION_FORBIDDEN
    const foreign = await rpcAs(handle, token, 'task.create', {
      intent: '越权',
      preset: 'minimal',
      tenant: 'acme',
      session: 'other',
    });
    assert.equal(foreign.status, 403);
    const err = foreign.body['error'] as Record<string, unknown>;
    assert.equal(err['code'], -32014);
    assert.equal((err['data'] as Record<string, unknown>)['code'], 'SESSION_FORBIDDEN');

    // 显式异 tenant 同样拒绝
    const otherTenant = await rpcAs(handle, token, 'task.create', {
      intent: '越权',
      preset: 'minimal',
      tenant: 'evil',
      session: 'dev-1',
    });
    assert.equal(otherTenant.status, 403);

    // admin 建的任务不属于本会话,session 身份不可触达
    const adminTask = resultOf(await rpc(handle, 'task.create', { intent: 'admin 的任务', preset: 'minimal' }));
    const adminTaskId = adminTask['task_id'] as string;
    for (const method of ['task.status', 'task.pause', 'task.cancel', 'budget.status']) {
      const res = await rpcAs(handle, token, method, { task_id: adminTaskId });
      assert.equal(res.status, 403, `${method} 应 403`);
    }
    // 自己的任务可查
    const own = await rpcAs(handle, token, 'task.status', { task_id: taskId });
    assert.equal(own.status, 200);
  });

  it('task.list 按会话收窄:session 身份只见本人任务,admin 全量', async () => {
    const handle = await start();
    const tokenA = await sessionToken(handle, 'acme', 'dev-1');
    const tokenB = await sessionToken(handle, 'acme', 'dev-2');
    await rpcAs(handle, tokenA, 'task.create', { intent: 'a 的任务', preset: 'minimal' });
    await rpc(handle, 'task.create', { intent: 'admin 的任务', preset: 'minimal' });

    const listA = resultOf((await rpcAs(handle, tokenA, 'task.list', {})).body);
    const aTasks = listA['tasks'] as { session: string | null }[];
    assert.equal(aTasks.length, 1);
    assert.equal(aTasks[0]?.session, 'dev-1');

    const listB = resultOf((await rpcAs(handle, tokenB, 'task.list', {})).body);
    assert.equal((listB['tasks'] as unknown[]).length, 0);

    const listAdmin = resultOf(await rpc(handle, 'task.list', {}));
    assert.ok((listAdmin['tasks'] as unknown[]).length >= 2);
  });

  it('重启后 token 在注册表但会话未激活 → SESSION_UNKNOWN(404/-32011)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-p2-identity-'));
    roots.push(stateDir);
    const first = await start({ stateDir });
    const token = await sessionToken(first, 'acme', 'dev-1');
    await first.stop();
    handles.pop();

    const second = await start({ stateDir });
    handles.pop();
    handles.push(second);
    // token 仍能过鉴权(注册表持久化),但会话表是内存态已清空。
    const res = await rpcAs(second, token, 'task.create', {
      intent: '重启后',
      preset: 'minimal',
    });
    assert.equal(res.status, 404);
    const err = res.body['error'] as Record<string, unknown>;
    assert.equal(err['code'], -32011);
    assert.equal((err['data'] as Record<string, unknown>)['code'], 'SESSION_UNKNOWN');
  });

  it('审批权绑定:session 只能定案本人会话审批单,by 强制记会话身份', async () => {
    const handle = await start();
    const token = await sessionToken(handle, 'acme', 'dev-1');
    const created = resultOf(
      (await rpcAs(handle, token, 'task.create', { intent: '自己的任务', preset: 'minimal' })).body,
    );
    const ownTaskId = created['task_id'] as string;

    await handle.board.submit({
      from: `${ownTaskId}/worker-01`,
      reqId: 'req-own',
      cap: 'mcp:playwright',
      reason: '需要浏览器',
      scope: 'write',
      duration: '1h',
    });
    await handle.board.submit({
      from: 'task-foreign/worker-01',
      reqId: 'req-foreign',
      cap: 'mcp:playwright',
      reason: '别人的单',
      scope: 'read',
      duration: '1h',
    });

    // approvals.list 收窄:只见本人会话的单
    const list = resultOf(
      (await rpcAs(handle, token, 'approvals.list', { status: 'pending' })).body,
    );
    const reqIds = (list['approvals'] as { reqId: string }[]).map((r) => r.reqId);
    assert.deepEqual(reqIds, ['req-own']);

    // 他人的单/未知单定案 → APPROVAL_FORBIDDEN(403/-32016)
    for (const reqId of ['req-foreign', 'req-unknown']) {
      const res = await rpcAs(handle, token, 'approvals.decide', {
        req_id: reqId,
        decision: 'granted',
        by: 'spoofed',
      });
      assert.equal(res.status, 403, `${reqId} 应 403`);
      const err = res.body['error'] as Record<string, unknown>;
      assert.equal(err['code'], -32016);
      assert.equal((err['data'] as Record<string, unknown>)['code'], 'APPROVAL_FORBIDDEN');
    }
    // 他人的单仍 pending(admin 可见)
    const adminList = resultOf(await rpc(handle, 'approvals.list', { status: 'pending' }));
    assert.equal((adminList['approvals'] as unknown[]).length, 2);

    // 本人单定案放行:by 被强制记为会话身份,忽略调用方伪造的 by
    const decided = resultOf(
      (await rpcAs(handle, token, 'approvals.decide', {
        req_id: 'req-own',
        decision: 'granted',
        by: 'spoofed',
      })).body,
    );
    assert.equal(decided['decision'], 'granted');
    const record = decided['record'] as Record<string, unknown>;
    assert.equal(record['decidedBy'], 'acme/dev-1');
  });
});

