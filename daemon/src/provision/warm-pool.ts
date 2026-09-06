/**
 * WarmPool(§9 P4 预热池,M7):
 *
 *   acquire(spec) ──池有同签名 snapshot──▶ restore 回热(Firecracker 模式)
 *                 └──池空──────────────────▶ provider.create 冷拉
 *   release(handle, healthy) ──健康且池未满──▶ snapshot 固化 + destroy 释放
 *                            │                (池条目 = snapshot 引用,VM 不占内存)
 *                            └──不健康/池满──▶ destroy
 *
 * 语义要点:
 * - 仅对 snapshotCapable 后端真池化;docker/memory 未声明该能力 → 直通退化:
 *   acquire 恒冷拉、release 恒销毁(接口不变,池层零行为);
 * - 池条目按「规格签名」(image+env+resources+network+user+workdir+非 workdir
 *   挂载;workdir 挂载归一化剔除 per-node source,#26)匹配,防止把 A 节点的
 *   挂载/环境静默塞给 B 节点(§4.4 spawn 硬规则的池化侧守卫);
 * - 与 M1 ResourceGate 共用同一信号量(协作语义:gate 控并发上限,pool 复用
 *   实例)——gate 挂在 NodeExecutor 执行包裹层,pool 在 gate 之内:acquire 先过
 *   gate(满员排队),命中/冷拉后占槽;release 回池/销毁后释放槽位。空闲池条目
 *   (snapshot 引用)不占任何槽位;
 * - 池迁移复用已有 sandbox.acquired / sandbox.released 事件(gate 缺席时经
 *   emit 独立落账),payload 增加 pool/hit 字段纯增量,不新增事件类型。
 */
import type { Principal } from "../events/types.ts";
import { principalOf, slotKeyOf, ResourceGate, type GateEmit } from "./pool.ts";
import type { SandboxHandle, SandboxProvider, SandboxSpec } from "./types.ts";

export interface WarmPoolOptions {
  readonly provider: SandboxProvider;
  /** 与 M1 共用的资源闸门(缺省无闸门 = 只池化不限流)。 */
  readonly gate?: ResourceGate;
  /** 池容量(snapshot 引用条目上限);溢出的健康实例直接销毁。缺省 2。 */
  readonly capacity?: number;
  /** gate 缺席时的事件出口(复用 sandbox.acquired/released,纯增量 payload)。 */
  readonly emit?: GateEmit;
  /**
   * 健康探针(release 时判定能否回池);缺省 exec ["true"],exit 0 即健康。
   * opts.healthy 显式给出时跳过探针(NodeExecutor 按终态给出,省一次 exec)。
   */
  readonly healthProbe?: (handle: SandboxHandle) => Promise<boolean>;
}

/** 池取出结果:fromPool=false = 冷拉(事件与审计需要区分)。 */
export interface PoolAcquireResult {
  readonly handle: SandboxHandle;
  readonly fromPool: boolean;
}

/** 池归还结果:pooled = 已固化为池条目;destroyed = 已销毁(事件收尾用)。 */
export type PoolReleaseVerdict = "pooled" | "destroyed";

/**
 * NodeExecutor 消费的最小池接口(§3.5:执行器只依赖 acquire/release 两面,
 * 不感知池内 snapshot/gate 细节);WarmPool 满足此接口。
 */
export interface SandboxPool {
  acquire(spec: SandboxSpec): Promise<PoolAcquireResult>;
  release(handle: SandboxHandle, opts?: { healthy?: boolean }): Promise<PoolReleaseVerdict>;
}

interface PoolEntry {
  readonly key: string;
  readonly ref: string;
}

export class WarmPool implements SandboxPool {
  readonly #provider: SandboxProvider;
  readonly #gate: ResourceGate | undefined;
  readonly #capacity: number;
  readonly #emit: GateEmit | undefined;
  readonly #healthProbe: (handle: SandboxHandle) => Promise<boolean>;
  readonly #pool: PoolEntry[] = [];

