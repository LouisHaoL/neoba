/**
 * e2e:workflow 执行链(task-chain,issue #1 回归)。
 *
 * 真实 daemon(HTTP 绑定 + stub runtime)跑 workflow.run 双节点链:
 *   1. 执行期事件断言:节点基线授予落 grant.granted —— principal 带 task/agent
 *      两层,payload 与 task.create 路径同一事件形状(cap/scope/source/decisionSource);
 *   2. grants.of 即时可见(manifest 快照随授予同步 TaskStore);
 *   3. 重启重放后 grant manifest 从事件流重建(§6 唯一事实源)。
 *
 * 注:节点内 harness 流事件(tool_inventory / usage)是 RuntimeResult 的
 * 进程内事实,不入 EventLog —— 属 issue #2 的观测面范畴,本文件不做断言。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { startDaemon } from '../../src/daemon/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';
import { minimalPresetDoc, parsePreset } from '../../src/capability/index.ts';
import type { Preset } from '../../src/capability/index.ts';
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
  const stateDir = opts.stateDir ?? (await mkdtemp(join(tmpdir(), 'neoba-e2e-chain-')));
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

// ---------------------------------------------------------------- 夹具

function coderPreset(): Preset {
  return parsePreset(
    minimalPresetDoc({
      name: 'coder',
      baseline_grants: [{ cap: 'fs:workdir', scope: 'rw' }],
      io_contracts: {
        inputs: [{ name: 'code', type: 'text' }],
        outputs: [{ name: 'code', type: 'text' }],
      },
    }),
  );
}

function stubRuntime(): NodeRuntime {
  return {
    run(ctx: NodeRunContext): Promise<RuntimeResult> {
      return Promise.resolve({
        exitCode: 0,
        events: [],
        artifacts: [{ name: 'code', payload: `artifact of ${ctx.nodeId}` }],
      });
    },
  };
}

const TWO_NODES = {
  api: 'workflow/1.0',
  intent_ref: 'wf-chain-1',
  nodes: [
    { id: 'impl', preset: 'coder' },
    { id: 'test', preset: 'coder', inputs: [{ from: 'impl.outputs.code' }] },
  ],
  outputs: [{ from: 'test.outputs.code', required: true }],
  feedback: [],
  evidence: [{ node: 'test', artifact: 'code', must_exist: true, sha256_recorded: true }],
};

const INTENT = { api: 'intent/1.0', goal: '两节点链路冒烟', acceptance: ['能用'], constraints: {} };

/** 断言一个 agent 的 manifest 恰含基线授予 fs:workdir rw。 */
async function assertBaselineManifest(handle: DaemonHandle, taskId: string, nodeId: string): Promise<void> {
  const body = await rpc(handle, 'grants.of', { agent_id: `${taskId}/${nodeId}` });
  const manifest = resultOf(body)['manifest'] as Record<string, unknown> | null;
  assert.ok(manifest !== null, `grants.of(${nodeId}) 应有 manifest`);
  const grants = manifest['grants'] as Record<string, unknown>[];
  assert.deepEqual(
    grants.map((g) => [g['cap'], g['scope'], g['source'], g['ttl']]),
    [['fs:workdir', 'rw', 'baseline', null]],
  );
}

// ---------------------------------------------------------------- 用例

describe('e2e:workflow 执行链(issue #1:基线授予审计)', () => {
  it('执行期 grant.granted 落事件(principal 带 task/agent);重启重放后 grants.of 重建 manifest', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-e2e-chain-restart-'));
    roots.push(stateDir);
    const first = await start({ stateDir, presets: { coder: coderPreset() }, runtime: stubRuntime() });
    const taskId = resultOf(
      await rpc(first, 'workflow.run', { workflow: TWO_NODES, intent: INTENT }),
    )['task_id'] as string;

    await waitFor(async () => {
      const body = await rpc(first, 'task.status', { task_id: taskId });
      return ((resultOf(body)['task'] as Record<string, unknown>) ?? {})['status'] === 'completed';
    }, '任务完成');

    // 执行期事件:基线授予逐节点落 grant.granted,形状与 task.create 路径一致
    const events = await first.events.readByPrincipal({ tenant: 'default', task: taskId });
    const grantEvents = events.filter((e) => e.type === 'grant.granted');
    assert.equal(grantEvents.length, 2);
    assert.deepEqual(
      grantEvents.map((e) => e.principal['agent']).sort(),
      [`${taskId}/impl`, `${taskId}/test`],
    );
    for (const ev of grantEvents) {
      assert.equal(ev.principal['task'], taskId);
      assert.equal(ev.principal['tenant'], 'default');
      const payload = ev.payload as unknown as Record<string, unknown>;
      assert.equal(payload['cap'], 'fs:workdir');
      assert.equal(payload['scope'], 'rw');
      assert.equal(payload['source'], 'baseline');
      assert.equal(payload['decisionSource'], 'auto_rule:baseline');
    }

    // grants.of 即时可见(manifest 快照随授予同步)
    for (const nodeId of ['impl', 'test']) {
      await assertBaselineManifest(first, taskId, nodeId);
    }
    await first.stop();
    handles.pop();

    // 重启重放:grant manifest 从 grant.granted 事件流重建(§6)
    const second = await start({ stateDir, presets: { coder: coderPreset() }, runtime: stubRuntime() });
    for (const nodeId of ['impl', 'test']) {
      await assertBaselineManifest(second, taskId, nodeId);
    }
  });
});
