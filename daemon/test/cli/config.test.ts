/**
 * cli/config.ts 测试(M6 遗留补测 + M7 接线):
 * - loadNeobaConfig(Detailed):项目级 → 用户级查找顺序、宽松缺省
 *   (不存在 / 损坏 JSON / 非 object 一律回退不抛);
 * - readSecretsConfig:缺省 / 非对象 → undefined;
 * - resolveConfiguredSandbox:配置缺省 → undefined(现行为零漂移);
 *   sandbox 小节 → provider 实例化;pool/image 字段装配;未知 provider 抛错。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  PROJECT_CONFIG_FILE,
  loadNeobaConfig,
  loadNeobaConfigDetailed,
  readSecretsConfig,
} from '../../src/cli/config.ts';
import { resolveConfiguredSandbox } from '../../src/cli/deps.ts';
import { ProviderUnknownError } from '../../src/provision/index.ts';
import { WarmPool } from '../../src/provision/warm-pool.ts';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `neoba-cli-cfg-${prefix}-`));
  roots.push(dir);
  return dir;
}

/** 用户级配置落点(<root>/.neoba/config.json)。 */
async function makeHome(prefix: string, body?: string): Promise<string> {
  const home = await makeTmp(prefix);
  if (body !== undefined) {
    await mkdir(join(home, '.neoba'), { recursive: true });
    await writeFile(join(home, '.neoba', 'config.json'), body, 'utf8');
  }
  return home;
}

describe('cli/config(loadNeobaConfig 查找与宽松缺省)', () => {
  it('项目级配置存在 → 命中 <cwd>/neoba.config.json,内容原样返回', async () => {
    const cwd = await makeTmp('proj');
    await writeFile(
      join(cwd, PROJECT_CONFIG_FILE),
      JSON.stringify({ sandbox: { provider: 'docker' } }),
      'utf8',
    );
    const home = await makeHome('home-empty');
    const loaded = await loadNeobaConfigDetailed({ cwd, homedir: home });
    assert.equal(loaded.path, join(cwd, PROJECT_CONFIG_FILE));
    assert.deepEqual(loaded.config, { sandbox: { provider: 'docker' } });
  });

  it('项目级缺失、用户级存在 → 回落 ~/.neoba/config.json', async () => {
    const cwd = await makeTmp('proj');
    const home = await makeHome('home', JSON.stringify({ secrets: { kind: 'keyring' } }));
    const loaded = await loadNeobaConfigDetailed({ cwd, homedir: home });
    assert.equal(loaded.path, join(home, '.neoba', 'config.json'));
    assert.deepEqual(loaded.config, { secrets: { kind: 'keyring' } });
  });

  it('两处都缺失 → 空配置 + path=null(不抛)', async () => {
    const cwd = await makeTmp('proj');
    const home = await makeHome('home-empty');
    const loaded = await loadNeobaConfigDetailed({ cwd, homedir: home });
    assert.equal(loaded.path, null);
    assert.deepEqual(loaded.config, {});
  });

  it('损坏 JSON / 顶层非 object → 一律宽松回退(不抛,继续往下找)', async () => {
    const cwd = await makeTmp('proj');
    await writeFile(join(cwd, PROJECT_CONFIG_FILE), '{ not json', 'utf8');
    const home = await makeHome('home-bad', '"just a string"');
    const loaded = await loadNeobaConfigDetailed({ cwd, homedir: home });
    assert.equal(loaded.path, null);
    assert.deepEqual(loaded.config, {});
    // loadNeobaConfig 宽松入口同形
    assert.deepEqual(await loadNeobaConfig({ cwd, homedir: home }), {});
  });

  it('readSecretsConfig:缺省 / 非对象 → undefined;对象原样透传', () => {
    assert.equal(readSecretsConfig(undefined), undefined);
    assert.equal(readSecretsConfig({}), undefined);
    assert.equal(
      readSecretsConfig({ secrets: 'keyring' } as never),
      undefined,
    );
    const section = { kind: 'keyring' };
    assert.equal(readSecretsConfig({ secrets: section }), section);
  });
});

