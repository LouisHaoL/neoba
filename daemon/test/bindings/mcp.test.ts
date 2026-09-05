/**
 * neoba-mcp 桥测试:换行分隔 JSON 帧上的 initialize(协议版本协商 + auto
 * session.init)/ tools/list / tools/call 全流程(接真实 daemon,验证 token
 * 传递与会话身份注入)、协议错误响应(解析失败/未知方法/未知工具/未初始化)、
 * daemon 错误 → result.isError、显式 session_init 工具、spawnBridge 子进程冒烟。
 */
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createMcpBridge, createDaemonHttpClient, spawnBridge } from '../../src/bindings/index.ts';
import type { McpBridge } from '../../src/bindings/index.ts';
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

async function start(): Promise<DaemonHandle> {
  const stateDir = await mkdtemp(join(tmpdir(), 'neoba-mcp-'));
  roots.push(stateDir);
  const handle = await startDaemon({ port: 0, stateDir });
  handles.push(handle);
  return handle;
}

/** 假 stdio:输入收集器 + 输出收集器,经 bridge.handleLine 驱动。 */
interface Harness {
  readonly bridge: McpBridge;
  call(request: Record<string, unknown>): Promise<Record<string, any>>;
  notify(request: Record<string, unknown>): Promise<void>;
  feed(line: string): Promise<string | null>;
}

function makeBridge(
  callDaemon: (method: string, params: unknown) => Promise<unknown>,
  options: Partial<Parameters<typeof createMcpBridge>[0]> = {},
): Harness {
  const written: string[] = [];
  const bridge = createMcpBridge({
    input: [] as unknown as AsyncIterable<Uint8Array>,
    output: { write(chunk: string) { written.push(chunk); return true; } },
    callDaemon,
    ...options,
  });
  return {
    bridge,
    async call(request) {
      const out = await bridge.handleLine(JSON.stringify(request));
      assert.ok(out !== null, `应有应答: ${JSON.stringify(request)}`);
      return JSON.parse(out);
    },
    async notify(request) {
      const out = await bridge.handleLine(JSON.stringify(request));
      assert.equal(out, null, '通知不应答');
    },
    async feed(line) {
      return bridge.handleLine(line);
    },
  };
}

async function initializedHarness(daemon: DaemonHandle, options: Partial<Parameters<typeof createMcpBridge>[0]> = {}): Promise<Harness> {
  const caller = createDaemonHttpClient({ baseUrl: daemon.baseUrl, token: daemon.token });
  const harness = makeBridge(caller, options);
  await harness.call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  await harness.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return harness;
}

describe('MCP initialize 握手', () => {
  it('协议版本协商:支持的版本原样回;不支持的回服务端最新', async () => {
    const daemon = await start();
    const caller = createDaemonHttpClient({ baseUrl: daemon.baseUrl, token: daemon.token });
    const harness = makeBridge(caller);
    const ok = await harness.call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    });
    assert.equal(ok['result']['protocolVersion'], '2024-11-05');
    assert.equal(ok['result']['serverInfo']['name'], 'neoba-mcp');
    assert.deepEqual(ok['result']['capabilities']['tools'], { listChanged: false });

    const fallback = await makeBridge(caller).call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    });
    assert.equal(fallback['result']['protocolVersion'], '2025-06-18');
  });

  it('auto-session:initialize 后自动完成 neoba session.init 并缓存会话身份', async () => {
    const daemon = await start();
    const harness = await initializedHarness(daemon);
    await harness.bridge.sessionReady();
    const session = harness.bridge.session();
    assert.ok(session !== null);
    assert.match(session.session, /^mcp-/);
    // 会话真的登记进了 daemon:重复 session_init 工具(同 id)会撞 SESSION_DUPLICATE
    const dup = await harness.call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'session_init', arguments: { session: session.session, tenant: session.tenant } },
    });
    assert.equal(dup['result']['isError'], true);
    assert.match(dup['result']['content'][0]['text'] as string, /SESSION_DUPLICATE/);
  });
});

