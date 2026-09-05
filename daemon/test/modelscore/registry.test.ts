/**
 * Model Score Registry 测试(§3.9):加载校验(单条目/多模型容器/重复模型/
 * 非法字段)、准入匹配(精确 / "*" / "provider/*" / 空 allowlist)、
 * 选型排序(observed null 回退 prior)、EMA 反馈(分桶独立、quality 缺省
 * 步长减半、dimensions 滚动、样本记录附任务元数据)。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EMA_ALPHA,
  ModelRegistryInvalid,
  ModelUnknown,
  checkAdmission,
  effectiveScore,
  loadModelRegistry,
  matchModelPattern,
  rankForTier,
  recordFeedback,
} from '../../src/modelscore/index.ts';
import type { ModelScoreEntry } from '../../src/modelscore/index.ts';

function entryDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: '1.0',
    spec_version: '1.0',
    model: 'glm-4.7-air',
    tier_fit: { fast: 0.91, standard: 0.62, heavy: 0.3 },
    score: {
      prior: { fast: 0.88, standard: 0.55, heavy: 0.2 },
      observed: { fast: null, standard: null, heavy: null },
      samples: { fast: 0, standard: 0, heavy: 0 },
      dimensions: { quality: 0.8, success_rate: 0.85, cost_efficiency: 0.74 },
    },
    updated_at: '2026-09-05T00:00:00Z',
    ...overrides,
  };
}

describe('modelscore/loadModelRegistry', () => {
  it('加载单模型条目(schema 根)', () => {
    const reg = loadModelRegistry(entryDoc());
    assert.equal(reg.entries.length, 1);
    assert.equal(reg.get('glm-4.7-air')?.tier_fit.fast, 0.91);
    assert.equal(reg.get('other'), undefined);
  });

  it('加载 modelscore/1.0 多模型容器', () => {
    const doc = {
      api: 'modelscore/1.0',
      models: [entryDoc(), entryDoc({ model: 'claude-opus-5', tier_fit: { fast: 0.4, standard: 0.9, heavy: 0.95 } })],
    };
    const reg = loadModelRegistry(doc);
    assert.equal(reg.entries.length, 2);
    assert.ok(reg.get('claude-opus-5'));
  });

  it('重复模型名报非法', () => {
    assert.throws(
      () => loadModelRegistry({ api: 'modelscore/1.0', models: [entryDoc(), entryDoc()] }),
      (err: unknown) => err instanceof ModelRegistryInvalid && /重复的模型/.test(err.issues.join()),
    );
  });

  it('一次报出全部问题', () => {
    try {
      loadModelRegistry(
        entryDoc({
          protocol: '2.0',
          tier_fit: { fast: 1.5, standard: 'x', heavy: 0.3 },
          score: { prior: {}, observed: {}, samples: {}, dimensions: {} },
        }),
      );
      assert.fail('应抛错');
    } catch (err) {
      assert.ok(err instanceof ModelRegistryInvalid);
      assert.ok(err.issues.length >= 5, `应有多条问题,实际 ${err.issues.length}`);
    }
  });

  it('非对象根报非法', () => {
    assert.throws(() => loadModelRegistry([1, 2]), ModelRegistryInvalid);
  });
});

describe('modelscore/准入', () => {
  it('matchModelPattern 三种语义', () => {
    assert.equal(matchModelPattern('glm-4.7-air', 'glm-4.7-air'), true);
    assert.equal(matchModelPattern('anything', '*'), true);
    assert.equal(matchModelPattern('anthropic/claude-opus-5', 'anthropic/*'), true);
    assert.equal(matchModelPattern('glm-4.7-air', 'anthropic/*'), false);
    assert.equal(matchModelPattern('glm-4.7-air', 'glm-4.7'), false); // 无自定义模糊匹配
  });

  it('checkAdmission 命中任一规则即通过', () => {
    const ok = checkAdmission('anthropic/claude-opus-5', ['glm-4.7-air', 'anthropic/*']);
    assert.equal(ok.admitted, true);
    assert.equal(ok.rejectedBy, null);
  });

  it('checkAdmission 未命中给出一票否决', () => {
    const verdict = checkAdmission('glm-4.7-air', ['anthropic/*']);
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.rejectedBy, 'anthropic/*');
  });

  it('空 allowlist = 全拒(白名单从严)', () => {
    assert.equal(checkAdmission('any', []).admitted, false);
  });
});

describe('modelscore/选型', () => {
  it('observed null 回退 prior 同档值', () => {
    const e = loadModelRegistry(entryDoc()).get('glm-4.7-air')!;
    assert.equal(effectiveScore(e, 'fast'), 0.88);
    assert.equal(effectiveScore(e, 'heavy'), 0.2);
  });

  it('rankForTier 按组合分降序、同分按名序', () => {
    const reg = loadModelRegistry({
      api: 'modelscore/1.0',
      models: [
        entryDoc({ model: 'b-model', tier_fit: { fast: 0.5, standard: 0.5, heavy: 0.5 } }),
        entryDoc({ model: 'a-model', tier_fit: { fast: 0.9, standard: 0.5, heavy: 0.5 } }),
        entryDoc({ model: 'c-model', tier_fit: { fast: 0.9, standard: 0.5, heavy: 0.5 } }),
      ],
    });
    const ranked = rankForTier(reg.entries, 'fast');
    assert.deepEqual(ranked.map((e) => e.model), ['a-model', 'c-model', 'b-model']);
  });
});

describe('modelscore/EMA 反馈', () => {
  it('首条样本:observed 从 null 直接落样本分,samples 计数', () => {
    const reg = loadModelRegistry(entryDoc());
    const result = recordFeedback(reg, {
      model: 'glm-4.7-air',
      tier: 'fast',
      success: true,
      quality: 0.9,
      taskType: 'bugfix',
      budgetTier: 'standard',
      traversals: 0,
    });
    assert.equal(result.entry.score.observed.fast, 0.95); // 0.5*0.9+0.5*1
    assert.equal(result.entry.score.samples.fast, 1);
    assert.equal(result.entry.score.observed.standard, null); // 其他桶不动
    assert.equal(result.alphaApplied, EMA_ALPHA);
  });

  it('分桶独立 EMA:α 加权滚动,quality 缺省步长减半', () => {
    const reg = loadModelRegistry(entryDoc());
    const r1 = recordFeedback(reg, {
      model: 'glm-4.7-air', tier: 'fast', success: true, quality: 0.8,
      taskType: 'bugfix', budgetTier: 'standard', traversals: 0,
    });
    const reg1 = { entries: [r1.entry], get: (m: string) => (m === r1.entry.model ? r1.entry : undefined) };
    const r2 = recordFeedback(reg1, {
      model: 'glm-4.7-air', tier: 'fast', success: false,
      taskType: 'bugfix', budgetTier: 'standard', traversals: 1,
    });
    assert.equal(r2.alphaApplied, EMA_ALPHA / 2);
    // 0.9 → EMA(0.9, 0, α/2) = 0.9*(1-0.075)
    const observedFast = r2.entry.score.observed.fast ?? 0;
    assert.ok(Math.abs(observedFast - 0.9 * (1 - EMA_ALPHA / 2)) < 1e-12);
    assert.equal(r2.entry.score.samples.fast, 2);
  });

  it('dimensions 滚动:quality/cost 只在提供时更新,success_rate 恒滚动', () => {
    const reg = loadModelRegistry(entryDoc());
    const r1 = recordFeedback(reg, {
      model: 'glm-4.7-air', tier: 'fast', success: true,
      taskType: 'refactor', budgetTier: 'low', traversals: 0,
    });
    const d1 = r1.entry.score.dimensions;
    assert.equal(d1.quality, 0.8); // 未提供 → 不动
    assert.ok(d1.success_rate > 0.85); // 成功样本向上滚
    const reg1 = { entries: [r1.entry], get: (m: string) => (m === r1.entry.model ? r1.entry : undefined) };
    const r2 = recordFeedback(reg1, {
      model: 'glm-4.7-air', tier: 'fast', success: true, quality: 0.4, costEfficiency: 0.2,
      taskType: 'refactor', budgetTier: 'low', traversals: 0,
    });
    const d2 = r2.entry.score.dimensions;
    assert.ok(d2.quality < 0.8);
    assert.ok(d2.cost_efficiency < 0.74);
  });

  it('样本记录附任务元数据(只记录不校准)', () => {
    const reg = loadModelRegistry(entryDoc());
    const r = recordFeedback(reg, {
      model: 'glm-4.7-air', tier: 'heavy', success: false, quality: 0.3,
      taskType: 'migration', budgetTier: 'high', traversals: 2,
    }, { now: () => new Date('2026-09-05T08:00:00Z') });
    const rec = r.entry.sample_records?.[0];
    assert.ok(rec);
    assert.equal(rec['task_type'], 'migration');
    assert.equal(rec['budget_tier'], 'high');
    assert.equal(rec['traversals'], 2);
    assert.equal(rec['tier'], 'heavy');
    assert.equal(rec['ts'], '2026-09-05T08:00:00.000Z');
    assert.equal(r.entry.updated_at, '2026-09-05T08:00:00.000Z');
  });

  it('未知模型抛 ModelUnknown', () => {
    const reg = loadModelRegistry(entryDoc());
    assert.throws(
      () =>
        recordFeedback(reg, {
          model: 'nope', tier: 'fast', success: true,
          taskType: 'x', budgetTier: 'x', traversals: 0,
        }),
      ModelUnknown,
    );
  });

  it('更新返回新条目,原条目不被原地改(不可变替换)', () => {
    const reg = loadModelRegistry(entryDoc());
    const before: ModelScoreEntry = reg.get('glm-4.7-air')!;
    recordFeedback(reg, {
      model: 'glm-4.7-air', tier: 'standard', success: true,
      taskType: 'x', budgetTier: 'x', traversals: 0,
    });
    assert.equal(before.score.observed.standard, null);
    assert.equal(before.score.samples.standard, 0);
  });
});
