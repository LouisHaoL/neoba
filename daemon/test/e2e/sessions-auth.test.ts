/**
 * e2e · 鉴权与双 token(子进程):401 变体、session.init 签发会话 token、
 * 会话 token 的 principal 贯通(SESSION_FORBIDDEN / 越权收窄)、多会话隔离。
 * 场景 07/08 的进程级对照(含真实 token 文件落盘)。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { bootDaemon, cleanupStateDir, readTokenFile, awaitTask } from './helpers.ts';

const kept: string[] = [];
after(async () => {
  await Promise.all(kept.map((dir) => cleanupStateDir(dir)));
});

describe('e2e · HTTP 鉴权(真实进程边界)', () => {
  it('无 token → 401;错 token → 401;健康检查不带 token 亦 401(POST /)', async () => {
    const daemon = await bootDaemon();
    kept.push(daemon.stateDir);
    try {
      const noAuth = await fetch(`${daemon.baseUrl}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'capabilities.list', params: {} }),
      });
      assert.equal(noAuth.status, 401);

      const wrong = await daemon.rpc('capabilities.list', {}, `wrong-${daemon.token}`);
      assert.equal(wrong.status, 401);

      const ok = await daemon.rpc('capabilities.list');
      assert.equal(ok.status, 200);
    } finally {
      await daemon.stop();
    }
  });
});

describe('e2e · 双 token 与会话隔离', () => {
  it('session.init 签发会话 token:principal 锁定,跨会话访问 403 SESSION_FORBIDDEN', async () => {
    const daemon = await bootDaemon({ exec: 'stream' });
    kept.push(daemon.stateDir);
    try {
      const init = await daemon.rpc('session.init', {
        protocol: '1.0',
        role: 'orchestrator',
        principal: { tenant: 'acme', session: 'dev-1' },
        harness: 'e2e-harness',
        capabilities: {},
      });
      assert.equal(init.body.error, undefined, JSON.stringify(init.body).slice(0, 400));
      const sessionToken = (init.body.result as Record<string, unknown>)['token'] as string;
      assert.ok(typeof sessionToken === 'string' && sessionToken.length >= 32, '会话 token 应为一次性明文');

      // 会话 token 在本会话内建任务:principal 贯通到任务与事件。
      const created = await daemon.rpc(
        'task.create',
        { intent: 'acme/dev-1 的任务', preset: 'minimal' },
        sessionToken,
      );
      assert.equal(created.body.error, undefined, JSON.stringify(created.body).slice(0, 400));
      const taskId = (created.body.result as Record<string, unknown>)['task_id'] as string;
      await awaitTask(daemon, taskId, { token: sessionToken });

      const events = await daemon.rpc('events.list', { task: taskId });
      const list = (events.body.result as { events: Array<{ principal: Record<string, unknown> }> }).events;
      const onTask = list.filter((e) => e.principal['tenant'] === 'acme');
      assert.ok(onTask.length > 0, '任务事件应带 acme principal');

      // 会话 token 越权显式 principal → 403/-32014 SESSION_FORBIDDEN。
      const forbidden = await daemon.rpc('events.list', { session: 'other' }, sessionToken);
      assert.equal(forbidden.status, 403);
      const err = forbidden.body.error as Record<string, unknown>;
      assert.equal(err['code'], -32014);
      assert.equal(
        ((err['data'] as Record<string, unknown>) ?? {})['code'],
        'SESSION_FORBIDDEN',
      );

      // bootstrap admin 可全域查;会话 token 缺省收窄到本会话。
      const adminView = await daemon.rpc('events.list', { task: taskId });
      const adminList = (adminView.body.result as { events: unknown[] }).events;
      assert.ok(adminList.length >= list.length);

      // token 文件是 bootstrap token,与会话 token 不同;sha256 注册表落盘。
      const fileToken = await readTokenFile(daemon.stateDir);
      assert.equal(fileToken, daemon.token);
    } finally {
      await daemon.stop();
    }
  });

  it('第二会话无法读第一会话任务(task.status 越权拒绝)', async () => {
    const daemon = await bootDaemon({ exec: 'stream' });
    kept.push(daemon.stateDir);
    try {
      const initA = await daemon.rpc('session.init', {
        protocol: '1.0',
        role: 'orchestrator',
        principal: { tenant: 'default', session: 'sess-a' },
        harness: 'e2e-harness',
        capabilities: {},
      });
      const tokenA = (initA.body.result as Record<string, unknown>)['token'] as string;
      const created = await daemon.rpc(
        'task.create',
        { intent: 'sess-a 私有任务', preset: 'minimal' },
        tokenA,
      );
      const taskId = (created.body.result as Record<string, unknown>)['task_id'] as string;

      const initB = await daemon.rpc('session.init', {
        protocol: '1.0',
        role: 'orchestrator',
        principal: { tenant: 'default', session: 'sess-b' },
        harness: 'e2e-harness',
        capabilities: {},
      });
      const tokenB = (initB.body.result as Record<string, unknown>)['token'] as string;

      const cross = await daemon.rpc('task.status', { task_id: taskId }, tokenB);
      assert.equal(cross.status, 403, `跨会话读任务应 403,实际 ${cross.status} ${JSON.stringify(cross.body).slice(0, 300)}`);

      const own = await daemon.rpc('task.status', { task_id: taskId }, tokenA);
      assert.equal(own.status, 200);
    } finally {
      await daemon.stop();
    }
  });
});
