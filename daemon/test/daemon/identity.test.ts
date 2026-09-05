/**
 * M3 双 token 模型单元测试:TokenRegistry 发放/校验/持久化恢复/吊销/
 * 同会话重握手换 token/损坏文件 fail-closed,及 resolveIdentity 的
 * bootstrap=admin 语义。
 */
import assert from 'node:assert/strict';
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
