/**
 * 通配匹配(§3 总则通用 Schema 约定:匹配规则写死,不允许实现自定义模糊匹配):
 * - 精确:pattern 与值全等;
 * - "*":仅整串通配(命中一切);
 * - "ns:*":前缀通配,命中命名空间 ns 下全部("mcp:*" 命中所有 mcp: 开头 cap)。
 *
 * cap 与模型名各走一条(模型前缀以 "/" 分隔,"provider/*")。审批流与
 * PlanCheck 共用本实现(forbidden_caps 的唯一匹配语义)。
 */

/** cap 禁授/通配匹配:pattern ∈ { 精确 cap id, "*", "ns:*" }。 */
export function matchCapPattern(cap: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) return cap.startsWith(pattern.slice(0, -1));
  return cap === pattern;
}

/** 任一 pattern 命中即 true(禁授清单语义:命中任意一条即禁)。 */
export function matchAnyCapPattern(cap: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchCapPattern(cap, p));
}
