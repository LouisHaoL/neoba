/**
 * budget 模块对外类型(§3.5f 预算执行)。
 */

/** 预算配置(intent.constraints.budget_tokens 是唯一必填来源;soft 缺省 80%)。 */
export interface BudgetConfig {
  /** hard limit(token 总量)。 */
  readonly limitTokens: number;
  /** soft limit 比例,缺省 0.8(§3.5f:soft 默认 80%)。 */
  readonly softRatio?: number;
}

export type BudgetLevel = 'ok' | 'soft' | 'hard';

/** record 的结论:本次触发的新 crossing(事件由 ledger 发,调用方不用重复发)。 */
export interface RecordVerdict {
  readonly observedTokens: number;
  /** 本次新触发的档位(状态未越级时为空数组)。 */
  readonly crossed: readonly ('soft' | 'hard')[];
  /** 当前整体档位。 */
  readonly level: BudgetLevel;
  /** hard 触发时的处置动作(§3.5f:pause 节点 + 升级主控)。 */
  readonly action?: 'paused';
}

/** 续预算结果(§3.5f hard 处置:续预算或终止)。 */
export interface RaiseResult {
  readonly limitTokens: number;
  readonly softTokens: number;
  /** 续预算后档位回落,soft 重新武装(再次越线会再发 warning)。 */
  readonly reArmed: boolean;
}
