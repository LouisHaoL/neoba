/**
 * CLI `neoba workflow check / export` 集成测试(§3.5g):
 * 本地查缺(预设/cap/模型准入清单)、--json 结构、三档导出落盘、
 * README/环境指引、检查不过拒绝导出、导出包移植后可再过 check;
 * 模型准入口径对齐(issue #5):声明 model.tier + 未传 --models → fail;
 * export 门禁与 check 同口径(#25):缺 --models 时同样拒导,坏包不出门。
 * 真实文件系统(mkdtemp),不连 daemon。
 */
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runCli } from '../../src/cli/main.ts';
import { defaultDeps } from '../../src/cli/deps.ts';
import type { CliDeps, CliIo } from '../../src/cli/types.ts';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

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

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `neoba-cli-wf-${prefix}-`));
  roots.push(dir);
  return dir;
}

async function makeDeps(overrides: Partial<CliDeps> = {}): Promise<CliDeps> {
  return await defaultDeps({ version: '9.9.9-test', ...overrides });
}

// ---------------------------------------------------------------- 夹具

const PRESETS: Record<string, object> = {
  'planner/tech-split': {
    api: 'preset/1.0',
    name: 'planner/tech-split',
    description: '规划者',
    base: 'any',
    model: { tier: 'standard' },
    baseline_grants: [{ cap: 'fs:workdir', scope: 'ro' }],
    io_contracts: {
      inputs: [{ name: 'intent', type: 'file:markdown' }],
      outputs: [{ name: 'split_plan', type: 'file:markdown' }],
    },
    escalation_policy: { auto_approve: [], require_approval: ['*'] },
  },
  'coder/backend': {
    api: 'preset/1.0',
    name: 'coder/backend',
    description: '后端实现者',
    base: 'any',
    model: { tier: 'standard' },
    baseline_grants: [{ cap: 'fs:workdir', scope: 'rw' }],
    io_contracts: {
      inputs: [{ name: 'split_plan', type: 'file:markdown' }],
      outputs: [{ name: 'patch', type: 'file:text' }],
    },
    escalation_policy: { auto_approve: [], require_approval: ['*'] },
  },
  'e2e-tester': {
    api: 'preset/1.0',
    name: 'e2e-tester',
    description: '端到端测试执行者',
    base: 'any',
    model: { tier: 'standard' },
    baseline_grants: [
      { cap: 'fs:workdir', scope: 'rw' },
      { cap: 'mcp:playwright', scope: 'write' },
    ],
    io_contracts: {
      inputs: [{ name: 'patch', type: 'file:text' }],
      outputs: [{ name: 'test_report', type: 'file:markdown' }],
    },
    escalation_policy: { auto_approve: [], require_approval: ['*'] },
  },
};

const WORKFLOW = {
  api: 'workflow/1.0',
  intent_ref: 'intent-001',
  nodes: [
    { id: 'plan', preset: 'planner/tech-split' },
    {
      id: 'impl',
      preset: 'coder/backend',
      inputs: [{ from: 'plan.outputs.split_plan' }],
      timeout: 3600,
      retry: { max: 1, on: ['crash'] },
    },
    { id: 'test', preset: 'e2e-tester', inputs: [{ from: 'impl.outputs.patch' }] },
  ],
  outputs: [{ from: 'test.outputs.test_report', required: true }],
  feedback: [{ from: 'test', to: 'impl', max_traversals: 2 }],
  evidence: [{ node: 'test', artifact: 'test_report', must_exist: true, sha256_recorded: true }],
};

const INTENT = {
  api: 'intent/1.0',
  goal: '做完并测过',
  acceptance: ['全绿,见 artifact:test_report', '有迁移脚本'],
  constraints: { forbidden_caps: ['mcp:prod-db'], allowed_models: ['*'] },
};

/** 含一个 tier=standard 可用候选的模型注册表(与 daemon 侧同格式)。 */
const MODELS_OK = {
  api: 'modelscore/1.0',
  models: [{
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
    updated_at: '2026-09-05T00:00:00Z',
  }],
};

