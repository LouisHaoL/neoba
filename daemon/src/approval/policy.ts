/**
 * 审批策略分层评估(§3.3 审批配置分层):
 *
 *   内置默认 < 全局配置 < preset.escalation_policy < orchestrator session 覆盖
 *
 * 合并语义(确定性、从严):
 * 1. 协议硬底线(§3.3,不可被任何层级覆盖)最优先:high+write/admin 与
 *    risk 缺失(fail-closed)一律 require;
 * 2. 收集层栈内全部命中的 require / auto 模式,按**特异性**裁决:
 *    精确 > 命名空间前缀通配("ns:*" / "provider/*") > "*" 整串;
 * 3. 同特异性 → require 胜(从严);
 * 4. 全不命中 → require(清单外能力一律逐条审批)。
 * 命中的模式来自哪一层,决定 decision_source 的 auto_rule:{层 id}。
 * 通配匹配复用 plancheck 的写死规则(精确 / "*" 整串 / "ns:*" 前缀)。
 */
import { hardlineVerdict } from '../capability/index.ts';
import type { RiskLevel, Scope } from '../capability/index.ts';
import { matchCapPattern } from '../plancheck/index.ts';
import type { PolicyLayer, PolicyOutcome } from './types.ts';

/** 内置默认层:清单外一律逐条审批(最保守,无自动放行)。 */
export const BUILTIN_LAYER: PolicyLayer = {
  id: 'builtin:default',
  policy: { auto_approve: [], require_approval: ['*'] },
};

/**
 * 组装层栈(低 → 高)。builtin 恒在栈底;global / preset / session 层由
 * 调用方按部署配置给出。
 */
export function policyStack(
  parts: {
    readonly global?: EscalationPolicyLike;
    readonly preset?: PolicyLayer;
    readonly session?: PolicyLayer;
  } = {},
): readonly PolicyLayer[] {
  const layers: PolicyLayer[] = [BUILTIN_LAYER];
  if (parts.global !== undefined) {
    layers.push({ id: 'global', policy: parts.global });
  }
  if (parts.preset !== undefined) layers.push(parts.preset);
  if (parts.session !== undefined) layers.push(parts.session);
  return layers;
}

/** 全局配置层的宽松形状(与 EscalationPolicy 同构;单独导出避免环导入)。 */
export interface EscalationPolicyLike {
  readonly auto_approve: readonly string[];
  readonly require_approval: readonly string[];
}

/** 模式特异性:精确 = 2,前缀通配 = 1,"*" = 0;不匹配 = -1。 */
function patternSpecificity(cap: string, pattern: string): number {
  if (pattern === '*') return matchCapPattern(cap, pattern) ? 0 : -1;
  if (pattern.endsWith(':*') || pattern.endsWith('/*')) {
    return matchCapPattern(cap, pattern) ? 1 : -1;
  }
  return cap === pattern ? 2 : -1;
}

interface Match {
  readonly outcome: PolicyOutcome;
  /** 命中层 id(auto 时作 decision_source = auto_rule:{id})。 */
  readonly layerId: string;
  readonly specificity: number;
}

function collectMatches(layers: readonly PolicyLayer[], cap: string): Match[] {
  const matches: Match[] = [];
  for (const layer of layers) {
    // builtin 层不参与特异性竞争:它是"清单外一律审批"的兜底缺省,
    // 只在没有任何配置层命中时生效(见 evaluateRequest 的缺省分支)。
    if (layer.id === BUILTIN_LAYER.id) continue;
    const bestOf = (patterns: readonly string[]): number => {
      let best = -1;
      for (const pattern of patterns) {
        const s = patternSpecificity(cap, pattern);
        if (s > best) best = s;
      }
      return best;
    };
    const requireSpec = bestOf(layer.policy.require_approval);
    if (requireSpec >= 0) {
      matches.push({ outcome: 'require', layerId: layer.id, specificity: requireSpec });
    }
    const autoSpec = bestOf(layer.policy.auto_approve);
    if (autoSpec >= 0) {
      matches.push({ outcome: 'auto', layerId: layer.id, specificity: autoSpec });
    }
  }
  return matches;
}

/**
 * 评估一个升级申请的处置路径(语义见模块头):
 * 硬底线 → 特异性裁决(同特异性 require 胜)→ 缺省 require。
 */
export function evaluateRequest(
  layers: readonly PolicyLayer[],
  cap: string,
  scope: Scope,
  riskLevel?: RiskLevel,
): { readonly outcome: PolicyOutcome; readonly ruleId: string | null } {
  const verdict = hardlineVerdict(riskLevel, scope);
  if (verdict !== 'permitted') {
    return { outcome: 'require', ruleId: `hardline:${verdict}` };
  }
  const matches = collectMatches(layers, cap);
  if (matches.length === 0) return { outcome: 'require', ruleId: 'default:require' };
  const best = matches.reduce((a, b) => {
    if (b.specificity !== a.specificity) return b.specificity > a.specificity ? b : a;
    // 同特异性:require 胜(从严);同为 require 取更高层。
    if (a.outcome !== b.outcome) return b.outcome === 'require' ? b : a;
    return b;
  });
  return { outcome: best.outcome, ruleId: best.layerId };
}
