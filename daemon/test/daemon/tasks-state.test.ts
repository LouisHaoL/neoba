/**
 * TaskStore 任务状态机单元测试(issue #17):可重试节点失败的重试回拨、
 * 终态闸、最终失败终态、cancelled 终态不可回拨 —— 重放与实时共用
 * applyTaskEvent,两态同构。
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { applyTaskEvent, replayTasks, TaskStore } from '../../src/daemon/tasks.ts';
import type { Event, EventType } from '../../src/events/index.ts';

let seq = 0;
function ev(type: EventType, nodeId: string, payload: Record<string, unknown>): Event {
  seq += 1;
  return {
    v: '1.0',
    seq,
    ts: new Date().toISOString(),
    type,
    principal: { tenant: 'default', session: null, task: 'task-1', agent: `task-1/${nodeId}` },
    payload,
  } as unknown as Event;
}

describe('daemon/TaskStore 状态机(issue #17)', () => {
  it('#17 可重试节点失败:重试期间任务非终态 → 重跑成功终态 completed,无翻转告警', () => {
    const errorSpy = mock.method(console, 'error', () => {});
    try {
      const events = [
        ev('node.started', 'n1', { nodeId: 'n1', attempt: 1 }),
        ev('node.failed', 'n1', { nodeId: 'n1', attempt: 1, reason: 'crash', detail: 'exit 1' }),
        ev('node.started', 'n1', { nodeId: 'n1', attempt: 2 }),
        ev('node.completed', 'n1', { nodeId: 'n1', attempt: 2, outputs: [] }),
      ];
      // 逐步推进(实时态):失败先落 failed(中间态),重试 started 拨回 running
      const live = new TaskStore();
      applyTaskEvent(live, events[0]!);
      assert.equal(live.get('task-1')?.status, 'running');
      applyTaskEvent(live, events[1]!);
      assert.equal(live.get('task-1')?.status, 'failed');
      applyTaskEvent(live, events[2]!);
      assert.equal(live.get('task-1')?.status, 'running', '重试 started 拨回 running(非终态)');
      applyTaskEvent(live, events[3]!);
      assert.equal(live.get('task-1')?.status, 'completed');
      // 重放同构:同样的流推进到 completed,无 failed→completed 翻转告警
      const replayed = replayTasks(events);
      assert.equal(replayed.get('task-1')?.status, 'completed');
      assert.equal(errorSpy.mock.callCount(), 0, '无终态翻转告警');
    } finally {
      errorSpy.mock.restore();
    }
  });

  it('#17 反馈回打重跑:其他节点以更大 attempt 重派发同样拨回 running;attempt 不增不回拨', () => {
    const store = new TaskStore();
    applyTaskEvent(store, ev('node.started', 'a', { nodeId: 'a', attempt: 1 }));
    applyTaskEvent(store, ev('node.failed', 'a', { nodeId: 'a', attempt: 1, reason: 'crash', detail: 'exit 1' }));
    assert.equal(store.get('task-1')?.status, 'failed');
    // attempt 不增(非重试)不回拨
    applyTaskEvent(store, ev('node.started', 'b', { nodeId: 'b', attempt: 1 }));
    assert.equal(store.get('task-1')?.status, 'failed');
    // 回打重置下游后,上游节点以 attempt 2 重派发 → 拨回 running
    applyTaskEvent(store, ev('node.started', 'a', { nodeId: 'a', attempt: 2 }));
    assert.equal(store.get('task-1')?.status, 'running', '回打重跑拨回 running');
  });

  it('#17 最终失败:终态 failed,终态闸拒绝 completed 覆盖并告警;cancelled 不被 started 回拨', () => {
    const errorSpy = mock.method(console, 'error', () => {});
    try {
      // 最终失败(无重试/重试耗尽):重放推进到 failed
      const store = replayTasks([
        ev('node.started', 'n1', { nodeId: 'n1', attempt: 1 }),
        ev('node.failed', 'n1', { nodeId: 'n1', attempt: 1, reason: 'crash', detail: 'exit 1' }),
      ]);
      assert.equal(store.get('task-1')?.status, 'failed');
      assert.equal(store.get('task-1')?.error, 'exit 1');
      // 终态闸:completed 不得覆盖 failed(拒绝并告警,终态不可逆)
      store.markCompleted('task-1');
      assert.equal(store.get('task-1')?.status, 'failed', '终态闸保留 failed');
      assert.ok(errorSpy.mock.callCount() > 0, '终态翻转告警');

      // cancelled 是终态:后续 node.started 不回拨(仅 failed 可被重试回拨)
      const cancelled = replayTasks([
        ev('node.started', 'n1', { nodeId: 'n1', attempt: 1 }),
        ev('node.failed', 'n1', { nodeId: 'n1', attempt: 1, reason: 'cancelled', detail: '执行被取消' }),
        ev('node.started', 'n2', { nodeId: 'n2', attempt: 2 }),
      ]);
      assert.equal(cancelled.get('task-1')?.status, 'cancelled');
    } finally {
      errorSpy.mock.restore();
    }
  });
});