/** 无 model 声明的预设 + 引用它的 workflow(验「无声明不强制 --models」)。 */
const PLAIN_PRESET = {
  api: 'preset/1.0',
  name: 'plain/worker',
  description: '无模型档位的普通执行者',
  base: 'any',
  baseline_grants: [{ cap: 'fs:workdir', scope: 'rw' }],
  io_contracts: {
    inputs: [],
    outputs: [{ name: 'report', type: 'file:markdown' }],
  },
  escalation_policy: { auto_approve: [], require_approval: ['*'] },
};

const PLAIN_WORKFLOW = {
  api: 'workflow/1.0',
  intent_ref: 'intent-plain',
  nodes: [{ id: 'work', preset: 'plain/worker' }],
  outputs: [{ from: 'work.outputs.report', required: true }],
  feedback: [],
  evidence: [{ node: 'work', artifact: 'report', must_exist: true, sha256_recorded: true }],
};

async function writeFixtures(dir: string, workflow: object = WORKFLOW): Promise<{ presetsDir: string; workflowPath: string; intentPath: string }> {
  const presetsDir = join(dir, 'presets');
  await mkdirSure(presetsDir);
  for (const [name, doc] of Object.entries(PRESETS)) {
    await writeFile(join(presetsDir, `${name.replaceAll('/', '__')}.json`), JSON.stringify(doc), 'utf8');
  }
  const workflowPath = join(dir, 'workflow.json');
  await writeFile(workflowPath, JSON.stringify(workflow), 'utf8');
  const intentPath = join(dir, 'intent.json');
  await writeFile(intentPath, JSON.stringify(INTENT), 'utf8');
  return { presetsDir, workflowPath, intentPath };
}

async function mkdirSure(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}

