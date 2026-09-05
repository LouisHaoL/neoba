/**
 * Model Score Registry(§3.9,P2 落地;数据结构随 P0 冻结):
 *
 * - 加载校验:单模型条目(schema 根)或 daemon 侧 modelscore/1.0 多模型容器,
 *   一次报出全部问题;运行时零第三方依赖,校验为手写 schema 子集;
 * - 准入:allowed_models 匹配(精确 / "*" 整串 / "provider/*" 前缀,规则写死);
 *   准入是安全面一票否决,评分只是排序;
 * - 选型:tier_fit[tier] × effectiveObserved(tier) 排序;observed 桶为 null
 *   (无样本)回退 prior 同档值;
 * - 反馈:observed 按 tier 分桶独立 EMA(α≈0.15),samples 按桶计数,
 *   dimensions 全模型聚合滚动;quality 缺省时样本仅以 success_rate 收敛、
 *   步长减半(评分诚实性约定);样本记录附任务元数据(只记录不校准)。
 *
 * 不可变约定:所有更新返回新条目(replace,不原地改),调用方负责持久化
 * (daemon 接线把 toJSON 快照写入状态目录)。
 */
import { ModelRegistryInvalid, ModelUnknown } from './errors.ts';
import type {
  AdmissionVerdict,
  AllowedModels,
  FeedbackResult,
  LoadedModelRegistry,
  ModelFeedback,
  ModelRegistryDoc,
  ModelScoreEntry,
  SampleRecord,
  ScoreDimensions,
  Tier,
  TieredMaybeScore,
  TieredSamples,
  TieredScore,
} from './types.ts';
import { TIERS } from './types.ts';

/** §3.9 钉死的 EMA 系数。 */
export const EMA_ALPHA = 0.15;

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SPEC_VERSION_RE = /^\d+\.\d+(\.\d+)?$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const TIER_SET: readonly string[] = TIERS;

// ---------------------------------------------------------------- 校验工具

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isUnit(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function unitOrIssue(v: unknown, issues: string[], field: string): void {
  if (!isUnit(v)) issues.push(`${field}: 必须是 0~1 的数值`);
}

function tieredScore(v: unknown, issues: string[], field: string): TieredScore | null {
  if (!isPlainObject(v)) {
    issues.push(`${field}: 必须是对象`);
    return null;
  }
  let ok = true;
  for (const tier of TIER_SET) {
    if (!isUnit(v[tier])) {
      issues.push(`${field}.${tier}: 必须是 0~1 的数值`);
      ok = false;
    }
  }
  return ok ? (v as unknown as TieredScore) : null;
}

function tieredMaybeScore(v: unknown, issues: string[], field: string): TieredMaybeScore | null {
  if (!isPlainObject(v)) {
    issues.push(`${field}: 必须是对象`);
    return null;
  }
  let ok = true;
  for (const tier of TIER_SET) {
    const x = v[tier];
    if (x !== null && !isUnit(x)) {
      issues.push(`${field}.${tier}: 必须是 0~1 的数值或 null`);
      ok = false;
    }
  }
  return ok ? (v as unknown as TieredMaybeScore) : null;
}

function tieredSamples(v: unknown, issues: string[], field: string): TieredSamples | null {
  if (!isPlainObject(v)) {
    issues.push(`${field}: 必须是对象`);
    return null;
  }
  let ok = true;
  for (const tier of TIER_SET) {
    const x = v[tier];
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0) {
      issues.push(`${field}.${tier}: 必须是非负整数`);
      ok = false;
    }
  }
  return ok ? (v as unknown as TieredSamples) : null;
}

