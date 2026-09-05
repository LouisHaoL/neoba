/**
 * 工件自动 GC(M5):plan / collect 分离。
 *
 * retention 语义以 retention.ts 模块头为准(daemon 行为定型;协议 schema 冻结):
 *   - RetentionPolicy = { mode: 'forever' } | { mode: 'days', days >= 1 };
 *   - days 到期仅删「终态任务」的 manifest,forever / 非终态永不删;
 *   - manifest 删后其对象变孤儿,由下一轮孤儿清扫回收 —— 因此每轮 collect
 *     的 in-use 判定先于 manifest 删除计算,本轮删掉的 manifest 引用的对象
 *     本轮绝不动(发布即写屏障的另一面:指针在,对象就不可达判定为在用)。
 *
 * in-use 判定 = 当前全部 manifest 指针可达的 object 集。发布(rename 指针)
 * 即写屏障,无需引擎侧索引:指针未换,旧对象全部在用;指针换上,新对象
 * 已先落 CAS。孤儿 = 在盘对象 − in-use 集。
 *
 * plan 是纯决策(不碰磁盘外的副作用),可 dry-run 单测;collect 组合
 * repository 的扫描/删除原语执行 plan,并把 plan 摘要落 `artifact.gc` 事件。
 *
 * 容错:损坏 manifest 指针 / 损坏 CAS 对象都不阻塞 GC(repository 层跳过,
 * 本层按名称可达性决策,不读对象字节);事件发射失败由调用方兜底捕获。
 */
import type { EventInput } from '../events/types.ts';
import type { ArtifactGcPayload } from '../events/types.ts';
import type { ArtifactRepository } from './repository.ts';
import type { ManifestListing } from './types.ts';

const DAY_MS = 86_400_000;

/** 任务终态集合(与 daemon/tasks.ts 的 TaskStatus 对应;不引依赖,复制闭集)。 */
const TERMINAL_STATUSES: readonly string[] = ['completed', 'failed', 'cancelled'];

// ---------------------------------------------------------------- plan(纯决策)

/** plan 输入:全部 manifest 快照 + 全部在盘对象 + 时钟 + 任务终态判定。 */
export interface GcPlanInput {
  readonly manifests: readonly ManifestListing[];
  /** 在盘 CAS 对象 sha 全集(半写临时文件已由 repository 过滤)。 */
  readonly objects: readonly string[];
  /** 当前时间(ISO 8601);到期判定 = now - publishedAt >= days*24h。 */
  readonly now: string;
  /**
   * 任务是否已终态(completed/failed/cancelled)。未知任务必须返回 false
   * (保守:任务表查不到的一律不删 manifest)。
   */
  readonly isTerminal: (taskId: string) => boolean;
}

/** plan 输出:GC 决策(不执行);removed* 字段是 collect 将产生的删除量。 */
export interface GcPlan {
  /** 扫描到的 manifest 指针数(损坏指针不计,repository 层已跳过)。 */
  readonly scannedManifests: number;
  /** 扫描到的在盘对象数。 */
  readonly scannedObjects: number;
  /** in-use 对象数(全部 manifest 指针可达集,含本轮待删 manifest 引用的)。 */
  readonly inUseObjects: number;
  /** 因 retention 到期且任务终态而将删除的 manifest id。 */
  readonly expiredManifests: readonly string[];
  /** 孤儿对象 sha(将删除;含被外部删掉 manifest 留下的历史孤儿)。 */
  readonly orphanedObjects: readonly string[];
}

