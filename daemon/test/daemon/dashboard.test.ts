/**
 * M4 观测线:http 绑定 GET 白名单 ——
 *   GET /            dashboard 静态页(200,html,零构建单页);
 *   GET /openapi.json  OpenAPI 3.1 文档(可取且合法);
 *   GET /events/stream SSE 事件流(先 replay 后 live、心跳保活、?token= 鉴权、
 *                      session 身份命名空间收窄);
 * 其余 GET / 其它方法保持 405。POST / 的 Bearer 语义不在本文件重复(daemon.test.ts)。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { startDaemon } from '../../src/daemon/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';
import type { Event } from '../../src/events/index.ts';

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
  const stateDir = opts.stateDir ?? (await mkdtemp(join(tmpdir(), 'neoba-dash-')));
  if (opts.stateDir === undefined) roots.push(stateDir);
  const handle = await startDaemon({ port: 0, ...opts, stateDir });
  handles.push(handle);
  return handle;
}

async function rpc(handle: DaemonHandle, method: string, params: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${handle.baseUrl}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${handle.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------- SSE 读取器

interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly comment?: string;
}

/** 把 SSE 字节流切成帧(空行分隔;行前缀 id:/event:/data:/:)。 */
async function* iterateSse(res: Response): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body!) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const fields: { id?: string; event?: string; data?: string; comment?: string } = {};
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) fields.comment = line.slice(1).trim();
        else if (line.startsWith('id:')) fields.id = line.slice(3).trim();
        else if (line.startsWith('event:')) fields.event = line.slice(6).trim();
        else if (line.startsWith('data:')) fields.data = (fields.data ?? '') + line.slice(5).trim();
      }
      yield fields;
    }
  }
}

/**
 * 打开 SSE 连接并收集帧,直到 predicate 满足(或超时抛错,附已收帧)。
 * 返回后即中止连接。测试中 predicate 之前收到的帧也全部带回(replay 断言用)。
 */
