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
import { createMcpBridge, createDaemonHttpClient, spawnBridge, DaemonCallError } from '../../src/bindings/index.ts';
import type { DaemonCaller, McpBridge } from '../../src/bindings/index.ts';
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
  callDaemon: DaemonCaller,
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
  it('tools/list 列出 daemon 操作全集(P1 + P2,共 20 个)', async () => {
    const daemon = await start();
    const harness = await initializedHarness(daemon);
    const res = await harness.call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = (res['result']['tools'] as any[]).map((t) => t['name']);
    assert.equal(names.length, 20);
    assert.deepEqual(names.sort(), [
      'approvals_decide', 'approvals_list', 'approvals_submit',
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

// ---- #19 回归:超时 / 并发读循环 / cancelled 取消 / close 收敛 ----

/** 假 stdio 入向流:可编程 push 完整行,end 模拟 stdin 关闭。 */
interface FakeStdio {
  readonly input: AsyncIterable<Uint8Array>;
  push(line: string): void;
  end(): void;
}

function fakeStdio(): FakeStdio {
  const queue: Uint8Array[] = [];
  let waiters: ((result: IteratorResult<Uint8Array>) => void)[] = [];
  return {
    input: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            const chunk = queue.shift();
            if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false });
            return new Promise((resolve) => { waiters.push(resolve); });
          },
        };
      },
    },
    push(line) {
      const chunk = new TextEncoder().encode(`${line}\n`);
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter({ value: chunk, done: false });
      else queue.push(chunk);
    },
    end() {
      const all = waiters;
      waiters = [];
      for (const waiter of all) waiter({ value: undefined, done: true });
    },
  };
}