  constructor(options: WarmPoolOptions) {
    if (options.capacity !== undefined && options.capacity <= 0) {
      throw new Error(`WarmPool capacity 必须 > 0,得到 ${options.capacity}`);
    }
    this.#provider = options.provider;
    this.#gate = options.gate;
    this.#capacity = options.capacity ?? 2;
    this.#emit = options.emit;
    this.#healthProbe = options.healthProbe ?? (async (handle) => {
      try {
        const r = await this.#provider.exec(handle, ["true"]);
        return r.exitCode === 0;
      } catch {
        return false;
      }
    });
  }

  get backend(): string {
    return this.#provider.backend;
  }

  /** 是否真池化(false = 直通退化:冷拉 + 销毁)。 */
  get pooling(): boolean {
    return this.#provider.snapshotCapable === true;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** 当前池内 snapshot 引用条目数(直通退化恒 0)。 */
  get size(): number {
    return this.#pool.length;
  }

  /**
   * 取一个沙箱:池命中 restore 回热,池空冷拉;gate 语义在先(控并发)。
   * 占槽之后任何一步(create 冷拉 / restore 回热)抛错都必须归还 gate 槽位,
   * 否则失败累计 slots 次后 gate 永久 FIFO 排队,供给链路死锁(对齐 release()
   * 的 finally #vacate 与 pool.ts withResourceGate 的「create 抛错即 release」)。
   */
  async acquire(spec: SandboxSpec): Promise<PoolAcquireResult> {
    const key = slotKeyOf(spec.labels?.["neoba.task"], spec.labels?.["neoba.node"], `pool-${Math.random().toString(36).slice(2, 8)}`);
    const principal = principalOf(spec.labels ?? {}, DEFAULT_PRINCIPAL);
    await this.#occupy(key, principal);
    try {
      if (!this.pooling) {
        // 直通退化:接口照旧,池层零行为(docker/memory 路径)
        return { handle: await this.#provider.create(spec), fromPool: false };
      }
      const sig = specSignature(spec);
      const idx = this.#pool.findIndex((e) => e.key === sig);
      if (idx >= 0) {
        const entry = this.#pool.splice(idx, 1)[0]!;
        // 回热失败:条目已 splice 出池,按池对孤儿引用的既有语义处理
        // (同 drain():仅丢引用,snapshot 介质清理归后端/磁盘管理,§9 P4),
        // 池内不残留引用;槽位由外层 catch 归还后原样重抛。
        const handle = await this.#provider.restore(entry.ref);
        // 回热实例继承本节点标签(gate key / 事件留痕按当前任务记账),
        // 并带上规格签名供 release 回池匹配。
        // 挂载语义(#26):restore 不重挂载(restore 参数无 mounts),回热实例的
        // /workspace 内容即 snapshot 固化的旧节点 workdir 卷内容 —— 这正是回热
        // 收益所在;新节点的 workdir 卷(per-node 唯一 source)不重挂,内容语义
        // 由 snapshot 承接,故签名对 workdir source 归一化是安全的。
        handle.labels = { ...handle.labels, "neoba.pool-key": sig, ...(spec.labels ?? {}) };
        return { handle, fromPool: true };
      }
      const handle = await this.#provider.create(spec);
      // 冷拉实例同样锚定规格签名(release 回池时按此归位)
      handle.labels = { ...handle.labels, "neoba.pool-key": sig };
      return { handle, fromPool: false };
    } catch (err) {
      // 失败路径归还槽位(与 release 的 finally #vacate 同一约定)
      await this.#vacate(key, principal);
      throw err;
    }
  }

  /**
   * 归还:健康且池未满 → snapshot 固化 + destroy(条目 = 引用);否则 destroy。
   * snapshot 失败降级 destroy(池化是优化,不可因回池失败丢清理语义)。
   * 无论走向,最后都释放 gate 槽位(空闲池条目不占槽)。
   */
  async release(
    handle: SandboxHandle,
    opts?: { healthy?: boolean },
  ): Promise<PoolReleaseVerdict> {
    const key = slotKeyOf(handle.labels["neoba.task"], handle.labels["neoba.node"], handle.id);
    const principal = principalOf(handle.labels, DEFAULT_PRINCIPAL);
    try {
      if (!this.pooling) {
        await this.#provider.destroy(handle);
        return "destroyed";
      }
      const healthy = opts?.healthy ?? (await this.#healthProbe(handle));
      if (!healthy || this.#pool.length >= this.#capacity) {
        await this.#provider.destroy(handle);
        return "destroyed";
      }
      let ref: string;
      try {
        ref = await this.#provider.snapshot(handle);
      } catch {
        // 回池固化失败:退化为直接销毁(不因池化失败泄漏沙箱)
        await this.#provider.destroy(handle);
        return "destroyed";
      }
      await this.#provider.destroy(handle);
      this.#pool.push({ key: handle.labels["neoba.pool-key"] ?? handle.id, ref });
      return "pooled";
    } finally {
      await this.#vacate(key, principal);
    }
  }

  /** 清空池条目(仅丢引用;snapshot 介质清理归后端/磁盘管理,§9 P4)。 */
  drain(): number {
    const n = this.#pool.length;
    this.#pool.length = 0;
    return n;
  }

  // --------------------------------------------------------------- 内部

  /** 占槽:有 gate 走 gate(自带 queued/acquired/released 事件);否则 emit 兜底。 */
  async #occupy(key: string, principal: Principal): Promise<void> {
    if (this.#gate !== undefined) {
      await this.#gate.acquire(key, principal);
      return;
    }
    await this.#emitEvent("sandbox.acquired", key, principal, {
      key, pool: true, limit: null,
    });
  }

  async #vacate(key: string, principal: Principal): Promise<void> {
    if (this.#gate !== undefined) {
      await this.#gate.release(key, principal);
      return;
    }
    await this.#emitEvent("sandbox.released", key, principal, {
      key, pool: true, limit: null,
    });
  }

  async #emitEvent(
    type: "sandbox.acquired" | "sandbox.released",
    key: string,
    principal: Principal,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.#emit === undefined) return;
    await this.#emit({ type, principal, payload });
  }
}

