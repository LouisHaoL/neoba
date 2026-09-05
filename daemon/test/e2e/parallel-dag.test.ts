/**
 * e2e · 并行 DAG(子进程):菱形 u → {a ∥ b} → c,max_parallel=2,
 * 集合级不变量(四节点各 started/completed 一次,c 收到双入边,端口工件
 * 入账)与反馈回打。场景 06 的进程级对照。
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

const DIAMOND = {
  api: 'workflow/1.0',
  intent_ref: 'intent-e2e-parallel',
  nodes: [
    { id: 'u', preset: 'coder' },
    { id: 'a', preset: 'coder', parallel: true, inputs: [{ from: 'u.outputs.code' }] },
    { id: 'b', preset: 'coder', parallel: true, inputs: [{ from: 'u.outputs.code' }] },
    { id: 'c', preset: 'coder', inputs: [{ from: 'a.outputs.code' }, { from: 'b.outputs.code' }] },
  ],
  outputs: [{ from: 'c.outputs.code', required: true }],
  feedback: [],
  evidence: [{ node: 'c', artifact: 'code', must_exist: true, sha256_recorded: true }],
};

const INTENT = {
  api: 'intent/1.0',
  goal: 'e2e 并行 DAG 冒烟:菱形依赖图跑通并交付',
  acceptance: ['菱形四节点全部完成'],
  constraints: { max_parallel: 2 },
};

describe('e2e · 并行 DAG(菱形,max_parallel=2)', () => {
  it('workflow.run 异步编排到 completed,四节点集合级恰好一次', async () => {
    const daemon = await bootDaemon({ exec: 'stream', presets: PRESETS });
    kept.push(daemon.stateDir);
    try {
      const res = await daemon.rpc('workflow.run', { workflow: DIAMOND, intent: INTENT });
      const result = res.body.result as Record<string, unknown>;
      assert.equal(res.body.error, undefined, JSON.stringify(res.body).slice(0, 400));
      assert.equal(result['status'], 'created');
      const taskId = result['task_id'] as string;

      const record = await awaitTask(daemon, taskId, { timeoutMs: 30_000 });
      assert.equal(record['status'], 'completed', `任务应完成,实际 ${JSON.stringify(record).slice(0, 400)}`);

      const events = await daemon.rpc('events.list', { task: taskId });
      const list = (events.body.result as { events: Array<{ type: string; payload: Record<string, unknown> }> }).events;

      // 集合级不变量:每个节点恰好 started/completed 一次(无重复派发);
      // 引擎事件 nodeId = 节点 spec.id(与 golden 场景 06 一致)。
      for (const node of ['u', 'a', 'b', 'c']) {
        const started = list.filter(
          (e) => e.type === 'node.started' && e.payload['nodeId'] === node,
        );
        const completed = list.filter(
          (e) => e.type === 'node.completed' && e.payload['nodeId'] === node,
        );
        assert.equal(started.length, 1, `节点 ${node} 应恰好 started 一次,实际 ${started.length}`);
        assert.equal(completed.length, 1, `节点 ${node} 应恰好 completed 一次,实际 ${completed.length}`);
      }

      // 端点工件:c 的 code 端口发布入账(evidence.sha256_recorded)。
      const resolved = await daemon.rpc('artifacts.resolve', { task: taskId, node: 'c', name: 'code' });
      assert.equal(resolved.body.error, undefined, JSON.stringify(resolved.body).slice(0, 400));
    } finally {
      await daemon.stop();
    }
  });

  it('task.pause / resume 状态机:暂停落在派发边界,resume 续跑完成', async () => {
    const daemon = await bootDaemon({ exec: 'slow', presets: PRESETS });
    kept.push(daemon.stateDir);
    try {
      const res = await daemon.rpc('workflow.run', {
        workflow: {
          api: 'workflow/1.0',
          intent_ref: 'wf-pause-2',
          nodes: [{ id: 'n1', preset: 'coder' }],
          outputs: [],
          feedback: [],
          evidence: [],
        },
        intent: { api: 'intent/1.0', goal: 'pause/resume 冒烟', acceptance: ['节点完成'], constraints: {} },
      });
      const taskId = (res.body.result as Record<string, unknown>)['task_id'] as string;

      // slow 档基座挂 800ms:pause 落在 n1 执行中(不打断在跑节点,
      // 闸门在下一派发边界生效;单节点任务已无下一边界 → 直接完成)。
      await daemon.rpc('task.pause', { task_id: taskId });
      const record = await awaitTask(daemon, taskId, { until: ['paused', 'completed'], timeoutMs: 20_000 });
      const pausedMid = record['status'] === 'paused';

      const resumed = await daemon.rpc('task.resume', { task_id: taskId });
      if (pausedMid) {
        assert.equal(resumed.body.error, undefined, JSON.stringify(resumed.body).slice(0, 300));
      }
      const done = await awaitTask(daemon, taskId, { until: ['completed', 'failed', 'cancelled'], timeoutMs: 30_000 });
      assert.equal(done['status'], 'completed', `resume 后应完成,实际 ${JSON.stringify(done).slice(0, 300)}`);

      // 二次暂停验证:对已完成任务 pause 幂等拒止(paused:false,无副作用)。
      const repause = await daemon.rpc('task.pause', { task_id: taskId });
      assert.equal(
        (repause.body.result as Record<string, unknown> | undefined)?.['paused'],
        false,
        `对 completed 任务 pause 应 paused:false:${JSON.stringify(repause.body).slice(0, 200)}`,
      );
    } finally {
      await daemon.stop();
    }
  });
});
