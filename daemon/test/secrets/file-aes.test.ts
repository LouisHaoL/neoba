/**
 * FileSecretBackend(AES-256-GCM 路径)测试 —— 全平台跑。
 * 覆盖:往返 / 持久化 / tenant 隔离 / 原子写 / 明文不落盘 /
 * 损坏密文与损坏元数据的类型化错误 / 密钥文件。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  FileSecretBackend,
  SecretCorrupt,
  SecretNotFound,
} from '../../src/secrets/index.ts';

const roots: string[] = [];

async function makeBackend(
  overrides?: Partial<ConstructorParameters<typeof FileSecretBackend>[0]>,
): Promise<FileSecretBackend> {
  const root = await mkdtemp(join(tmpdir(), 'neoba-secrets-'));
  roots.push(root);
  return new FileSecretBackend({ root, mode: 'aes-gcm', ...overrides });
}

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const PLAINTEXT = 'ghp_super-secret-value-42';

describe('FileSecretBackend(aes-gcm)基本语义', () => {
  it('set/get 往返;list 只有元数据', async () => {
    const backend = await makeBackend();
    const meta = await backend.set('acme', 'api-key', PLAINTEXT, {
      description: 'desc',
    });
    assert.equal(meta.id, 'api-key');
    assert.equal(await backend.get('acme', 'api-key'), PLAINTEXT);

    const list = await backend.list('acme');
    assert.equal(list.length, 1);
    assert.ok(!('value' in list[0]!));
    assert.equal(JSON.stringify(list).includes(PLAINTEXT), false);
  });

  it('重复 set 保留 createdAt,更新 updatedAt', async () => {
    const backend = await makeBackend();
    const first = await backend.set('acme', 'k', 'v1');
    const second = await backend.set('acme', 'k', 'v2');
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(await backend.get('acme', 'k'), 'v2');
  });

  it('持久化:同 root 重开后可读(密钥文件复用)', async () => {
    const backend = await makeBackend();
    await backend.set('acme', 'k', PLAINTEXT);
    const reopened = await makeBackend({ root: backend.root });
    assert.equal(await reopened.get('acme', 'k'), PLAINTEXT);
  });

  it('get 不存在 → SecretNotFound;delete 语义', async () => {
    const backend = await makeBackend();
    await assert.rejects(backend.get('acme', 'missing'), SecretNotFound);
    await backend.set('acme', 'k', 'v');
    assert.equal(await backend.delete('acme', 'k'), true);
    assert.equal(await backend.delete('acme', 'k'), false);
    await assert.rejects(backend.get('acme', 'k'), SecretNotFound);
  });

  it('tenant 隔离:同 id 各桶独立;跨桶读 NotFound', async () => {
    const backend = await makeBackend();
    await backend.set('tenant-a', 'k', 'value-a');
    await backend.set('tenant-b', 'k', 'value-b');
    await backend.set('tenant-a', 'only-in-a', 'x');
    assert.equal(await backend.get('tenant-a', 'k'), 'value-a');
    assert.equal(await backend.get('tenant-b', 'k'), 'value-b');
    await assert.rejects(backend.get('tenant-b', 'only-in-a'), SecretNotFound);
    assert.equal(await backend.get('tenant-a', 'only-in-a'), 'x');
  });

  it('空 tenant 桶 list 返回空数组', async () => {
    const backend = await makeBackend();
    assert.deepEqual(await backend.list('ghost'), []);
  });
});

describe('FileSecretBackend(aes-gcm)落盘安全', () => {
  it('明文永不落盘:密文与元数据分离,两边都搜不到明文', async () => {
    const backend = await makeBackend();
    await backend.set('acme', 'api-key', PLAINTEXT, { description: 'd' });
    const tenantDir = join(backend.root, 'acme');
    const names = await readdir(tenantDir);
    assert.ok(names.includes('api-key.bin'));
    assert.ok(names.includes('api-key.meta.json'));

    const bin = await readFile(join(tenantDir, 'api-key.bin'), 'utf8');
    assert.match(bin, /^neoba-secret\/v1\|aes-gcm\|/);
    assert.equal(bin.includes(PLAINTEXT), false);
    const meta = await readFile(join(tenantDir, 'api-key.meta.json'), 'utf8');
    assert.equal(meta.includes(PLAINTEXT), false);
    assert.ok(!meta.includes('"value"'));
  });

  it('原子写:set 后无 .tmp 残留', async () => {
    const backend = await makeBackend();
    for (let i = 0; i < 5; i++) {
      await backend.set('acme', `k${i}`, `v${i}`);
      await backend.set('acme', 'k0', `over-${i}`);
    }
    const names = await readdir(join(backend.root, 'acme'));
    assert.equal(
      names.filter((n) => n.endsWith('.tmp')).length,
      0,
      `残留 tmp: ${names.join(',')}`,
    );
  });

  it('密钥文件:自动生成、32 字节、POSIX 上 0600', async () => {
    const backend = await makeBackend();
    await backend.set('acme', 'k', 'v'); // 触发生成
    const keyPath = join(backend.root, '.key');
    const key = await readFile(keyPath);
    assert.equal(key.length, 32);
    if (process.platform !== 'win32') {
      assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    }
  });

  it('损坏密文(GCM 认证失败)→ SecretCorrupt', async () => {
    const backend = await makeBackend();
    await backend.set('acme', 'k', PLAINTEXT);
    const binPath = join(backend.root, 'acme', 'k.bin');
    const original = await readFile(binPath, 'utf8');
    // 翻动 base64 体中间一个字符(保持合法 base64,破坏密文)
    const sep = original.lastIndexOf('|');
    const body = original.slice(sep + 1);
    const mid = Math.floor(body.length / 2);
    const flipped = (body[mid] === 'A' ? 'B' : 'A');
    const tampered = original.slice(0, sep + 1) +
      body.slice(0, mid) + flipped + body.slice(mid + 1);
    await writeFile(binPath, tampered, 'utf8');
    await assert.rejects(
      backend.get('acme', 'k'),
      (err: unknown) =>
        err instanceof SecretCorrupt && err.code === 'SECRET_CORRUPT',
    );
  });

  it('密文魔数损坏 → SecretCorrupt', async () => {
    const backend = await makeBackend();
    await backend.set('acme', 'k', 'v');
    const binPath = join(backend.root, 'acme', 'k.bin');
    await writeFile(binPath, 'not-an-envelope-at-all', 'utf8');
    await assert.rejects(backend.get('acme', 'k'), SecretCorrupt);
  });

  it('密钥文件丢失后被新实例重建 → 旧密文解不开 → SecretCorrupt(不静默返回错值)', async () => {
    const backend = await makeBackend();
    await backend.set('acme', 'k', PLAINTEXT);
    await rm(join(backend.root, '.key'));
    // 新实例(无内存密钥缓存)读不到 .key 会重建新密钥,旧密文认证失败。
    const fresh = await makeBackend({ root: backend.root });
    await assert.rejects(fresh.get('acme', 'k'), SecretCorrupt);
  });

  it('损坏元数据 → list 报 SecretCorrupt', async () => {
    const backend = await makeBackend();
    await backend.set('acme', 'k', 'v');
    await writeFile(
      join(backend.root, 'acme', 'k.meta.json'),
      '{broken json',
      'utf8',
    );
    await assert.rejects(backend.list('acme'), SecretCorrupt);
  });

  it('值只在 get 时出接口:set/list 均不回传明文', async () => {
    const backend = await makeBackend();
    const meta = await backend.set('acme', 'k', PLAINTEXT);
    assert.equal(JSON.stringify(meta).includes(PLAINTEXT), false);
    assert.equal(JSON.stringify(await backend.list('acme')).includes(PLAINTEXT), false);
    assert.equal(JSON.stringify(await backend.delete('acme', 'k')), 'true');
  });
});