describe('cli/deps(resolveConfiguredSandbox 生产接线)', () => {
  it('配置缺省(无 sandbox 小节)→ undefined:startDaemon 保持现行为', async () => {
    const cwd = await makeTmp('default');
    const home = await makeHome('home-empty');
    assert.equal(await resolveConfiguredSandbox({ cwd, homedir: home }), undefined);
  });

  it('sandbox.provider=docker → provider 实例化;无 pool 小节不建池;无 image 不注入', async () => {
    const cwd = await makeTmp('docker');
    await writeFile(
      join(cwd, PROJECT_CONFIG_FILE),
      JSON.stringify({ sandbox: { provider: 'docker' } }),
      'utf8',
    );
    const resolved = await resolveConfiguredSandbox({
      cwd,
      homedir: await makeHome('home-empty'),
    });
    assert.ok(resolved !== undefined);
    assert.equal(resolved.provider.backend, 'docker');
    assert.equal(resolved.pool, undefined);
    assert.equal(resolved.image, undefined);
  });

  it('provider 缺省但小节存在 → 工厂按缺省 memory 实例化(不是 undefined)', async () => {
    const cwd = await makeTmp('bare');
    await writeFile(
      join(cwd, PROJECT_CONFIG_FILE),
      JSON.stringify({ sandbox: { pool: { capacity: 3 } } }),
      'utf8',
    );
    const resolved = await resolveConfiguredSandbox({
      cwd,
      homedir: await makeHome('home-empty'),
    });
    assert.ok(resolved !== undefined);
    assert.equal(resolved.provider.backend, 'memory');
    assert.equal(resolved.image, undefined);
  });

  it('sandbox.pool 小节 → 建 WarmPool;slots>0 时同挂 ResourceGate;capacity 透传', async () => {
    const cwd = await makeTmp('pool');
    await writeFile(
      join(cwd, PROJECT_CONFIG_FILE),
      JSON.stringify({
        sandbox: { provider: 'microsandbox', pool: { slots: 4, capacity: 2 } },
      }),
      'utf8',
    );
    const resolved = await resolveConfiguredSandbox({
      cwd,
      homedir: await makeHome('home-empty'),
    });
    assert.ok(resolved?.pool instanceof WarmPool);
    const pool = resolved.pool as WarmPool;
    assert.equal(pool.capacity, 2);
  });

  it('pool.slots 非法(0/负数/非数字)→ 不建闸门但仍建池', async () => {
    const cwd = await makeTmp('pool-bad');
    await writeFile(
      join(cwd, PROJECT_CONFIG_FILE),
      JSON.stringify({ sandbox: { pool: { slots: 0, capacity: 1 } } }),
      'utf8',
    );
    const resolved = await resolveConfiguredSandbox({
      cwd,
      homedir: await makeHome('home-empty'),
    });
    assert.ok(resolved?.pool instanceof WarmPool);
  });

  it('sandbox.image 显式给出 → 原样透传给引擎注入', async () => {
    const cwd = await makeTmp('image');
    await writeFile(
      join(cwd, PROJECT_CONFIG_FILE),
      JSON.stringify({ sandbox: { image: 'neoba/worker:v2' } }),
      'utf8',
    );
    const resolved = await resolveConfiguredSandbox({
      cwd,
      homedir: await makeHome('home-empty'),
    });
    assert.equal(resolved?.image, 'neoba/worker:v2');
  });

  it('未知 provider 名 → ProviderUnknownError 显式拒绝,不静默降级', async () => {
    const cwd = await makeTmp('unknown');
    await writeFile(
      join(cwd, PROJECT_CONFIG_FILE),
      JSON.stringify({ sandbox: { provider: 'lxc' } }),
      'utf8',
    );
    await assert.rejects(
      resolveConfiguredSandbox({ cwd, homedir: await makeHome('home-empty') }),
      ProviderUnknownError,
    );
  });
});