async function collectSse(
  handle: DaemonHandle,
  path: string,
  until: (frames: SseFrame[]) => boolean,
  timeoutMs = 5000,
): Promise<{ status: number; contentType: string | null; frames: SseFrame[] }> {
  const controller = new AbortController();
  let res: Response;
  try {
    res = await fetch(`${handle.baseUrl}${path}`, { signal: controller.signal });
  } catch (err) {
    controller.abort();
    throw err;
  }
  const frames: SseFrame[] = [];
  const pump = (async (): Promise<boolean> => {
    try {
      for await (const frame of iterateSse(res)) {
        frames.push(frame);
        if (until(frames)) return true;
      }
    } catch {
      return false; // abort 后的正常退出路径
    }
    return false;
  })();
  const guarded = pump.catch(() => false);
  const ok = await Promise.race([
    guarded,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (!ok) {
    throw new Error(
      `SSE 等待超时(${timeoutMs}ms):已收 ${frames.length} 帧\n` +
        JSON.stringify(frames.map((f) => f.event ?? f.comment ?? f.data?.slice(0, 40)), null, 1),
    );
  }
  return { status: res.status, contentType: res.headers.get('content-type'), frames };
}

const eventFrames = (frames: SseFrame[]): SseFrame[] => frames.filter((f) => f.event !== undefined);
const hasEvent = (frames: SseFrame[], type: string): boolean =>
  eventFrames(frames).some((f) => f.event === type);

// ---------------------------------------------------------------- GET 白名单

describe('GET 白名单(M4 观测线)', () => {
  it('GET / → 200 dashboard 静态页(只读单页,含 SSE/观测面接线)', async () => {
    const handle = await start();
    const res = await fetch(`${handle.baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    const html = await res.text();
    assert.match(html, /<title>neoba dashboard<\/title>/);
    assert.ok(html.includes('/events/stream'), '页面应接 SSE 事件流');
    for (const marker of ['task.list', 'approvals.list', 'budget.status']) {
      assert.ok(html.includes(marker), `页面应调用只读 RPC ${marker}`);
    }
    // 只读边界:不得出现任何写操作 RPC 的调用入口(事件类型 approval.decided
    // 只是 SSE 监听项,不算写入口)。
    for (const writeRpc of ['approvals.decide', 'task.cancel', 'task.pause', 'task.resume', 'budget.raise', 'models.feedback']) {
      assert.ok(!html.includes(writeRpc), `只读页面不得出现写操作入口 ${writeRpc}`);
    }
  });

  it('GET /openapi.json → 200 且为合法 OpenAPI 3.1 文档', async () => {
    const handle = await start();
    const res = await fetch(`${handle.baseUrl}/openapi.json`);
    assert.equal(res.status, 200);
    const doc = (await res.json()) as Record<string, unknown>;
    assert.equal(doc['openapi'], '3.1.0');
    const paths = doc['paths'] as Record<string, unknown>;
    assert.ok((paths['/'] as Record<string, unknown>)['post'] !== undefined);
    const components = doc['components'] as Record<string, unknown>;
    assert.ok((components['securitySchemes'] as Record<string, unknown>)['bearerAuth'] !== undefined);
  });

  it('未白名单 GET → 405;其它方法(如 PUT)→ 405', async () => {
    const handle = await start();
    const get = await fetch(`${handle.baseUrl}/nope`, { headers: { 'authorization': `Bearer ${handle.token}` } });
    assert.equal(get.status, 405);
    const body = (await get.json()) as Record<string, unknown>;
    assert.equal(((body['error'] as Record<string, unknown>)['data'] as Record<string, unknown>)['code'], 'METHOD_NOT_ALLOWED');

    const put = await fetch(`${handle.baseUrl}/`, { method: 'PUT' });
    assert.equal(put.status, 405);
  });
});

// ---------------------------------------------------------------- SSE /events/stream

describe('SSE /events/stream(M4)', () => {
  it('鉴权:无 token → 401;错 token → 401', async () => {
    const handle = await start();
    const none = await fetch(`${handle.baseUrl}/events/stream`);
    assert.equal(none.status, 401);
    const wrong = await fetch(`${handle.baseUrl}/events/stream?token=not-a-token`);
    assert.equal(wrong.status, 401);
    const body = (await wrong.json()) as Record<string, unknown>;
    assert.equal(((body['error'] as Record<string, unknown>)['data'] as Record<string, unknown>)['reason'], 'invalid_token');
  });

  it('admin:先 replay 既有事件再推 live;心跳注释行保活', async () => {
    const handle = await start({ sseHeartbeatMs: 30 });
    // 冷启动即有的事件:daemon.started;再补一条任务事件进重放窗口。
    await rpc(handle, 'task.create', { intent: '观测回放', preset: 'minimal' });

    const live = await handle.events.append({
      type: 'correction',
      principal: { tenant: 'default', session: null, task: null, agent: null },
      payload: { refSeq: 1, target: 'test:live', reason: 'sse-live' },
    });

    const { status, contentType, frames } = await collectSse(
      handle,
      `/events/stream?token=${encodeURIComponent(handle.token)}`,
      (fs) => hasEvent(fs, 'correction') && fs.some((f) => f.comment === 'keepalive'),
    );
    assert.equal(status, 200);
    assert.match(contentType ?? '', /^text\/event-stream/);
    // replay 窗口:建连接前已落盘的事件按序重放。
    assert.ok(hasEvent(frames, 'daemon.started'), '应重放 daemon.started');
    assert.ok(hasEvent(frames, 'node.started'), '应重放 node.started');
    assert.ok(hasEvent(frames, 'correction'), '应收到 live 事件 correction');
    // live 事件的 data 是完整事件 JSON(含回填的 seq/ts)。
    const correction = eventFrames(frames).find((f) => f.event === 'correction');
    const payload = JSON.parse(correction!.data!) as Event<'correction'>;
    assert.equal(payload.seq, live.seq);
    assert.equal(payload.payload['reason'], 'sse-live');
    // 首帧前有 retry 提示,流内有 replay-done 注释。
    assert.ok(frames.some((f) => f.comment === 'replay-done'));
  });

  it('session 身份:命名空间收窄(绑定 (tenant, session) 之外的事件不可见)', async () => {
    const handle = await start({ sseHeartbeatMs: 0 });
    const sessionToken = await handle.tokens.issue('acme', 'dev-1');
    const mine = await handle.events.append({
      type: 'correction',
      principal: { tenant: 'acme', session: 'dev-1', task: null, agent: null },
      payload: { refSeq: 1, target: 'test:mine', reason: 'in-namespace' },
    });
    await handle.events.append({
      type: 'correction',
      principal: { tenant: 'acme', session: 'dev-2', task: null, agent: null },
      payload: { refSeq: 1, target: 'test:others', reason: 'out-namespace' },
    });
    await handle.events.append({
      type: 'daemon.started',
      principal: { tenant: 'default', session: null, task: null, agent: null },
      payload: { pid: 1 },
    });

    const { frames } = await collectSse(
      handle,
      `/events/stream?token=${encodeURIComponent(sessionToken)}`,
      (fs) => hasEvent(fs, 'correction'),
    );
    const events = eventFrames(frames).map((f) => JSON.parse(f.data!) as Event<'correction'>);
    assert.ok(events.some((e) => e.payload['target'] === 'test:mine' && e.seq === mine.seq));
    assert.ok(
      events.every((e) => e.principal.tenant === 'acme' && e.principal.session === 'dev-1'),
      'session 身份只见绑定命名空间内的事件',
    );
    assert.ok(!hasEvent(frames, 'daemon.started'), 'daemon 级(session=null)事件对 session 身份不可见');

    // live 同样收窄:绑定命名空间外的新事件不推送。
    await handle.events.append({
      type: 'correction',
      principal: { tenant: 'acme', session: 'dev-2', task: null, agent: null },
      payload: { refSeq: 2, target: 'test:live-others', reason: 'out' },
    });
    const framesAfter: SseFrame[] = [];
    // 连接已被 collectSse 中止;用短连接二次验证 live 收窄:新开一条流只等 300ms。
    const controller = new AbortController();
    const res = await fetch(`${handle.baseUrl}/events/stream?token=${encodeURIComponent(sessionToken)}`, {
      signal: controller.signal,
    });
    const seen: SseFrame[] = [];
    const pump = (async () => {
      try {
        for await (const frame of iterateSse(res)) seen.push(frame);
      } catch { /* abort */ }
    })();
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    await pump.catch(() => {});
    framesAfter.push(...seen);
    assert.ok(
      !eventFrames(framesAfter).some((f) => String(JSON.parse(f.data!)['payload']['target']) === 'test:live-others'),
      '绑定命名空间外的 live 事件不得推送',
    );
  });
});
