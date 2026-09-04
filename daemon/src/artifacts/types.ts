/**
 * 工件仓库的对外类型(CAS 语义,§3.7 v0.2)。
 */

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
  /** GC 预留字段位(v0.2 只占位,自动 GC 为 P2+ 工作项)。 */
  readonly retention: string | null;
}

export interface PublishResult {
  readonly version: number;
  readonly rootSha256: string;
  readonly size: number;
}

export interface VerifyResult {
  readonly version: number;
  readonly rootSha256: string;
  /** 通过校验的条目数。 */
  readonly entries: number;
  readonly size: number;
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
