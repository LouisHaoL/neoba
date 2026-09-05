/**
 * EngineGate(§9 P2 任务暂停/恢复状态机的执行面):
 *
 *   open ──pause()──▶ paused ──resume()──▶ open
 *     └──────────abort()──────────▶ aborted(终态:cancel)
 *
 * - 引擎在每个节点派发前 wait():open 立即通过,paused 阻塞到 resume/abort;
 * - abort 对**执行中的节点**同样生效:signal 上挂着 AbortSignal,
 *   NodeExecutor 据此销毁沙箱并按 cancelled 收尾;
 * - 状态只能前进(paused 不能回 open 之外;aborted 是终态,不可恢复 ——
 *   恢复语义归上层:重新下发任务)。
 */
export class GateAborted extends Error {
  constructor() {
    super('执行已被取消(gate aborted)');
    this.name = 'GateAborted';
  }
}

export type GateState = 'open' | 'paused' | 'aborted';

export class EngineGate {
  #state: GateState = 'open';
  readonly #controller = new AbortController();
  #waiters: (() => void)[] = [];

  get state(): GateState {
    return this.#state;
  }

  get paused(): boolean {
    return this.#state === 'paused';
  }

  get aborted(): boolean {
    return this.#state === 'aborted';
  }

  /** 取消信号(执行中节点据此协作终止)。 */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  pause(): boolean {
    if (this.#state !== 'open') return false;
    this.#state = 'paused';
    return true;
  }

  resume(): boolean {
    if (this.#state !== 'paused') return false;
    this.#state = 'open';
    this.#wake();
    return true;
  }

  abort(): boolean {
    if (this.#state === 'aborted') return false;
    this.#state = 'aborted';
    this.#controller.abort();
    this.#wake();
    return true;
  }

  /**
   * 在节点派发边界等闸门:open 立即通过;paused 阻塞;aborted 抛 GateAborted。
   * signal 已触发(abort 发生在 wait 之前入队)同样抛。
   */
  async wait(): Promise<void> {
    if (this.#state === 'aborted' || this.#controller.signal.aborted) {
      throw new GateAborted();
    }
    if (this.#state === 'open') return;
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
    if (this.state === 'aborted') throw new GateAborted();
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}
