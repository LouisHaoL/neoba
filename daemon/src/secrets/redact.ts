/**
 * 凭据脱敏(§3.8 强制:审计日志与事件流对凭据值强制脱敏,
 * args_digest 等字段不含 secret 内容)。
 *
 * 用法:进程内持有一个 Redactor,凡 SecretStore.set 写入过的值都 register
 * 进去(可经 SecretStore 自动完成);事件/审计序列化前先过 redactDeep。
 *
 * 脱敏串形态(稳定,可跨进程对比):
 *   已注册的值  →  secret:<id 前 8 字符>[REDACTED]     (如 secret:github-t[REDACTED])
 *   未注册的串  →  secret:<sha256 前 8 位>[REDACTED]   (稳定且不可逆向)
 */
import { createHash } from 'node:crypto';

/** 已知 secret 值的稳定脱敏串(取 id 前 8 字符)。 */
export function secretRefToken(secretId: string): string {
  return `secret:${secretId.slice(0, 8)}[REDACTED]`;
}

function unknownToken(value: string): string {
  const digest = createHash('sha256').update(value, 'utf8').digest('hex');
  return `secret:${digest.slice(0, 8)}[REDACTED]`;
}

/** 未注册值的稳定脱敏串(sha256 前 8 位,不可逆向)。独立暴露给
 * 没有 Redactor 上下文、但确定手里是敏感串的调用点。 */
export function redactUnknownValue(value: string): string {
  if (value === '') return '';
  return unknownToken(value);
}

export class Redactor {
  /** value → secret id(反向索引;只在进程内存里,不落盘)。 */
  private readonly knownValues = new Map<string, string>();

  /** entries: [secretId, value] 二元组序列。 */
  constructor(entries?: Iterable<readonly [string, string]>) {
    if (entries !== undefined) {
      for (const entry of entries) {
        this.register(entry[0], entry[1]);
      }
    }
  }

  /** 注册一个已知凭据值。空串不注册(空串是万能匹配,注册即误报)。 */
  register(secretId: string, value: string): void {
    if (typeof value === 'string' && value !== '') {
      this.knownValues.set(value, secretId);
    }
  }

  /** 单值脱敏。空串原样返回(无内容可泄)。 */
  redact(value: string): string {
    const id = this.knownValues.get(value);
    if (id !== undefined) return secretRefToken(id);
    if (value === '') return '';
    return unknownToken(value);
  }

  /** 深度遍历:数组与普通对象逐层复制并对字符串成员做已知值替换;
   * Date/Map/Set 等其他类型原样保留;循环引用按原样截断(不展开)。
   * 返回新结构,不改入参。**只替换已注册的已知值** ——
   * 未注册的普通文本(日志正文)原样通过。 */
  redactDeep<T>(value: T): T {
    return walkRedact(value, this.knownValues, new WeakSet<object>()) as T;
  }

  /** 深度检测结构中是否含已注册的凭据值(事件落盘前的廉价闸门)。 */
  containsSecret(value: unknown): boolean {
    return walkContains(value, this.knownValues, new WeakSet<object>());
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walkRedact(
  value: unknown,
  known: Map<string, string>,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return known.has(value) ? secretRefToken(known.get(value)!) : value;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return value; // 循环引用:原样截断
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => walkRedact(item, known, seen));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = walkRedact(value[key], known, seen);
    }
    return out;
  }
  return value; // Date / Map / Set / 类实例等,原样保留
}

function walkContains(
  value: unknown,
  known: Map<string, string>,
  seen: WeakSet<object>,
): boolean {
  if (typeof value === 'string') return known.has(value);
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => walkContains(item, known, seen));
  }
  if (isPlainObject(value)) {
    return Object.keys(value).some((key) =>
      walkContains(value[key], known, seen),
    );
  }
  return false;
}