const DEFAULT_PRINCIPAL: Principal = { tenant: "default", session: null, task: null, agent: null };

/**
 * 规格签名:池命中判据。实例环境(image/env/资源/网络/user/workdir)必须逐位
 * 一致才允许复用;labels(任务/节点身份)不参与签名,回热后由调用方覆写。
 *
 * workdir 挂载归一化(#26):source 由 NodeExecutor 逐节点生成
 * (`neoba-${taskId}-${nodeId}`,node-executor.ts),属 per-node 唯一段,若参与
 * 逐位比对则跨节点永不命中,池退化成「仅同节点重试可复用」。签名只保留
 * target+mode(source 剔除):回热内容本就来自 snapshot 本身(restore 不重挂载,
 * 见 microsandbox-provider restore),workdir source 的差异不构成复用障碍;
 * secret/config 挂载(§4.4 凭据/配置硬规则)仍全量参与签名,静默错配不可接受。
 * env/network/resources 仍逐位比对,不同环境/网络的节点绝不混池。
 */
function specSignature(spec: SandboxSpec): string {
  const mounts = (spec.mounts ?? []).map((m) =>
    m.kind === "workdir"
      ? { kind: m.kind, target: m.target, mode: m.mode }
      : m,
  );
  return JSON.stringify([
    spec.image,
    spec.env ?? {},
    mounts,
    spec.resources ?? {},
    spec.network ?? { mode: "none" },
    spec.user,
    spec.workdir,
  ]);
}
