/**
 * SecretStore 模块(§3.8:凭据存取 / 按 tenant 分桶 / 注入与脱敏)。
 *
 * 铁律(§3.5g):list/export 类接口只出元数据,类型上不可表达
 * "导出凭据明文";值只在 get / resolveInjection 时出接口。
 * 运行时零第三方依赖,仅用 node 内置模块(powershell 桥除外,那是子进程)。
 */
export { FileSecretBackend } from './backends/file.ts';
export type {
  FileBackendMode,
  FileSecretBackendOptions,
} from './backends/file.ts';
export { MemorySecretBackend } from './backends/memory.ts';
export {
  DEFAULT_DPAPI_TIMEOUT_MS,
  DEFAULT_POWERSHELL,
  dpapiProtect,
  dpapiUnprotect,
} from './backends/dpapi.ts';
export {
  DEFAULT_KEYRING_TIMEOUT_MS,
  DEFAULT_SECRET_TOOL,
  KEYRING_SERVICE,
  KeyringSecretBackend,
  defaultSecretToolRunner,
} from './backends/keyring.ts';
export type {
  SecretToolResult,
  SecretToolRunner,
} from './backends/keyring.ts';
export {
  createSecretBackend,
  createSecretStore,
} from './factory.ts';
export type {
  ConfiguredSecretBackendKind,
  SecretStoreFactoryConfig,
  SecretStoreFactoryEnv,
} from './factory.ts';
export { SecretStore } from './store.ts';
export type { SecretStoreOptions } from './store.ts';
export { Redactor, redactUnknownValue, secretRefToken } from './redact.ts';
export { SECRET_ID_MAX_LENGTH, SECRET_ID_RE, TENANT_RE } from './validate.ts';
export {
  CrossTenantAccess,
  InvalidSecretId,
  InvalidTenant,
  SecretBackendError,
  SecretBackendTimeout,
  SecretBackendUnavailable,
  SecretCorrupt,
  SecretError,
  SecretNotFound,
  UnknownSecretBackendKind,
} from './errors.ts';
export type {
  SecretBackend,
  SecretId,
  SecretInjection,
  SecretManifestEntry,
  SecretMetadata,
  SecretRef,
  SecretSetOptions,
  SecretValue,
  Tenant,
} from './types.ts';
