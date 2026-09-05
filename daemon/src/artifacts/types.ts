/**
 * 工件仓库的对外类型(CAS 语义,§3.7 v0.2)。
 *
 * retention 语义(daemon 侧定型,M5):RetentionPolicy 见 retention.ts;
 * ArtifactRef.retention 为 null = 旧数据未声明,按 forever 处理。
 */
export type { RetentionPolicy } from './retention.ts';
import type { RetentionPolicy } from './retention.ts';

/** 四层命名空间的前两层(§10.4:tenant → session → task → agent,
 *  P1–P2 单 tenant 单 session,session 层暂并入 task 路径不单列)。 */
export interface ArtifactNamespace {
  readonly tenant: string;
  readonly task: string;
}

/** 单个文件型工件的内容:整块或流式(流式是写屏障语义的关键载荷)。 */
export type ArtifactContent =
  | string
  | Uint8Array
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

/** 目录型工件的成员:相对路径 + 各自内容(每文件各自 hash)。 */
export interface ArtifactFile {
  readonly path: string;
  readonly content: ArtifactContent;
}

/** publish 载荷:单文件,或文件清单(目录型工件)。 */
export type ArtifactPayload = ArtifactContent | readonly ArtifactFile[];

/** manifest 中的一条对象引用(已 dedup 进 CAS 的文件)。 */
export interface ArtifactEntry {
  /** 相对路径;单文件工件等于工件名本身。 */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

/** 已发布工件的不可变引用 = 当前 manifest 指针的快照。 */
export interface ArtifactRef {
  readonly tenant: string;
  readonly task: string;
  readonly node: string;
  readonly name: string;
  /** manifest 文档的结构版本轴(如 "artifact-manifest/1.0"),独立于
   * version 发布计数:api 轴管结构演进,保证旧工件库永远可读。 */
  readonly api: string;
  /** manifest 指针的单调递增版本号,同一路径只增不改。 */
  readonly version: number;
  readonly kind: 'file' | 'tree';
  /** file = 唯一对象的 sha256;tree = 文件清单的规范哈希。 */
  readonly rootSha256: string;
  /** 全部条目的字节总量。 */
  readonly size: number;
  readonly entries: readonly ArtifactEntry[];
  readonly publishedAt: string;
  /** 保留策略;null = 未声明,按 forever 处理(M5 起由 GC 消费)。 */
  readonly retention: RetentionPolicy | null;
}

export interface PublishResult {
  readonly version: number;
  readonly rootSha256: string;
  readonly size: number;
  /** retention 非法被降级为 forever 时的告警文案(合法时缺省)。 */
  readonly retentionWarnings?: readonly string[];
}

export interface VerifyResult {
  readonly version: number;
  readonly rootSha256: string;
  /** 通过校验的条目数。 */
  readonly entries: number;
  readonly size: number;
}

/**
 * manifest 指针的扫描快照(GC 的 plan 输入):当前盘上可解析的全部指针。
 * 损坏指针不在列(由 listManifests 跳过,读路径容错)。
 */
export interface ManifestListing {
  /** 指针标识:'{tenant}/{task}/{node}/{name}'(deleteManifest 的入参)。 */
  readonly id: string;
  readonly tenant: string;
  readonly task: string;
  readonly node: string;
  readonly name: string;
  readonly version: number;
  readonly publishedAt: string;
  /** 保留策略(落盘值已解析;null = 未声明,按 forever 处理)。 */
  readonly retention: RetentionPolicy | null;
  /** 该指针当前引用的全部 CAS 对象 sha。 */
  readonly objects: readonly string[];
}

/** reconcile() 对账报告:CAS 目录重建/审计的结果。 */
export interface ReconcileReport {
  /** 扫描到的 manifest 指针数。 */
  readonly manifests: number;
  /** 扫描到的 CAS 对象数。 */
  readonly objects: number;
  /** manifest 引用但 CAS 缺失的对象(sha)。 */
  readonly missing: string[];
  /** 字节与哈希不符的对象(sha,含文件名与内容不一致)。 */
  readonly corrupted: string[];
  /** 无任何 manifest 引用的孤儿对象(sha,可被 prune() 清理)。 */
  readonly unreferenced: string[];
}