describe('tools/list 与 tools/call 全流程(真实 daemon)', () => {
  it('tools/list 列出 daemon 操作全集(P1 + P2,共 19 个)', async () => {
    const daemon = await start();
    const harness = await initializedHarness(daemon);
    const res = await harness.call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = (res['result']['tools'] as any[]).map((t) => t['name']);
    assert.equal(names.length, 19);
    assert.deepEqual(names.sort(), [
      'approvals_decide', 'approvals_list',
      'artifacts_publish', 'artifacts_read', 'artifacts_resolve',
      'budget_raise', 'budget_status',
      'capabilities_list', 'grants_of', 'models_feedback', 'models_list',
      'session_init',
      'task_cancel', 'task_create', 'task_list', 'task_pause', 'task_resume', 'task_status',
      'workflow_run',
    ]);
    for (const tool of res['result']['tools'] as any[]) {
      assert.equal(tool['inputSchema']['type'], 'object');
    }
  });

  it('task_create → grants_of → task_status:token 传递 + 会话身份注入', async () => {
    const daemon = await start();
    const harness = await initializedHarness(daemon);
    // arguments 不带 tenant/session → 桥注入 auto-session 身份
    const created = await harness.call({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'task_create', arguments: { intent: '桥上建任务', preset: 'minimal' } },
    });
    assert.equal(created['result']['isError'], false);
    const task = created['result']['structuredContent'];
    assert.match(task['task_id'], /^task-/);
    assert.equal(task['status'], 'completed');

    const grants = await harness.call({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'grants_of', arguments: { agent_id: task['agent_id'] } },
    });
    assert.deepEqual(
      grants['result']['structuredContent']['manifest']['grants'].map((g: any) => g['cap']),
      ['fs:workdir'],
    );

    const status = await harness.call({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'task_status', arguments: { task_id: task['task_id'] } },
    });
    assert.equal(status['result']['structuredContent']['task']['intent'], '桥上建任务');

    const list = await harness.call({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'task_list', arguments: {} },
    });
    assert.equal((list['result']['structuredContent']['tasks'] as any[]).length, 1);

    // artifacts 三工具
    const pub = await harness.call({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: {
        name: 'artifacts_publish',
        arguments: { task: task['task_id'], node: 'n1', name: 'out', content: 'payload-1' },
      },
    });
    assert.equal(pub['result']['structuredContent']['kind'], 'file');
    const read = await harness.call({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: {
        name: 'artifacts_read',
        arguments: { task: task['task_id'], node: 'n1', name: 'out' },
      },
    });
    assert.equal(read['result']['structuredContent']['data'], 'payload-1');
    const resolve = await harness.call({
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: {
        name: 'artifacts_resolve',
        arguments: { task: task['task_id'], node: 'n1', name: 'out' },
      },
    });
    assert.equal(resolve['result']['structuredContent']['version'], 1);
    // 会话身份确实注入到了 daemon 侧(t1/s-art 里的 task 命名空间有事件)
    const events = await daemon.events.readByPrincipal({ tenant: 'default' });
    assert.ok(events.some((e) => e.type === 'artifact.published'));
  });

  it('token 传递失败:错 token → 工具执行错误 isError=true(UNAUTHORIZED)', async () => {
    const daemon = await start();
    const caller = createDaemonHttpClient({ baseUrl: daemon.baseUrl, token: 'bad-token' });
    const harness = makeBridge(caller);
    await harness.call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    });
    const res = await harness.call({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'capabilities_list', arguments: {} },
    });
    assert.equal(res['result']['isError'], true);
    assert.match(res['result']['content'][0]['text'] as string, /UNAUTHORIZED|-32001/);
  });
});

describe('协议错误响应', () => {
  it('非法 JSON → -32700(id=null);未知方法 → -32601', async () => {
    const daemon = await start();
    const harness = await initializedHarness(daemon);
    const parseFrame = await harness.feed('this is not json');
    assert.ok(parseFrame !== null);
    const parsed = JSON.parse(parseFrame);
    assert.equal(parsed['error']['code'], -32700);
    assert.equal(parsed['id'], null);
    const out = await harness.call({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} });
    assert.equal(out['error']['code'], -32601);
  });

  it('非法 JSON:直接断言错误帧内容', async () => {
    const bridge = createMcpBridge({
      input: [] as unknown as AsyncIterable<Uint8Array>,
      output: { write() { return true; } },
      callDaemon: async () => ({}),
    });
    const frame = await bridge.handleLine('{broken');
    assert.ok(frame !== null);
    assert.equal(JSON.parse(frame)['error']['code'], -32700);
    assert.equal(JSON.parse(frame)['id'], null);
  });

  it('未知工具 → -32602;未 initialize 的 tools/call → -32602', async () => {
    const daemon = await start();
    const caller = createDaemonHttpClient({ baseUrl: daemon.baseUrl, token: daemon.token });
    const harness = makeBridge(caller);
    const notInit = await harness.call({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'task_create', arguments: {} },
    });
    assert.equal(notInit['error']['code'], -32602);
    await harness.call({
      jsonrpc: '2.0', id: 2, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    });
    const unknown = await harness.call({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'orchestration_run', arguments: {} },
    });
    assert.equal(unknown['error']['code'], -32602);
  });

  it('daemon 侧业务错误 → isError=true(不走协议错误)', async () => {
    const daemon = await start();
    const harness = await initializedHarness(daemon);
    const res = await harness.call({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'task_status', arguments: { task_id: 'task-ghost' } },
    });
    assert.equal(res['result']['isError'], true);
    assert.match(res['result']['content'][0]['text'] as string, /TASK_NOT_FOUND/);
    assert.equal(res['error'], undefined);
  });
});

describe('spawnBridge 子进程模式', () => {
  it('拉起 cli.ts,经真实 stdio 完成 initialize + tools/call', async () => {
    const daemon = await start();
    const child = spawnBridge({ baseUrl: daemon.baseUrl, token: daemon.token });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    try {
      const stdin = child.stdin;
      const stdout = child.stdout;
      if (stdin === null || stdout === null) throw new Error('桥进程 stdio 未就绪');
      const reader = createInterface({ input: stdout });
      const responses: any[] = [];
      const done = new Promise<void>((resolve, reject) => {
        reader.on('line', (line) => {
          responses.push(JSON.parse(line));
          if (responses.length >= 2) resolve();
        });
        child.on('exit', () => reject(new Error(`桥进程提前退出: ${stderr}`)));
        setTimeout(() => reject(new Error(`桥进程无响应: ${stderr}`)), 15000).unref();
      });
      stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
      }) + '\n');
      stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'task_create', arguments: { intent: '子进程任务', preset: 'minimal' } },
      }) + '\n');
      await done;
      assert.equal(responses[0]!['result']['protocolVersion'], '2025-06-18');
      assert.equal(responses[1]!['result']['isError'], false);
      assert.match(responses[1]!['result']['structuredContent']['task_id'], /^task-/);
    } finally {
      child.kill();
    }
  });
});
