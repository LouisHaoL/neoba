/**
 * e2e · MCP 桥(真实子进程,stdio 行 JSON):initialize 握手、19 工具全集、
 * 工具 → daemon RPC 的端到端调用(自动会话注入)、坏 token 的错误传播。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  bootDaemon,
  cleanupStateDir,
  spawnBridgeClient,
  awaitTask,
  type BridgeClient,
} from './helpers.ts';

const kept: string[] = [];
after(async () => {
  await Promise.all(kept.map((dir) => cleanupStateDir(dir)));
});

async function initialize(bridge: BridgeClient): Promise<Record<string, unknown>> {
  const { body } = await bridge.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'neoba-e2e', version: '0.0.0' },
  });
  return body;
}

describe('e2e · MCP 桥子进程', () => {
  it('initialize 握手 + tools/list 恰好 20 工具', async () => {
    const daemon = await bootDaemon();
    kept.push(daemon.stateDir);
    let bridge: BridgeClient | null = null;
    try {
      bridge = spawnBridgeClient(daemon);
      const init = await initialize(bridge);
      const result = init['result'] as Record<string, unknown> | undefined;
      assert.ok(result !== undefined, `initialize 应成功:${JSON.stringify(init).slice(0, 300)}`);
      assert.equal(result['serverInfo'] !== undefined || result['protocolVersion'] !== undefined, true);

      const tools = await bridge.request('tools/list', {});
      const toolList = ((tools.body['result'] as Record<string, unknown>)['tools'] ?? []) as Array<{ name: string }>;
      assert.equal(toolList.length, 20, `桥应暴露 20 工具,实际 ${toolList.length}:${toolList.map((t) => t.name).join(',')}`);
      for (const expected of ['session_init', 'task_create', 'task_status', 'approvals_list', 'budget_status', 'events_missing_probe']) {
        if (expected === 'events_missing_probe') {
          assert.ok(!toolList.some((t) => t.name === 'events_list'), 'events.list 未上桥(已知缺口,钉住不回归成 21)');
        } else {
          assert.ok(toolList.some((t) => t.name === expected), `工具应含 ${expected}`);
        }
      }
    } finally {
      bridge?.stop().catch(() => undefined);
      await daemon.stop();
    }
  });

  it('经桥建任务(task_create)→ 自动会话 → task_status 端到端可见', async () => {
    const daemon = await bootDaemon({ exec: 'stream' });
    kept.push(daemon.stateDir);
    let bridge: BridgeClient | null = null;
    try {
      bridge = spawnBridgeClient(daemon);
      await initialize(bridge);

      const created = await bridge.request('tools/call', {
        name: 'task_create',
        arguments: { intent: '经 MCP 桥创建的任务', preset: 'minimal' },
      });
      const content = ((created.body['result'] as Record<string, unknown>)['content'] ?? []) as Array<{ text?: string }>;
      const text = content.map((c) => c.text ?? '').join('');
      assert.match(text, /task-[a-z0-9-]+/, `task_create 应返回 task_id:${text.slice(0, 300)}`);
      const taskId = /task-[a-z0-9-]+/.exec(text)![0]!;

      const status = await bridge.request('tools/call', {
        name: 'task_status',
        arguments: { task_id: taskId },
      });
      const statusText = (((status.body['result'] as Record<string, unknown>)['content'] ?? []) as Array<{ text?: string }>)
        .map((c) => c.text ?? '').join('');
      assert.match(statusText, /completed|running|pending/, `task_status 应可查:${statusText.slice(0, 300)}`);

      // daemon 直查:桥的自动会话任务落了 acme 之外的 default 域,admin 可见。
      const record = await awaitTask(daemon, taskId, { timeoutMs: 20_000 });
      assert.equal(record['status'], 'completed');
    } finally {
      bridge?.stop().catch(() => undefined);
      await daemon.stop();
    }
  });

  it('坏 token:桥进程拉得起,工具调用传播 daemon 401 错误', async () => {
    const daemon = await bootDaemon();
    kept.push(daemon.stateDir);
    let bridge: BridgeClient | null = null;
    try {
      // 手动以坏 token 拉桥(不走 spawnBridgeClient 的正确 token)。
      const { spawnBridge } = await import('../../src/bindings/index.ts');
      const proc = spawnBridge({ baseUrl: daemon.baseUrl, token: 'definitely-wrong-token', cwd: process.cwd() });
      proc.stdout!.on('data', () => {});
      const pending = new Map<number, (body: Record<string, unknown>) => void>();
      let buf = '';
      proc.stdout!.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line === '') continue;
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (typeof msg['id'] === 'number') {
              pending.get(msg['id'] as number)?.(msg);
              pending.delete(msg['id'] as number);
            }
          } catch { /* 忽略非 JSON */ }
        }
      });
      const call = (id: number, method: string, params: unknown) =>
        new Promise<Record<string, unknown>>((resolve) => {
          pending.set(id, resolve);
          proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
      bridge = {
        request: (method, params) => call(9000 + Math.floor(Math.random() * 900), method, params).then((body) => ({ id: 0, body })),
        notifications: [],
        stop: async () => {
          proc.kill();
          return { code: null, stdout: '', stderr: '' };
        },
      };

      await call(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'neoba-e2e-bad', version: '0.0.0' },
      });
      const res = await call(2, 'tools/call', {
        name: 'capabilities_list',
        arguments: {},
      });
      const body = JSON.stringify(res);
      assert.match(body, /401|Unauthorized|未授权|鉴权|error/i, `坏 token 应以错误传播:${body.slice(0, 400)}`);
    } finally {
      bridge?.stop().catch(() => undefined);
      await daemon.stop();
    }
  });
});