/** 轮询直到断言成立(帧写回时序不确定,轮询等)。 */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 永不 resolve 但响应 abort 的假 fetch:模拟 daemon TCP 可达但停摆。 */
function hangingFetch(): typeof fetch {
  return (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

/** 尊重 signal 的假 callDaemon:abort 时以取消错误拒绝(模拟真实 fetch 行为)。 */
function cancelAwareCallDaemon(): DaemonCaller {
  return (method, _params, signal) => new Promise((_, reject) => {
    const cancel = () => reject(new DaemonCallError({
      code: -32000, message: '调用被取消', data: { code: 'DAEMON_CANCELLED' }, status: 0,
    }));
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

describe('daemon HTTP 客户端超时与取消(#19)', () => {
  it('fetch 永挂:按 timeoutMs 抛 DaemonCallError(code=-32000, data.code=DAEMON_TIMEOUT)', async () => {
    const caller = createDaemonHttpClient({
      baseUrl: 'http://127.0.0.1:1', token: 't', fetchImpl: hangingFetch(), timeoutMs: 30,
    });
    await assert.rejects(caller('capabilities.list', {}), (err: unknown) => {
      assert.ok(err instanceof DaemonCallError);
      assert.equal(err.code, -32000);
      assert.equal(err.status, 0);
      assert.equal((err.data as Record<string, unknown>)['code'], 'DAEMON_TIMEOUT');
      return true;
    });
  });

  it('外部 signal abort:抛 DaemonCallError(data.code=DAEMON_CANCELLED),超时定时器被清理', async () => {
    const fetchImpl: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const caller = createDaemonHttpClient({
      baseUrl: 'http://127.0.0.1:1', token: 't', fetchImpl, timeoutMs: 10_000,
    });
    const controller = new AbortController();
    const call = caller('capabilities.list', {}, controller.signal);
    setTimeout(() => controller.abort(), 10).unref();
    await assert.rejects(call, (err: unknown) => {
      assert.ok(err instanceof DaemonCallError);
      assert.equal((err.data as Record<string, unknown>)['code'], 'DAEMON_CANCELLED');
      return true;
    });
  });
});

describe('桥健壮性:并发读循环 / 取消 / 收尾(#19)', () => {
  it('daemon fetch 永挂:调用按超时失败,读循环不被阻塞(ping 照常应答)', async () => {
    const caller = createDaemonHttpClient({
      baseUrl: 'http://127.0.0.1:1', token: 't', fetchImpl: hangingFetch(), timeoutMs: 80,
    });
    const stdio = fakeStdio();
    const written: string[] = [];
    const bridge = createMcpBridge({
      input: stdio.input,
      output: { write(chunk: string) { written.push(chunk); return true; } },
      callDaemon: caller,
      autoSession: false,
    });
    bridge.start();
    stdio.push(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    }));
    stdio.push(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'capabilities_list', arguments: {} },
    }));
    stdio.push(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }));
    // ping 在 tools/call 超时(80ms)之前就应答 → 读循环没有被挂起调用阻塞
    await waitFor(() => written.some((l) => l.includes('"id":3')));
    const ping = JSON.parse(written.find((l) => l.includes('"id":3'))!);
    assert.deepEqual(ping['result'], {});
    // 挂起调用按超时收敛:错误帧写回,文案带 DAEMON_TIMEOUT
    await waitFor(() => written.some((l) => l.includes('"id":2')));
    const timed = JSON.parse(written.find((l) => l.includes('"id":2'))!);
    assert.equal(timed['result']['isError'], true);
    assert.match(timed['result']['content'][0]['text'] as string, /DAEMON_TIMEOUT/);
    stdio.end();
    await bridge.close();
  });

  it('并发两调用乱序返回:响应 id 一一对应', async () => {
    let resolveCaps: (value: unknown) => void = () => {};
    const capsPromise = new Promise((resolve) => { resolveCaps = resolve; });
    const callDaemon: DaemonCaller = (method: string) => {
      if (method === 'capabilities.list') return capsPromise;
      return Promise.resolve({ which: method });
    };
    const harness = makeBridge(callDaemon, { autoSession: false });
    await harness.call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    });
    const first = harness.call({
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'capabilities_list', arguments: {} },
    });
    const second = harness.call({
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'models_list', arguments: {} },
    });
    // 第一个调用还挂着,第二个先返回 → 逐行 await 的旧实现会在这里死锁
    const secondFrame = await second;
    assert.equal(secondFrame['id'], 11);
    assert.equal(secondFrame['result']['structuredContent']['which'], 'models.list');
    resolveCaps({ which: 'capabilities.list' });
    const firstFrame = await first;
    assert.equal(firstFrame['id'], 10);
    assert.equal(firstFrame['result']['structuredContent']['which'], 'capabilities.list');
  });

  it('notifications/cancelled:在飞调用被提前取消(结果帧 isError,含取消语义)', async () => {
    const harness = makeBridge(cancelAwareCallDaemon(), { autoSession: false });
    await harness.call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    });
    const inflight = harness.call({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'capabilities_list', arguments: {} },
    });
    await harness.notify({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 },
    });
    const frame = await inflight;
    assert.equal(frame['id'], 7);
    assert.equal(frame['result']['isError'], true);
    assert.match(frame['result']['content'][0]['text'] as string, /DAEMON_CANCELLED/);
  });

  it('close 在 pending 存在时收敛:abort 在飞调用并等错误帧写回', async () => {
    const stdio = fakeStdio();
    const written: string[] = [];
    const bridge = createMcpBridge({
      input: stdio.input,
      output: { write(chunk: string) { written.push(chunk); return true; } },
      callDaemon: cancelAwareCallDaemon(),
      autoSession: false,
    });
    bridge.start();
    stdio.push(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    }));
    stdio.push(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'capabilities_list', arguments: {} },
    }));
    await waitFor(() => written.length >= 1); // initialize 已应答,tools/call 在飞
    const outcome = await Promise.race([
      bridge.close().then(() => 'closed' as const),
      new Promise<'hung'>((resolve) => { setTimeout(() => resolve('hung'), 1000).unref(); }),
    ]);
    assert.equal(outcome, 'closed');
    // 在飞调用收到 close 的 abort:错误帧在 close 返回前写回
    await waitFor(() => written.length >= 2);
    const frame = JSON.parse(written[1]!);
    assert.equal(frame['id'], 2);
    assert.equal(frame['result']['isError'], true);
    assert.match(frame['result']['content'][0]['text'] as string, /DAEMON_CANCELLED/);
    stdio.end();
  });
});

// ---- #20 回归:auto-session 握手失败不再静默降级为 admin 语义 ----

/** 可编程假 callDaemon:session.init 可按队列逐次失败/成功,其余方法照常记账。 */
function fakeCallDaemonWithHandshake(handshakeOutcomes: ('fail' | 'ok')[]): {
  caller: DaemonCaller;
  calls: { method: string; params: Record<string, unknown> }[];
} {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let handshakeIndex = 0;
  const caller: DaemonCaller = (method, params) => {
    calls.push({ method, params: params as Record<string, unknown> });
    if (method === 'session.init') {
      const outcome = handshakeOutcomes[Math.min(handshakeIndex, handshakeOutcomes.length - 1)];
      handshakeIndex += 1;
      if (outcome === 'fail') {
        return Promise.reject(new DaemonCallError({
          code: -32000, message: 'daemon 不可达', data: { code: 'DAEMON_TIMEOUT' }, status: 0,
        }));
      }
      return Promise.resolve({ protocol: '1.0' });
    }
    return Promise.resolve({ method });
  };
  return { caller, calls };
}

