/**
 * daemon 工件自动 GC 接线测试(M5):gcIntervalMs 选项(缺省 10min / 0 = 关闭)、
 * handle.runGc() 手动触发一轮 GC 并把 plan 摘要落 artifact.gc 事件。
 * 守护定时器本体与 reclaimTimer 同款(unref + stop 清理),周期行为不在单测里等钟。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { startDaemon } from '../../src/daemon/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';

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
  const stateDir = opts.stateDir ?? (await mkdtemp(join(tmpdir(), 'neoba-gcdaemon-')));
  roots.push(stateDir);
  const handle = await startDaemon({ port: 0, ...opts, stateDir });
  handles.push(handle);
  return handle;
}

describe('daemon 工件自动 GC 接线', () => {
  it('gcIntervalMs 缺省 10min,可覆盖,0 = 关闭', async () => {
    const def = await start();
    assert.equal(def.gcIntervalMs, 600_000);
    const custom = await start({ gcIntervalMs: 1234 });
    assert.equal(custom.gcIntervalMs, 1234);
    const off = await start({ gcIntervalMs: 0 });
    assert.equal(off.gcIntervalMs, 0);
  });

  it('runGc() 手动触发一轮 GC:空仓库也落 artifact.gc 事件(plan 摘要)', async () => {
    const handle = await start();
    const result = await handle.runGc();
    assert.equal(result.removedManifests, 0);
    assert.equal(result.removedObjects, 0);
    assert.equal(result.plan.scannedManifests, 0);

    const seen = [];
    for await (const ev of handle.events.replay()) seen.push(ev);
    const gcEvents = seen.filter((ev) => ev.type === 'artifact.gc');
    assert.equal(gcEvents.length, 1);
    const gcEvent = gcEvents[0];
    assert.ok(gcEvent);
    const payload = gcEvent.payload as unknown as Record<string, unknown>;
    assert.equal(payload['scanned'], 0);
    assert.equal(payload['orphaned'], 0);
    assert.equal(payload['removedManifests'], 0);
    assert.equal(payload['removedObjects'], 0);
  });

  it('runGc() 只删终态任务的到期 manifest(任务表来自重放/实态)', async () => {
    const handle = await start();
    // 手工造一个指针 + 模拟任务表:直接走底层仓库 API 验证终态闸。
    await handle.artifacts.publish(
      { tenant: 'default', task: 'task-a' },
      'n',
      'doc',
      'body',
      { retention: { mode: 'days', days: 1 } },
    );
    // 任务 task-a 不在 TaskStore → isTerminal 保守 false → 不删。
    const conservative = await handle.runGc();
    assert.deepEqual(conservative.plan.expiredManifests, []);
    await assert.doesNotReject(
      handle.artifacts.read({ tenant: 'default', task: 'task-a' }, 'n', 'doc'),
    );
  });
});
