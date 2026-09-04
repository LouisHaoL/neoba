/**
 * capability 模块共用的字段级校验小工具(与 common.schema.json 对齐)。
 */
export const CAP_ID_RE = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;
export const SPEC_VERSION_RE = /^\d+\.\d+(\.\d+)?$/;
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const ARTIFACT_NAME_RE = /^[a-z][a-z0-9_-]*$/;
export const IO_TYPE_RE = /^[a-z][a-z0-9_.:-]*$/;
export const PRESET_NAME_RE = /^[a-z0-9][a-z0-9._/-]*$/;
/** cap_id_or_wildcard(common.schema.json):精确 id / 整串 "*" / 前缀通配 "ns:*"。 */
export const CAP_ID_OR_WILDCARD_RE = /^(\*|[a-z][a-z0-9-]*:(\*|[a-z0-9][a-z0-9._-]*))$/;

export const SCOPES: readonly string[] = ['read', 'write', 'admin', 'ro', 'rw'];
export const RISK_LEVELS: readonly string[] = ['low', 'medium', 'high'];
export const CAP_KINDS: readonly string[] = ['mcp_server', 'skill', 'fs_path', 'model'];
export const TIERS: readonly string[] = ['fast', 'standard', 'heavy'];
export const BASES: readonly string[] = ['any', 'claude-code', 'codex', 'opencode'];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 收集问题清单的校验器:字段路径 + 一句话原因,最后一次性抛出。 */
export class Issues {
  private readonly list: string[] = [];

  add(field: string, reason: string): void {
    this.list.push(`${field}: ${reason}`);
  }

  addIf(condition: boolean, field: string, reason: string): void {
    if (condition) this.add(field, reason);
  }

  get isEmpty(): boolean {
    return this.list.length === 0;
  }

  /** 全部问题,以逗号分号连接的可读清单。 */
  get all(): readonly string[] {
    return this.list;
  }
}

/** 枚举成员校验:合法返回原值,否则记一条 issue。 */
export function checkEnum(
  issues: Issues,
  field: string,
  value: unknown,
  allowed: readonly string[],
): boolean {
  if (typeof value === 'string' && allowed.includes(value)) return true;
  issues.add(field, `必须是 ${allowed.join(' | ')} 之一`);
  return false;
}

/** 字符串模式校验:匹配返回原值,否则记一条 issue。 */
export function checkPattern(
  issues: Issues,
  field: string,
  value: unknown,
  re: RegExp,
  what: string,
): boolean {
  if (typeof value === 'string' && re.test(value)) return true;
  issues.add(field, `必须匹配 ${what}`);
  return false;
}

/** 数组元素逐个模式校验(cap_id_or_wildcard 等列表用)。 */
export function checkPatternArray(
  issues: Issues,
  field: string,
  value: unknown,
  re: RegExp,
  what: string,
): boolean {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !re.test(v))) {
    issues.add(field, `必须是非空字符串数组且每项匹配 ${what}`);
    return false;
  }
  return true;
}
