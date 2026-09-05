/**
 * Provider 工厂测试(M7):createProvider 决策表 —— 配置缺省/未知值显式拒绝、
 * 三后端实例化、sandbox 小节读取的宽松缺省。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DockerProvider,
  KNOWN_PROVIDERS,
  MemoryProvider,
  MicrosandboxProvider,
  ProviderUnknownError,
  createProvider,
  readSandboxConfig,
} from '../../src/provision/index.ts';
import type { NeobaConfig } from '../../src/doctor/config.ts';

describe('provision/factory(createProvider 决策表)', () => {
  it('配置缺省(无 sandbox 小节)→ memory(现行为零漂移)', () => {
    const p = createProvider({});
    assert.ok(p instanceof MemoryProvider);
    assert.equal(p.backend, 'memory');
  });

  it('sandbox.provider 显式 memory / docker / microsandbox → 对应后端', () => {
    assert.ok(createProvider({ sandbox: { provider: 'memory' } }) instanceof MemoryProvider);
    assert.ok(createProvider({ sandbox: { provider: 'docker' } }) instanceof DockerProvider);
    assert.ok(
      createProvider({ sandbox: { provider: 'microsandbox' } }) instanceof MicrosandboxProvider,
    );
  });

  it('microsandbox:binary 显式给出 → 按其构造 runner;msbRunner 注入优先', async () => {
    const injected = createProvider({
      sandbox: { provider: 'microsandbox', binary: '/opt/msb' },
    }, { msbRunner: async () => ({ code: 0, stdout: '', stderr: '' }) });
    assert.ok(injected instanceof MicrosandboxProvider);
    // 不注入 msbRunner 时,binary 路径进入 runner 的 spawn 目标(经一次 spawn 失败观察)
    const p = createProvider({ sandbox: { provider: 'microsandbox', binary: 'neoba-definitely-not-msb' } });
    await assert.rejects(
      (p as MicrosandboxProvider).runner(['--version']),
      (err: unknown) => err instanceof Error && /neoba-definitely-not-msb|ENOENT|spawn/i.test(err.message),
    );
  });

  it('未知后端名 → ProviderUnknownError(显式拒绝,不静默降级)', () => {
    assert.throws(
      () => createProvider({ sandbox: { provider: 'lxc' } }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderUnknownError);
        assert.equal(err.code, 'provider_unknown');
        assert.equal(err.requested, 'lxc');
        assert.deepEqual([...err.known], [...KNOWN_PROVIDERS]);
        return true;
      },
    );
  });

  it('snapshotCapable 能力位:仅 microsandbox 声明', () => {
    assert.equal(createProvider({ sandbox: { provider: 'memory' } }).snapshotCapable, undefined);
    assert.equal(createProvider({ sandbox: { provider: 'docker' } }).snapshotCapable, undefined);
    assert.equal(createProvider({ sandbox: { provider: 'microsandbox' } }).snapshotCapable, true);
  });

  it('readSandboxConfig:小节缺失 / 非对象 → undefined;对象原样收窄', () => {
    assert.equal(readSandboxConfig(undefined), undefined);
    assert.equal(readSandboxConfig({ sandbox: 'nope' as unknown as NeobaConfig['sandbox'] }), undefined);
    const section = readSandboxConfig({ sandbox: { provider: 'docker', image: 'img:1' } });
    assert.equal(section?.provider, 'docker');
    assert.equal(section?.image, 'img:1');
  });
});
