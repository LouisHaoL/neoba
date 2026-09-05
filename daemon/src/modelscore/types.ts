/**
 * Model Score Registry 对外类型(§3.9,结构按 model-score-registry.schema.json
 * P0 冻结物)。协议 schema 根 = 单模型条目;多模型注册表是 daemon 侧容器
 * (modelscore/1.0 包装文档),不进协议。
 */

export type Tier = 'fast' | 'standard' | 'heavy';

export const TIERS: readonly Tier[] = ['fast', 'standard', 'heavy'];

/** 分桶评分:三档各一个值。 */
export interface TieredScore {
  readonly fast: number;
  readonly standard: number;
  readonly heavy: number;
}

/** 分桶可空评分:observed 用(null = 该桶尚无实测样本)。 */
export interface TieredMaybeScore {
  readonly fast: number | null;
  readonly standard: number | null;
  readonly heavy: number | null;
}

/** 分桶样本计数。 */
export interface TieredSamples {
  readonly fast: number;
  readonly standard: number;
  readonly heavy: number;
}

/** 分维度评分(全模型聚合,不按桶,§3.9)。 */
export interface ScoreDimensions {
  readonly quality: number;
  readonly success_rate: number;
  readonly cost_efficiency: number;
}

/** 单条实测样本的任务元数据(schema sampleRecord;评分诚实性约定 v0.2)。 */
export interface SampleRecord {
  readonly ts: string;
  readonly tier: Tier;
  readonly task_type: string;
  readonly budget_tier: string;
  readonly traversals: number;
  readonly success?: boolean;
  readonly quality?: number;
}

/** schema 根:单模型评分条目。 */
export interface ModelScoreEntry {
  readonly protocol: '1.0';
  readonly spec_version: string;
  readonly model: string;
  readonly tier_fit: TieredScore;
  readonly score: {
    readonly prior: TieredScore;
    readonly observed: TieredMaybeScore;
    readonly samples: TieredSamples;
    readonly dimensions: ScoreDimensions;
  };
  readonly sample_records?: readonly SampleRecord[];
  readonly updated_at: string;
}

/** daemon 侧多模型容器文档(modelscore/1.0,非协议物)。 */
export interface ModelRegistryDoc {
  readonly api: 'modelscore/1.0';
  readonly models: readonly unknown[];
}

/** 加载后的注册表:按模型名索引 + 决策/反馈操作(见 registry.ts)。 */
export interface LoadedModelRegistry {
  readonly entries: readonly ModelScoreEntry[];
  /** 按模型名查询;不存在返回 undefined。 */
  get(model: string): ModelScoreEntry | undefined;
}

// ---------------------------------------------------------------- 决策与反馈

/** 模型准入 allowlist(匹配语义同 forbidden_caps:精确 / "*" / "provider/*")。 */
export type AllowedModels = readonly string[];

/** 准入判定结论。 */
export interface AdmissionVerdict {
  readonly admitted: boolean;
  /** 拒绝时命中的是哪条规则(诊断用;admitted = true 时为 null)。 */
  readonly rejectedBy: string | null;
}

/**
 * 反馈输入(§3.9 闭环第 4 步:每次任务结束验收方给一次反馈)。
 * quality 可选:缺省时该样本仅以 success_rate 收敛、EMA 步长减半
 * (评分诚实性约定:防单次噪声振荡)。
 */
export interface ModelFeedback {
  readonly model: string;
  readonly tier: Tier;
  readonly success: boolean;
  readonly quality?: number;
  /** token 成效比(0~1);缺省则 cost_efficiency 维度不更新。 */
  readonly costEfficiency?: number;
  /** 任务元数据(难度代理,只记录不校准)。 */
  readonly taskType: string;
  readonly budgetTier: string;
  readonly traversals: number;
}

/** 反馈后的快照(回给调用方;entry 为更新后的新条目,不可变替换)。 */
export interface FeedbackResult {
  readonly entry: ModelScoreEntry;
  /** 本次实际生效的 EMA 步长(quality 缺省时为 α/2,诊断用)。 */
  readonly alphaApplied: number;
  /** 本次落入 observed 桶的样本分。 */
  readonly sampleScore: number;
}
