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
  CommandFailedError,
  InvalidSpecError,
  InvalidStateError,
  NotSupportedError,
  PrerequisiteNotMetError,
  ProviderUnavailableError,
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
export { createDockerCliRunner, type CliResult, type CliRunner } from "./runner.ts";
export { validateSpec } from "./validate.ts";
export { DockerProvider, type DockerProviderOptions, type UsernsProbe } from "./docker-provider.ts";
export {
  MemoryProvider,
  type MemoryExecCall,
  type MemoryExecHandler,
  type MemoryProviderOptions,
} from "./memory-provider.ts";
