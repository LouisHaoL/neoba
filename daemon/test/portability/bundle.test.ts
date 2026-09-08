/**
 * portability 单元测试(§3.5g):三档导出内容差异、README 必备章节、
 * 铁律擦除(凭据键 → 占位 + 引用记录)、预设 JSON 往返(导出的 preset
 * 文件能被 parsePreset 重新解析)、loadPresetsFromDirs 递归/重名/坏文件/
 * YAML 显式报错(#30)。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { parsePreset, defaultRegistry, minimalPresetDoc } from '../../src/capability/index.ts';
import {
  EXPORT_LEVELS,
  buildExportBundle,
  loadPresetsFromDirs,
  scrubCredentials,
  usedPresetNames,
} from '../../src/portability/index.ts';
import type { Preset } from '../../src/capability/types.ts';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

const WORKFLOW = {
  api: 'workflow/1.0',
  intent_ref: 'wf-1',
  nodes: [
    { id: 'impl', preset: 'coder' },
    { id: 'test', preset: 'tester', inputs: [{ from: 'impl.outputs.code' }] },
  ],
  outputs: [{ from: 'test.outputs.report', required: true }],
  feedback: [],
  evidence: [{ node: 'test', artifact: 'report', must_exist: true, sha256_recorded: true }],
};

const INTENT = {
  api: 'intent/1.0',
  goal: '做东西',
  acceptance: ['能用,见 artifact:report'],
  constraints: { forbidden_caps: ['mcp:prod-db'] },
};

function presetOf(name: string, overrides: Record<string, unknown> = {}): Preset {
  return parsePreset(minimalPresetDoc({
    name,
    baseline_grants: [{ cap: 'fs:workdir', scope: 'rw' }],
    io_contracts: {
      inputs: [{ name: 'code', type: 'text' }],
      outputs: [{ name: 'code', type: 'text' }, { name: 'report', type: 'file:markdown' }],
    },
    ...overrides,
  }));
}

const PRESETS = {
  coder: presetOf('coder'),
  tester: presetOf('tester', {
    model: { tier: 'standard' },
    baseline_grants: [
      { cap: 'fs:workdir', scope: 'rw' },
      { cap: 'mcp:playwright', scope: 'write' },
    ],
  }),
};

function bundleFor(level: 'minimal' | 'brief' | 'full') {
  return buildExportBundle({
    workflow: WORKFLOW,
    level,
    presets: PRESETS,
    registry: defaultRegistry(),
    intent: INTENT,
    exportedAt: '2026-09-05T00:00:00Z',
  });
}

function fileOf(bundle: { files: readonly { path: string; content: string }[] }, path: string): string {
  const file = bundle.files.find((f) => f.path === path);
  assert.ok(file, `导出包应包含 ${path}`);
  return file.content;
}

// ---------------------------------------------------------------- 三档差异

describe('portability:三档导出', () => {
  it('档位闭集与内容差异:minimal 最小,brief+manifest,full+预设/授予/环境', () => {
    assert.deepEqual(EXPORT_LEVELS, ['minimal', 'brief', 'full']);

    const minimal = bundleFor('minimal').files.map((f) => f.path);
    assert.deepEqual(minimal.sort(), ['README.md', 'caps.json', 'workflow.json']);

    const brief = bundleFor('brief').files.map((f) => f.path);
    assert.deepEqual(brief.sort(), ['README.md', 'capabilities.json', 'caps.json', 'workflow.json']);

    const full = bundleFor('full').files.map((f) => f.path);
    assert.ok(full.includes('presets/coder.json'));
    assert.ok(full.includes('presets/tester.json'));
    assert.ok(full.includes('baseline-grants.json'));
    assert.ok(full.includes('environment.md'));
  });

  it('minimal 的 caps.json 带用途描述与 used_by;brief 快照含 risk_level/tools', () => {
    const caps = JSON.parse(fileOf(bundleFor('minimal'), 'caps.json')) as {
      caps: { cap: string; description: string; used_by: string[] }[];
    };
    const playwright = caps.caps.find((c) => c.cap === 'mcp:playwright');
    assert.ok(playwright);
    assert.equal(playwright.description, '浏览器自动化:页面操作、截图、端到端验证');
    assert.deepEqual(playwright.used_by, ['tester']);

    const manifest = JSON.parse(fileOf(bundleFor('brief'), 'capabilities.json')) as {
      capabilities: { id: string; risk_level?: string; tools?: string[] }[];
    };
    const entry = manifest.capabilities.find((c) => c.id === 'mcp:playwright');
    assert.ok(entry);
    assert.equal(entry.risk_level, 'medium');
    assert.ok(Array.isArray(entry.tools));
  });

  it('README 必备章节:凭据铁律 / 本地路径 / 模型准入 / 移植后核验', () => {
    const readme = fileOf(bundleFor('full'), 'README.md');
    assert.ok(readme.includes('不含任何凭据'));
    assert.ok(readme.includes('本地路径'));
    assert.ok(readme.includes('模型准入'));
    assert.ok(readme.includes('standard'));
    assert.ok(readme.includes('workflow check'));
    assert.ok(readme.includes('2026-09-05T00:00:00Z'));
  });

  it('environment.md 给安装规格(MCP server 需提供的 tools),不含凭据', () => {
    const env = fileOf(bundleFor('full'), 'environment.md');
    assert.ok(env.includes('mcp:playwright'));
    assert.ok(env.includes('screenshot'));
    assert.ok(env.includes('安装'));
    assert.ok(env.includes('neoba/sandbox:latest'));
  });

  it('full 档导出的预设文件可被 parsePreset 往返解析且字段一致', () => {
    const bundle = bundleFor('full');
    const doc = JSON.parse(fileOf(bundle, 'presets/tester.json')) as Record<string, unknown>;
    const reparsed = parsePreset(doc);
    assert.equal(reparsed.name, 'tester');
    assert.equal(reparsed.model?.tier, 'standard');
    assert.equal(reparsed.baseline_grants.length, 2);
    assert.equal(reparsed.io_contracts.outputs.length, 2);
  });

  it('usedPresetNames 按节点出现序去重', () => {
    assert.deepEqual(
      usedPresetNames({ nodes: [{ preset: 'a' }, { preset: 'b' }, { preset: 'a' }] }),
      ['a', 'b'],
    );
  });

  it('注册表缺口进 missingCaps 并写进 README', () => {
    const bundle = buildExportBundle({
      workflow: WORKFLOW,
      level: 'minimal',
      presets: { coder: presetOf('coder', { baseline_grants: [{ cap: 'fs:custom-path', scope: 'rw' }] }) },
      registry: defaultRegistry(),
      exportedAt: '2026-09-05T00:00:00Z',
    });
    assert.deepEqual(bundle.missingCaps, ['fs:custom-path']);
    const readme = fileOf(bundle, 'README.md');
    assert.ok(readme.includes('能力注册表缺口'));
    assert.ok(readme.includes('fs:custom-path'));
  });
});

// ---------------------------------------------------------------- 铁律擦除

describe('portability:凭据擦除(§3.5g 铁律)', () => {
  it('凭据语义键替换为占位,原值不出现;引用带类型说明', () => {
    const creds: { path: string; hint: string }[] = [];
    const clean = scrubCredentials(
      {
        nodes: [{ id: 'impl', secret_ids: ['github-token', 'db-pass'] }],
        nested: { api_key: 'sk-123', note: 'plain' },
      },
      creds,
    ) as {
      nodes: { id: string; secret_ids: string[] }[];
      nested: { api_key: string; note: string };
    };

    assert.equal(clean.nodes[0]?.secret_ids.length, 2);
    for (const v of clean.nodes[0]?.secret_ids ?? []) {
      assert.ok(String(v).includes('占位'));
      assert.ok(!String(v).includes('github-token'));
    }
    assert.equal(clean.nodes[0]?.id, 'impl');
    assert.equal(clean.nested.note, 'plain');
    assert.ok(!String(clean.nested.api_key).includes('sk-123'));

    assert.equal(creds.length, 2);
    assert.equal(creds[0]?.path, 'nodes[0].secret_ids');
    assert.ok(creds[0]?.hint.includes('github-token'));
    assert.ok(creds[0]?.hint.includes('SecretStore'));
    assert.equal(creds[1]?.path, 'nested.api_key');
  });

  it('无凭据文档擦除后原样返回,credentials 为空 → README 写"未引用凭据"', () => {
    const creds: { path: string; hint: string }[] = [];
    const clean = scrubCredentials({ api: 'workflow/1.0', nodes: [] }, creds);
    assert.deepEqual(clean, { api: 'workflow/1.0', nodes: [] });
    assert.equal(creds.length, 0);

    const bundle = buildExportBundle({
      workflow: WORKFLOW,
      level: 'minimal',
      presets: PRESETS,
      registry: defaultRegistry(),
      exportedAt: '2026-09-05T00:00:00Z',
    });
    assert.equal(bundle.credentials.length, 0);
    assert.ok(fileOf(bundle, 'README.md').includes('未引用凭据'));
  });
});

// ---------------------------------------------------------------- 预设目录加载

describe('portability:loadPresetsFromDirs', () => {
  it('递归加载子目录 JSON;坏文件与重名进 errors,不阻断其它预设', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neoba-port-'));
    roots.push(dir);
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'a.json'), JSON.stringify(minimalPresetDoc({ name: 'alpha' })), 'utf8');
    await writeFile(
      join(dir, 'nested', 'b.json'),
      JSON.stringify(minimalPresetDoc({ name: 'alpha', description: '重复名' })),
      'utf8',
    );
    await writeFile(join(dir, 'bad.json'), '{ not json', 'utf8');
    await writeFile(
      join(dir, 'workflow.json'),
      JSON.stringify({ api: 'workflow/1.0', intent_ref: 'x', nodes: [], outputs: [], feedback: [], evidence: [] }),
      'utf8',
    );
    await writeFile(join(dir, 'note.txt'), 'ignore me', 'utf8');

    const report = await loadPresetsFromDirs([dir]);
    assert.deepEqual(Object.keys(report.presets).sort(), ['alpha']);
    assert.equal(report.presets['alpha']?.description, '端到端测试执行者');
    assert.equal(report.errors.length, 2); // 重名 + 坏 JSON(workflow 文档跳过不报)
    assert.ok(report.errors.some((e) => e.path.includes('bad.json')));
    assert.ok(report.errors.some((e) => e.message.includes('重复')));
  });

  it('目录不存在 → 单条 error,不抛', async () => {
    const report = await loadPresetsFromDirs([join(tmpdir(), 'neoba-port-nonexistent')]);
    assert.deepEqual(Object.keys(report.presets), []);
    assert.equal(report.errors.length, 1);
    assert.ok(report.errors[0]?.message.includes('不可读'));
  });

  it('目录含 .yaml/.yml(#30)→ 逐文件 PresetLoadError 带转 JSON 指引,不静默忽略', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neoba-port-'));
    roots.push(dir);
    await writeFile(
      join(dir, 'planner.yaml'),
      'name: planner\ndescription: 人读样例(YAML 不再静默忽略)\n',
      'utf8',
    );
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', 'e2e.yml'), 'name: e2e-tester\n', 'utf8');
    await writeFile(
      join(dir, 'alpha.json'),
      JSON.stringify(minimalPresetDoc({ name: 'alpha' })),
      'utf8',
    );

    const report = await loadPresetsFromDirs([dir]);
    // 同目录 .json 不受影响,正常装载
    assert.deepEqual(Object.keys(report.presets), ['alpha']);
    // 两个 YAML 文件各报一条错,信息可定位且带"转成 .json"的修复指引
    assert.equal(report.errors.length, 2);
    const yamlErrors = report.errors.filter((e) => /\.ya?ml$/.test(e.path));
    assert.equal(yamlErrors.length, 2);
    for (const e of yamlErrors) {
      assert.ok(e.message.includes('不支持 YAML'));
      assert.ok(e.message.includes('JSON'), '指引应指明转成等价 JSON');
      assert.ok(e.message.includes('presets/planner.json'), '指引应给出字段结构参考');
    }
  });
});
