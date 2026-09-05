/**
 * Provider 工厂(M7):按 neoba.config.json 的 sandbox 小节实例化
 * SandboxProvider。生产组装(cli/deps.ts)与测试共用同一入口。
 *
 * 决策表(sandbox.provider):
 *   缺省(小节/字段缺失)→ memory(现行为,零漂移)
 *   "memory"        → MemoryProvider(进程内,单测/无后端环境)
 *   "docker"        → DockerProvider(CLI 子进程)
 *   "microsandbox"  → MicrosandboxProvider(Firecracker microVM,msb CLI)
 *   其他任何值      → ProviderUnknownError(显式拒绝,不静默降级)
 *
 * doctor 的 recommendedBackend 仍以 docker 优先(M6 语义不变);microsandbox
 * 是显式配置项,doctor 只负责探测 msb 可用性(microsandboxReady)供人工决策。
 */
import { ProviderUnknownError } from "./errors.ts";
import { DockerProvider } from "./docker-provider.ts";
import { MemoryProvider } from "./memory-provider.ts";
import { MicrosandboxProvider } from "./microsandbox-provider.ts";
import { createMicrosandboxCliRunner, type CliRunner } from "./runner.ts";
import type { SandboxProvider } from "./types.ts";
import type { NeobaConfig } from "../doctor/config.ts";

/** 注册表:工厂认识的全部后端(错误提示与测试决策表共用)。 */
export const KNOWN_PROVIDERS = ["memory", "docker", "microsandbox"] as const;

/** sandbox 小节的 M7 感知字段(其余字段原样透传/忽略)。 */
export interface SandboxSectionConfig {
  /** 后端名;缺省 memory。 */
  provider?: string;
  /** microsandbox CLI 可执行名(缺省 msb; PATH 之外的安装路径用)。 */
  binary?: string;
  /** 节点基座镜像缺省值(cli/deps 接线传给 startDaemon;缺省 neoba/sandbox:latest)。 */
  image?: string;
  /** 预热池小节;存在即建池(直通退化与否由 provider 能力决定)。 */
  pool?: { capacity?: number; slots?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取 config 的 sandbox 小节;缺省 / 非对象 → undefined(调用方保持现行为)。 */
export function readSandboxConfig(config: NeobaConfig | undefined): SandboxSectionConfig | undefined {
  const section = config?.["sandbox"];
  if (!isRecord(section)) return undefined;
  return section as SandboxSectionConfig;
}

export interface CreateProviderOptions {
  /** microsandbox runner 注入(测试假 runner;生产缺省 spawn 真实 msb)。 */
  msbRunner?: CliRunner;
}

/** 按配置实例化 provider;未知后端名抛 ProviderUnknownError,不降级。 */
export function createProvider(
  config: NeobaConfig | undefined,
  opts: CreateProviderOptions = {},
): SandboxProvider {
  const section = readSandboxConfig(config);
  const name = section?.provider ?? "memory";
  switch (name) {
    case "memory":
      return new MemoryProvider();
    case "docker":
      return new DockerProvider();
    case "microsandbox":
      return new MicrosandboxProvider({
        // binary 显式给出(含路径)→ 按其构造 runner;否则 provider 内部缺省 spawn msb
        ...(opts.msbRunner !== undefined
          ? { runner: opts.msbRunner }
          : section?.binary !== undefined && section.binary !== ""
            ? { runner: createMicrosandboxCliRunner(section.binary) }
            : {}),
      });
    default:
      throw new ProviderUnknownError(name, [...KNOWN_PROVIDERS]);
  }
}
