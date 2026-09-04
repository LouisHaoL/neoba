/**
 * daemon 服务壳测试(§6):token 鉴权(缺失/错误/正确)、session.init 全流程
 * (成功/版本不兼容/重复会话)、task.create 授予与事件落盘、单 task 抛错的
 * failure domain、artifacts 三操作、task.list/status 与重启恢复、优雅关闭、
 * 协议层错误(解析/未知方法/参数非法/超大请求体)、端口冲突。
 * HTTP 一律随机高位端口(port 0)。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  startDaemon,
  defaultPresets,
  readTokenFile,
  tokensMatch,
  DEFAULT_TENANT,
} from '../../src/daemon/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';
import { minimalPresetDoc, parsePreset } from '../../src/capability/index.ts';
import type { Preset } from '../../src/capability/index.ts';

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
  const stateDir = opts.stateDir ?? await mkdtemp(join(tmpdir(), 'neoba-daemon-'));
  if (opts.stateDir === undefined) roots.push(stateDir);
  const handle = await startDaemon({ port: 0, ...opts, stateDir });
  handles.push(handle);
  return handle;
}

interface RpcResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function rpc(
  handle: DaemonHandle,
  method: string,
  params: unknown,
  token?: string | null,
): Promise<RpcResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['authorization'] = `Bearer ${token ?? handle.token}`;
  const res = await fetch(`${handle.baseUrl}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function sessionParams(session: string, tenant = 't1'): Record<string, unknown> {
  return {
    protocol: '1.0',
    role: 'orchestrator',
    principal: { tenant, session },
    harness: 'test-harness',
    capabilities: { broadcast: true },
  };
}

describe('鉴权(§6:Bearer token 强制)', () => {
  it('缺失 token → 401 + 类型化错误结构(missing_token)', async () => {
    const handle = await start();
    const res = await fetch(`${handle.baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'capabilities.list' }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body['jsonrpc'], '2.0');
    assert.equal(body['error']['code'], -32001);
    assert.equal(body['error']['data']['reason'], 'missing_token');
  });

  it('错误 token → 401 invalid_token;token 文件存在且可读、权限尽力而为', async () => {
    const handle = await start();
    const { status, body } = await rpc(handle, 'capabilities.list', {}, 'wrong-token');
    assert.equal(status, 401);
    assert.equal((body['error'] as Record<string, any>)['data']['reason'], 'invalid_token');
    const stored = await readTokenFile(handle.tokenFile);
    assert.equal(stored, handle.token);
    assert.ok(tokensMatch(handle.token, stored));
    assert.ok(!tokensMatch(handle.token, 'nope'));
    assert.ok(handle.token.length >= 40);
  });

  it('正确 token → 通过', async () => {
    const handle = await start();
    const { status, body } = await rpc(handle, 'capabilities.list', {});
    assert.equal(status, 200);
    assert.ok(Array.isArray(body['result'] && (body['result'] as any)['capabilities']));
  });
});

describe('session.init 全流程', () => {
  it('成功握手:应答字段齐全、会话登记、能力降级说明', async () => {
    const handle = await start();
    const { status, body } = await rpc(handle, 'session.init', sessionParams('s1'));
    assert.equal(status, 200);
    const result = body['result'] as Record<string, any>;
    assert.equal(result['response']['protocol'], '1.0');
    assert.equal(result['response']['spec_version'], '1.0');
    assert.ok(typeof result['response']['daemon_version'] === 'string');
    assert.deepEqual(result['response']['document_kinds']['preset'].length > 0, true);
    assert.equal(result['session']['tenant'], 't1');
    assert.equal(result['session']['session'], 's1');
    assert.deepEqual(result['session']['capabilities'], {
      broadcast: true,
      async_events: false,
      interactive_approval: false,
    });
  });

  it('版本不兼容:protocol "2.0" → 类型化错误(非 2xx,SESSION_INIT_INVALID)', async () => {
    const handle = await start();
    const { status, body } = await rpc(handle, 'session.init', {
      ...sessionParams('s-bad'),
      protocol: '2.0',
    });
    assert.equal(status, 400);
    const error = body['error'] as Record<string, any>;
    assert.equal(error['code'], -32000);
    assert.equal(error['data']['code'], 'SESSION_INIT_INVALID');
    assert.equal(error['data']['field'], 'protocol');
  });

  it('重复会话:同 tenant/session 再次握手 → SESSION_DUPLICATE', async () => {
    const handle = await start();
    await rpc(handle, 'session.init', sessionParams('dup'));
    const { status, body } = await rpc(handle, 'session.init', sessionParams('dup'));
    assert.equal(status, 409);
    const error = body['error'] as Record<string, any>;
    assert.equal(error['data']['code'], 'SESSION_DUPLICATE');
  });

  it('capabilities.list:注册表可查(内置 fs:workdir)', async () => {
    const handle = await start();
    const { body } = await rpc(handle, 'capabilities.list', {});
    const caps = (body['result'] as Record<string, any>)['capabilities'] as any[];
    assert.ok(caps.some((c) => c['id'] === 'fs:workdir'));
  });
});

describe('task.create / grants.of / task.status(P1 单节点闭环)', () => {
  it('创建任务:基线授予 + 事件落盘 + grants.of 可查', async () => {
    const handle = await start();
    await rpc(handle, 'session.init', sessionParams('s-task'));
    const { status, body } = await rpc(handle, 'task.create', {
      intent: '跑一轮 e2e 回归',
      preset: 'minimal',
      session: 's-task',
    });
    assert.equal(status, 200);
    const result = body['result'] as Record<string, any>;
    assert.match(result['task_id'] as string, /^task-/);
    assert.equal(result['agent_id'], `${result['task_id']}/worker-01`);
    assert.equal(result['status'], 'completed');
    const grants = (result['manifest']['grants'] as any[]).map((g) => [g['cap'], g['scope']]);
    assert.deepEqual(grants, [['fs:workdir', 'rw']]);
    assert.equal(result['manifest']['grants'][0]['source'], 'baseline');

    // grants.of 与 task.status
    const of = await rpc(handle, 'grants.of', { agent_id: result['agent_id'] });
    assert.equal(((of.body['result'] as any)['manifest']['grants']).length, 1);
    const st = await rpc(handle, 'task.status', { task_id: result['task_id'] });
    assert.equal(((st.body['result'] as any)['task']['status']), 'completed');
    assert.equal(((st.body['result'] as any)['task']['intent']), '跑一轮 e2e 回归');

    // 事件落盘:node.started → grant.granted → node.completed
    const taskId = result['task_id'] as string;
    const events = await handle.events.readByPrincipal({ tenant: 't1', task: taskId });
    assert.deepEqual(
      events.map((e) => e.type),
      ['node.started', 'grant.granted', 'node.completed'],
    );
    const grantEvent = events[1]! as any;
    assert.equal(grantEvent['payload']['cap'], 'fs:workdir');
    assert.equal(grantEvent['payload']['scope'], 'rw');
    assert.equal(grantEvent['payload']['decisionSource'], 'auto_rule:baseline');
    assert.equal(grantEvent['principal']['agent'], result['agent_id']);
    // daemon.started 也在日志里
    const all = await handle.events.readByPrincipal({ tenant: DEFAULT_TENANT });
    assert.ok(all.some((e) => e.type === 'daemon.started'));
  });

  it('未声明 session 时 principal 落默认 tenant;未知 session 拒绝', async () => {
    const handle = await start();
    const ok = await rpc(handle, 'task.create', { intent: 'x', preset: 'minimal' });
    assert.equal(ok.status, 200);
    assert.equal(((ok.body['result'] as any)['manifest']['agent_id'] as string).startsWith('task-'), true);
    const bad = await rpc(handle, 'task.create', {
      intent: 'x',
      preset: 'minimal',
      session: 'ghost',
    });
    assert.equal(bad.status, 404);
    assert.equal((bad.body['error'] as Record<string, any>)['data']['code'], 'SESSION_UNKNOWN');
  });

  it('task.create 缺参数 → -32602;task.status 不存在 → TASK_NOT_FOUND', async () => {
    const handle = await start();
    const missing = await rpc(handle, 'task.create', { intent: 'x' });
    assert.equal(missing.status, 400);
    assert.equal((missing.body['error'] as Record<string, any>)['code'], -32602);
    const gone = await rpc(handle, 'task.status', { task_id: 'task-none' });
    assert.equal((gone.body['error'] as Record<string, any>)['data']['code'], 'TASK_NOT_FOUND');
  });
});

describe('任务级 failure domain(§6)', () => {
  it('单 task 抛错:记 node.failed + task 标 failed,daemon 不崩、其他请求照常', async () => {
    const broken: Record<string, Preset> = {
      ...defaultPresets(),
      broken: parsePreset(
        minimalPresetDoc({ baseline_grants: [{ cap: 'fs:workdir', scope: 'rw' }, { cap: 'nope:missing', scope: 'read' }] }),
      ),
    };
    const handle = await start({ presets: broken });
    const { status, body } = await rpc(handle, 'task.create', { intent: '会炸', preset: 'broken' });
    assert.equal(status, 409); // BaselineAlreadyApplied? 否——CapUnknown
    const error = body['error'] as Record<string, any>;
    assert.equal(error['data']['code'], 'CAP_UNKNOWN');

    // task 已标 failed 且 node.failed 落盘
    const listed = await rpc(handle, 'task.list', {});
    const tasks = (listed.body['result'] as any)['tasks'] as any[];
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!['status'], 'failed');
    assert.match(tasks[0]!['error'] as string, /nope:missing/);
    const failedEvents = await handle.events.readByPrincipal({
      tenant: DEFAULT_TENANT,
      task: tasks[0]!['taskId'] as string,
      types: ['node.failed'],
    });
    assert.equal(failedEvents.length, 1);
    assert.equal((failedEvents[0]!['payload'] as any)['reason'], 'crash');

    // daemon 存活:后续请求照常
    const alive = await rpc(handle, 'capabilities.list', {});
    assert.equal(alive.status, 200);
    const good = await rpc(handle, 'task.create', { intent: '正常', preset: 'minimal' });
    assert.equal(good.status, 200);
  });
});

describe('artifacts 三操作', () => {
  it('publish → resolve → read 走通,artifact.published 落盘', async () => {
    const handle = await start();
    await rpc(handle, 'session.init', sessionParams('s-art'));
    const pub = await rpc(handle, 'artifacts.publish', {
      session: 's-art',
      task: 'task-art1',
      node: 'n1',
      name: 'report',
      content: '# hello\n',
    });
    assert.equal(pub.status, 200);
    const pubResult = pub.body['result'] as Record<string, any>;
    assert.equal(pubResult['version'], 1);
    assert.equal(pubResult['kind'], 'file');
    assert.match(pubResult['root_sha256'] as string, /^[0-9a-f]{64}$/);

    const resolve = await rpc(handle, 'artifacts.resolve', {
      session: 's-art',
      task: 'task-art1',
      node: 'n1',
      name: 'report',
    });
    const ref = resolve.body['result'] as Record<string, any>;
    assert.equal(ref['version'], 1);
    assert.equal(ref['rootSha256'], pubResult['root_sha256']);

    const read = await rpc(handle, 'artifacts.read', {
      session: 's-art',
      task: 'task-art1',
      node: 'n1',
      name: 'report',
    });
    const readResult = read.body['result'] as Record<string, any>;
    assert.equal(readResult['encoding'], 'utf8');
    assert.equal(readResult['data'], '# hello\n');

    // 目录型工件 + entry_path 读取
    const tree = await rpc(handle, 'artifacts.publish', {
      session: 's-art',
      task: 'task-art1',
      node: 'n1',
      name: 'bundle',
      files: [
        { path: 'a.txt', content: 'A' },
        { path: 'sub/b.txt', content: 'B' },
      ],
    });
    assert.equal((tree.body['result'] as any)['kind'], 'tree');
    const readEntry = await rpc(handle, 'artifacts.read', {
      session: 's-art',
      task: 'task-art1',
      node: 'n1',
      name: 'bundle',
      entry_path: 'sub/b.txt',
    });
    assert.equal((readEntry.body['result'] as any)['data'], 'B');

    // 从未发布 → resolve 返回 null;read 不存在条目 → 类型化错误
    const never = await rpc(handle, 'artifacts.resolve', {
      session: 's-art', task: 'task-art1', node: 'n1', name: 'ghost',
    });
    assert.equal(never.body['result'], null);
    const missing = await rpc(handle, 'artifacts.read', {
      session: 's-art', task: 'task-art1', node: 'n1', name: 'bundle', entry_path: 'nope.txt',
    });
    assert.equal((missing.body['error'] as Record<string, any>)['data']['code'], 'ARTIFACT_NOT_FOUND');

    const events = await handle.events.readByPrincipal({ tenant: 't1', task: 'task-art1' });
    assert.equal(events.filter((e) => e.type === 'artifact.published').length, 2);
  });

  it('声明未知 session 的工件操作 → SESSION_UNKNOWN', async () => {
    const handle = await start();
    const res = await rpc(handle, 'artifacts.publish', {
      session: 'ghost', task: 't', node: 'n', name: 'x', content: 'y',
    });
    assert.equal(res.status, 404);
    assert.equal((res.body['error'] as Record<string, any>)['data']['code'], 'SESSION_UNKNOWN');
  });
});

describe('恢复(事件重放)与 task.list', () => {
  it('重启后 task.list / grants.of 从事件重放恢复', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-recover-'));
    roots.push(stateDir);
    const first = await start({ stateDir });
    await rpc(first, 'task.create', { intent: '任务甲', preset: 'minimal' });
    const created = await rpc(first, 'task.create', { intent: '任务乙', preset: 'minimal' });
    const agentId = (created.body['result'] as any)['agent_id'] as string;
    await first.stop();
    handles.pop();

    const second = await start({ stateDir });
    const list = await rpc(second, 'task.list', {});
    const tasks = (list.body['result'] as any)['tasks'] as any[];
    assert.equal(tasks.length, 2);
    const statuses = new Map(tasks.map((t) => [t['intent'], t['status']]));
    assert.equal(statuses.get('任务甲'), 'completed');
    assert.equal(statuses.get('任务乙'), 'completed');
    // manifest 从 grant.granted 重建
    const of = await rpc(second, 'grants.of', { agent_id: agentId });
    const manifest = (of.body['result'] as any)['manifest'];
    assert.deepEqual(manifest['grants'].map((g: any) => g['cap']), ['fs:workdir']);
    assert.equal(manifest['audit'][0]['decision_source'], 'auto_rule:baseline');
    // recovered 事件已记
    const all = await second.events.readByPrincipal({ tenant: DEFAULT_TENANT });
    const recovered = all.filter((e) => e.type === 'daemon.recovered');
    assert.ok(recovered.length >= 1);
    assert.ok((recovered.at(-1)!['payload'] as any)['replayed'] >= 2);
  });
});

describe('协议层错误与限制', () => {
  it('非法 JSON → -32700;未知方法 → -32601;GET → 405', async () => {
    const handle = await start();
    const bad = await fetch(`${handle.baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${handle.token}` },
      body: '{not json',
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as any)['error']['code'], -32700);

    const unknown = await rpc(handle, 'orchestration.run', {});
    assert.equal(unknown.status, 404);
    assert.equal((unknown.body['error'] as Record<string, any>)['code'], -32601);

    const get = await fetch(`${handle.baseUrl}/`, { headers: { 'authorization': `Bearer ${handle.token}` } });
    assert.equal(get.status, 405);
  });

  it('超过请求大小限制 → 413 PAYLOAD_TOO_LARGE', async () => {
    const handle = await start({ maxBodyBytes: 64 });
    const res = await fetch(`${handle.baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${handle.token}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'artifacts.publish',
        params: { task: 't', node: 'n', name: 'big', content: 'x'.repeat(4096) },
      }),
    });
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as any)['error']['code'], -32002);
  });

  it('端口冲突:同端口第二个 daemon 报 PORT_IN_USE,第一个不受影响', async () => {
    const first = await start({ port: 0 });
    const conflictDir = await mkdtemp(join(tmpdir(), 'neoba-conflict-'));
    roots.push(conflictDir);
    let threw = false;
    try {
      await startDaemon({ stateDir: conflictDir, port: first.port });
    } catch (err: any) {
      threw = true;
      assert.equal(err.code, 'PORT_IN_USE');
    }
    assert.ok(threw);
    const alive = await rpc(first, 'capabilities.list', {});
    assert.equal(alive.status, 200);
  });
});

describe('优雅关闭', () => {
  it('stopDaemon:停止接受请求、状态标记落盘、事件日志已 flush', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'neoba-stop-'));
    roots.push(stateDir);
    const handle = await start({ stateDir });
    await rpc(handle, 'task.create', { intent: '关停前', preset: 'minimal' });
    await handle.stop();
    await assert.rejects(() => fetch(`${handle.baseUrl}/`));
    const state = JSON.parse(await readFile(join(stateDir, 'daemon-state.json'), 'utf8'));
    assert.equal(state['stoppedAt'] !== null, true);
    assert.equal(typeof state['port'], 'number');
    // 事件文件确有内容(flush 落盘)
    const log = await readFile(join(stateDir, 'events', 'events.jsonl'), 'utf8');
    assert.ok(log.includes('node.started'));
    assert.ok(log.includes('daemon.started'));
  });

  it('重复 stop 幂等', async () => {
    const handle = await start();
    await handle.stop();
    await handle.stop();
  });
});