/** 收集 stderr 输出的假诊断通道。 */
function fakeStderr(): { channel: { write(chunk: string): unknown }; lines: string[] } {
  const lines: string[] = [];
  return { channel: { write(chunk: string) { lines.push(chunk); return true; } }, lines };
}

describe('auto-session 失败显式报错(#20)', () => {
  it('握手失败后 needsSession 工具 → isError 阻断,stderr 留痕,不透传 admin 语义', async () => {
    const { caller, calls } = fakeCallDaemonWithHandshake(['fail']);
    const errSink = fakeStderr();
    const harness = makeBridge(caller, { stderr: errSink.channel });
    await harness.call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    });
    await harness.bridge.sessionReady();
    // initialize 阶段已失败并写 stderr(含失败原因摘要)
    assert.equal(harness.bridge.session(), null);
    assert.equal(errSink.lines.length, 1);
    assert.match(errSink.lines[0]!, /auto-session 握手失败/);
    assert.match(errSink.lines[0]!, /daemon 不可达/);

    // needsSession 工具:阻断执行,自动重试仍失败 → isError
    const blocked = await harness.call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'task_create', arguments: { intent: '不该被执行', preset: 'minimal' } },
    });
    assert.equal(blocked['result']['isError'], true);
    assert.match(blocked['result']['content'][0]['text'] as string, /auto-session 握手失败/);
    // daemon 侧只看到 initialize 一次握手 + 一次重试握手,task.create 从未发出
    assert.deepEqual(calls.map((c) => c.method), ['session.init', 'session.init']);

    // 阻断帧也写了 stderr(重试失败再次留痕)
    assert.ok(errSink.lines.length >= 2);
  });

  it('重试握手成功:首次 needsSession 调用前自动重试一次,随后正常执行并注入身份', async () => {
    const { caller, calls } = fakeCallDaemonWithHandshake(['fail', 'ok']);
    const errSink = fakeStderr();
    const harness = makeBridge(caller, { stderr: errSink.channel });
    await harness.call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    });
    await harness.bridge.sessionReady();
    assert.equal(harness.bridge.session(), null);

    const created = await harness.call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'task_create', arguments: { intent: '重试后建成', preset: 'minimal' } },
    });
    assert.equal(created['result']['isError'], false);
    assert.equal(created['result']['structuredContent']['method'], 'task.create');
    // task.create 携带了重试握手成功后的会话身份
    const create = calls.find((c) => c.method === 'task.create');
    assert.ok(create !== undefined);
    assert.match(create.params['session'] as string, /^mcp-/);
    assert.equal(create.params['tenant'], 'default');
    assert.ok(harness.bridge.session() !== null);
  });

  it('白名单工具(needsSession=false)在 identity=null 时行为不变,照常透传', async () => {
    const { caller, calls } = fakeCallDaemonWithHandshake(['fail']);
    const errSink = fakeStderr();
    const harness = makeBridge(caller, { stderr: errSink.channel, autoSession: false });
    await harness.call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    });
    assert.equal(harness.bridge.session(), null);
    const caps = await harness.call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'capabilities_list', arguments: {} },
    });
    assert.equal(caps['result']['isError'], false);
    assert.equal(caps['result']['structuredContent']['method'], 'capabilities.list');
    // 无重试握手副作用:白名单工具不触发 session.init
    assert.deepEqual(calls.map((c) => c.method), ['capabilities.list']);
  });

  it('参数显式给全 tenant+session:身份是明示选择,握手失败也放行(不静默注入)', async () => {
    const { caller, calls } = fakeCallDaemonWithHandshake(['fail']);
    const errSink = fakeStderr();
    const harness = makeBridge(caller, { stderr: errSink.channel, autoSession: false });
    await harness.call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    });
    const created = await harness.call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'task_create',
        arguments: { intent: '显式身份', preset: 'minimal', tenant: 'acme', session: 's-manual' },
      },
    });
    assert.equal(created['result']['isError'], false);
    const create = calls.find((c) => c.method === 'task.create');
    assert.equal(create!.params['tenant'], 'acme');
    assert.equal(create!.params['session'], 's-manual');
  });
});
