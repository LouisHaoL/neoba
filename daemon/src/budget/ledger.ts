/**
 * BudgetLedger(§3.5f 预算执行):daemon 为每个 task 维护的预算台账,
 * 聚合 §3.6 usage 事实(sidecar 尽力上报 + daemon 估算硬切,不是精确计费)。
 *
 * 状态机(单调 token 累积,状态可随续预算回落):
 *   ok ──observed ≥ soft──▶ soft(发 budget.warning,一次)
 *   soft/hard(续预算后)──observed ≥ hard──▶ hard(发 budget.exceeded,
 *     action = paused:调用方 pause 节点 + 升级主控,续预算或终止)
 *
 * 事件经注入的 emit 落入事件日志(budget.warning / budget.exceeded,payload
 * 按事件闭集的 BudgetPayload);token 计量口径 = tokens_in + tokens_out。
 * 续预算(raise)后 soft 重新武装:回落到新 soft 之下再次越线会再发 warning。
 *
 * 与 P1 的关系:§9 P1 "usage 只记录不熔断" = 不给 task 配 ledger;本模块
 * 只在配置了 limitTokens 时生效(= P2 熔断开关),没有预算约束时 daemon
 * 行为与 P1 完全一致。
 */
import type { BudgetConfig, BudgetLevel, RaiseResult, RecordVerdict } from './types.ts';

export const DEFAULT_SOFT_RATIO = 0.8;

/** 预算事件出口(daemon 接 EventLog.append)。 */
export interface BudgetEmitInput {
  readonly type: 'budget.warning' | 'budget.exceeded';
  readonly payload: {
    readonly level: 'soft' | 'hard';
    readonly limitTokens: number;
    readonly observedTokens: number;
    readonly action?: 'paused' | 'terminated';
  };
}

export interface BudgetLedgerOptions {
  /** 预算事件出口(注入;测试接数组)。 */
  readonly emit: (event: BudgetEmitInput) => Promise<void> | void;
}

export class BudgetLedger {
  readonly #softRatio: number;
  readonly #emit: (event: BudgetEmitInput) => Promise<void> | void;
  #limitTokens: number;
  #observed = 0;
  #softFired = false;
  #hardFired = false;
  /** emit 串行链:所有事件按发起序(= 同步段入队序)落盘,杜绝并行 await 插队(#22)。 */
  #emitting: Promise<void> = Promise.resolve();

  constructor(config: BudgetConfig, options: BudgetLedgerOptions) {
    if (!Number.isInteger(config.limitTokens) || config.limitTokens < 0) {
      throw new TypeError(`budget.limitTokens 必须是非负整数: ${config.limitTokens}`);
    }
    this.#softRatio = config.softRatio ?? DEFAULT_SOFT_RATIO;
    if (this.#softRatio <= 0 || this.#softRatio > 1) {
      throw new TypeError(`budget.softRatio 必须在 (0, 1] 内: ${this.#softRatio}`);
    }
    this.#limitTokens = config.limitTokens;
    this.#emit = options.emit;
  }

  get limitTokens(): number {
    return this.#limitTokens;
  }

  get softTokens(): number {
    return Math.floor(this.#limitTokens * this.#softRatio);
  }

  get observedTokens(): number {
    return this.#observed;
  }

  /** 当前档位(不含发事件)。 */
  get level(): BudgetLevel {
    if (this.#observed >= this.#limitTokens) return 'hard';
    if (this.#observed >= this.softTokens) return 'soft';
    return 'ok';
  }

  /**
   * 记一笔 usage 事实并推进状态机;新触发的档位发对应事件(warning 一次,
   * exceeded 一次;续预算可重新武装)。
   */
  async record(tokensIn: number, tokensOut: number): Promise<RecordVerdict> {
    if (!Number.isFinite(tokensIn) || !Number.isFinite(tokensOut) || tokensIn < 0 || tokensOut < 0) {
      throw new TypeError(`usage 计量必须是非负有限数: ${tokensIn}/${tokensOut}`);
    }
    const before = this.level;
    this.#observed += tokensIn + tokensOut;
    const after = this.level;
    // 同步段内决定 crossed 集合并按档位序构造事件、置位 flags、全部入队(#22):
    // 若边构造边 await emit,先越 soft 的 record 挂起在 warning 上,后越 hard 的
    // 并发 record 会抢先完成 exceeded → 事件序倒挂(计数本身正确)。
    const crossed: ('soft' | 'hard')[] = [];
    const events: BudgetEmitInput[] = [];
    if (before === 'ok' && after !== 'ok' && !this.#softFired) {
      this.#softFired = true;
      crossed.push('soft');
      events.push({
        type: 'budget.warning',
        payload: { level: 'soft', limitTokens: this.softTokens, observedTokens: this.#observed },
      });
    }
    if (after === 'hard' && !this.#hardFired) {
      this.#hardFired = true;
      crossed.push('hard');
      events.push({
        type: 'budget.exceeded',
        payload: {
          level: 'hard',
          limitTokens: this.#limitTokens,
          observedTokens: this.#observed,
          action: 'paused',
        },
      });
    }
    // 同一同步段内全部挂上串行链再统一等待:落盘序 = 入队序 = warning 先于 exceeded。
    const runs = events.map((event) => this.#emitOrdered(event));
    for (const run of runs) await run;
    return {
      observedTokens: this.#observed,
      crossed,
      level: after,
      ...(after === 'hard' ? { action: 'paused' as const } : {}),
    };
  }

  /**
   * emit 串行化:事件链式执行,后入队的不会在先入队的 await 窗口内插队完成;
   * 单点 emit 失败不阻断链上后续事件。
   */
  #emitOrdered(event: BudgetEmitInput): Promise<void> {
    const run = this.#emitting.then(() => this.#emit(event));
    this.#emitting = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 续预算(§3.5f hard 处置之一):抬高 hard limit;observed 回到新 soft 之下
   * 时 soft 重新武装。返回快照供事件/审计。
   */
  raise(newLimitTokens: number): RaiseResult {
    if (!Number.isInteger(newLimitTokens) || newLimitTokens < this.#observed) {
      throw new TypeError(
        `续预算新 limit 必须是非负整数且 ≥ 已耗 ${this.#observed}: ${newLimitTokens}`,
      );
    }
    this.#limitTokens = newLimitTokens;
    const reArmed = this.level === 'ok';
    if (reArmed) {
      this.#softFired = false;
      this.#hardFired = false;
    } else if (this.level === 'soft') {
      // 回落到 soft~hard 之间:hard 重新武装(下次越 hard 再发),soft 保持已发。
      this.#hardFired = false;
    }
    return { limitTokens: this.#limitTokens, softTokens: this.softTokens, reArmed };
  }
}
