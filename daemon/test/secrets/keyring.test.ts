/**
 * KeyringSecretBackend 测试 —— 假 runner 全矩阵(不依赖真 keyring,
 * 任意平台跑;仿 dpapi.ts 的注入模式,binary/timeout/runner 全可注入)。
 * 覆盖:get/set/delete 往返、secret-tool 缺失、spawn 超时、非零退出、
 * 属性编码(含特殊字符的 tenant/id)、元数据索引(list)与校验前置。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  DEFAULT_KEYRING_TIMEOUT_MS,
  DEFAULT_SECRET_TOOL,
  KEYRING_SERVICE,
  KeyringSecretBackend,
  SecretBackendError,
  SecretBackendTimeout,
  SecretBackendUnavailable,
  SecretNotFound,
  defaultSecretToolRunner,
} from '../../src/secrets/index.ts';
import type { SecretToolRunner } from '../../src/secrets/index.ts';

const indexRoots: string[] = [];

async function makeIndexRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'neoba-keyring-idx-'));
  indexRoots.push(root);
  return root;
}

afterEach(async () => {
  while (indexRoots.length > 0) {
    await rm(indexRoots.pop()!, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ 假 keyring

/** 属性对解析:argv 序列 [k1, v1, k2, v2, ...](剥掉 --flag)→ 稳定键串。 */
function attrKey(args: readonly string[]): string {
  const attrs = args.filter((a) => !a.startsWith('--'));
  const parts: string[] = [];
  for (let i = 0; i < attrs.length; i += 2) {
    parts.push(`${attrs[i]}=${attrs[i + 1]}`);
  }
  return parts.join(' ');
}

interface FakeCall {
  binary: string;
  args: string[];
  input: string;
  timeoutMs: number;
}

