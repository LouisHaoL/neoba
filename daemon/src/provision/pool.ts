/**
 * ResourceGate(§6 资源池:并发容器数由 Provisioner 确定性排队,§9 P3 落地):
 *
 * - FIFO 信号量:acquire(key) 占槽,满员则排队;release(key) 唤醒队首;
 * - 每次排队/占用/释放落事件日志(sandbox.queued / acquired / released),
 *   恢复 = 重放重建排队历史(状态同样走事件日志,§6 v0.2 决议);
 * - withResourceGate 把闸门包在 provider 外层:create 前 acquire、create 失败
 *   或 destroy 后 release —— NodeExecutor 每个沙箱都保证 destroy(§3.5 配对),
 *   所以槽位不泄漏;闸门对 memory/docker/远端后端一视同仁。
 */
import type { Principal } from '../events/types.ts';
import type { SandboxProvider, SandboxHandle, SandboxSpec } from './types.ts';

/** 资源池事件出口(daemon 接 EventLog.append;测试接数组)。 */
export type GateEmit = (input: {
  type: 'sandbox.queued' | 'sandbox.acquired' | 'sandbox.released';
  principal: Principal;
  payload: Record<string, unknown>;
}) => Promise<unknown> | unknown;

export interface ResourceGateOptions {
  /** 并发槽位数;Infinity = 不限(此时 acquire 永不排队)。 */
  readonly slots: number;
  /** 事件出口(可选;不给 = 只做进程内信号量)。 */
  readonly emit?: GateEmit;
  /** 槽位事件的 principal 兜底(labels 缺 tenant 时用)。 */
  readonly principal?: Principal;
}

interface Waiter {
  resolve: () => void;
  /** 唤醒时槽位是否已由 release 同步移交(+1 已在 release 内完成),acquire 续段不再重复计数。 */
  granted?: boolean;
}

export class ResourceGate {
  readonly #slots: number;
  readonly #emit: GateEmit | undefined;
  readonly #defaultPrincipal: Principal;
  #inUse = 0;
  readonly #queue: Waiter[] = [];

  constructor(opts: ResourceGateOptions) {
    if (opts.slots <= 0) throw new Error(`ResourceGate slots 必须 > 0,得到 ${opts.slots}`);
    this.#slots = opts.slots;
    this.#emit = opts.emit;
    this.#defaultPrincipal = opts.principal ?? { tenant: 'default', session: null, task: null, agent: null };
  }

  get limit(): number | null {
    return Number.isFinite(this.#slots) ? this.#slots : null;
  }

  get inUse(): number {
    return this.#inUse;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  /**
   * 占用一个槽位:有空槽立即返回(返回 true);满员 FIFO 排队,按到达序
   * 确定性唤醒(返回 false,审计用)。
   */
  async acquire(key: string, principal?: Principal): Promise<boolean> {
    if (this.#inUse < this.#slots) {
      this.#inUse += 1;
      await this.#emitEvent('sandbox.acquired', key, principal, { key, inUse: this.#inUse, limit: this.limit });
      return true;
    }
    // 先同步入队再发事件:emit 的 await 期间若有 release 插入,也能正确唤醒本等待者。
    let wake!: () => void;
    const waiter: Waiter = { resolve: () => {}, granted: false };
    const queued = new Promise<void>((resolve) => {
      wake = resolve;
      waiter.resolve = resolve;
      this.#queue.push(waiter);
    });
    await this.#emitEvent('sandbox.queued', key, principal, { key, waiting: this.#queue.length, limit: this.limit });
    await queued;
    void wake;
    if (!waiter.granted) this.#inUse += 1; // 已由 release 同步移交则不重复计数
    await this.#emitEvent('sandbox.acquired', key, principal, { key, inUse: this.#inUse, limit: this.limit });
    return false;
  }

  /** 释放槽位并唤醒队首(成对于 acquire;多余 release 幂等忽略)。 */
  async release(key: string, principal?: Principal): Promise<void> {
    if (this.#inUse === 0) return;
    // 关键段(减计数 + 移交队首 + 唤醒)必须在同一同步段内完成,emit 放到唤醒
    // 之后(#22):若在减计数与唤醒之间 await emit(含 fsync),窗口内新 acquire
    // 会看到空槽直接拿走,随后队首被唤醒再 +1 → inUse 超 slots(槽位超发)。
    // 这里进一步把槽位 +1 也同步移交给队首(granted),连「release 未 await 就
    // 同步连发 acquire」的极端窗口也一并封死:同步段内不可能有任何观察者插入。
    this.#inUse -= 1;
    const next = this.#queue.shift();
    if (next !== undefined) {
      this.#inUse += 1;
      next.granted = true;
      next.resolve();
    }
    await this.#emitEvent('sandbox.released', key, principal, { key, inUse: this.#inUse, limit: this.limit });
  }

  async #emitEvent(
    type: 'sandbox.queued' | 'sandbox.acquired' | 'sandbox.released',
    key: string,
    principal: Principal | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.#emit === undefined) return;
    await this.#emit({ type, principal: principal ?? this.#defaultPrincipal, payload });
  }
}

/** 槽位 key:从 neoba.task / neoba.node 标签推导;缺省兜底句柄 id / 随机段。 */
export function slotKeyOf(task: string | undefined, node: string | undefined, fallback: string): string {
  if (task !== undefined && node !== undefined) return `${task}/${node}`;
  if (task !== undefined) return task;
  return fallback;
}

/** 从 neoba.* 标签还原 principal(事件留痕用;缺省字段逐层回退)。 */
export function principalOf(
  labels: Record<string, string>,
  fallback: Principal,
): Principal {
  const task = labels['neoba.task'];
  const node = labels['neoba.node'];
  return {
    tenant: labels['neoba.tenant'] ?? fallback.tenant,
    session: labels['neoba.session'] ?? fallback.session,
    task: task ?? fallback.task,
    agent: task !== undefined && node !== undefined ? `${task}/${node}` : fallback.agent,
  };
}

/**
 * 把 ResourceGate 包在 provider 外层:create 前 acquire,create 抛错即释放,
 * destroy 后 release(幂等)。provider 自身的 acquire/release 占位照旧抛
 * NotSupported —— 排队语义由闸门在包装层承担(§6:Provisioner 确定性排队)。
 */
export function withResourceGate(provider: SandboxProvider, gate: ResourceGate): SandboxProvider {
  const fallback = { tenant: 'default', session: null, task: null, agent: null } as Principal;
  return {
    backend: provider.backend,
    create: async (spec: SandboxSpec) => {
      const labels = spec.labels ?? {};
      const key = slotKeyOf(labels['neoba.task'], labels['neoba.node'], `anon-${Math.random().toString(36).slice(2, 8)}`);
      await gate.acquire(key, principalOf(labels, fallback));
      try {
        return await provider.create(spec);
      } catch (err) {
        await gate.release(key, principalOf(labels, fallback));
        throw err;
      }
    },
    exec: (handle, cmd, opts) => provider.exec(handle, cmd, opts),
    logs: (handle, opts) => provider.logs(handle, opts),
    destroy: async (handle: SandboxHandle) => {
      await provider.destroy(handle);
      const key = slotKeyOf(handle.labels['neoba.task'], handle.labels['neoba.node'], handle.id);
      await gate.release(key, principalOf(handle.labels, fallback));
    },
    list: (labels) => provider.list(labels),
    snapshot: (handle) => provider.snapshot(handle),
    restore: (snapshotRef) => provider.restore(snapshotRef),
    acquire: (slot) => provider.acquire(slot),
    release: (slot) => provider.release(slot),
  };
}
