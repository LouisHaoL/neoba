/**
 * #10 回归:grants.of / models.feedback 按调用者身份收窄 ——
 * - grants.of:session token 只能查本人 (tenant, session) 命名空间内 agent
 *   的授权清单,他人 tenant / 不存在的 task 段一律 SESSION_FORBIDDEN(403);
 *   bootstrap(admin)token 不受限;
 * - models.feedback:session token 一律拒绝(写权收归 admin,防跨租户污染
 *   plancheck 准入与调度依据的 modelscore 注册表);admin 可写;
 * - models.list:只读聚合观测,所有已认证身份可读。
 * in-process startDaemon + 真实 HTTP 面(identity 经 resolveIdentity 解析)。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { startDaemon } from '../../src/daemon/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';
import { loadModelRegistry } from '../../src/modelscore/index.ts';

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

/** 预置一条模型评分记录(admin 反馈路径要用;空表会报 MODEL_UNKNOWN)。 */
function seededModels(): ReturnType<typeof loadModelRegistry> {
  return loadModelRegistry({
    api: 'modelscore/1.0',
    models: [
      {
        protocol: '1.0',
        spec_version: '1.0',
        model: 'glm-4.7-air',
        tier_fit: { fast: 0.91, standard: 0.62, heavy: 0.3 },
        score: {
          prior: { fast: 0.88, standard: 0.55, heavy: 0.2 },
          observed: { fast: null, standard: null, heavy: null },
          samples: { fast: 0, standard: 0, heavy: 0 },
          dimensions: { quality: 0.8, success_rate: 0.85, cost_efficiency: 0.74 },
        },
        updated_at: '2026-09-05T00:00:00Z',
      },
    ],
  });
}

async function start(): Promise<DaemonHandle> {
  const stateDir = await mkdtemp(join(tmpdir(), 'neoba-issue10-'));
  roots.push(stateDir);
  const handle = await startDaemon({ port: 0, stateDir, models: seededModels() });
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
    harness: 'issue10-harness',
    capabilities: {},
  };
}

/** admin 为指定 (tenant, session) 签发会话 token,并以其身份建一个任务。 */
async function seedTenantTask(
  handle: DaemonHandle,
  tenant: string,
  session: string,
): Promise<{ token: string; agentId: string }> {
  const init = await rpc(handle, 'session.init', sessionInitParams(tenant, session));
  const token = ((init.body['result'] as Record<string, unknown>)['token']) as string;
  const created = await rpc(
    handle,
    'task.create',
    { intent: `${tenant}/${session} 的任务`, preset: 'minimal' },
    token,
  );
  assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300));
  const agentId = (created.body['result'] as Record<string, unknown>)['agent_id'] as string;
  return { token, agentId };
}

function errorCode(body: Record<string, unknown>): unknown {
  return (((body['error'] as Record<string, unknown>)?.['data'] ?? {}) as Record<string, unknown>)['code'];
}

describe('grants.of 身份收窄(#10 回归)', () => {
  it('session token 查本人命名空间 agent → 200;查他人 tenant / 不存在 task 段 → 403 SESSION_FORBIDDEN', async () => {
    const handle = await start();
    const mine = await seedTenantTask(handle, 'acme', 'dev-1');
    const other = await seedTenantTask(handle, 'victim', 'other');

    // 本人命名空间:manifest 可查。
    const own = await rpc(handle, 'grants.of', { agent_id: mine.agentId }, mine.token);
    assert.equal(own.status, 200, JSON.stringify(own.body).slice(0, 300));
    assert.ok(((own.body['result'] as Record<string, unknown>)['manifest']) !== null);

    // 他人 tenant 的 agent_id:拒绝,错误码 SESSION_FORBIDDEN(-32014)。
    const cross = await rpc(handle, 'grants.of', { agent_id: other.agentId }, mine.token);
    assert.equal(cross.status, 403, JSON.stringify(cross.body).slice(0, 300));
    assert.equal(cross.body['error'] && (cross.body['error'] as Record<string, unknown>)['code'], -32014);
    assert.equal(errorCode(cross.body), 'SESSION_FORBIDDEN');

    // 不存在的 task 段:同样按越权拒绝,不给跨租户探测空间。
    const probe = await rpc(handle, 'grants.of', { agent_id: 'task-nope/worker-01' }, mine.token);
    assert.equal(probe.status, 403);
    assert.equal(errorCode(probe.body), 'SESSION_FORBIDDEN');
  });

  it('bootstrap token 不受限:可查任意 tenant 的 agent 授权清单(admin 现语义)', async () => {
    const handle = await start();
    const other = await seedTenantTask(handle, 'victim', 'other');
    const res = await rpc(handle, 'grants.of', { agent_id: other.agentId });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    assert.ok(((res.body['result'] as Record<string, unknown>)['manifest']) !== null);
  });
});

describe('models.* 身份收窄(#10 回归)', () => {
  it('session token 提交 models.feedback → 403 SESSION_FORBIDDEN;admin 可写;models.list 只读放行', async () => {
    const handle = await start();
    const mine = await seedTenantTask(handle, 'acme', 'dev-1');

    // session 身份拒绝:评分写权收归 admin,防跨租户污染注册表。
    const denied = await rpc(
      handle,
      'models.feedback',
      { model: 'glm-4.7-air', tier: 'fast', success: true, quality: 0.9 },
      mine.token,
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body).slice(0, 300));
    assert.equal(denied.body['error'] && (denied.body['error'] as Record<string, unknown>)['code'], -32014);
    assert.equal(errorCode(denied.body), 'SESSION_FORBIDDEN');

    // 拒绝后注册表未被污染(session 名义无评分写入;仍是预置的 0 样本)。
    const list = await rpc(handle, 'models.list', {}, mine.token);
    assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300));
    const models = ((list.body['result'] as Record<string, unknown>)['models']) as {
      model: string;
      score: { samples: { fast: number } };
    }[];
    assert.equal(models.length, 1);
    assert.equal(models[0]?.['score']['samples']['fast'], 0);

    // admin(bootstrap)可写:EMA 正常入账。
    const fed = await rpc(handle, 'models.feedback', {
      model: 'glm-4.7-air',
      tier: 'fast',
      success: true,
      quality: 0.9,
    });
    assert.equal(fed.status, 200, JSON.stringify(fed.body).slice(0, 300));
    assert.equal(((fed.body['result'] as Record<string, unknown>)['samples']), 1);
  });
});
