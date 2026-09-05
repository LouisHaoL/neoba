/**
 * 工件仓库模块(§3.7 交付契约 / §10.2 v0.2 工件跨容器传递)。
 *
 * CAS(内容寻址存储)+ manifest 指针;发布即写屏障;
 * 共享读(不可变无锁)/ 同路径写写串行;任务间默认物理无共享,
 * 跨任务只有显式发布走工件仓库一条路。
 * 运行时零第三方依赖,仅用 node 内置模块。
 */
export {
  ArtifactRepository,
  MANIFEST_API_VERSION,
} from './repository.ts';
export type {
  ArtifactContent,
  ArtifactFile,
  ArtifactNamespace,
  ArtifactPayload,
  RetentionPolicy,
} from './repository.ts';
export type {
  ArtifactEntry,
  ArtifactRef,
  ManifestListing,
  PublishResult,
  ReconcileReport,
  VerifyResult,
} from './types.ts';
export {
  parseRetentionPolicy,
  retentionFromDiskValue,
  serializeRetentionPolicy,
  RETAIN_FOREVER,
} from './retention.ts';
export { collectArtifactGc, planArtifactGc, isTerminalStatus } from './gc.ts';
export type {
  GcCollectContext,
  GcCollectResult,
  GcEventEmitter,
  GcPlan,
  GcPlanInput,
} from './gc.ts';
export {
  ArtifactError,
  ArtifactNotFound,
  CasObjectNotFound,
  HashMismatch,
  InvalidArtifactPath,
  ManifestCorrupt,
  NotPublished,
} from './errors.ts';