/** 纯决策:哪些 manifest 到期可删、哪些对象是孤儿。不产生任何副作用。 */
export function planArtifactGc(input: GcPlanInput): GcPlan {
  const { manifests, objects, now, isTerminal } = input;

  // 1. in-use 集:先于任何删除计算 —— 本轮待删 manifest 的对象本轮不动,
  //    留给下一轮(删后变孤儿,下轮再被扫)。
  const inUse = new Set<string>();
  for (const manifest of manifests) {
    for (const sha of manifest.objects) inUse.add(sha);
  }

  // 2. retention 到期判定:仅 days 模式 + 任务终态;forever / 非终态 /
  //    未知任务(保守按非终态)永不删。
  const nowMs = Date.parse(now);
  const expiredManifests: string[] = [];
  for (const manifest of manifests) {
    const retention = manifest.retention;
    if (retention === null || retention.mode !== 'days') continue;
    if (!isTerminal(manifest.task)) continue;
    const publishedMs = Date.parse(manifest.publishedAt);
    if (Number.isNaN(publishedMs)) continue; // 时间戳坏:保守不删
    if (Number.isNaN(nowMs)) continue;
    if (nowMs - publishedMs >= retention.days * DAY_MS) {
      expiredManifests.push(manifest.id);
    }
  }

  // 3. 孤儿 = 在盘 − in-use。
  const orphanedObjects = objects.filter((sha) => !inUse.has(sha));

  return {
    scannedManifests: manifests.length,
    scannedObjects: objects.length,
    inUseObjects: inUse.size,
    expiredManifests,
    orphanedObjects,
  };
}

// ---------------------------------------------------------------- collect(执行)

/** collect 的发射通道:把 artifact.gc 事件交给 EventLog(daemon 接线);
 * 返回值忽略(EventLog.append 的完整事件不需要)。 */
export type GcEventEmitter = (input: EventInput<'artifact.gc'>) => unknown;

export interface GcCollectContext {
  /** 时钟(可注入;缺省系统时间)。 */
  readonly now?: () => Date;
  /** 任务终态判定(未知任务必须保守返回 false)。 */
  readonly isTerminal: (taskId: string) => boolean;
  /** 事件发射(缺省不落事件,如 CLI dry-run)。 */
  readonly emit?: GcEventEmitter;
  /** principal 主体(GC 是 daemon 级动作,缺省仅 tenant 一层)。 */
  readonly principal?: EventInput<'artifact.gc'>['principal'];
}

export interface GcCollectResult {
  readonly plan: GcPlan;
  /** 实际删除的 manifest 数(id 列表见 plan.expiredManifests)。 */
  readonly removedManifests: number;
  /** 实际删除的孤儿对象数。 */
  readonly removedObjects: number;
}

/**
 * 执行一轮自动 GC:plan → 删到期 manifest(对象不动)→ 清孤儿对象 →
 * 落 artifact.gc 事件(payload = plan 摘要)。
 */
export async function collectArtifactGc(
  repo: ArtifactRepository,
  ctx: GcCollectContext,
): Promise<GcCollectResult> {
  const now = (ctx.now ?? (() => new Date()))().toISOString();
  const manifests = await repo.listManifests();
  const objects = await repo.listObjects();
  const plan = planArtifactGc({ manifests, objects, now, isTerminal: ctx.isTerminal });

  let removedManifests = 0;
  for (const id of plan.expiredManifests) {
    if (await repo.deleteManifest(id)) removedManifests += 1;
  }
  const removedShas = await repo.removeObjects(plan.orphanedObjects);

  const payload: ArtifactGcPayload = {
    scanned: plan.scannedManifests,
    scannedObjects: plan.scannedObjects,
    inUseObjects: plan.inUseObjects,
    orphaned: plan.orphanedObjects.length,
    removedManifests,
    removedObjects: removedShas.length,
    expiredManifests: plan.expiredManifests,
  };
  if (ctx.emit !== undefined) {
    await ctx.emit({
      type: 'artifact.gc',
      principal: ctx.principal ?? {
        tenant: 'default',
        session: null,
        task: null,
        agent: null,
      },
      payload,
    });
  }
  return {
    plan,
    removedManifests,
    removedObjects: removedShas.length,
  };
}

/** 终态判定辅助:供 daemon 接线把 TaskStore 状态映射成 isTerminal。 */
export function isTerminalStatus(status: string | undefined | null): boolean {
  return status !== undefined && status !== null && TERMINAL_STATUSES.includes(status);
}