/** 校验并归一单模型条目(条目级问题进 issues;结构不可救时返回 null)。 */
function loadEntry(raw: unknown, issues: string[], field: string): ModelScoreEntry | null {
  if (!isPlainObject(raw)) {
    issues.push(`${field}: 必须是对象`);
    return null;
  }
  const before = issues.length;
  if (raw['protocol'] !== '1.0') issues.push(`${field}.protocol: 必须为 "1.0"`);
  if (typeof raw['spec_version'] !== 'string' || !SPEC_VERSION_RE.test(raw['spec_version'])) {
    issues.push(`${field}.spec_version: 必须是 \\d+.\\d+(.\\d+)? 形式`);
  }
  if (typeof raw['model'] !== 'string' || !MODEL_RE.test(raw['model'])) {
    issues.push(`${field}.model: 必须匹配 ${MODEL_RE.source}`);
  }
  const tierFit = tieredScore(raw['tier_fit'], issues, `${field}.tier_fit`);
  let prior: TieredScore | null = null;
  let observed: TieredMaybeScore | null = null;
  let samples: TieredSamples | null = null;
  let dimensions: ScoreDimensions | null = null;
  if (isPlainObject(raw['score'])) {
    const score = raw['score'];
    prior = tieredScore(score['prior'], issues, `${field}.score.prior`);
    observed = tieredMaybeScore(score['observed'], issues, `${field}.score.observed`);
    samples = tieredSamples(score['samples'], issues, `${field}.score.samples`);
    if (isPlainObject(score['dimensions'])) {
      const d = score['dimensions'];
      const dims: Record<string, number> = {};
      let dOk = true;
      for (const key of ['quality', 'success_rate', 'cost_efficiency']) {
        if (!isUnit(d[key])) {
          issues.push(`${field}.score.dimensions.${key}: 必须是 0~1 的数值`);
          dOk = false;
        } else {
          dims[key] = d[key] as number;
        }
      }
      dimensions = dOk
        ? { quality: dims['quality']!, success_rate: dims['success_rate']!, cost_efficiency: dims['cost_efficiency']! }
        : null;
    } else {
      issues.push(`${field}.score.dimensions: 必须是对象`);
    }
  } else {
    issues.push(`${field}.score: 必须是对象`);
  }
  // sample_records(schema 可选)。
  let sampleRecords: SampleRecord[] = [];
  if (raw['sample_records'] !== undefined) {
    if (!Array.isArray(raw['sample_records'])) {
      issues.push(`${field}.sample_records: 必须是数组`);
    } else {
      raw['sample_records'].forEach((rec, i) => {
        const f = `${field}.sample_records[${i}]`;
        if (!isPlainObject(rec)) {
          issues.push(`${f}: 必须是对象`);
          return;
        }
        if (typeof rec['ts'] !== 'string' || !TIMESTAMP_RE.test(rec['ts'])) {
          issues.push(`${f}.ts: 必须是 RFC3339 时间戳`);
        }
        if (!TIER_SET.includes(rec['tier'] as string)) {
          issues.push(`${f}.tier: 必须是 ${TIER_SET.join('/')}`);
        }
        for (const key of ['task_type', 'budget_tier']) {
          if (typeof rec[key] !== 'string' || (rec[key] as string).length === 0) {
            issues.push(`${f}.${key}: 必须是非空字符串`);
          }
        }
        if (typeof rec['traversals'] !== 'number' || !Number.isInteger(rec['traversals']) || rec['traversals'] < 0) {
          issues.push(`${f}.traversals: 必须是非负整数`);
        }
        if (rec['success'] !== undefined && typeof rec['success'] !== 'boolean') {
          issues.push(`${f}.success: 必须是布尔值`);
        }
        if (rec['quality'] !== undefined && !isUnit(rec['quality'])) {
          issues.push(`${f}.quality: 必须是 0~1 的数值`);
        }
        sampleRecords.push(rec as unknown as SampleRecord);
      });
    }
  }
  if (typeof raw['updated_at'] !== 'string' || !TIMESTAMP_RE.test(raw['updated_at'])) {
    issues.push(`${field}.updated_at: 必须是 RFC3339 时间戳`);
  }
  if (issues.length > before) return null;
  return {
    protocol: '1.0',
    spec_version: raw['spec_version'] as string,
    model: raw['model'] as string,
    tier_fit: tierFit!,
    score: { prior: prior!, observed: observed!, samples: samples!, dimensions: dimensions! },
    ...(sampleRecords.length > 0 ? { sample_records: sampleRecords } : {}),
    updated_at: raw['updated_at'] as string,
  };
}

/**
 * 解析注册表文档:接受单模型条目(schema 根)或 modelscore/1.0 容器
 * ({ api, models: [...] })。模型名重复 → 非法。
 */
export function loadModelRegistry(raw: unknown): LoadedModelRegistry {
  const issues: string[] = [];
  let items: readonly unknown[];
  if (isPlainObject(raw) && raw['api'] === 'modelscore/1.0') {
    if (!Array.isArray(raw['models'])) {
      throw new ModelRegistryInvalid(['models: 必须是数组']);
    }
    items = raw['models'];
  } else {
    items = [raw];
  }
  const entries: ModelScoreEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const entry = loadEntry(items[i], issues, `models[${i}]`);
    if (entry !== null) {
      if (seen.has(entry.model)) issues.push(`models[${i}].model: 重复的模型 "${entry.model}"`);
      seen.add(entry.model);
      entries.push(entry);
    }
  }
  if (issues.length > 0) throw new ModelRegistryInvalid(issues);
  const frozen = Object.freeze(entries);
  const index = new Map(frozen.map((e) => [e.model, e]));
  return { entries: frozen, get: (model: string) => index.get(model) };
}

// ---------------------------------------------------------------- 准入(安全面)

