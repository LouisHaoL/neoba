/**
 * FileSecretBackend(DPAPI 路径)测试 —— 仅 win32 跑(真 DPAPI 子进程),
 * 其余平台整组跳过。
 * 覆盖:真实 DPAPI 往返 / 持久化 / 损坏密文类型化错误 /
 * powershell 子进程错误传播与超时。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  FileSecretBackend,
  SecretBackendError,
  SecretBackendTimeout,
  SecretCorrupt,
  SecretNotFound,
} from '../../src/secrets/index.ts';

const roots: string[] = [];

async function makeBackend(
  overrides?: Partial<ConstructorParameters<typeof FileSecretBackend>[0]>,
): Promise<FileSecretBackend> {
  const root = await mkdtemp(join(tmpdir(), 'neoba-secrets-dpapi-'));
  roots.push(root);
  return new FileSecretBackend({ root, mode: 'dpapi', ...overrides });
}

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const WIN32_ONLY = { skip: process.platform !== 'win32' && '仅 win32 跑' };

describe('FileSecretBackend(dpapi)真实 DPAPI 往返', WIN32_ONLY, () => {
  it('set/get 往返(CurrentUser 作用域)', async () => {
    const backend = await makeBackend();
    await backend.set('acme', 'api-key', 'dpapi-plaintext-value', {
      description: 'd',
    });
    assert.equal(await backend.get('acme', 'api-key'), 'dpapi-plaintext-value');
    assert.equal(
      JSON.stringify(await backend.list('acme')).includes('dpapi-plaintext-value'),
      false,
    );
  });

  it('持久化:同 root 重开可解(密钥由 Windows 按用户管理,不落盘)', async () => {
    const backend = await makeBackend();
    await backend.set('acme', 'k', 'roundtrip-v2');
    const reopened = await makeBackend({ root: backend.root });
    assert.equal(await reopened.get('acme', 'k'), 'roundtrip-v2');
  });

  it('信封魔数为 dpapi;root 下没有 .key 文件(DPAPI 不落盘密钥)', async () => {
    const backend = await makeBackend();
    await backend.set('acme', 'k', 'v');
    const bin = await readFile(join(backend.root, 'acme', 'k.bin'), 'utf8');
    assert.match(bin, /^neoba-secret\/v1\|dpapi\|/);
    await assert.rejects(readFile(join(backend.root, '.key'), 'utf8'));
  });

  it('get 不存在 → SecretNotFound;delete 后再读 NotFound', async () => {
    const backend = await makeBackend();
    await assert.rejects(backend.get('acme', 'missing'), SecretNotFound);
    await backend.set('acme', 'k', 'v');
    assert.equal(await backend.delete('acme', 'k'), true);
    await assert.rejects(backend.get('acme', 'k'), SecretNotFound);
  });

  it('损坏密文 → DPAPI 解密失败类型化为 SecretCorrupt', async () => {
    const backend = await makeBackend();
    await backend.set('acme', 'k', 'v');
    const binPath = join(backend.root, 'acme', 'k.bin');
    const original = await readFile(binPath, 'utf8');
    const sep = original.lastIndexOf('|');
    const body = original.slice(sep + 1);
    const mid = Math.floor(body.length / 2);
    const flipped = body[mid] === 'A' ? 'B' : 'A';
    await writeFile(
      binPath,
      original.slice(0, sep + 1) + body.slice(0, mid) + flipped + body.slice(mid + 1),
      'utf8',
    );
    await assert.rejects(
      backend.get('acme', 'k'),
      (err: unknown) =>
        err instanceof SecretCorrupt && err.code === 'SECRET_CORRUPT',
    );
  });

  it('powershell 启动失败 → SecretBackendError(错误传播)', async () => {
    const backend = await makeBackend({
      powershellPath: 'definitely-not-a-real-powershell.exe',
    });
    await assert.rejects(
      backend.set('acme', 'k', 'v'),
      (err: unknown) =>
        err instanceof SecretBackendError &&
        err.code === 'SECRET_BACKEND_ERROR' &&
        !(err instanceof SecretBackendTimeout),
    );
  });

  it('powershell 非零退出(cmd.exe 冒充)→ SecretBackendError', async () => {
    const backend = await makeBackend({ powershellPath: 'cmd.exe' });
    await assert.rejects(backend.set('acme', 'k', 'v'), SecretBackendError);
  });

  it('子进程超时 → SecretBackendTimeout(50ms 远小于 powershell 启动耗时)', async () => {
    const backend = await makeBackend({ timeoutMs: 50 });
    await assert.rejects(
      backend.set('acme', 'k', 'v'),
      (err: unknown) =>
        err instanceof SecretBackendTimeout && err.code === 'SECRET_BACKEND_TIMEOUT',
    );
  });
});
