/**
 * PlanCheck 测试(§3.5c):结构校验(一次报全)、契约类型匹配、依赖成环、
 * 反馈边校验、禁授能力(通配)、模型准入、重试/幂等组合、验收可追溯、
 * required 输出证据声明。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultRegistry, minimalPresetDoc, parsePreset } from '../../src/capability/index.ts';
import type { Preset } from '../../src/capability/index.ts';
import { loadModelRegistry } from '../../src/modelscore/index.ts';
import { matchAnyCapPattern, matchCapPattern } from '../../src/plancheck/index.ts';
import { checkIntent, checkWorkflow } from '../../src/plancheck/index.ts';
import { parseIntent, parseOutputBinding, parseWorkflow } from '../../src/plancheck/index.ts';
import { IntentInvalid, WorkflowInvalid } from '../../src/plancheck/index.ts';
import type { PlanCheckContext } from '../../src/plancheck/index.ts';

// ---------------------------------------------------------------- fixtures

function presetDoc(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return minimalPresetDoc({
    name,
    description: `预设 ${name}`,
    baseline_grants: [{ cap: 'fs:workdir', scope: 'rw' }],
    ...overrides,
  });
}

const plannerPreset: Preset = parsePreset(
  presetDoc('planner/tech-split', {
    io_contracts: {
      inputs: [],
      outputs: [{ name: 'split_plan', type: 'file:markdown' }],
    },
    escalation_policy: { auto_approve: ['mcp:playwright'], require_approval: ['mcp:*', '*'] },
  }),
);

const coderPreset: Preset = parsePreset(
  presetDoc('coder/backend', {
    io_contracts: {
      inputs: [{ name: 'split_plan', type: 'file:markdown' }, { name: 'patch', type: 'dir' }],
      outputs: [{ name: 'patch', type: 'dir' }],
    },
  }),
);

const testerPreset: Preset = parsePreset(
  presetDoc('e2e-tester', {
    io_contracts: {
      inputs: [{ name: 'patch', type: 'dir' }],
      outputs: [{ name: 'test_report', type: 'file:markdown' }],
    },
  }),
);

const PRESETS: Record<string, Preset> = {
  'planner/tech-split': plannerPreset,
  'coder/backend': coderPreset,
  'e2e-tester': testerPreset,
};

function ctx(overrides: Partial<PlanCheckContext> = {}): PlanCheckContext {
  return { presets: PRESETS, registry: defaultRegistry(), ...overrides };
}

function designExampleWorkflow(): Record<string, unknown> {
  return {
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
      {
        id: 'test',
        preset: 'e2e-tester',
        inputs: [{ from: 'impl.outputs.patch' }],
      },
    ],
    outputs: [{ from: 'test.outputs.test_report', required: true }],
    feedback: [{ from: 'test', to: 'impl', max_traversals: 2 }],
    evidence: [
      { node: 'test', artifact: 'test_report', must_exist: true, sha256_recorded: true },
    ],
  };
}

// ---------------------------------------------------------------- 结构校验

describe('plancheck/parse', () => {
  it('设计文档示例 workflow 通过结构解析', () => {
    const doc = parseWorkflow(designExampleWorkflow());
    assert.equal(doc.nodes.length, 3);
    assert.equal(doc.outputs[0]?.required, true);
    assert.deepEqual(doc.feedback[0], { from: 'test', to: 'impl', max_traversals: 2 });
  });

  it('parallel 字段:合法布尔解析,缺省不出现', () => {
    const raw = designExampleWorkflow();
    (raw.nodes as Record<string, unknown>[])[1]!['parallel'] = true;
    const doc = parseWorkflow(raw);
    assert.equal(doc.nodes[1]?.parallel, true);
    assert.equal(doc.nodes[0]?.parallel, undefined);
  });

  it('parallel 字段:非布尔报 issue', () => {
    const raw = designExampleWorkflow();
    (raw.nodes as Record<string, unknown>[])[1]!['parallel'] = 'yes';
    try {
      parseWorkflow(raw);
      assert.fail('应抛错');
    } catch (err) {
      assert.ok(err instanceof WorkflowInvalid);
      assert.ok(err.issues.some((i) => i.field === 'nodes[1].parallel'));
    }
  });

  it('结构问题一次报全', () => {
    try {
      parseWorkflow({
        api: 'workflow/1.0',
        intent_ref: '',
        nodes: [
          { id: 'Bad-ID', preset: 'coder/backend' },
          { id: 'impl', preset: 'coder/backend', timeout: 0, extra: 1 },
          { id: 'impl', preset: 'x', retry: { max: -1, on: ['nope'] } },
        ],
        outputs: [{ from: 'bad binding' }],
        feedback: [{ from: 'a', to: 'a', max_traversals: -1 }],
        evidence: [{ node: 'test', artifact: 'X', must_exist: 'yes', sha256_recorded: true }],
      });
      assert.fail('应抛错');
    } catch (err) {
      assert.ok(err instanceof WorkflowInvalid);
      const fields = err.issues.map((i) => i.field);
      assert.ok(fields.some((f) => f.includes('intent_ref')));
      assert.ok(fields.some((f) => f.includes('nodes[0].id')));
      assert.ok(fields.some((f) => f.includes('nodes[1].timeout')));
      assert.ok(fields.some((f) => f.includes('nodes[1].extra')));
      assert.ok(fields.some((f) => f.includes('nodes[2].id')));
      assert.ok(fields.length >= 8, `应有 ≥8 处,实际 ${fields.length}`);
    }
  });

  it('文档类根禁 protocol/spec_version', () => {
    assert.throws(
      () => parseWorkflow({ ...designExampleWorkflow(), protocol: '1.0' }),
      WorkflowInvalid,
    );
  });

  it('parseIntent 结构校验', () => {
    const doc = parseIntent({
      api: 'intent/1.0',
      goal: '做一件事',
      acceptance: ['pytest 全绿'],
      constraints: { budget_tokens: 2000000, forbidden_caps: ['mcp:*', '*'], allowed_models: ['anthropic/*'] },
    });
    assert.deepEqual(doc.constraints.forbidden_caps, ['mcp:*', '*']);
    assert.throws(
      () => parseIntent({ api: 'intent/1.0', goal: 'x', acceptance: [], constraints: { nope: 1 } }),
      IntentInvalid,
    );
  });

  it('parseOutputBinding 拆节点与工件名', () => {
    assert.deepEqual(parseOutputBinding('plan.outputs.split_plan'), { node: 'plan', artifact: 'split_plan' });
    assert.equal(parseOutputBinding('nonsense'), null);
  });
});

// ---------------------------------------------------------------- 通配匹配

describe('plancheck/match', () => {
  it('cap 通配三种语义(禁授唯一匹配规则)', () => {
    assert.equal(matchCapPattern('mcp:github', 'mcp:github'), true);
    assert.equal(matchCapPattern('anything:at-all', '*'), true);
    assert.equal(matchCapPattern('mcp:github', 'mcp:*'), true);
    assert.equal(matchCapPattern('fs:workdir', 'mcp:*'), false);
    assert.equal(matchCapPattern('mcp:github-mirror', 'mcp:github'), false);
    assert.equal(matchAnyCapPattern('fs:workdir', ['mcp:*', 'net:*']), false);
    assert.equal(matchAnyCapPattern('net:prod', ['mcp:*', 'net:*']), true);
  });
});

// ---------------------------------------------------------------- 语义检查

describe('plancheck/checkWorkflow', () => {
  it('设计文档示例全绿(语义无 issue)', () => {
    const result = checkWorkflow(designExampleWorkflow(), ctx());
    assert.deepEqual(
      result.issues,
      [],
      `应无 issue,实际: ${result.issues.map((i) => `${i.code}@${i.field}`).join('; ')}`,
    );
    assert.equal(result.ok, true);
    assert.ok(result.doc);
  });

  it('未知预设报 preset_unknown', () => {
    const wf = designExampleWorkflow();
    (wf['nodes'] as Record<string, unknown>[])[1]!['preset'] = 'coder/missing';
    const result = checkWorkflow(wf, ctx());
    assert.ok(result.issues.some((i) => i.code === 'preset_unknown'));
  });

  it('契约类型不匹配报 contract_type_mismatch', () => {
    const bad = parsePreset(
      presetDoc('coder/typo', {
        io_contracts: {
          inputs: [{ name: 'split_plan', type: 'dir' }],
          outputs: [{ name: 'patch', type: 'dir' }],
        },
      }),
    );
    const presets = { ...PRESETS, 'coder/typo': bad };
    const wf = designExampleWorkflow();
    (wf['nodes'] as Record<string, unknown>[])[1]!['preset'] = 'coder/typo';
    const result = checkWorkflow(wf, ctx({ presets }));
    assert.ok(result.issues.some((i) => i.code === 'contract_type_mismatch' && i.field.includes('impl')));
  });

  it('上游无该输出端口 / 消费侧无该输入端口', () => {
    const wf = designExampleWorkflow();
    (wf['nodes'] as Record<string, unknown>[])[2] = {
      id: 'test',
      preset: 'e2e-tester',
      inputs: [{ from: 'impl.outputs.nonexistent' }],
    };
    const result = checkWorkflow(wf, ctx());
    assert.ok(result.issues.some((i) => i.code === 'output_port_unknown'));
  });

  it('输入依赖成环报 dependency_cycle(反馈边不算环)', () => {
    const loopCoder = parsePreset(
      presetDoc('coder/loop', {
        io_contracts: {
          inputs: [{ name: 'patch', type: 'dir' }],
          outputs: [{ name: 'patch', type: 'dir' }],
        },
      }),
    );
    const presets = { ...PRESETS, 'coder/loop': loopCoder };
    const wf = {
      api: 'workflow/1.0',
      intent_ref: 'i',
      nodes: [
        { id: 'a', preset: 'coder/loop', inputs: [{ from: 'b.outputs.patch' }] },
        { id: 'b', preset: 'coder/loop', inputs: [{ from: 'a.outputs.patch' }] },
      ],
      outputs: [],
      feedback: [],
      evidence: [],
    };
    const result = checkWorkflow(wf, ctx({ presets }));
    assert.ok(result.issues.some((i) => i.code === 'dependency_cycle'));
  });

  it('required 输出缺证据声明报 evidence_missing', () => {
    const wf = designExampleWorkflow();
    (wf['evidence'] as unknown[]) = [];
    const result = checkWorkflow(wf, ctx());
    assert.ok(result.issues.some((i) => i.code === 'evidence_missing'));
  });

  it('证据引用未声明端口报 evidence_port_unknown', () => {
    const wf = designExampleWorkflow();
    (wf['evidence'] as Record<string, unknown>[])[0]!['artifact'] = 'no_such_port';
    const result = checkWorkflow(wf, ctx());
    assert.ok(result.issues.some((i) => i.code === 'evidence_port_unknown'));
  });

  it('非幂等预设 retry timeout 报 retry_timeout_requires_idempotent', () => {
    const wf = designExampleWorkflow();
    (wf['nodes'] as Record<string, unknown>[])[1]!['retry'] = { max: 1, on: ['crash', 'timeout'] };
    const result = checkWorkflow(wf, ctx());
    assert.ok(result.issues.some((i) => i.code === 'retry_timeout_requires_idempotent'));
  });

  it('幂等预设 retry timeout 放行', () => {
    const idem = parsePreset(
      presetDoc('coder/idem', {
        idempotent: true,
        io_contracts: {
          inputs: [{ name: 'split_plan', type: 'file:markdown' }],
          outputs: [{ name: 'patch', type: 'dir' }],
        },
      }),
    );
    const presets = { ...PRESETS, 'coder/idem': idem };
    const wf = designExampleWorkflow();
    (wf['nodes'] as Record<string, unknown>[])[1]!['preset'] = 'coder/idem';
    const result = checkWorkflow(wf, ctx({ presets }));
    assert.equal(result.ok, true, result.issues.map((i) => i.code).join(';'));
  });

  it('基线授予命中禁授清单报 cap_forbidden(通配)', () => {
    const wf = designExampleWorkflow();
    const tester = parsePreset(
      presetDoc('e2e-tester', {
        baseline_grants: [
          { cap: 'fs:workdir', scope: 'rw' },
          { cap: 'mcp:playwright', scope: 'read' },
        ],
        io_contracts: {
          inputs: [{ name: 'patch', type: 'dir' }],
          outputs: [{ name: 'test_report', type: 'file:markdown' }],
        },
      }),
    );
    const presets = { ...PRESETS, 'e2e-tester': tester };
    const intent = parseIntent({
      api: 'intent/1.0',
      goal: 'g',
      acceptance: ['a'],
      constraints: { forbidden_caps: ['mcp:*'] },
    });
    const result = checkWorkflow(wf, ctx({ presets, intent }));
    assert.ok(result.issues.some((i) => i.code === 'cap_forbidden' && i.message.includes('mcp:playwright')));
  });

  it('模型准入:tier 无可用模型报 model_admission_empty', () => {
    const heavy = parsePreset(
      presetDoc('planner/tech-split', { model: { tier: 'heavy' } }),
    );
    const presets = { ...PRESETS, 'planner/tech-split': heavy };
    const models = loadModelRegistry({
      api: 'modelscore/1.0',
      models: [
        {
          protocol: '1.0', spec_version: '1.0', model: 'glm-4.7-air',
          tier_fit: { fast: 0.9, standard: 0.6, heavy: 0.0 },
          score: {
            prior: { fast: 0.8, standard: 0.5, heavy: 0.2 },
            observed: { fast: null, standard: null, heavy: null },
            samples: { fast: 0, standard: 0, heavy: 0 },
            dimensions: { quality: 0.8, success_rate: 0.8, cost_efficiency: 0.7 },
          },
          updated_at: '2026-09-05T00:00:00Z',
        },
      ],
    });
    const intent = parseIntent({
      api: 'intent/1.0', goal: 'g', acceptance: ['a'],
      constraints: { allowed_models: ['glm/*'] },
    });
    // glm/* 准入放行 glm-4.7-air,但 heavy 档 tier_fit=0 → 无可用。
    const blocked = checkWorkflow(designExampleWorkflow(), ctx({ presets, models, intent }));
    assert.ok(blocked.issues.some((i) => i.code === 'model_admission_empty'));
    // 放宽准入到 anthropic/* → 模型被准入拒,同样无候选。
    const intent2 = parseIntent({
      api: 'intent/1.0', goal: 'g', acceptance: ['a'],
      constraints: { allowed_models: ['anthropic/*'] },
    });
    const blocked2 = checkWorkflow(designExampleWorkflow(), ctx({ presets, models, intent: intent2 }));
    assert.ok(blocked2.issues.some((i) => i.code === 'model_admission_empty'));
  });
});

describe('plancheck/验收可追溯', () => {
  it('有带证据的 required 输出即覆盖无引用验收项', () => {
    const intent = parseIntent({
      api: 'intent/1.0', goal: 'g', acceptance: ['pytest 全绿', '有迁移脚本'],
      constraints: {},
    });
    const result = checkWorkflow(designExampleWorkflow(), ctx({ intent }));
    assert.equal(result.ok, true, result.issues.map((i) => i.code).join(';'));
  });

  it('缺 required 输出时逐项报 acceptance_uncovered', () => {
    const intent = parseIntent({
      api: 'intent/1.0', goal: 'g', acceptance: ['a', 'b'],
      constraints: {},
    });
    const wf = designExampleWorkflow();
    (wf['outputs'] as Record<string, unknown>[]) = [{ from: 'test.outputs.test_report' }]; // required 缺省 false
    const result = checkWorkflow(wf, ctx({ intent }));
    const uncovered = result.issues.filter((i) => i.code === 'acceptance_uncovered');
    assert.equal(uncovered.length, 2);
  });

  it('显式 artifact: 引用必须可解析', () => {
    const intent = parseIntent({
      api: 'intent/1.0', goal: 'g',
      acceptance: ['报告 artifact:test_report 产出且 artifact:ghost 存在'],
      constraints: {},
    });
    const result = checkWorkflow(designExampleWorkflow(), ctx({ intent }));
    assert.ok(result.issues.some((i) => i.code === 'acceptance_artifact_unresolved' && i.message.includes('ghost')));
    assert.equal(result.issues.filter((i) => i.code === 'acceptance_artifact_unresolved').length, 1);
  });
});

describe('plancheck/checkIntent', () => {
  it('合法 intent 通过,结构问题走 issue 通道不抛错', () => {
    const ok = checkIntent({
      api: 'intent/1.0', goal: 'g', acceptance: ['a'], constraints: {},
    });
    assert.equal(ok.ok, true);
    const bad = checkIntent({ api: 'intent/2.0' });
    assert.equal(bad.ok, false);
    assert.ok(bad.issues.length >= 3);
    assert.ok(bad.doc === null);
  });
});
