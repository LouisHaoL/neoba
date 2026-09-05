/**
 * CLI 依赖的默认装配:把壳接到既有模块(daemon / doctor / artifacts / bindings)。
 * 业务逻辑全在那些模块里;这里只做转发,不改行为。
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { startDaemon } from '../daemon/index.ts';
import type { DaemonHandle, DaemonOptions } from '../daemon/index.ts';
import { runDoctor, writeConfig, defaultConfigPath, execProbe } from '../doctor/index.ts';
import type { DoctorReport } from '../doctor/index.ts';
import { ArtifactRepository } from '../artifacts/index.ts';
import { spawnBridge } from '../bindings/index.ts';
import { createSecretStore } from '../secrets/factory.ts';
import type { SecretStore } from '../secrets/index.ts';
import { createProvider, readSandboxConfig } from '../provision/factory.ts';
import { ResourceGate } from '../provision/pool.ts';
import { WarmPool } from '../provision/warm-pool.ts';
import type { SandboxPool, SandboxProvider } from '../provision/index.ts';
import { loadNeobaConfig, readSecretsConfig } from './config.ts';
import type { CliDeps } from './types.ts';

/** daemon 包的 package.json(版本号来源,随本模块位置解析)。 */
export function packageJsonPath(): string {
  return fileURLToPath(new URL('../../package.json', import.meta.url));
}

/** 读 package.json 的 version;读不到回退 0.0.0(--version 永不抛)。 */
export async function loadPackageVersion(): Promise<string> {
  try {
    const raw = await readFile(packageJsonPath(), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * M6 生产接线:配置显式声明 secrets 小节时,经工厂把 SecretStore 传入
 * startDaemon(workflow 节点 secret_ids 注入容器 env,§3.8);配置缺省时
 * 保持现行为(不注入,引擎侧报"未配置 SecretStore")。
 * 后端不可用 / 未知 kind 的类型化错误从这里向上传播,不静默降级。
 */
export async function resolveConfiguredSecretStore(): Promise<SecretStore | undefined> {
  const config = await loadNeobaConfig();
  const secretsConfig = readSecretsConfig(config);
  if (secretsConfig === undefined) return undefined;
  return createSecretStore(secretsConfig);
}

/** M7 装配结果:配置声明 sandbox 小节时的 provider / 池 / 缺省镜像。 */
export interface ResolvedSandbox {
  readonly provider: SandboxProvider;
  /** 仅当配置声明 sandbox.pool 小节时非空(池在 gate 之内,见 warm-pool.ts)。 */
  readonly pool: SandboxPool | undefined;
  /** 配置 sandbox.image 显式给出时非空(缺省 neoba/sandbox:latest,引擎侧兜底)。 */
  readonly image: string | undefined;
}

/**
 * M7 生产接线:按 neoba.config.json 的 sandbox 小节实例化沙箱后端
 * (仿 resolveConfiguredSecretStore 的先例)。配置缺省(无 sandbox 小节)
 * 返回 undefined,startDaemon 保持现行为 = MemoryProvider、不建池、零漂移;
 * 小节存在即经工厂实例化 —— 未知 provider 名抛 ProviderUnknownError,
 * 从这里向上传播,不静默降级。opts 透传 loadNeobaConfig(测试注入 cwd)。
 */
export async function resolveConfiguredSandbox(
  opts?: { cwd?: string; homedir?: string },
): Promise<ResolvedSandbox | undefined> {
  const config = await loadNeobaConfig(opts);
  const sandbox = readSandboxConfig(config);
  if (sandbox === undefined) return undefined;

  const provider = createProvider(config);
  let pool: SandboxPool | undefined;
  if (sandbox.pool !== undefined && typeof sandbox.pool === 'object') {
    // gate 挂在 NodeExecutor 执行包裹层、pool 在 gate 之内的语义由 WarmPool
    // 承担:slots 显式给出才建闸门(控并发上限),capacity 控池条目上限。
    const slots = typeof sandbox.pool['slots'] === 'number' ? sandbox.pool['slots'] : undefined;
    const capacity = typeof sandbox.pool['capacity'] === 'number' ? sandbox.pool['capacity'] : undefined;
    const gate = slots !== undefined && slots > 0
      ? new ResourceGate({ slots })
      : undefined;
    pool = new WarmPool({ provider, ...(gate !== undefined ? { gate } : {}), ...(capacity !== undefined ? { capacity } : {}) });
  }
  const image = typeof sandbox['image'] === 'string' && sandbox['image'] !== ''
    ? sandbox['image']
    : undefined;
  return { provider, pool, image };
}

/** 组装默认依赖:真实 daemon / doctor / CAS 仓库 / MCP 桥。 */
export async function defaultDeps(overrides: Partial<CliDeps> = {}): Promise<CliDeps> {
  const deps: CliDeps = {
    version: await loadPackageVersion(),
    startDaemon: async (opts) => {
      const [secrets, sandbox] = await Promise.all([
        resolveConfiguredSecretStore(),
        resolveConfiguredSandbox(),
      ]);
      return startDaemon({
        ...(opts as DaemonOptions),
        ...(secrets !== undefined ? { secrets } : {}),
        ...(sandbox !== undefined ? { provider: sandbox.provider } : {}),
        ...(sandbox?.pool !== undefined ? { pool: sandbox.pool } : {}),
        ...(sandbox?.image !== undefined ? { image: sandbox.image } : {}),
      });
    },
    runDoctor: (opts) => runDoctor({ probe: opts.probe }),
    writeConfig: (report, configPath) =>
      writeConfig(report as DoctorReport, configPath),
    defaultConfigPath: () => defaultConfigPath(),
    execProbe: (cmd, args) => execProbe(cmd, [...args]),
    openRepository: (root) => ArtifactRepository.open(root),
    spawnBridge: (opts) => spawnBridge(opts),
    fetch: (input, init) => fetch(input, init),
    homedir: () => osHomedir(),
    readTextFile,
    fileExists,
    ...overrides,
  };
  return deps;
}

export type { DaemonHandle, DaemonOptions };
