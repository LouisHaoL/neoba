/**
 * SecretStore 工厂(M6 生产接线):显式 config 优先 > 平台探测。
 *
 * 决策表(config.secrets 小节 / SecretStoreFactoryConfig):
 *   kind 显式     → 按 kind 构造(memory / file / dpapi / keyring);
 *                    未知 kind 抛 UnknownSecretBackendKind,不静默降级(§3.8)。
 *   kind 缺省     → 平台探测:win32 → file+dpapi(DPAPI 不落盘密钥,首选);
 *                    linux → keyring(libsecret secret-tool);其余 → file+aes-gcm。
 *
 * env.platform / env.homedir 可注入,测试在任意平台覆盖全部分支
 * (仿 doctor 的 PlatformInfo 注入风格;不用 enum,平台分支走 if/switch)。
 */
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { FileSecretBackend } from './backends/file.ts';
import type { FileBackendMode } from './backends/file.ts';
import { KeyringSecretBackend } from './backends/keyring.ts';
import { MemorySecretBackend } from './backends/memory.ts';
import { UnknownSecretBackendKind } from './errors.ts';
import { SecretStore } from './store.ts';
import type { SecretStoreOptions } from './store.ts';
import type { SecretBackend } from './types.ts';

/** 配置里可声明的后端 kind('dpapi' = file 后端的 DPAPI 模式)。 */
export type ConfiguredSecretBackendKind =
  | 'memory'
  | 'file'
  | 'dpapi'
  | 'keyring';

/** config 的 secrets 小节(宽松:全部字段可选,未知字段由调用方忽略)。 */
export interface SecretStoreFactoryConfig {
  readonly kind?: ConfiguredSecretBackendKind;
  /** file 后端的存储根 / keyring 后端的元数据索引根。 */
  readonly root?: string;
  /** file 后端加密模式(kind='file' 时可显式覆盖平台默认)。 */
  readonly mode?: FileBackendMode;
  /** keyring 后端:secret-tool 可执行文件。 */
  readonly binary?: string;
  /** keyring 后端:子进程超时毫秒。 */
  readonly timeoutMs?: number;
}

/** 工厂环境(缺省 = 真实平台与用户主目录;测试注入)。 */
export interface SecretStoreFactoryEnv {
  /** os.platform() 的替身(缺省 process.platform)。 */
  readonly platform?: string;
  /** os.homedir() 的替身(缺省 os.homedir())。 */
  readonly homedir?: string;
}

function platformDefaultMode(platformName: string): FileBackendMode {
  return platformName === 'win32' ? 'dpapi' : 'aes-gcm';
}

/** 按决策表构造后端(kind 判定独立出来,便于测试与复用)。 */
export function createSecretBackend(
  config?: SecretStoreFactoryConfig,
  env?: SecretStoreFactoryEnv,
): SecretBackend {
  const platformName = env?.platform ?? process.platform;
  // file 存储根 / keyring 索引根共用默认布局(~/.neoba/secrets,互不冲突)。
  const root = config?.root ?? join(env?.homedir ?? osHomedir(), '.neoba', 'secrets');
  const timeoutMs = config?.timeoutMs;

  const kind = config?.kind;
  if (kind === 'memory') return new MemorySecretBackend();
  if (kind === 'keyring') {
    return new KeyringSecretBackend({
      ...(config?.binary !== undefined ? { binary: config.binary } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      indexRoot: root,
    });
  }
  if (kind === 'dpapi') {
    return new FileSecretBackend({
      mode: 'dpapi',
      root,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }
  if (kind === 'file') {
    return new FileSecretBackend({
      mode: config?.mode ?? platformDefaultMode(platformName),
      root,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }
  if (kind !== undefined) {
    throw new UnknownSecretBackendKind(
      kind,
      ['memory', 'file', 'dpapi', 'keyring'],
    );
  }

  // kind 缺省:平台探测。
  if (platformName === 'win32') {
    return new FileSecretBackend({
      mode: 'dpapi',
      root,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }
  if (platformName === 'linux') {
    return new KeyringSecretBackend({
      ...(config?.binary !== undefined ? { binary: config.binary } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      indexRoot: root,
    });
  }
  return new FileSecretBackend({ mode: 'aes-gcm', root });
}

/** 按决策表构造 SecretStore 门面(redactor 可选透传)。 */
export function createSecretStore(
  config?: SecretStoreFactoryConfig,
  env?: SecretStoreFactoryEnv,
  options?: SecretStoreOptions,
): SecretStore {
  return new SecretStore(createSecretBackend(config, env), options);
}
