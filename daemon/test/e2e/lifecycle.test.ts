/**
 * e2e · 生命周期(真实子进程):`neoba start` 壳路径的状态文件发现、
 * boot 引导进程的优雅停机(stoppedAt 落账)、跨进程重启恢复(事件重放 /
 * 任务内存态重建 / token 轮换)、端口冲突退出码。
 *
 * Windows 约束:进程信号(SIGTERM/SIGINT)不可达,信号 → stop() 的接线由
 * start.ts 静态可读性保证;进程边界的优雅停机经 boot.ts 的 stdin 停机
 * 通道走同一条 handle.stop() 路径验证。
 */
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { after, describe, it } from 'node:test';

import {
  bootDaemon,
  cleanupStateDir,
  CLI_SCRIPT,
  readStateFile,
  readTokenFile,
  runNeoba,
  tempStateDir,
  waitExit,
} from './helpers.ts';

const kept: string[] = [];
after(async () => {
  await Promise.all(kept.map((dir) => cleanupStateDir(dir)));
});

function keep(dir: string): string {
  kept.push(dir);
  return dir;
}

describe('e2e · neoba start 壳(真实子进程)', () => {
  it('拉起后写状态文件与 token,neoba status 探活通过', async () => {
    const stateDir = keep(await tempStateDir());
    const proc = nodeSpawn(process.execPath, [CLI_SCRIPT, 'start', '--state-dir', stateDir, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error('start 超时')), 15_000);
        proc.stdout!.on('data', (c: Buffer) => {
          out += c.toString('utf8');
          if (out.includes('neoba daemon 已启动')) {
            clearTimeout(timer);
            resolve({ stdout: out });
          }
        });
        proc.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`start 提前退出 code=${code}`));
        });
      });
      assert.match(stdout, /已启动: http:\/\/127\.0\.0\.1:\d+/);

      const state = await readStateFile(stateDir);
      assert.equal(state.stoppedAt, null);
      assert.ok(state.port > 0);
      const token = await readTokenFile(stateDir);
      assert.ok(token.length >= 32, 'bootstrap token 应为 32 字节 base64url 级长度');

      const status = await runNeoba(['status', '--state-dir', stateDir, '--json']);
      assert.equal(status.code, 0, `status 退出码: ${status.stdout}${status.stderr}`);
      const report = JSON.parse(status.stdout) as { running: boolean; alive: boolean; port: number };
      assert.equal(report.running, true);
      assert.equal(report.alive, true);
      assert.equal(report.port, state.port);
    } finally {
      proc.kill();
      await waitExit(proc).catch(() => undefined);
    }
  });

  it('端口被占时 exit 1 并提示 PORT_IN_USE', async () => {
    const daemon = await bootDaemon();
    try {
      const port = new URL(daemon.baseUrl).port;
      const other = keep(await tempStateDir());
      const clash = await runNeoba(['start', '--state-dir', other, '--port', port], { timeoutMs: 15_000 });
      assert.equal(clash.code, 1);
      assert.match(clash.stderr, /PORT_IN_USE/);
    } finally {
      await daemon.stop();
    }
  });
});

describe('e2e · 停机与重启恢复(跨进程)', () => {
  it('优雅停机:exit 0、stoppedAt 落账、旧 token 失效', async () => {
    const daemon = await bootDaemon();
    const stateDir = daemon.stateDir;
    const tokenBefore = await readTokenFile(stateDir);
    assert.equal(tokenBefore, daemon.token, 'boot 上报的 token 与 token 文件一致');

    const outcome = await daemon.stop();
    assert.equal(outcome.code, 0, `停机退出码: ${outcome.stderr.slice(-500)}`);
    const state = await readStateFile(stateDir);
    assert.ok(state.stoppedAt !== null, 'stop() 应把 stoppedAt 写回状态文件');

    const dead = await daemon.rpc('capabilities.list', {}, tokenBefore).then(
      () => null,
      () => 'unreachable',
    );
    assert.equal(dead, 'unreachable', '停机后 HTTP 端口应关闭');
  });

  it('重启恢复:事件重放、任务内存态重建、token 轮换', async () => {
    const stateDir = keep(await tempStateDir());
    const first = await bootDaemon({ stateDir, exec: 'stream' });
    const created = await first.rpc('task.create', { intent: 'e2e 重启恢复', preset: 'minimal' });
    const taskId = (created.body.result as Record<string, unknown>)['task_id'];
    assert.equal(created.body.error, undefined);

    await first.stop();

    const second = await bootDaemon({ stateDir, exec: 'stream' });
    try {
      assert.notEqual(second.token, first.token, '重启应轮换 bootstrap token');

      // 旧 token 已失效(401),新 token 可用。
      const stale = await second.rpc('capabilities.list', {}, first.token);
      assert.equal(stale.status, 401);
      const fresh = await second.rpc('capabilities.list');
      assert.equal(fresh.body.error, undefined);

      // 事件重放:上一进程的 task.create 链事件仍在。
      const events = await second.rpc('events.list', { task: taskId });
      const list = (events.body.result as { events: Array<{ type: string }> }).events;
      assert.ok(list.some((e) => e.type === 'node.completed'), `事件应含 node.completed,实际 ${JSON.stringify(list.map((e) => e.type))}`);

      // 任务内存态由重放重建:task.status 可查且终态。
      const task = await second.rpc('task.status', { task_id: taskId });
      const record = ((task.body.result as Record<string, unknown>)['task']) as Record<string, unknown>;
      assert.equal(record['taskId'], taskId);
      assert.equal(record['status'], 'completed');

      // daemon.started 应有两轮(每进程一条)。
      const started = await second.rpc('events.list', { type: 'daemon.started' });
      const startedList = (started.body.result as { events: unknown[] }).events;
      assert.ok(startedList.length >= 2, `daemon.started 应 ≥2 条,实际 ${startedList.length}`);
    } finally {
      await second.stop();
    }
  });
});
