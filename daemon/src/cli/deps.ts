/**
 * CLI 依赖的默认装配:把壳接到既有模块(daemon / doctor / artifacts / bindings)。
 * 业务逻辑全在那些模块里;这里只做转发,不改行为。
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDaemon } from '../daemon/index.ts';
import type { DaemonHandle, DaemonOptions } from '../daemon/index.ts';
import { runDoctor, writeConfig, defaultConfigPath, execProbe } from '../doctor/index.ts';
import type { DoctorReport } from '../doctor/index.ts';
import { ArtifactRepository } from '../artifacts/index.ts';
import { spawnBridge } from '../bindings/index.ts';
import { loadCapabilityRegistryFile } from '../capability/index.ts';
import type { LoadedRegistry, Preset } from '../capability/types.ts';
import type { LoadedModelRegistry } from '../modelscore/types.ts';
import { loadModelsFile, loadPresetsFromDirs } from '../portability/index.ts';
import { createSecretStore } from '../secrets/factory.ts';
import type { SecretStore } from '../secrets/index.ts';
import { createProvider, readSandboxConfig } from '../provision/factory.ts';
import { ResourceGate } from '../provision/pool.ts';
import { WarmPool } from '../provision/warm-pool.ts';
import type { SandboxPool, SandboxProvider } from '../provision/index.ts';
import { loadNeobaConfig, loadNeobaConfigDetailed, readSecretsConfig } from './config.ts';
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

// ---------------------------------------------------------------- start 装载(#6)

/**
 * #6 start 装载失败(预设 schema 不合 / 注册表校验不过 / 文件不存在)的
 * 类型化错误:runCli 捕获后退出码非 0,不静默降级。kind 标明哪一路装载,
 * path 为实际解析后的文件/目录,详情在 message(含底层校验问题清单)。
 */
export class StartArtifactLoadError extends Error {
  readonly kind: 'presets' | 'registry' | 'models';
  readonly path: string;

  constructor(kind: 'presets' | 'registry' | 'models', path: string, detail: string) {
    super(`start 装载失败(${kind}) ${path}: ${detail}`);
    this.name = 'StartArtifactLoadError';
    this.kind = kind;
    this.path = path;
  }
}

/** CLI 命令层透传的装载路径(--presets/--registry/--models flag 与 config 字段的统一入口)。 */
export interface StartArtifactRefs {
  readonly presets?: string;
  readonly registry?: string;
  readonly models?: string;
}

/** 装载结果:只含显式声明的路;未声明的路不注入(startDaemon 走各自缺省)。 */
export interface ResolvedStartArtifacts {
  readonly presets?: Readonly<Record<string, Preset>>;
  readonly registry?: LoadedRegistry;
  readonly models?: LoadedModelRegistry;
}

/** config 顶层字段取值:字符串路径原样返回;非字符串显式拒绝(不静默当未声明)。 */
function configString(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v === '') {
    throw new StartArtifactLoadError(key as 'presets' | 'registry' | 'models', String(v), 'config 字段必须是非空字符串路径');
  }
  return v;
}

/**
 * #6 生产接线:`neoba start` 的外部编排文档装载 —— 与 `workflow check`
 * 同源(loadPresetsFromDirs / loadCapabilityRegistryFile / loadModelsFile,
 * 不另写一份解析,避免 #5 式口径分叉)。
 *
 * 来源优先级:CLI flag > neoba.config.json 顶层字段 > 缺省(不注入)。
 * config 中的相对路径相对命中 config 文件所在目录解析;flag 相对 cwd。
 * 任一路装载失败抛 StartArtifactLoadError,不静默降级;三路全缺省返回
 * 空对象 —— startDaemon 保持现行为(内置 minimal、缺省注册表、models 走
 * <stateDir>/modelscore.json),零漂移。
 */
export async function resolveConfiguredStartArtifacts(
  refs: StartArtifactRefs,
  opts?: { cwd?: string; homedir?: string },
): Promise<ResolvedStartArtifacts> {
  const loaded = await loadNeobaConfigDetailed(opts);
  // config 相对路径的基准:命中的 config 文件所在目录;无 config 时 cwd。
  const base = loaded.path !== null
    ? dirname(loaded.path)
    : (opts?.cwd ?? process.cwd());
  const resolvePath = (p: string): string => (isAbsolute(p) ? p : join(base, p));

  const presetsRef = refs.presets ?? configString(loaded.config, 'presets');
  const registryRef = refs.registry ?? configString(loaded.config, 'registry');
  const modelsRef = refs.models ?? configString(loaded.config, 'models');

  const out: {
    presets?: Readonly<Record<string, Preset>>;
    registry?: LoadedRegistry;
    models?: LoadedModelRegistry;
  } = {};

  if (presetsRef !== undefined) {
    const dir = resolvePath(presetsRef);
    const report = await loadPresetsFromDirs([dir]);
    if (report.errors.length > 0) {
      const detail = report.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      throw new StartArtifactLoadError('presets', dir, detail);
    }
    out.presets = report.presets;
  }
  if (registryRef !== undefined) {
    const file = resolvePath(registryRef);
    try {
      out.registry = await loadCapabilityRegistryFile(file);
    } catch (err) {
      throw new StartArtifactLoadError('registry', file, err instanceof Error ? err.message : String(err));
    }
  }
  if (modelsRef !== undefined) {
    const file = resolvePath(modelsRef);
    try {
      const models = await loadModelsFile(file);
      if (models === undefined) {
        throw new StartArtifactLoadError('models', file, '模型评分表装载结果为空');
      }
      out.models = models;
    } catch (err) {
      if (err instanceof StartArtifactLoadError) throw err;
      throw new StartArtifactLoadError('models', file, err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

/** 组装默认依赖:真实 daemon / doctor / CAS 仓库 / MCP 桥。 */
export async function defaultDeps(overrides: Partial<CliDeps> = {}): Promise<CliDeps> {
  const deps: CliDeps = {
    version: await loadPackageVersion(),
    startDaemon: async (opts) => {
      // #6:start 命令经 presetsPath/registryPath/modelsPath(CLI flag)透传
      // 装载路径,config 字段(presets/registry/models)为缺省、flag 可覆盖;
      // 装载器与 workflow check 同源。库用注入(DaemonOptions 的对象形态
      // presets/registry/models)不经此路径,原样透传。
      const raw = (opts ?? {}) as Record<string, unknown>;
      const strRef = (key: string): string | undefined => {
        const v = raw[key];
        return typeof v === 'string' ? v : undefined;
      };
      const artifacts = await resolveConfiguredStartArtifacts({
        presets: strRef('presetsPath'),
        registry: strRef('registryPath'),
        models: strRef('modelsPath'),
      });
      const [secrets, sandbox] = await Promise.all([
        resolveConfiguredSecretStore(),
        resolveConfiguredSandbox(),
      ]);
      return startDaemon({
        ...(raw as DaemonOptions),
        ...(artifacts.presets !== undefined ? { presets: artifacts.presets } : {}),
        ...(artifacts.registry !== undefined ? { registry: artifacts.registry } : {}),
        ...(artifacts.models !== undefined ? { models: artifacts.models } : {}),
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
