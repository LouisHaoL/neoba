/**
 * SandboxProvider 抽象(设计文档 §5,v0.2)。
 *
 * "docker 只是概念,核心是干净环境"。本模块只定义供给接口的语义模型,
 * 不绑定任何具体后端(Docker / gVisor / Firecracker / WASM 均可实现)。
 */

/** 沙箱生命周期状态。v0.2 daemon 不观测容器内进程退出,故 running 之后只有 removed。 */
export type SandboxStatus =
  | "pending" // 已受理,尚未开始拉起
  | "provisioning" // 正在拉起(docker create/start 进行中)
  | "running" // 可 exec
  | "stopped" // 预留:后端观测到容器退出(v0.2 不产生)
  | "removed"; // 已销毁;destroy 对该状态幂等

/**
 * 基座前置条件契约(§5 v0.2,spike #1 F5):create 时后端必须满足或显式拒绝。
 * - userns:Codex/bubblewrap 依赖 clone(CLONE_NEWUSER),docker 默认 seccomp 会拦;
 * - preinstalled:镜像内需预装的组件(如 bubblewrap),由镜像构建/neoba doctor 校验。
 */
export interface BaseRequirements {
  /** 声明的基座(如 "codex" / "claude-code"),仅记录与打标签 */
  harness?: string;
  /** 需要宿主 userns 能力;不可满足时后端显式拒绝(PrerequisiteNotMetError) */
  userns?: boolean;
  /** 需要镜像内预装的组件;本期为声明性记录 */
  preinstalled?: string[];
}

/**
 * 网络策略(§5 v0.2):"可出网/可达某地址段"本身是 grant 项,每任务独立 netns。
 * - none:无网络(默认,最严)
 * - bridge:默认桥接
 * - allowlist:出口 allowlist——本期预留,create 一律 NotSupportedError
 */
export type NetworkPolicy =
  | { mode: "none" }
  | { mode: "bridge" }
  | { mode: "allowlist"; allow: string[] };

/**
 * 挂载卷(§4.4 v0.2 spawn 硬规则):
 * - workdir:普通工作目录挂载,ro/rw 自选(grant manifest 的 fs 挂载位);
 * - secret / config:基座配置与凭据挂载,一律 ro——类型上 mode 即字面量 "ro",
 *   无法表达 rw;运行时再次强制(防 JS 侧 as 绕过)。
 */
export type SandboxMount =
  | { kind: "workdir"; source: string; target: string; mode: "ro" | "rw" }
  | { kind: "secret" | "config"; source: string; target: string; mode: "ro" };

/** 资源限额。memoryBytes 用字节整数,由各后端自行翻译(如 docker --memory)。 */
export interface SandboxResources {
  cpus?: number;
  memoryBytes?: number;
  pidsLimit?: number;
}

/**
 * 沙箱规格。labels 会被统一追加 neoba.* 前缀的管理标签
 * (neoba.managed / neoba.provider / neoba.created-at),便于按标签清理。
 */
export interface SandboxSpec {
  /** 基座镜像(参考 spike/Dockerfile:node:22-slim + CLI + 非 root worker 用户) */
  image: string;
  /** 覆盖镜像默认 CMD 的命令(如 supervisor / harness 基座拉起命令) */
  command?: string[];
  /** 基座前置条件(§5 v0.2);缺省视为无特殊要求(如 Claude Code) */
  baseRequirements?: BaseRequirements;
  env?: Record<string, string>;
  resources?: SandboxResources;
  /** 缺省为 { mode: "none" }:默认最严网络 */
  network?: NetworkPolicy;
  mounts?: SandboxMount[];
  /** 额外业务标签,原样透传给后端 */
  labels?: Record<string, string>;
  /** 非 root 运行用户(如 "worker" 或 "1000:1000") */
  user?: string;
  /** 容器内工作目录 */
  workdir?: string;
}

/** 沙箱句柄:跨 provider 调用的稳定引用。 */
export interface SandboxHandle {
  id: string;
  status: SandboxStatus;
  /** ISO 8601 时间戳 */
  createdAt: string;
  /** 后端侧可读名称(docker 为 --name;memory 为内部名) */
  name: string;
  /** 含 neoba.* 管理标签在内的全量标签 */
  labels: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
}

export interface LogsOptions {
  /** 只取末尾 N 行;缺省取全部 */
  tail?: number;
}

/**
 * 沙箱供给接口(§5 v0.2)。
 *
 * 实现约定:
 * - destroy 对已销毁/未知句柄幂等(不抛错);
 * - exec 对非 running 句柄抛 InvalidStateError;
 * - create 对不可满足的基座前置条件抛 PrerequisiteNotMetError(显式拒绝,不静默降级);
 * - snapshot/restore 与 acquire/release 为未实现能力,一律抛 NotSupportedError;
 * - list 只返回本 provider 实例创建的、未销毁的句柄,labels 为子集匹配。
 */
export interface SandboxProvider {
  /** 后端标识,如 "docker" / "memory" / "microsandbox" */
  readonly backend: string;
  /**
   * 是否具备 snapshot/restore 能力(M7 预热池的准入判据,§9 P4):
   * 缺省(未声明)= 不支持 —— docker/memory 不声明,M7 WarmPool 对其
   * 直通退化为冷拉;microsandbox(Firecracker microVM)声明 true。
   */
  readonly snapshotCapable?: boolean;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult>;
  logs(handle: SandboxHandle, opts?: LogsOptions): Promise<string>;
  destroy(handle: SandboxHandle): Promise<void>;
  list(labels?: Record<string, string>): Promise<SandboxHandle[]>;
  snapshot(handle: SandboxHandle): Promise<string>;
  restore(snapshotRef: string): Promise<SandboxHandle>;
  /**
   * 资源池预留位(§6 v0.2:并发容器数/配额排队)。v0.2 不实现排队——
   * 由 Provisioner 在事件日志上确定性执行,本接口仅占位,调用抛 NotSupportedError。
   */
  acquire(slot: string): Promise<void>;
  release(slot: string): Promise<void>;
}
