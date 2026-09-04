/**
 * sidecar 模块(supervisor sidecar 配置生成器:授予落地,P1)。
 * grant manifest -> SidecarPlan(容器配置 + 文件清单 + 启动命令),
 * 纯函数产物;执行(写文件/拉容器)留给 Provisioner 接线。
 */
export {
  assertNoBypassFlags,
  assertNoBypassSettings,
  BYPASS_FLAGS,
  FORBIDDEN_PERMISSION_MODE,
} from './bypass.ts';
export {
  buildSandboxConfig,
  assertNoSecretPlaintext,
  materializeSecretEnv,
} from './build.ts';
export {
  CONTAINER_CONFIG_DIR,
  CONTAINER_WORKDIR,
  DEFAULT_WORKER_IMAGE,
  defaultSecretEnvName,
} from './types.ts';
export type {
  BuildSandboxConfigOptions,
  McpCatalog,
  McpServerSpec,
  PlanFile,
  SafePermissionMode,
  SecretInjectionEntry,
  SidecarPlan,
} from './types.ts';
export {
  BypassFlagDetected,
  McpServerNotInCatalog,
  SecretPlaintextLeak,
  SidecarConfigInvalid,
  SidecarError,
} from './errors.ts';
