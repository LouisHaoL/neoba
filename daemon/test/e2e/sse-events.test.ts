/**
 * e2e · 观测线(子进程):events.list 过滤 + /events/stream SSE
 * (replay + live 去重 + 心跳,Bearer 头与 ?token= 两种鉴权)。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { bootDaemon, cleanupStateDir, sseCollect, type SseEvent } from './helpers.ts';

const kept: string[] = [];
after(async () => {
  await Promise.all(kept.map((dir) => cleanupStateDir(dir)));
});

async function makeTask(daemon: Awaited<ReturnType<typeof bootDaemon>>, intent: string): Promise<string> {
  const res = await daemon.rpc('task.create', { intent, preset: 'minimal' });
  return ((res.body.result as Record<string, unknown>)['task_id']) as string;
}

describe('e2e · events.list(真实 EventLog 落盘)', () => {
  it('type/task/session 过滤与顺序稳定', async () => {
    const daemon = await bootDaemon({ exec: 'stream' });
    kept.push(daemon.stateDir);
    try {
      const taskId = await makeTask(daemon, 'events.list 冒烟');

      const byTask = await daemon.rpc('events.list', { task: taskId });
      const list = (byTask.body.result as { events: Array<{ type: string; seq: number }> }).events;
      assert.ok(list.length >= 3, `任务事件应 ≥3 条,实际 ${list.length}`);
      const seqs = list.map((e) => e.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '事件应按 seq 升序');

      const byType = await daemon.rpc('events.list', { task: taskId, type: 'node.completed' });
      const completed = (byType.body.result as { events: Array<{ type: string }> }).events;
      assert.equal(completed.length, 1);
      assert.equal(completed[0]!['type'], 'node.completed');
    } finally {
      await daemon.stop();
    }
  });
});

describe('e2e · SSE /events/stream(真实进程 + 真实端口)', () => {
  it('replay 历史事件 + live 新事件;Bearer 与 ?token= 均可鉴权', async () => {
    const daemon = await bootDaemon({ exec: 'stream', sseHeartbeatMs: 50 });
    kept.push(daemon.stateDir);
    try {
      const replayTaskId = await makeTask(daemon, 'SSE replay 冒烟');

      for (const tokenSource of ['header', 'query'] as const) {
        const collectedPromise = sseCollect(daemon, {
          tokenSource,
          timeoutMs: 8_000,
          until: (ev: SseEvent) => ev.data.includes('LIVE-MARKER'),
        });
        // 给连接留建立时间,再制造 live 事件。
        await new Promise((r) => setTimeout(r, 300));
        await makeTask(daemon, `SSE live ${tokenSource} LIVE-MARKER`);
        const events = await collectedPromise;

        const datas = events.map((e) => e.data);
        assert.ok(
          datas.some((d) => d.includes(replayTaskId)),
          `${tokenSource}: 应先 replay 到历史任务事件`,
        );
        assert.ok(
          datas.some((d) => d.includes('LIVE-MARKER')),
          `${tokenSource}: 应收到 live 事件`,
        );
        // replay 与 live 不重复(去重键):replayTaskId 在流里至多一轮。
        const replayHits = datas.filter((d) => d.includes(replayTaskId)).length;
        assert.ok(replayHits >= 1 && replayHits <= 3, `replay 去重异常: ${replayHits}`);
      }
    } finally {
      await daemon.stop();
    }
  });

  it('心跳帧定期到达(短心跳)', async () => {
    const daemon = await bootDaemon({ exec: 'echo', sseHeartbeatMs: 50 });
    kept.push(daemon.stateDir);
    try {
      const events = await sseCollect(daemon, { timeoutMs: 1_200 });
      const heartbeats = events.filter((e) => e.event === 'heartbeat' || e.data === '' || e.data.includes('heartbeat'));
      assert.ok(heartbeats.length >= 1, `50ms 心跳下 1.2s 应收到心跳帧,收到 ${events.length} 帧:${JSON.stringify(events.slice(0, 5))}`);
    } finally {
      await daemon.stop();
    }
  });

  it('无 token 的 SSE 连接被拒(401)', async () => {
    const daemon = await bootDaemon();
    kept.push(daemon.stateDir);
    try {
      const res = await fetch(new URL('/events/stream', daemon.baseUrl), {
        headers: { accept: 'text/event-stream' },
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(res.status, 401);
    } finally {
      await daemon.stop();
    }
  });
});