/** 落一个模型注册表文件,返回路径。 */
async function writeModels(dir: string, doc: object = MODELS_OK): Promise<string> {
  const path = join(dir, 'models.json');
  await writeFile(path, JSON.stringify(doc), 'utf8');
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- check

describe('cli:workflow check', () => {
  it('引用齐备 → 通过(退出 0);--intent 联动验收可追溯', async () => {
    const dir = await makeTmp('ok');
    const { presetsDir, workflowPath, intentPath } = await writeFixtures(dir);
    const modelsPath = await writeModels(dir); // 预设声明 model.tier → check 需要 --models(issue #5)
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'check', workflowPath, '--presets', presetsDir, '--intent', intentPath, '--models', modelsPath],
      io,
      await makeDeps(),
    );
    assert.equal(code, 0);
    const text = io.outLines.join('\n');
    assert.ok(text.includes('3 节点'));
    assert.ok(text.includes('检查通过'));
  });

  it('缺预设 → 退出 1,清单指出 preset_unknown', async () => {
    const dir = await makeTmp('missing');
    const { workflowPath, intentPath } = await writeFixtures(dir);
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'check', workflowPath, '--presets', join(dir, 'nonexistent'), '--intent', intentPath],
      io,
      await makeDeps(),
    );
    assert.equal(code, 1);
    const text = io.outLines.join('\n');
    assert.ok(text.includes('preset_unknown'));
    assert.ok(text.includes('planner/tech-split'));
    assert.ok(text.includes('预设目录不可读'));
  });

  it('--json 输出 {ok, issues, preset_errors} 结构', async () => {
    const dir = await makeTmp('json');
    const { presetsDir, workflowPath } = await writeFixtures(dir);
    const modelsPath = await writeModels(dir);
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'check', workflowPath, '--presets', presetsDir, '--models', modelsPath, '--json'],
      io,
      await makeDeps(),
    );
    assert.equal(code, 0);
    assert.equal(io.outLines.length, 1);
    const parsed = JSON.parse(io.outLines[0] ?? '{}') as { ok: boolean; issues: unknown[]; preset_errors: unknown[] };
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parsed.preset_errors, []);
  });

  it('模型准入:空 models 注册表 → model_admission_empty;修复后通过', async () => {
    const dir = await makeTmp('models');
    const { presetsDir, workflowPath } = await writeFixtures(dir);
    const modelsPath = join(dir, 'models.json');
    await writeFile(
      modelsPath,
      JSON.stringify({ api: 'modelscore/1.0', models: [] }),
      'utf8',
    );
    const io = makeIo();
    let code = await runCli(
      ['workflow', 'check', workflowPath, '--presets', presetsDir, '--models', modelsPath],
      io,
      await makeDeps(),
    );
    assert.equal(code, 1);
    assert.ok(io.outLines.join('\n').includes('model_admission_empty'));

    // 补上 tier=standard 的候选模型后,同一工作流通过。
    await writeFile(modelsPath, JSON.stringify(MODELS_OK), 'utf8');
    const io2 = makeIo();
    code = await runCli(
      ['workflow', 'check', workflowPath, '--presets', presetsDir, '--models', modelsPath],
      io2,
      await makeDeps(),
    );
    assert.equal(code, 0);
  });

  it('口径对齐(issue #5):声明 model.tier + 未传 --models → 退出 1 报 models_registry_missing', async () => {
    const dir = await makeTmp('gate-text');
    const { presetsDir, workflowPath } = await writeFixtures(dir);
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'check', workflowPath, '--presets', presetsDir],
      io,
      await makeDeps(),
    );
    assert.equal(code, 1);
    const text = io.outLines.join('\n');
    assert.ok(text.includes('models_registry_missing'));
    assert.ok(text.includes('--models'));
    assert.ok(text.includes('tier=standard'));
    assert.ok(text.includes('检查通过') === false);
  });

  it('口径对齐(issue #5):--json 下 models_registry_missing 计入 issues 且 ok=false', async () => {
    const dir = await makeTmp('gate-json');
    const { presetsDir, workflowPath } = await writeFixtures(dir);
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'check', workflowPath, '--presets', presetsDir, '--json'],
      io,
      await makeDeps(),
    );
    assert.equal(code, 1);
    const parsed = JSON.parse(io.outLines[0] ?? '{}') as {
      ok: boolean;
      issues: { code: string; message: string }[];
    };
    assert.equal(parsed.ok, false);
    const gate = parsed.issues.filter((i) => i.code === 'models_registry_missing');
    assert.equal(gate.length, 1);
    assert.ok(gate[0]?.message.includes('--models'));
  });

  it('无 model 声明 + 未传 --models → 维持过检(现状不回归)', async () => {
    const dir = await makeTmp('gate-plain');
    const presetsDir = join(dir, 'presets');
    await mkdirSure(presetsDir);
    await writeFile(join(presetsDir, 'plain__worker.json'), JSON.stringify(PLAIN_PRESET), 'utf8');
    const workflowPath = join(dir, 'workflow.json');
    await writeFile(workflowPath, JSON.stringify(PLAIN_WORKFLOW), 'utf8');
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'check', workflowPath, '--presets', presetsDir],
      io,
      await makeDeps(),
    );
    assert.equal(code, 0);
    const text = io.outLines.join('\n');
    assert.ok(text.includes('检查通过'));
    assert.ok(text.includes('models_registry_missing') === false);
  });

  it('预设目录里有坏 JSON → 报 ⚠ 且退出 1,不阻断其它预设加载', async () => {
    const dir = await makeTmp('badpreset');
    const { presetsDir, workflowPath } = await writeFixtures(dir);
    await writeFile(join(presetsDir, 'broken.json'), '{oops', 'utf8');
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'check', workflowPath, '--presets', presetsDir],
      io,
      await makeDeps(),
    );
    assert.equal(code, 1);
    const text = io.outLines.join('\n');
    assert.ok(text.includes('预设加载失败'));
    assert.ok(text.includes('检查未通过') === false);
    // 好预设仍然加载成功,工作流本体检查通过(问题只来自坏文件)。
    assert.ok(text.includes('已加载预设'));
  });

  it('缺子命令 / 未知子命令 → 用法错误(退出 2)', async () => {
    const io = makeIo();
    let code = await runCli(['workflow'], io, await makeDeps());
    assert.equal(code, 2);
    code = await runCli(['workflow', 'frobnicate'], io, await makeDeps());
    assert.equal(code, 2);
    assert.ok(io.errLines.join('\n').includes('check 或 export'));
  });
});

// ---------------------------------------------------------------- export

