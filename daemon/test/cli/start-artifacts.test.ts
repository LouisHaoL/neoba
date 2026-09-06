/**
 * #6 CLI start 外部编排文档装载:
 * - resolveConfiguredStartArtifacts:flag > config > 缺省的优先级、config 相对
 *   路径相对 config 文件目录解析、装载失败(文件不存在 / preset schema 不合 /
 *   registry 校验不过 / models 非法 / config 字段类型不对)一律类型化
 *   StartArtifactLoadError 不静默降级;
 * - 装载器与 workflow check 同源(loadPresetsFromDirs / loadCapabilityRegistryFile
 *   / loadModelsFile),防止 #5 式两处解析口径分叉;
 * - defaultDeps().startDaemon 装配层:presetsPath 透传 → workflow.run 引用
 *   外部 preset 真跑通;runCli(['start', ...]) 装载失败退出码 1。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runCli } from '../../src/cli/main.ts';
import { defaultDeps, resolveConfiguredStartArtifacts, StartArtifactLoadError } from '../../src/cli/deps.ts';
import type { CliIo } from '../../src/cli/types.ts';
import { minimalPresetDoc } from '../../src/capability/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `neoba-start-${prefix}-`));
  roots.push(dir);
  return dir;
}

interface TestIo extends CliIo {
  outLines: string[];
  errLines: string[];
}

function makeIo(): TestIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    out: (t) => outLines.push(t),
    err: (t) => errLines.push(t),
    outLines,
    errLines,
  };
}

// ---------------------------------------------------------------- 测试夹具

const REGISTRY_DOC = {
  protocol: '1.0',
  spec_version: '1.0',
  capabilities: [
    {
      id: 'fs:workdir',
      kind: 'fs_path',
      description: '任务工作目录',
      risk_level: 'low',
      grantable_scopes: ['ro', 'rw'],
      path_template: '${task.workdir}',
    },
  ],
};

const MODELS_DOC = {
  api: 'modelscore/1.0',
  models: [
    {
      protocol: '1.0',
      spec_version: '1.0',
      model: 'glm-4.7-air',
      tier_fit: { fast: 0.9, standard: 0.6, heavy: 0.2 },
      score: {
        prior: { fast: 0.8, standard: 0.5, heavy: 0.2 },
        observed: { fast: null, standard: null, heavy: null },
        samples: { fast: 0, standard: 0, heavy: 0 },
        dimensions: { quality: 0.8, success_rate: 0.8, cost_efficiency: 0.7 },
      },
      updated_at: '2026-09-06T00:00:00Z',
    },
  ],
};

async function writePresetsDir(prefix: string, presetName = 'ae-rpa'): Promise<string> {
  const dir = join(await tmp(prefix), 'presets');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'ae-rpa.json'), JSON.stringify(minimalPresetDoc({ name: presetName })), 'utf8');
  return dir;
}

async function writeRegistry(prefix: string, body: unknown = REGISTRY_DOC): Promise<string> {
  const file = join(await tmp(`${prefix}-reg`), 'capabilities.json');
  await writeFile(file, JSON.stringify(body), 'utf8');
  return file;
}

async function writeModels(prefix: string, body: unknown = MODELS_DOC): Promise<string> {
  const file = join(await tmp(`${prefix}-models`), 'modelscore.json');
  await writeFile(file, JSON.stringify(body), 'utf8');
  return file;
}

async function writeConfig(dir: string, body: unknown): Promise<string> {
  const file = join(dir, 'neoba.config.json');
  await writeFile(file, JSON.stringify(body), 'utf8');
  return file;
}

// ---------------------------------------------------------------- 解析层

describe('cli/deps resolveConfiguredStartArtifacts(#6 同源装载)', () => {
  it('三路全缺省 → 空结果:startDaemon 走内置缺省(零漂移)', async () => {
    const cwd = await tmp('default');
    const resolved = await resolveConfiguredStartArtifacts({}, { cwd, homedir: await tmp('home-empty') });
    assert.deepEqual(resolved, {});
  });

  it('--presets 目录 → 外部 preset 装入(与 workflow check 同源 loadPresetsFromDirs)', async () => {
    const dir = await writePresetsDir('ok');
    const resolved = await resolveConfiguredStartArtifacts({ presets: dir }, { cwd: await tmp('cwd') });
    assert.ok(resolved.presets !== undefined);
    assert.ok(resolved.presets['ae-rpa'] !== undefined);
    assert.equal(resolved.registry, undefined);
    assert.equal(resolved.models, undefined);
  });

  it('preset schema 不合 → StartArtifactLoadError(kind=presets),不静默降级', async () => {
    const dir = join(await tmp('bad-preset'), 'presets');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'broken.json'), JSON.stringify({ api: 'preset/1.0', name: '' }), 'utf8');
    await assert.rejects(
      resolveConfiguredStartArtifacts({ presets: dir }, { cwd: await tmp('cwd') }),
      (err: unknown) => err instanceof StartArtifactLoadError && err.kind === 'presets',
    );
  });

  it('预设目录不存在 → StartArtifactLoadError(kind=presets)', async () => {
    const missing = join(await tmp('missing'), 'no-such-dir');
    await assert.rejects(
      resolveConfiguredStartArtifacts({ presets: missing }, { cwd: await tmp('cwd') }),
      (err: unknown) => err instanceof StartArtifactLoadError && err.kind === 'presets',
    );
  });

  it('registry 合法 → get 命中;校验不过 → StartArtifactLoadError(kind=registry)', async () => {
    const file = await writeRegistry('reg-ok');
    const resolved = await resolveConfiguredStartArtifacts({ registry: file }, { cwd: await tmp('cwd') });
    assert.ok(resolved.registry?.get('fs:workdir') !== undefined);

    const bad = await writeRegistry('reg-bad', { protocol: '1.0', capabilities: [{ id: 'x' }] });
    await assert.rejects(
      resolveConfiguredStartArtifacts({ registry: bad }, { cwd: await tmp('cwd') }),
      (err: unknown) => err instanceof StartArtifactLoadError && err.kind === 'registry',
    );
  });

  it('models 文件不存在 / 内容非法 → StartArtifactLoadError(kind=models);合法 → 条目装载', async () => {
    const missing = join(await tmp('models-missing'), 'nope.json');
    await assert.rejects(
      resolveConfiguredStartArtifacts({ models: missing }, { cwd: await tmp('cwd') }),
      (err: unknown) => err instanceof StartArtifactLoadError && err.kind === 'models',
    );
    const bad = join(await tmp('models-bad'), 'modelscore.json');
    await writeFile(bad, '{ not json', 'utf8');
    await assert.rejects(
      resolveConfiguredStartArtifacts({ models: bad }, { cwd: await tmp('cwd') }),
      (err: unknown) => err instanceof StartArtifactLoadError && err.kind === 'models',
    );
    const ok = await writeModels('models-ok');
    const resolved = await resolveConfiguredStartArtifacts({ models: ok }, { cwd: await tmp('cwd') });
    assert.ok(resolved.models?.get('glm-4.7-air') !== undefined);
  });

  it('config 字段生效;相对路径相对 config 文件所在目录解析', async () => {
    const cwd = await tmp('cfg');
    const extPresets = join(cwd, 'ext', 'presets');
    await mkdir(extPresets, { recursive: true });
    await writeFile(join(extPresets, 'ae-rpa.json'), JSON.stringify(minimalPresetDoc({ name: 'ae-rpa' })), 'utf8');
    // config 在 cwd/sub/ 下,presets 写相对路径 ../ext/presets
    const sub = join(cwd, 'sub');
    await mkdir(sub, { recursive: true });
    await writeConfig(sub, { presets: '../ext/presets', registry: '../ext/capabilities.json' });
    await writeFile(join(cwd, 'ext', 'capabilities.json'), JSON.stringify(REGISTRY_DOC), 'utf8');

    const resolved = await resolveConfiguredStartArtifacts({}, { cwd: sub, homedir: await tmp('home-empty') });
    assert.ok(resolved.presets?.['ae-rpa'] !== undefined);
    assert.ok(resolved.registry?.get('fs:workdir') !== undefined);
  });

  it('flag 覆盖 config(config 指坏文件、flag 指好文件 → 用 flag,不抛)', async () => {
    const cwd = await tmp('override');
    const badReg = join(cwd, 'bad-capabilities.json');
    await writeFile(badReg, '{ not json', 'utf8');
    await writeConfig(cwd, { registry: badReg, presets: join(cwd, 'no-such-dir') });
    const goodReg = await writeRegistry('override-reg');
    const goodPresets = await writePresetsDir('override-presets');

    const resolved = await resolveConfiguredStartArtifacts(
      { presets: goodPresets, registry: goodReg },
      { cwd, homedir: await tmp('home-empty') },
    );
    assert.ok(resolved.presets?.['ae-rpa'] !== undefined);
    assert.ok(resolved.registry?.get('fs:workdir') !== undefined);
  });

  it('config 字段类型不对(非字符串)→ StartArtifactLoadError 显式拒绝', async () => {
    const cwd = await tmp('cfg-badtype');
    await writeConfig(cwd, { presets: 42 });
    await assert.rejects(
      resolveConfiguredStartArtifacts({}, { cwd, homedir: await tmp('home-empty') }),
      (err: unknown) => err instanceof StartArtifactLoadError && err.kind === 'presets',
    );
  });
});

// ---------------------------------------------------------------- 装配层

describe('cli/deps startDaemon 装配(#6 外部 preset 常驻可用)', () => {
  it('presetsPath/registryPath/modelsPath 透传 → workflow.run 引用外部 preset 跑通', async () => {
    const stateDir = await tmp('asm-state');
    const presetsDir = await writePresetsDir('asm');
    const registryFile = await writeRegistry('asm');
    const modelsFile = await writeModels('asm');

    const deps = await defaultDeps();
    const handle = (await deps.startDaemon({
      port: 0,
      stateDir,
      presetsPath: presetsDir,
      registryPath: registryFile,
      modelsPath: modelsFile,
    })) as DaemonHandle;
    roots.push(stateDir);
    try {
      const body = await rpc(handle, 'workflow.run', {
        workflow: {
          api: 'workflow/1.0',
          intent_ref: 'i-1',
          nodes: [{ id: 'n1', preset: 'ae-rpa' }],
          outputs: [],
          feedback: [],
          evidence: [],
        },
      });
      const taskId = (body['result'] as Record<string, unknown>)['task_id'] as string;
      assert.ok(taskId?.startsWith('task-'));

      const done = await waitFor(async () => {
        const status = await rpc(handle, 'task.status', { task_id: taskId });
        const task = ((status['result'] as Record<string, unknown>)?.['task'] ?? {}) as Record<string, unknown>;
        return task['status'] === 'completed' || task['status'] === 'failed' ? String(task['status']) : null;
      }, '任务到终态');
      assert.equal(done, 'completed');
    } finally {
      await handle.stop().catch(() => {});
    }
  });

  it('runCli start --presets 坏目录 → 类型化报错,退出码 1(非 0,不静默)', async () => {
    const stateDir = await tmp('fail-state');
    const badDir = join(await tmp('fail'), 'no-such-presets');
    const io: TestIo = makeIo();
    const code = await runCli(
      ['start', '--state-dir', stateDir, '--port', '0', '--presets', badDir],
      io,
      await defaultDeps(),
    );
    assert.equal(code, 1);
    assert.ok(io.errLines.join('\n').includes('start 装载失败(presets)'));
  });
});

// ---------------------------------------------------------------- 复用 p2 的 rpc/waitFor 小工具

async function rpc(handle: DaemonHandle, method: string, params: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${handle.baseUrl}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${handle.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function waitFor(
  predicate: () => Promise<string | null>,
  what: string,
): Promise<string> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const hit = await predicate();
    if (hit !== null) return hit;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
