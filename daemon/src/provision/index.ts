/** Provisioner:沙箱后端抽象(§5)与参考实现。 */
export type {
  BaseRequirements,
  ExecOptions,
  ExecResult,
  LogsOptions,
  NetworkPolicy,
  SandboxHandle,
  SandboxMount,
  SandboxProvider,
  SandboxResources,
  SandboxSpec,
  SandboxStatus,
} from "./types.ts";
export type { SandboxErrorCode } from "./errors.ts";
export {
  CliOutputParseError,
  CommandFailedError,
  InvalidSpecError,
  InvalidStateError,
  NotSupportedError,
  PrerequisiteNotMetError,
  ProviderUnavailableError,
  ProviderUnknownError,
  SandboxError,
} from "./errors.ts";
export { NEOBA_CREATED_AT_LABEL, NEOBA_MANAGED_LABEL, NEOBA_PROVIDER_LABEL, labelsMatch, mergeLabels } from "./labels.ts";
export {
  buildCreateArgs,
  buildExecArgs,
  buildLogsArgs,
  buildRemoveArgs,
  buildStartArgs,
  containerName,
} from "./docker-args.ts";
export {
  buildCreateArgs as buildMsbCreateArgs,
  buildExecArgs as buildMsbExecArgs,
  buildLogsArgs as buildMsbLogsArgs,
  buildRemoveArgs as buildMsbRemoveArgs,
  buildRestoreArgs,
  buildSnapshotCreateArgs,
  buildStopArgs,
  formatMemoryMiB,
  sandboxName,
  snapshotName,
} from "./msb-args.ts";
export {
  createCliRunner,
  createDockerCliRunner,
  createMicrosandboxCliRunner,
  type CliResult,
  type CliRunner,
} from "./runner.ts";
export { validateSpec } from "./validate.ts";
export { DockerProvider, type DockerProviderOptions, type UsernsProbe } from "./docker-provider.ts";
export {
  MemoryProvider,
  type MemoryExecCall,
  type MemoryExecHandler,
  type MemoryProviderOptions,
} from "./memory-provider.ts";
export { MicrosandboxProvider, type MicrosandboxProviderOptions } from "./microsandbox-provider.ts";
export {
  KNOWN_PROVIDERS,
  createProvider,
  readSandboxConfig,
  type CreateProviderOptions,
  type SandboxSectionConfig,
} from "./factory.ts";
export { ResourceGate, principalOf, slotKeyOf, withResourceGate, type GateEmit, type ResourceGateOptions } from "./pool.ts";
export {
  WarmPool,
  type PoolAcquireResult,
  type PoolReleaseVerdict,
  type SandboxPool,
  type WarmPoolOptions,
} from "./warm-pool.ts";
