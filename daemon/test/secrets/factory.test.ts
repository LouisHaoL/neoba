/**
 * SecretStore 工厂测试:显式 config 优先 > 平台探测;未知 kind 类型化报错。
 * 平台分支用注入 env.platform 覆盖(仿 doctor 的 PlatformInfo 注入风格,
 * 不 mock 模块、不用 enum),任意平台跑全部分支。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  KeyringSecretBackend,
  MemorySecretBackend,
  UnknownSecretBackendKind,
  createSecretBackend,
  createSecretStore,
} from '../../src/secrets/index.ts';
import { FileSecretBackend } from '../../src/secrets/index.ts';

const HOME = '/tmp/fake-home';

function modeOf(backend: unknown): string {
  assert.ok(backend instanceof FileSecretBackend);
  return backend.mode;
}

describe('createSecretBackend:显式 kind 覆盖平台探测', () => {
  it('win32 平台 + 显式 keyring → keyring(显式优先)', () => {
    const backend = createSecretBackend(
      { kind: 'keyring', root: '/idx' },
      { platform: 'win32', homedir: HOME },
    );
    assert.ok(backend instanceof KeyringSecretBackend);
  });

  it('linux 平台 + 显式 memory → memory', () => {
    const backend = createSecretBackend(
      { kind: 'memory' },
      { platform: 'linux', homedir: HOME },
    );
    assert.ok(backend instanceof MemorySecretBackend);
    assert.equal(backend.kind, 'memory');
  });

  it('显式 dpapi → file 后端 DPAPI 模式(即使平台是 linux)', () => {
    const backend = createSecretBackend(
      { kind: 'dpapi', root: '/sec' },
      { platform: 'linux', homedir: HOME },
    );
    assert.equal(backend.kind, 'file');
    assert.equal(modeOf(backend), 'dpapi');
  });

  it('显式 file + mode 覆盖平台默认', () => {
    const backend = createSecretBackend(
      { kind: 'file', mode: 'aes-gcm' },
      { platform: 'win32', homedir: HOME },
    );
    assert.equal(modeOf(backend), 'aes-gcm');
  });

  it('显式 keyring:binary / timeoutMs / 索引根透传', () => {
    const backend = createSecretBackend(
      { kind: 'keyring', binary: '/opt/st', timeoutMs: 4321 },
      { platform: 'linux', homedir: HOME },
    );
    assert.ok(backend instanceof KeyringSecretBackend);
    assert.equal(backend.binary, '/opt/st');
    assert.equal(backend.timeoutMs, 4321);
    assert.ok(backend.indexRoot.includes('fake-home'));
  });

  it('未知 kind → UnknownSecretBackendKind(SECRET_BACKEND_UNKNOWN_KIND)', () => {
    assert.throws(
      // 故意越界:模拟配置写错 kind
      () => createSecretBackend(
        { kind: 'keepass' as never },
        { platform: 'linux', homedir: HOME },
      ),
      (err: unknown) =>
        err instanceof UnknownSecretBackendKind &&
        err.code === 'SECRET_BACKEND_UNKNOWN_KIND' &&
        err.kind === 'keepass',
    );
  });
});

describe('createSecretBackend:kind 缺省时平台探测', () => {
  it('win32 → file + dpapi', () => {
    const backend = createSecretBackend(undefined, {
      platform: 'win32',
      homedir: HOME,
    });
    assert.equal(backend.kind, 'file');
    assert.equal(modeOf(backend), 'dpapi');
  });

  it('linux → keyring(libsecret secret-tool)', () => {
    const backend = createSecretBackend(undefined, {
      platform: 'linux',
      homedir: HOME,
    });
    assert.ok(backend instanceof KeyringSecretBackend);
    assert.equal(backend.kind, 'keyring');
  });

  it('darwin / 其他 → file + aes-gcm 兜底', () => {
    for (const platformName of ['darwin', 'freebsd']) {
      const backend = createSecretBackend(undefined, {
        platform: platformName,
        homedir: HOME,
      });
      assert.equal(backend.kind, 'file', platformName);
      assert.equal(modeOf(backend), 'aes-gcm', platformName);
    }
  });

  it('env 缺省跟随真实平台(不注入时 = process.platform)', () => {
    const backend = createSecretBackend();
    if (process.platform === 'win32') {
      assert.equal(modeOf(backend), 'dpapi');
    } else if (process.platform === 'linux') {
      assert.equal(backend.kind, 'keyring');
    } else {
      assert.equal(modeOf(backend), 'aes-gcm');
    }
  });
});

describe('createSecretStore', () => {
  it('返回 SecretStore 门面,set/get 经选定后端往返', async () => {
    const store = createSecretStore(
      { kind: 'memory' },
      { platform: 'linux', homedir: HOME },
    );
    await store.set('acme', 'api-key', 'factory-value');
    assert.equal(await store.get('acme', 'api-key'), 'factory-value');
    const metas = await store.list('acme');
    assert.deepEqual(metas.map((m) => m.id), ['api-key']);
  });

  it('跨 tenant 访问仍被 store 层拒绝(工厂不削弱 §3.8 不变量)', async () => {
    const store = createSecretStore({ kind: 'memory' });
    await store.set('acme', 'k', 'v');
    await assert.rejects(
      store.getFromRef('other', { tenant: 'acme', id: 'k' }),
      (err: unknown) => err instanceof Error && err.name === 'CrossTenantAccess',
    );
  });
});
