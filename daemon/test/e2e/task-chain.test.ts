/**
 * e2e · 任务执行链(子进程 + 假基座 stream/fail 档):
 * 执行链入口是 workflow.run(task.create 是 P1 最小闭环:只记账授权与挂载
 * 意图,不派发执行器 —— 与 golden 场景 01 的语义一致)。本套件验证基座
 * stream-json 输出归一为事件、usage 入账、io_contracts 产物自动发布,以及
 * 基座 exit 1 → 任务 failed 的失败域,全部走真实 EventLog / CAS 落盘。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { join } from 'node:path';

import { bootDaemon, cleanupStateDir, awaitTask } from './helpers.ts';

const PRESETS = join(import.meta.dirname, 'fixtures', 'coder-presets.json');

const kept: string[] = [];
after(async () => {
  await Promise.all(kept.map((dir) => cleanupStateDir(dir)));
});

const SINGLE_NODE = (intentRef: string) => ({
  api: 'workflow/1.0',
  intent_ref: intentRef,
  nodes: [{ id: 'n1', preset: 'coder' }],
  outputs: [{ from: 'n1.outputs.code', required: true }],
  feedback: [],
  evidence: [{ node: 'n1', artifact: 'code', must_exist: true, sha256_recorded: true }],
});

const INTENT = (goal: string) => ({
  api: 'intent/1.0',
  goal,
  acceptance: ['交付 code 工件'],
  constraints: {},
});

describe('e2e · 执行链(假基座 stream 档)', () => {
  it('workflow.run:基座 stream-json 归一为事件,产物按 io_contracts 自动发布', async () => {
    const daemon = await bootDaemon({ exec: 'stream', presets: PRESETS });
    kept.push(daemon.stateDir);
    try {
      const res = await daemon.rpc('workflow.run', {
        workflow: SINGLE_NODE('wf-e2e-chain'),
        intent: INTENT('e2e 执行链冒烟'),
      });
      const result = res.body.result as Record<string, unknown>;
      assert.equal(res.body.error, undefined, JSON.stringify(res.body).slice(0, 400));
      const taskId = result['task_id'] as string;

      const record = await awaitTask(daemon, taskId, { timeoutMs: 20_000 });
      assert.equal(record['status'], 'completed', `任务应完成,实际 ${JSON.stringify(record).slice(0, 400)}`);

      // 事件链(子进程 EventLog):编排事实事件齐备(§3.6 归一事件的落账
      // 边界见 issue:tool_inventory/usage 当前不入 EventLog)。
      const events = await daemon.rpc('events.list', { task: taskId });
      const list = (events.body.result as { events: Array<{ type: string; payload: Record<string, unknown> }> }).events;
      const types = list.map((e) => e.type);
      for (const expected of ['node.started', 'sandbox.created', 'node.completed', 'artifact.published', 'sandbox.destroyed']) {
        assert.ok(types.includes(expected), `事件应含 ${expected},实际 ${JSON.stringify(types)}`);
      }

      // io_contracts.outputs(code)从假基座 cat 回读并发布为 CAS 工件(节点 spec.id 命名空间)。
      const resolved = await daemon.rpc('artifacts.resolve', { task: taskId, node: 'n1', name: 'code' });
      assert.equal(resolved.body.error, undefined, JSON.stringify(resolved.body).slice(0, 400));
      const art = resolved.body.result as Record<string, unknown>;
      assert.equal(art['kind'], 'file');
      assert.match(String(art['rootSha256']), /^[0-9a-f]{64}$/);
      const read = await daemon.rpc('artifacts.read', { task: taskId, node: 'n1', name: 'code' });
      assert.equal(
        ((read.body.result as Record<string, unknown>)['data'] as string).startsWith('# fake code'),
        true,
      );
    } finally {
      await daemon.stop();
    }
  });
});

describe('e2e · 失败域(假基座 fail 档)', () => {
  it('基座 exit 1:重试穷尽后任务落 failed,事件可查,不悬挂', async () => {
    const daemon = await bootDaemon({ exec: 'fail', presets: PRESETS });
    kept.push(daemon.stateDir);
    try {
      const res = await daemon.rpc('workflow.run', {
        workflow: SINGLE_NODE('wf-e2e-fail'),
        intent: INTENT('e2e 失败域冒烟'),
      });
      const taskId = ((res.body.result as Record<string, unknown>)['task_id']) as string;
      const record = await awaitTask(daemon, taskId, { until: ['failed'], timeoutMs: 30_000 });
      assert.equal(record['status'], 'failed', `假基座必败,任务应 failed,实际 ${JSON.stringify(record).slice(0, 400)}`);

      const events = await daemon.rpc('events.list', { task: taskId });
      const list = (events.body.result as { events: Array<{ type: string; payload: Record<string, unknown> }> }).events;
      const crashes = list.filter(
        (e) => e.type === 'node.failed' && e.payload['reason'] === 'crash',
      );
      assert.ok(crashes.length >= 1, `应有 crash 失败事件,实际 ${JSON.stringify(list.map((e) => e.type))}`);
    } finally {
      await daemon.stop();
    }
  });
});
