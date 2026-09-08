/**
 * M3 双 token 模型单元测试:TokenRegistry 发放/校验/持久化恢复/吊销/
 * 同会话重握手换 token/损坏文件 fail-closed,及 resolveIdentity 的
 * bootstrap=admin 语义;#30 追加 ttl 过期语义(到期拒、脏值 fail-closed、
 * 无 ttl 永不过期、重启恢复后仍生效)。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ADMIN_IDENTITY, resolveIdentity, TokenRegistry } from '../../src/daemon/index.ts';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function open(): Promise<{ registry: TokenRegistry; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'neoba-identity-'));
  roots.push(dir);
  return { registry: await TokenRegistry.open(dir), dir };
}

describe('TokenRegistry(§6 M3 双 token 模型)', () => {
  it('issue → verify:命中返回 session 身份;未命中返回 null', async () => {
    const { registry } = await open();
    const token = await registry.issue('acme', 'dev-1');
    assert.deepEqual(registry.verify(token), { kind: 'session', tenant: 'acme', session: 'dev-1' });
    assert.equal(registry.verify(`wrong-${token}`), null);
    assert.equal(registry.size, 1);
  });

  it('明文不落盘:tokens.json 只含 sha256', async () => {
    const { registry, dir } = await open();
    const token = await registry.issue('acme', 'dev-1');
    const raw = await readFile(join(dir, 'tokens.json'), 'utf8');
    assert.ok(!raw.includes(token), 'tokens.json 不得含 token 明文');
    assert.match(raw, /"api": "neoba-tokens\/1\.0"/);
  });

  it('重启恢复:重新 open 后旧 token 仍可校验', async () => {
    const { registry, dir } = await open();
    const token = await registry.issue('acme', 'dev-1');
    const reopened = await TokenRegistry.open(dir);
    assert.deepEqual(reopened.verify(token), { kind: 'session', tenant: 'acme', session: 'dev-1' });
    assert.notEqual(reopened, registry);
    void registry;
  });

  it('同会话重握手换 token:旧 token 失效,新 token 唯一有效', async () => {
    const { registry } = await open();
    const first = await registry.issue('acme', 'dev-1');
    const second = await registry.issue('acme', 'dev-1');
    assert.notEqual(first, second);
    assert.equal(registry.verify(first), null);
    assert.deepEqual(registry.verify(second), { kind: 'session', tenant: 'acme', session: 'dev-1' });
    assert.equal(registry.size, 1, '一个会话同时只持一枚有效 token');
  });

  it('不同会话各自持 token,互不影响', async () => {
    const { registry } = await open();
    const t1 = await registry.issue('acme', 'dev-1');
    const t2 = await registry.issue('acme', 'dev-2');
    assert.notEqual(registry.verify(t1), null);
    assert.notEqual(registry.verify(t2), null);
    assert.equal(registry.size, 2);
  });

  it('revoke:吊销后立即失效;重复吊销返回 false', async () => {
    const { registry, dir } = await open();
    const token = await registry.issue('acme', 'dev-1');
    assert.equal(await registry.revoke('acme', 'dev-1'), true);
    assert.equal(registry.verify(token), null);
    assert.equal(await registry.revoke('acme', 'dev-1'), false);
    // 吊销也落盘:重新 open 后依旧失效。
    assert.equal((await TokenRegistry.open(dir)).verify(token), null);
  });

  it('损坏的 tokens.json 按空表处理(fail-closed),不阻断打开', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neoba-identity-'));
    roots.push(dir);
    await writeFile(join(dir, 'tokens.json'), '{{{not json', 'utf8');
    const registry = await TokenRegistry.open(dir);
    assert.equal(registry.size, 0);
    assert.equal(registry.verify('anything'), null);
  });

  it('缺文件 = 首次启动空表', async () => {
    const { registry } = await open();
    assert.equal(registry.size, 0);
  });
});

describe('TokenRegistry 过期(#30:issue 支持 ttlMs,verify fail-closed)', () => {
  const T0 = new Date('2026-09-04T12:00:00Z');

  it('带 ttlMs:到期前 verify 命中,到期后返回 null', async () => {
    const { registry } = await open();
    const token = await registry.issue('acme', 'dev-1', {
      ttlMs: 60_000,
      now: () => T0,
    });
    // 到期前(ttl 内任一时刻)仍有效
    assert.deepEqual(registry.verify(token, () => new Date(T0.getTime() + 59_999)), {
      kind: 'session', tenant: 'acme', session: 'dev-1',
    });
    // 到期时刻(<=)即拒
    assert.equal(registry.verify(token, () => new Date(T0.getTime() + 60_000)), null);
    assert.equal(registry.verify(token, () => new Date(T0.getTime() + 61_000)), null);
  });

  it('带 ttlMs 的记录落盘含 expiresAt;无 ttl 不落该键 = 永不过期', async () => {
    const { registry, dir } = await open();
    const ttlToken = await registry.issue('acme', 'with-ttl', { ttlMs: 1_000, now: () => T0 });
    const plainToken = await registry.issue('acme', 'no-ttl', { now: () => T0 });
    const raw = await readFile(join(dir, 'tokens.json'), 'utf8');
    const parsed = JSON.parse(raw) as { tokens: { session: string; expiresAt?: string }[] };
    const withTtl = parsed.tokens.find((t) => t.session === 'with-ttl');
    const noTtl = parsed.tokens.find((t) => t.session === 'no-ttl');
    assert.equal(withTtl?.expiresAt, '2026-09-04T12:00:01.000Z');
    assert.equal(noTtl?.expiresAt, undefined);
    // 无 ttl:任意远的将来仍有效(现行为不变);对照 ttl token 同时点已过期。
    assert.deepEqual(registry.verify(plainToken, () => new Date('2126-01-01T00:00:00Z')), {
      kind: 'session', tenant: 'acme', session: 'no-ttl',
    });
    assert.equal(registry.verify(ttlToken, () => new Date(T0.getTime() + 1_001)), null);
  });

  it('脏 expiresAt(非法 ISO)→ fail-closed 返回 null', async () => {
    const { dir } = await open();
    const token = 'presented-plain';
    const hash = createHash('sha256').update(token, 'utf8').digest('hex');
    await writeFile(
      join(dir, 'tokens.json'),
      JSON.stringify({
        api: 'neoba-tokens/1.0',
        tokens: [{ hash, tenant: 'acme', session: 'dev-1', issuedAt: T0.toISOString(), expiresAt: 'not-a-date' }],
      }),
      'utf8',
    );
    const registry = await TokenRegistry.open(dir);
    assert.equal(registry.verify(token), null, '解析失败的过期时刻必须按已过期处理');
  });

  it('重启恢复后过期语义仍生效:重新 open,到期后 verify 返回 null', async () => {
    const { registry, dir } = await open();
    const token = await registry.issue('acme', 'dev-1', { ttlMs: 60_000, now: () => T0 });
    const reopened = await TokenRegistry.open(dir);
    assert.deepEqual(reopened.verify(token, () => new Date(T0.getTime() + 1_000)), {
      kind: 'session', tenant: 'acme', session: 'dev-1',
    });
    assert.equal(reopened.verify(token, () => new Date(T0.getTime() + 60_001)), null);
    void registry;
  });
});

describe('resolveIdentity(bootstrap = admin,现语义不变)', () => {
  it('bootstrap token → admin 身份;会话 token → session 身份;未知 → null', async () => {
    const { registry } = await open();
    const sessionToken = await registry.issue('acme', 'dev-1');
    assert.equal(resolveIdentity('boot', 'boot', registry), ADMIN_IDENTITY);
    assert.deepEqual(resolveIdentity(sessionToken, 'boot', registry), {
      kind: 'session', tenant: 'acme', session: 'dev-1',
    });
    assert.equal(resolveIdentity('nope', 'boot', registry), null);
  });

  it('未配置注册表:仅 bootstrap 可用(现语义,单 token 部署)', () => {
    assert.equal(resolveIdentity('boot', 'boot', undefined), ADMIN_IDENTITY);
    assert.equal(resolveIdentity('other', 'boot', undefined), null);
  });
});
