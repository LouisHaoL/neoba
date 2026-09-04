/**
 * 协议层硬底线(§3.3 v0.2,纯函数):risk_level = high 且
 * scope ∈ {write, admin} 的能力,禁止进入任何 source 为自动放行的授予;
 * 不进配置,不可被任何层级覆盖。本期 P1 只有 baseline 授予(设计产物、
 * 人工把关,不走 auto_rule 放行路径),本函数先立住供 P2 审批流接线。
 */
import type { RiskLevel, Scope } from './types.ts';

export type HardlineVerdict =
  /** 允许进入自动放行授予。 */
  | 'permitted'
  /** 命中硬底线:high + write/admin,任何自动放行路径必须拒绝。 */
  | 'forbidden'
  /** 注册表未给出 risk_level(schema 可选字段):无法判定,fail-closed。 */
  | 'unknown_risk';

const AUTO_SENSITIVE_SCOPES: ReadonlySet<string> = new Set(['write', 'admin']);

/** 硬底线三态判定。risk_level 缺失(unknown)按不可自动放行处理。 */
export function hardlineVerdict(
  riskLevel: RiskLevel | undefined,
  scope: Scope,
): HardlineVerdict {
  if (riskLevel === undefined) return 'unknown_risk';
  if (riskLevel === 'high' && AUTO_SENSITIVE_SCOPES.has(scope)) return 'forbidden';
  return 'permitted';
}

/** 自动放行路径的统一判定口径:仅 permitted 可自动放行(fail-closed)。 */
export function hardlineAllowsAuto(verdict: HardlineVerdict): boolean {
  return verdict === 'permitted';
}