/**
 * 模型名通配匹配(§3 总则:规则写死,不允许自定义模糊匹配):
 * 精确名;"*" 仅整串通配;"provider/*" 前缀通配(命中 provider/ 命名空间全部)。
 */
export function matchModelPattern(model: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) return model.startsWith(pattern.slice(0, -1));
  return model === pattern;
}

/**
 * 准入判定:命中任一 allowlist 规则即通过。空 allowlist = 全拒
 * (白名单语义,从严;intent schema default 是 ["*"],显式给 [] 是有意收紧)。
 */
export function checkAdmission(model: string, allowed: AllowedModels): AdmissionVerdict {
  for (const pattern of allowed) {
    if (matchModelPattern(model, pattern)) return { admitted: true, rejectedBy: null };
  }
  return { admitted: false, rejectedBy: allowed.length > 0 ? (allowed[0] as string) : '(空 allowlist)' };
}

// ---------------------------------------------------------------- 选型(排序面)

/** 桶生效分:observed 为 null(无样本)回退 prior 同档值。 */
export function effectiveScore(entry: ModelScoreEntry, tier: Tier): number {
  const observed = entry.score.observed[tier];
  return observed ?? entry.score.prior[tier];
}

/**
 * 档位选型排序(§3.9 闭环第 3 步):tier_fit[tier] × effectiveScore(tier),
 * 降序;分相同按模型名字典序(确定性)。不做准入 —— 准入是调用方的前置
 * 过滤(一票否决在 checkAdmission / assertAdmitted)。
 */
export function rankForTier(entries: readonly ModelScoreEntry[], tier: Tier): readonly ModelScoreEntry[] {
  return [...entries].sort((a, b) => {
    const sa = a.tier_fit[tier] * effectiveScore(a, tier);
    const sb = b.tier_fit[tier] * effectiveScore(b, tier);
    if (sa !== sb) return sb - sa;
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  });
}

// ---------------------------------------------------------------- 反馈(EMA)

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function ema(old: number, sample: number, alpha: number): number {
  return clamp01((1 - alpha) * old + alpha * sample);
}

/**
 * 记一次任务反馈并滚动更新(§3.9 闭环第 4/5 步):
 * - 样本分 = quality 缺省 ? success(0/1) : 0.5×quality + 0.5×success;
 * - 步长 = quality 缺省 ? α/2 : α(权重降低,防单次噪声振荡);
 * - observed[tier] 桶独立 EMA,samples[tier] +1,dimensions 全模型聚合
 *   (quality 只在提供时更新;cost_efficiency 同理);
 * - sample_records 追加任务元数据(只记录不校准)。
 * 模型不存在 → ModelUnknown。
 */
export function recordFeedback(
  registry: LoadedModelRegistry,
  feedback: ModelFeedback,
  options: { readonly now?: () => Date } = {},
): FeedbackResult {
  const entry = registry.get(feedback.model);
  if (entry === undefined) throw new ModelUnknown(feedback.model);
  const tier = feedback.tier;
  const success = feedback.success ? 1 : 0;
  const hasQuality = feedback.quality !== undefined;
  const sampleScore = hasQuality ? 0.5 * (feedback.quality as number) + 0.5 * success : success;
  const alpha = hasQuality ? EMA_ALPHA : EMA_ALPHA / 2;

  const oldObserved = entry.score.observed[tier];
  const newObserved = oldObserved === null ? sampleScore : ema(oldObserved, sampleScore, alpha);
  const oldSamples = entry.score.samples[tier];
  const dims = entry.score.dimensions;
  const newDimensions: ScoreDimensions = {
    quality: hasQuality ? ema(dims.quality, feedback.quality as number, EMA_ALPHA) : dims.quality,
    success_rate: ema(dims.success_rate, success, EMA_ALPHA),
    cost_efficiency:
      feedback.costEfficiency !== undefined
        ? ema(dims.cost_efficiency, feedback.costEfficiency, EMA_ALPHA)
        : dims.cost_efficiency,
  };
  const record: SampleRecord = {
    ts: (options.now?.() ?? new Date()).toISOString(),
    tier,
    task_type: feedback.taskType,
    budget_tier: feedback.budgetTier,
    traversals: feedback.traversals,
    success: feedback.success,
    ...(hasQuality ? { quality: feedback.quality as number } : {}),
  };
  const next: ModelScoreEntry = {
    ...entry,
    tier_fit: { ...entry.tier_fit },
    score: {
      prior: { ...entry.score.prior },
      observed: { ...entry.score.observed, [tier]: newObserved },
      samples: { ...entry.score.samples, [tier]: oldSamples + 1 },
      dimensions: newDimensions,
    },
    sample_records: [...(entry.sample_records ?? []), record],
    updated_at: record.ts,
  };
  return { entry: next, alphaApplied: alpha, sampleScore };
}
