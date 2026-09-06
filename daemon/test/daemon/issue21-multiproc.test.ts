/**
 * issue #21 回归:事件日志与多进程一致性。
 * 1. 单实例守卫:第二个 daemon 同 state-dir 启动被拒(DAEMON_ALREADY_RUNNING),
 *    第一个不受影响;崩溃残留锁(pid 已死)可安全接管;stop 释放锁后可重启。
 * 2. 启动重放 quarantine:中段坏行 → daemon 可启动、坏行入 sidecar、
 *    correction 事件落盘、warning 上浮。
 * 3. daemon 运行中 CLI 打开工件仓库不清 staging(CLI 侧 cleanStaging=false)。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { startDaemon } from '../../src/daemon/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';
import { EventLog } from '../../src/events/index.ts';
import { defaultDeps } from '../../src/cli/deps.ts';

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

/** 伪造一条 daemon.started 事件行(手工拼日志用)。 */
function daemonStartedLine(seq: number, pid: number): string {
  return JSON.stringify({
    v: '1.0',
    seq,
    ts: '2026-09-04T10:00:00Z',
    type: 'daemon.started',
    principal: { tenant: 'default', session: null, task: null, agent: null },
    payload: { pid },
  });
}

describe('issue #21:daemon 单实例守卫', () => {
  it('第二个 daemon 同 state-dir 启动被拒,第一个不受影响', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-guard-'));
    roots.push(stateDir);
    const first = await startDaemon({ port: 0, stateDir });
    handles.push(first);

    // 同 state-dir 的第二个实例:锁 pid(本测试进程)存活 → 拒绝
    await assert.rejects(
      startDaemon({ port: 0, stateDir }),
      (err: Error) => (err as Error & { code?: string }).code === 'DAEMON_ALREADY_RUNNING',
    );
    // 第一个 daemon 仍能服务
    assert.equal(first.port > 0, true);
    // 锁内容可读:pid + 启动时间 + 版本
    const lock = JSON.parse(await readFile(join(stateDir, 'daemon.lock'), 'utf8')) as {
      pid: number; startedAt: string; version: string;
    };
    assert.equal(lock.pid, process.pid);
    assert.ok(lock.startedAt.length > 0);
    assert.ok(lock.version.length > 0);
  });

  it('崩溃残留锁(pid 已死)可安全接管;残缺锁文件同样接管', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-stale-lock-'));
    roots.push(stateDir);
    // 造一个"已死进程"的 pid:同步跑一个立即退出的子进程,拿它的 pid
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(dead.status, 0);
    const deadPid = dead.pid ?? 0;
    await writeFile(
      join(stateDir, 'daemon.lock'),
      JSON.stringify({ pid: deadPid, startedAt: '2026-09-04T10:00:00Z', version: '0.1.0' }, null, 2) + '\n',
      'utf8',
    );
    const handle = await startDaemon({ port: 0, stateDir });
    handles.push(handle);
    // 接管成功:锁已被换成当前进程
    const lock = JSON.parse(await readFile(join(stateDir, 'daemon.lock'), 'utf8')) as { pid: number };
    assert.equal(lock.pid, process.pid);
    await handle.stop();

    // 残缺(半写)锁文件:按无主锁接管,不卡死启动
    await writeFile(join(stateDir, 'daemon.lock'), '{"pid":', 'utf8');
    const second = await startDaemon({ port: 0, stateDir });
    handles.push(second);
    assert.ok(second.port > 0);
  });

  it('stop 释放锁,同 state-dir 可再次启动', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-rellock-'));
    roots.push(stateDir);
    const first = await startDaemon({ port: 0, stateDir });
    handles.push(first);
    await first.stop();
    handles.pop();
    assert.equal(
      await readFile(join(stateDir, 'daemon.lock'), 'utf8').then(() => true, () => false),
      false,
      'stop 后锁文件应已删除',
    );
    const second = await startDaemon({ port: 0, stateDir });
    handles.push(second);
    assert.ok(second.port > 0);
  });
});

describe('issue #21:启动重放 quarantine(中段坏行不变砖)', () => {
  it('中段坏行 → daemon 可启动、坏行入 sidecar、correction 事件落盘、warning 上浮', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-quarantine-'));
    roots.push(stateDir);
    await mkdir(join(stateDir, 'events'), { recursive: true });
    const eventsPath = join(stateDir, 'events', 'events.jsonl');
    await writeFile(
      eventsPath,
      daemonStartedLine(1, 100) + '\n' + 'garbage-not-json\n' + daemonStartedLine(2, 101) + '\n',
      'utf8',
    );

    const handle = await startDaemon({ port: 0, stateDir });
    handles.push(handle);
    // daemon 正常起来了(没有在坏行上炸掉)
    assert.ok(handle.port > 0);
    // warning 上浮
    assert.ok(
      handle.warnings.some((w) => w.includes('隔离') && w.includes('events.jsonl')),
      `warnings 应含隔离提示,实际: ${JSON.stringify(handle.warnings)}`,
    );
    // 坏行入 sidecar
    const sidecar = await readFile(join(stateDir, 'events', 'events.jsonl.corrupt'), 'utf8');
    assert.match(sidecar, /garbage-not-json/);
    await handle.stop();

    // correction 事件落盘(reason=quarantine,target 指向 分片#行号)
    const log = await EventLog.open(join(stateDir, 'events'), { quarantine: true });
    const corrections: Array<Record<string, unknown>> = [];
    for await (const ev of log.replay()) {
      if (ev.type === 'correction') {
        corrections.push(ev.payload as unknown as Record<string, unknown>);
      }
    }
    await log.close();
    const quarantineFix = corrections.find((p) => p['reason'] === 'quarantine');
    assert.ok(quarantineFix !== undefined, '应有 quarantine correction 事件');
    assert.equal(quarantineFix['target'], 'eventlog:events.jsonl#2');
  });
});

describe('issue #21:daemon 运行中 CLI 打开仓库不清 staging', () => {
  it('defaultDeps().openRepository 不清在写 staging 目录(CLI 侧 cleanStaging=false)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-cli-stage-'));
    roots.push(stateDir);
    const handle = await startDaemon({ port: 0, stateDir });
    handles.push(handle);

    // 模拟 daemon 正在写的 staging 目录(publish 中途的半写状态)
    const stagingDir = join(stateDir, 'artifacts', '.staging', 'publishing-4242');
    await mkdir(join(stagingDir, 'inner'), { recursive: true });
    await writeFile(join(stagingDir, 'inner', 'half-written.bin'), 'partial', 'utf8');

    const deps = await defaultDeps();
    const repo = await deps.openRepository(join(stateDir, 'artifacts'));
    try {
      const survived = await readFile(join(stagingDir, 'inner', 'half-written.bin'), 'utf8');
      assert.equal(survived, 'partial', '在写 staging 不得被 CLI 打开仓库清掉');
    } finally {
      await repo.close().catch(() => {});
    }
  });
});