/** 内存假 keyring:按属性键存值,记录全部调用供断言。 */
function makeFakeKeyring(overrides?: {
  code?: number;
  stderr?: string;
  throwOnce?: Error;
}): { runner: SecretToolRunner; calls: FakeCall[]; size(): number } {
  const store = new Map<string, string>();
  const calls: FakeCall[] = [];
  const runner: SecretToolRunner = async (binary, args, input, timeoutMs) => {
    calls.push({ binary, args: [...args], input, timeoutMs });
    if (overrides?.throwOnce !== undefined) {
      throw overrides.throwOnce;
    }
    if (overrides?.code !== undefined && overrides.code !== 0) {
      return { code: overrides.code, stdout: '', stderr: overrides.stderr ?? 'boom' };
    }
    const op = args[0]!;
    const key = attrKey(args.slice(1));
    if (op === 'store') {
      store.set(key, input);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (op === 'lookup') {
      const v = store.get(key);
      return { code: 0, stdout: v ?? '', stderr: '' };
    }
    if (op === 'clear') {
      store.delete(key);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 2, stdout: '', stderr: `unknown op ${op}` };
  };
  return { runner, calls, size: () => store.size };
}

async function makeBackend(
  fake: ReturnType<typeof makeFakeKeyring>,
  overrides?: { binary?: string; timeoutMs?: number },
): Promise<KeyringSecretBackend> {
  return new KeyringSecretBackend({
    runner: fake.runner,
    indexRoot: await makeIndexRoot(),
    ...overrides,
  });
}

// ------------------------------------------------------------ 后端全矩阵

describe('KeyringSecretBackend(假 runner)', () => {
  it('set/get 往返;值经 stdin 不落命令行;属性为 service/tenant/id 三对', async () => {
    const fake = makeFakeKeyring();
    const backend = await makeBackend(fake);
    await backend.set('acme', 'api-key', 'ring-plaintext-value', {
      description: '用于 CI 拉取',
    });
    assert.equal(await backend.get('acme', 'api-key'), 'ring-plaintext-value');

    // 属性编码:service=neoba + tenant/id 原样成对出现
    const store = fake.calls.find((c) => c.args[0] === 'store')!;
    assert.equal(store.binary, DEFAULT_SECRET_TOOL);
    assert.deepEqual(store.args.slice(1), [
      '--label=neoba:acme/api-key',
      'service', KEYRING_SERVICE,
      'tenant', 'acme',
      'id', 'api-key',
    ]);
    // 值只经 stdin
    assert.equal(store.input, 'ring-plaintext-value');
    assert.ok(!store.args.some((a) => a.includes('ring-plaintext-value')));
  });

  it('get 不存在 → SecretNotFound;delete 不存在 → false', async () => {
    const fake = makeFakeKeyring();
    const backend = await makeBackend(fake);
    await assert.rejects(backend.get('acme', 'missing'), SecretNotFound);
    assert.equal(await backend.delete('acme', 'missing'), false);
  });

  it('delete 成功 → true 且 keyring 与索引都清掉', async () => {
    const fake = makeFakeKeyring();
    const backend = await makeBackend(fake);
    await backend.set('acme', 'k', 'v');
    assert.equal(await backend.delete('acme', 'k'), true);
    await assert.rejects(backend.get('acme', 'k'), SecretNotFound);
    assert.deepEqual(await backend.list('acme'), []);
  });

  it('secret-tool 非零退出 → SecretBackendError(set/get/delete 三路)', async () => {
    for (const op of ['set', 'get', 'delete'] as const) {
      const fake = makeFakeKeyring({ code: 1, stderr: 'No such secret' });
      const backend = await makeBackend(fake);
      const action =
        op === 'set'
          ? backend.set('acme', 'k', 'v')
          : op === 'get'
            ? backend.get('acme', 'k')
            : backend.delete('acme', 'k');
      await assert.rejects(action, (err: unknown) =>
        err instanceof SecretBackendError &&
        err.code === 'SECRET_BACKEND_ERROR');
    }
  });

  it('runner 抛 SecretBackendUnavailable(secret-tool 缺失)→ 原样传播,不静默降级', async () => {
    const unavailable = new SecretBackendUnavailable('未找到 secret-tool');
    const fake = makeFakeKeyring({ throwOnce: unavailable });
    const backend = await makeBackend(fake);
    await assert.rejects(backend.set('acme', 'k', 'v'), (err: unknown) => {
      assert.ok(err instanceof SecretBackendUnavailable);
      assert.equal(err.code, 'SECRET_BACKEND_UNAVAILABLE');
      return true;
    });
  });

  it('属性编码:含特殊字符的 tenant/id 原样成对传递并正确往返', async () => {
    const fake = makeFakeKeyring();
    const backend = await makeBackend(fake);
    const tenant = 'Acme.Corp-01_x';
    const id = 'api-key_v2.prod';
    await backend.set(tenant, id, 'special-value');
    assert.equal(await backend.get(tenant, id), 'special-value');
    const store = fake.calls.find((c) => c.args[0] === 'store')!;
    assert.deepEqual(store.args.slice(-4), [
      'tenant', tenant,
      'id', id,
    ]);
    // 不同 (tenant, id) 不串桶
    await assert.rejects(backend.get('acme', id), SecretNotFound);
    await assert.rejects(backend.get(tenant, 'other-key'), SecretNotFound);
  });

  it('非法 tenant/id 在触碰 runner 之前被拒(不给探测通道)', async () => {
    const fake = makeFakeKeyring();
    const backend = await makeBackend(fake);
    await assert.rejects(backend.set('../evil', 'k', 'v'), (err: unknown) =>
      err instanceof Error && err.name === 'InvalidTenant');
    await assert.rejects(backend.get('acme', 'UPPER'), (err: unknown) =>
      err instanceof Error && err.name === 'InvalidSecretId');
    assert.equal(fake.calls.length, 0);
  });

  it('空凭据值显式拒绝(lookup 协议上空值与不存在不可区分)', async () => {
    const fake = makeFakeKeyring();
    const backend = await makeBackend(fake);
    await assert.rejects(backend.set('acme', 'k', ''), SecretBackendError);
    assert.equal(fake.calls.length, 0);
  });

  it('list 出元数据(id/description/时间戳),永不包含值', async () => {
    const fake = makeFakeKeyring();
    const backend = await makeBackend(fake);
    await backend.set('acme', 'b-key', 'secret-b', { description: 'B' });
    await backend.set('acme', 'a-key', 'secret-a');
    const metas = await backend.list('acme');
    assert.deepEqual(metas.map((m) => m.id), ['a-key', 'b-key']);
    assert.equal(metas[0]!.description, null);
    assert.equal(metas[1]!.description, 'B');
    assert.match(metas[0]!.createdAt, /^\d{4}-/);
    assert.ok(!JSON.stringify(metas).includes('secret-'));
  });

  it('set 覆盖:保留首次 description 与 createdAt,刷新 updatedAt', async () => {
    const fake = makeFakeKeyring();
    const backend = await makeBackend(fake);
    const first = await backend.set('acme', 'k', 'v1', { description: 'd1' });
    const second = await backend.set('acme', 'k', 'v2');
    assert.equal(second.description, 'd1');
    assert.equal(second.createdAt, first.createdAt);
    const metas = await backend.list('acme');
    assert.equal(metas.length, 1);
    assert.equal(await backend.get('acme', 'k'), 'v2');
  });

  it('binary / timeoutMs 可注入并透传给 runner', async () => {
    const fake = makeFakeKeyring();
    const backend = await makeBackend(fake, {
      binary: '/usr/local/bin/secret-tool',
      timeoutMs: 1234,
    });
    await backend.set('acme', 'k', 'v');
    assert.equal(fake.calls[0]!.binary, '/usr/local/bin/secret-tool');
    assert.equal(fake.calls[0]!.timeoutMs, 1234);
  });
});

// ------------------------------------------------------------ 默认执行器

describe('defaultSecretToolRunner(真 spawn,跨平台)', () => {
  it('正常执行:收集 stdout/stderr 与退出码', async () => {
    const r = await defaultSecretToolRunner(
      process.execPath,
      ['-e', 'process.stdout.write("ok-out");process.stderr.write("e")'],
      '',
      10_000,
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'ok-out');
    assert.ok(r.stderr.includes('e'));
  });

  it('stdin 送值', async () => {
    const r = await defaultSecretToolRunner(
      process.execPath,
      ['-e', 'process.stdin.on("data", (d) => process.stdout.write(d))'],
      'stdin-payload',
      10_000,
    );
    assert.equal(r.stdout, 'stdin-payload');
  });

  it('非零退出:原样返回退出码与 stderr(由后端类型化为 SecretBackendError)', async () => {
    const r = await defaultSecretToolRunner(
      process.execPath,
      ['-e', 'process.stderr.write("boom");process.exit(3)'],
      '',
      10_000,
    );
    assert.equal(r.code, 3);
    assert.ok(r.stderr.includes('boom'));
  });

  it('spawn 超时 → SecretBackendTimeout(50ms 远小于休眠时长)', async () => {
    await assert.rejects(
      defaultSecretToolRunner(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 60_000)'],
        '',
        50,
      ),
      (err: unknown) =>
        err instanceof SecretBackendTimeout &&
        err.code === 'SECRET_BACKEND_TIMEOUT' &&
        err.timeoutMs === 50,
    );
  });

  it('secret-tool 缺失(ENOENT)→ SecretBackendUnavailable,不静默降级', async () => {
    await assert.rejects(
      defaultSecretToolRunner('definitely-not-secret-tool-xyz', ['lookup'], '', 10_000),
      (err: unknown) =>
        err instanceof SecretBackendUnavailable &&
        err.code === 'SECRET_BACKEND_UNAVAILABLE' &&
        err.detail.includes('definitely-not-secret-tool-xyz'),
    );
  });

  it('默认超时与默认二进制常量', () => {
    assert.equal(DEFAULT_SECRET_TOOL, 'secret-tool');
    assert.equal(DEFAULT_KEYRING_TIMEOUT_MS, 10_000);
  });
});
