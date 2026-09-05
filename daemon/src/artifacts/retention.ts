/**
 * retention 策略定型(daemon 侧,M5 工件自动 GC)。
 *
 * 语义(以 daemon 行为为准;协议 schema 本轮冻结不动):
 *   - RetentionPolicy = { mode: 'forever' } | { mode: 'days', days: number(整数 >= 1) };
 *   - 'forever':manifest 永不因到期被 GC 删除;
 *   - 'days':manifest 发布满 days 天且所属任务已终态(completed/failed/cancelled)
 *     时,GC 才允许删除 manifest 指针;删后其对象变孤儿,由下一轮 GC 清扫;
 *   - 非法值(缺字段 / 越界 / 类型不对)一律按 forever 处理并产生 warning
 *     (经 onWarning 钩子落日志 / PublishResult.retentionWarnings 回传),
 *     读路径永不因 retention 非法而抛错;
 *   - manifest 指针上的落盘形态是规范字符串:'forever' | 'days:<n>';
 *     旧数据里的 null = 未声明,按 forever 处理(不告警,属合法缺省)。
 *
 * 零第三方依赖;本模块为纯函数,供 repository(读写 manifest)与 gc(到期判定)共用。
 */

/** 工件保留策略(闭集字面量联合,不用 enum)。 */
export type RetentionPolicy =
  | { readonly mode: 'forever' }
  | { readonly mode: 'days'; readonly days: number };

/** 永久保留的规范常量。 */
export const RETAIN_FOREVER: RetentionPolicy = { mode: 'forever' };

/** 解析结果:policy 恒为合法策略(非法输入已降级为 forever);warnings 收集告警文案。 */
export interface RetentionParseResult {
  readonly policy: RetentionPolicy;
  readonly warnings: readonly string[];
}

/** 超长入参截断,告警文案不带爆量载荷。 */
function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function invalid(value: unknown, detail: string): RetentionParseResult {
  return {
    policy: RETAIN_FOREVER,
    warnings: [`非法 retention(${detail}): ${preview(value)},按 forever 处理`],
  };
}

/**
 * 把外部输入(publish 选项 / RPC 参数,任意 JSON)解析成合法策略。
 * 缺省(null/undefined)是合法的 forever,不告警;其余非法值降级 forever + warning。
 */
export function parseRetentionPolicy(value: unknown): RetentionParseResult {
  if (value === undefined || value === null) return { policy: RETAIN_FOREVER, warnings: [] };
  if (typeof value !== 'object') return invalid(value, '不是对象');
  const v = value as Record<string, unknown>;
  if (v['mode'] === 'forever') return { policy: RETAIN_FOREVER, warnings: [] };
  if (v['mode'] === 'days') {
    const days = v['days'];
    if (typeof days !== 'number' || !Number.isInteger(days)) {
      return invalid(value, 'days 不是整数');
    }
    if (days < 1) return invalid(value, `days=${days} 越界(须 >= 1)`);
    return { policy: { mode: 'days', days }, warnings: [] };
  }
  return invalid(value, `未知 mode: ${preview(v['mode'])}`);
}

/** 落盘规范形态:'forever' | 'days:<n>'。 */
export function serializeRetentionPolicy(policy: RetentionPolicy): string {
  return policy.mode === 'days' ? `days:${policy.days}` : 'forever';
}

/**
 * 从 manifest 指针的落盘字段读回策略:规范串照读;null(旧数据未声明)按
 * forever 不告警;其余(手改盘 / 历史脏数据)按 forever + 告警。
 */
export function retentionFromDiskValue(value: string | null): RetentionParseResult {
  if (value === null) return { policy: RETAIN_FOREVER, warnings: [] };
  if (value === 'forever') return { policy: RETAIN_FOREVER, warnings: [] };
  const match = /^days:(\d+)$/.exec(value);
  if (match !== null) {
    const days = Number(match[1]);
    if (Number.isInteger(days) && days >= 1) {
      return { policy: { mode: 'days', days }, warnings: [] };
    }
  }
  return invalid(value, 'manifest 落盘值不认识');
}
