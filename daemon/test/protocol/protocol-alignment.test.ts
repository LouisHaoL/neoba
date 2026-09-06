/**
 * 协议一致性回归(#24):装载器/校验器对齐冻结 schema,实现不再静默超集。
 * 1. preset / capability-registry 未知字段 fail-fast(schema additionalProperties: false)
 * 2. WorkflowSpec 必填键 outputs/feedback/evidence 缺失即报(schema required)
 * 3. CAP_WILDCARD_RE 收紧为 "ns:*"(名称段不允许再含 "*")
 * 4. workflow.run 的 secret_ids 校验冻结 pattern(common.schema.json secret_id)
 * 5. handshake schema 允许扩展字段(修订裁决:协议 examples 校验另经 validate.mjs 回归)
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  loadCapabilityRegistry,
  minimalPresetDoc,
  parsePreset,
  PresetInvalid,
  RegistryInvalid,
} from '../../src/capability/index.ts';
import type { Preset } from '../../src/capability/index.ts';
import { checkIntent, parseWorkflow, WorkflowInvalid } from '../../src/plancheck/index.ts';
import { startDaemon } from '../../src/daemon/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';
import type { NodeRuntime, RuntimeResult } from '../../src/engine/index.ts';

// --------------------------------------------------------------- 1. 未知字段

describe('protocol/alignment #24: preset/registry 未知字段 fail-fast', () => {
  it('preset 根未知键 → PresetInvalid(报出未知键名)', () => {
    try {
      parsePreset(minimalPresetDoc({ riskLevel: 'high' }));
      assert.fail('应抛 PresetInvalid');
    } catch (err) {
      assert.ok(err instanceof PresetInvalid);
      assert.ok(err.issues.some((i) => i.includes('riskLevel') && i.includes('未知字段')));
    }
  });

  it('preset model 未知键(如 riskLevel)→ 报错而非静默丢弃', () => {
    const doc = minimalPresetDoc({ model: { tier: 'standard', riskLevel: 'high' } });
    assert.throws(
      () => parsePreset(doc),
      (err: unknown) =>
        err instanceof PresetInvalid && err.issues.some((i) => i.includes('model.riskLevel')),
    );
  });

  it('preset baseline_grants 条目未知键 → 报错', () => {
    const doc = minimalPresetDoc({
      baseline_grants: [{ cap: 'fs:workdir', scope: 'rw', extra: 1 }],
    });
    assert.throws(
      () => parsePreset(doc),
      (err: unknown) =>
        err instanceof PresetInvalid && err.issues.some((i) => i.includes('extra')),
    );
  });

  it('registry 根未知键 → RegistryInvalid', () => {
    assert.throws(
      () => loadCapabilityRegistry({ protocol: '1.0', spec_version: '1.0', capabilities: [], risk_level: 'low' }),
      (err: unknown) =>
        err instanceof RegistryInvalid && err.issues.some((i) => i.includes('risk_level')),
    );
  });

  it('registry 条目未知键(camelCase typo)→ RegistryInvalid', () => {
    assert.throws(
      () =>
        loadCapabilityRegistry({
          protocol: '1.0',
          spec_version: '1.0',
          capabilities: [
            {
              id: 'fs:workdir',
              kind: 'fs_path',
              description: '任务工作目录',
              riskLevel: 'low',
              grantable_scopes: ['ro', 'rw'],
              path_template: '${task.workdir}',
            },
          ],
        }),
      (err: unknown) =>
        err instanceof RegistryInvalid && err.issues.some((i) => i.includes('riskLevel')),
    );
  });
});

// ------------------------------------------------------- 2. WorkflowSpec 必填键

function baseWorkflow(): Record<string, unknown> {
  return {
    api: 'workflow/1.0',
    intent_ref: 'intent-001',
    nodes: [{ id: 'plan', preset: 'planner/tech-split' }],
    outputs: [],
    feedback: [],
    evidence: [],
  };
}

describe('protocol/alignment #24: WorkflowSpec 必填键缺失即报', () => {
  for (const key of ['outputs', 'feedback', 'evidence']) {
    it(`缺失 ${key} → WorkflowInvalid`, () => {
      const doc = { ...baseWorkflow() } as Record<string, unknown>;
      delete doc[key];
      try {
        parseWorkflow(doc);
        assert.fail(`应因缺失 ${key} 抛 WorkflowInvalid`);
      } catch (err) {
        assert.ok(err instanceof WorkflowInvalid);
        assert.ok(err.issues.some((i) => i.field === key && i.message.includes('必填')));
      }
    });
  }

  it('三项齐备(空数组)→ 通过', () => {
    const doc = parseWorkflow(baseWorkflow());
    assert.deepEqual(doc.outputs, []);
    assert.deepEqual(doc.feedback, []);
    assert.deepEqual(doc.evidence, []);
  });
});

// ---------------------------------------------------------- 3. 通配 cap 正则

describe('protocol/alignment #24: forbidden_caps 通配形态与 schema 对齐', () => {
  it('"ns:*" 合法,"a*:*"/"**:*" 拒绝', () => {
    const ok = checkIntent({
      api: 'intent/1.0',
      goal: 'g',
      acceptance: ['a'],
      constraints: { forbidden_caps: ['fs:*', '*'] },
    });
    assert.equal(ok.ok, true);

    for (const bad of ['a*:*', '**:*']) {
      const res = checkIntent({
        api: 'intent/1.0',
        goal: 'g',
        acceptance: ['a'],
        constraints: { forbidden_caps: [bad] },
      });
      assert.equal(res.ok, false, `${bad} 应被拒绝`);
    }
  });
});

// ------------------------------------------------------------ 4. secret_ids

const roots: string[] = [];
const handles: DaemonHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle === undefined) break;
    await handle.stop().catch(() => {});
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

function preset(name: string): Preset {
  return parsePreset(
    minimalPresetDoc({
      name,
      io_contracts: { inputs: [], outputs: [{ name: 'code', type: 'text' }] },
    }),
  );
}

/** 全桩 runtime:节点直接成功,不依赖真实基座。 */
function stubRuntime(): NodeRuntime {
  return {
    async run(): Promise<RuntimeResult> {
      return { exitCode: 0, events: [], artifacts: [] };
    },
  };
}