describe('cli:workflow export', () => {
  it('minimal 档:workflow/caps/README 三件套,无 manifest/预设', async () => {
    const dir = await makeTmp('exp-min');
    const { presetsDir, workflowPath } = await writeFixtures(dir);
    const modelsPath = await writeModels(dir); // 预设声明 model.tier → export 需要 --models(#25)
    const out = join(dir, 'bundle');
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'export', workflowPath, '--presets', presetsDir, '--models', modelsPath, '--level', 'minimal', '--out', out],
      io,
      await makeDeps(),
    );
    assert.equal(code, 0);
    assert.ok(await exists(join(out, 'workflow.json')));
    assert.ok(await exists(join(out, 'caps.json')));
    assert.ok(await exists(join(out, 'README.md')));
    assert.equal(await exists(join(out, 'capabilities.json')), false);
    assert.equal(await exists(join(out, 'environment.md')), false);
    const readme = await readFile(join(out, 'README.md'), 'utf8');
    assert.ok(readme.includes('minimal'));
    assert.ok(readme.includes('不含任何凭据'));
    assert.ok(io.outLines.join('\n').includes('workflow check'));
  });

  it('full 档:预设文件/基线授予/环境指引齐备;导出包可再过 check(移植后核验)', async () => {
    const dir = await makeTmp('exp-full');
    const { presetsDir, workflowPath } = await writeFixtures(dir);
    const modelsPath = await writeModels(dir); // 预设声明 model.tier → export 需要 --models(#25)
    const out = join(dir, 'bundle');
    const deps = await makeDeps();
    let code = await runCli(
      ['workflow', 'export', workflowPath, '--presets', presetsDir, '--models', modelsPath, '--level', 'full', '--out', out],
      makeIo(),
      deps,
    );
    assert.equal(code, 0);

    assert.ok(await exists(join(out, 'presets', 'planner', 'tech-split.json')));
    assert.ok(await exists(join(out, 'presets', 'coder', 'backend.json')));
    assert.ok(await exists(join(out, 'presets', 'e2e-tester.json')));
    assert.ok(await exists(join(out, 'baseline-grants.json')));
    assert.ok(await exists(join(out, 'capabilities.json')));
    const env = await readFile(join(out, 'environment.md'), 'utf8');
    assert.ok(env.includes('mcp:playwright'));
    assert.ok(env.includes('安装'));

    const grants = JSON.parse(await readFile(join(out, 'baseline-grants.json'), 'utf8')) as {
      grants: { preset: string; cap: string; scope: string }[];
    };
    assert.equal(grants.grants.length, 4);
    assert.ok(grants.grants.some((g) => g.preset === 'e2e-tester' && g.cap === 'mcp:playwright'));

    // 移植后核验:只带导出包自带的预设目录,check 应通过
    // (导出包预设声明 model.tier → 需随包给 --models,issue #5 口径)。
    const io2 = makeIo();
    code = await runCli(
      ['workflow', 'check', join(out, 'workflow.json'), '--presets', join(out, 'presets'), '--models', modelsPath],
      io2,
      deps,
    );
    assert.equal(code, 0);
    assert.ok(io2.outLines.join('\n').includes('检查通过'));
  });

  it('检查不过 → 拒绝导出(退出 1),不产生输出目录', async () => {
    const dir = await makeTmp('exp-reject');
    const { workflowPath } = await writeFixtures(dir);
    const out = join(dir, 'bundle');
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'export', workflowPath, '--presets', join(dir, 'nonexistent'), '--level', 'brief', '--out', out],
      io,
      await makeDeps(),
    );
    assert.equal(code, 1);
    assert.ok(io.errLines.join('\n').includes('拒绝导出'));
    assert.equal(await exists(out), false);
  });

  it('--level 非法 → 用法错误;--json 输出导出回执', async () => {
    const dir = await makeTmp('exp-json');
    const { presetsDir, workflowPath } = await writeFixtures(dir);
    const modelsPath = await writeModels(dir); // 预设声明 model.tier → export 需要 --models(#25)
    const deps = await makeDeps();
    const io = makeIo();
    let code = await runCli(
      ['workflow', 'export', workflowPath, '--presets', presetsDir, '--models', modelsPath, '--level', 'mega', '--out', join(dir, 'b1')],
      io,
      deps,
    );
    assert.equal(code, 2);

    const out = join(dir, 'b2');
    const io2 = makeIo();
    code = await runCli(
      ['workflow', 'export', workflowPath, '--presets', presetsDir, '--models', modelsPath, '--level', 'brief', '--out', out, '--json'],
      io2,
      deps,
    );
    assert.equal(code, 0);
    const receipt = JSON.parse(io2.outLines[0] ?? '{}') as {
      level: string;
      out: string;
      files: string[];
      credentials: unknown[];
      missing_caps: unknown[];
    };
    assert.equal(receipt.level, 'brief');
    assert.ok(receipt.files.some((f) => f.endsWith('capabilities.json')));
    assert.deepEqual(receipt.credentials, []);
    assert.deepEqual(receipt.missing_caps, []);
  });

  it('--help 列出 workflow 命令', async () => {
    const io = makeIo();
    const code = await runCli(['--help'], io, await makeDeps());
    assert.equal(code, 0);
    assert.ok(io.outLines.join('\n').includes('workflow'));
  });
});

