/**
 * #9 回归:session.init 按调用者身份收窄 tenant —— 会话 token 只能在绑定
 * tenant 下登记会话并签发新 token(声明他人 tenant → SESSION_FORBIDDEN,
 * session 名可自选);bootstrap(admin)token 不受限,可为任意 tenant 签发。
 * in-process startDaemon + 真实 HTTP 面(identity 经 resolveIdentity 解析)。
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

async function start(): Promise<DaemonHandle> {
  const stateDir = await mkdtemp(join(tmpdir(), 'neoba-issue9-'));
  roots.push(stateDir);
  const handle = await startDaemon({ port: 0, stateDir });
  handles.push(handle); // afterEach 统一停服,否则 HTTP server 挂住事件循环。
  return handle;
}

async function rpc(
  handle: DaemonHandle,
  method: string,
  params: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${handle.baseUrl}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token ?? handle.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function sessionInitParams(tenant: string, session: string): Record<string, unknown> {
  return {
    protocol: '1.0',
    role: 'orchestrator',
    principal: { tenant, session },
    harness: 'issue9-harness',
    capabilities: {},
  };
}

describe('session.init 身份收窄(#9 回归)', () => {
  it('会话 token 声明他人 tenant → 403 SESSION_FORBIDDEN,且不登记会话、不签发 token', async () => {
    const handle = await start();
    const init = await rpc(handle, 'session.init', sessionInitParams('acme', 'dev-1'));
    const sessionToken = (init.body['result'] as Record<string, unknown>)['token'] as string;

    const cross = await rpc(
      handle,
      'session.init',
      sessionInitParams('victim', 'evil'),
      sessionToken,
    );
    assert.equal(cross.status, 403, JSON.stringify(cross.body).slice(0, 300));
    const err = cross.body['error'] as Record<string, unknown>;
    assert.equal(err['code'], -32014);
    assert.equal(
      ((err['data'] as Record<string, unknown>) ?? {})['code'],
      'SESSION_FORBIDDEN',
    );

    // 被拒会话未登记:admin 以该 principal 建任务 → SESSION_UNKNOWN(404)。
    const probe = await rpc(handle, 'task.create', {
      intent: '探测被拒会话是否登记',
      preset: 'minimal',
      tenant: 'victim',
      session: 'evil',
    });
    assert.equal(probe.status, 404);
    assert.equal(
      ((probe.body['error'] as Record<string, unknown>)['data'] as Record<string, unknown>)['code'],
      'SESSION_UNKNOWN',
    );
  });

  it('会话 token 声明本人 tenant(session 名可自选)→ 成功,新 token 绑定同 tenant', async () => {
    const handle = await start();
    const first = await rpc(handle, 'session.init', sessionInitParams('acme', 'dev-1'));
    const token1 = (first.body['result'] as Record<string, unknown>)['token'] as string;

    const second = await rpc(
      handle,
      'session.init',
      sessionInitParams('acme', 'dev-2'),
      token1,
    );
    assert.equal(second.status, 200, JSON.stringify(second.body).slice(0, 300));
    const result = second.body['result'] as Record<string, unknown>;
    const session = result['session'] as Record<string, unknown>;
    assert.equal(session['tenant'], 'acme');
    assert.equal(session['session'], 'dev-2');
    const token2 = result['token'] as string;
    assert.ok(typeof token2 === 'string' && token2.length >= 32, '应签发新会话 token');

    // 新 token 贯通:以 acme/dev-2 身份建任务成功。
    const created = await rpc(
      handle,
      'task.create',
      { intent: 'dev-2 任务', preset: 'minimal' },
      token2,
    );
    assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300));
  });

  it('bootstrap token 声明任意 tenant → 成功(admin 不受限)', async () => {
    const handle = await start();
    const res = await rpc(handle, 'session.init', sessionInitParams('任意租户', 'admin-made'));
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const result = res.body['result'] as Record<string, unknown>;
    const session = result['session'] as Record<string, unknown>;
    assert.equal(session['tenant'], '任意租户');
    assert.equal(session['session'], 'admin-made');
    assert.ok(typeof result['token'] === 'string' && (result['token'] as string).length >= 32);
  });
});