async function start(): Promise<DaemonHandle> {
  const stateDir = await mkdtemp(join(tmpdir(), 'neoba-align-'));
  roots.push(stateDir);
  const handle = await startDaemon({
    port: 0,
    stateDir,
    presets: { coder: preset('coder') },
    runtime: stubRuntime(),
  });
  handles.push(handle);
  return handle;
}

async function rpc(handle: DaemonHandle, method: string, params: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${handle.baseUrl}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${handle.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as Record<string, unknown>;
}

const ONE_NODE = {
  api: 'workflow/1.0',
  intent_ref: 'wf-1',
  nodes: [{ id: 'impl', preset: 'coder' }],
  outputs: [{ from: 'impl.outputs.code', required: false }],
  feedback: [],
  evidence: [],
};

describe('protocol/alignment #24: workflow.run secret_ids 校验冻结 pattern', () => {
  it('不合 pattern 的 id(如 MY_TOKEN)→ InvalidParams', async () => {
    const handle = await start();
    const res = await rpc(handle, 'workflow.run', {
      workflow: ONE_NODE,
      secret_ids: ['MY_TOKEN'],
    });
    const err = res['error'] as Record<string, unknown> | undefined;
    assert.ok(err, '应返回错误');
    assert.match(String(err['message']), /secret_ids/);
  });

  it('合法 id(小写标识符)不被该层拒绝', async () => {
    const handle = await start();
    const res = await rpc(handle, 'workflow.run', {
      workflow: ONE_NODE,
      secret_ids: ['github_token'],
    });
    assert.equal(res['error'], undefined, `不应在 secret_ids 层被拒: ${JSON.stringify(res['error'])}`);
    assert.ok((res['result'] as Record<string, unknown>)['task_id']);
  });
});
