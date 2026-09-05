/**
 * harness 模块错误(§4 多基座集成)。
 */

/** 工厂收到未知基座名(注册表外的 base)——显式拒绝,不静默降级。 */
export class AdapterUnknown extends Error {
  readonly base: string;
  readonly known: readonly string[];

  constructor(base: string, known: readonly string[]) {
    super(
      `未知基座 "${base}"(已知:${known.join(', ')})` +
        ';请在 preset.base 中使用已注册基座,或扩展 harness/adapter.ts 注册表',
    );
    this.name = 'AdapterUnknown';
    this.base = base;
    this.known = known;
  }
}