// ------------------------------------------------------- export models 门禁(#25)

describe('cli:workflow export models 门禁(#25)', () => {
  it('声明 model.tier + 无 --models → 拒绝导出(退出 1)报 models_registry_missing,不落盘', async () => {
    const dir = await makeTmp('exp-gate-text');
    const { presetsDir, workflowPath } = await writeFixtures(dir);
    const out = join(dir, 'bundle');
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'export', workflowPath, '--presets', presetsDir, '--level', 'full', '--out', out],
      io,
      await makeDeps(),
    );
    assert.equal(code, 1);
    const text = io.errLines.join('\n');
    assert.ok(text.includes('models_registry_missing'));
    assert.ok(text.includes('--models'));
    assert.ok(text.includes('拒绝导出'));
    assert.equal(await exists(out), false);
  });

  it('--json 下同样拒导,issues 含 models_registry_missing 且 ok=false', async () => {
    const dir = await makeTmp('exp-gate-json');
    const { presetsDir, workflowPath } = await writeFixtures(dir);
    const out = join(dir, 'bundle');
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'export', workflowPath, '--presets', presetsDir, '--level', 'brief', '--out', out, '--json'],
      io,
      await makeDeps(),
    );
    assert.equal(code, 1);
    assert.equal(io.outLines.length, 0);
    const parsed = JSON.parse(io.errLines[0] ?? '{}') as {
      ok: boolean;
      issues: { code: string }[];
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.issues.filter((i) => i.code === 'models_registry_missing').length, 1);
    assert.equal(await exists(out), false);
  });

  it('带 --models → 同一输入正常出包(与 check 口径一致)', async () => {
    const dir = await makeTmp('exp-gate-ok');
    const { presetsDir, workflowPath } = await writeFixtures(dir);
    const modelsPath = await writeModels(dir);
    const out = join(dir, 'bundle');
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'export', workflowPath, '--presets', presetsDir, '--models', modelsPath, '--level', 'brief', '--out', out],
      io,
      await makeDeps(),
    );
    assert.equal(code, 0);
    assert.ok(await exists(join(out, 'workflow.json')));
    assert.ok(await exists(join(out, 'README.md')));
  });

  it('无 model 声明的预设 + 无 --models → 仍可导出(现状不回归)', async () => {
    const dir = await makeTmp('exp-gate-plain');
    const presetsDir = join(dir, 'presets');
    await mkdirSure(presetsDir);
    await writeFile(join(presetsDir, 'plain__worker.json'), JSON.stringify(PLAIN_PRESET), 'utf8');
    const workflowPath = join(dir, 'workflow.json');
    await writeFile(workflowPath, JSON.stringify(PLAIN_WORKFLOW), 'utf8');
    const out = join(dir, 'bundle');
    const io = makeIo();
    const code = await runCli(
      ['workflow', 'export', workflowPath, '--presets', presetsDir, '--level', 'minimal', '--out', out],
      io,
      await makeDeps(),
    );
    assert.equal(code, 0);
    assert.ok(await exists(join(out, 'workflow.json')));
    assert.ok(io.outLines.join('\n').includes('models_registry_missing') === false);
  });
});
