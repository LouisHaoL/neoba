/**
 * neoba doctor - 类型定义
 *
 * 全部字段 camelCase;报告字段要么全 camelCase,不允许混用 snake_case。
 */

/** 单次外部命令执行的标准化结果。 */
export interface ExecResult {
  /** 0 = 成功;-1 = 探针异常(如命令不存在/超时);其他 = 命令自身退出码。 */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 外部命令探针接口。核心检测逻辑只依赖此接口,不直接触碰 child_process。
 * 真实实现见 ./realProbe.ts。
 */
export type ExecProbe = (cmd: string, args: string[]) => Promise<ExecResult>;

/** 检查项严重级别:ok=通过 / warn=有缺失但不阻塞 / fail=不满足 / unknown=无法判定(不阻塞)。 */
export type Severity = 'ok' | 'warn' | 'fail' | 'unknown';

export interface CheckResult {
  /** 检查项稳定标识,如 "docker-cli"、"wsl-status"。 */
  id: string;
  /** 是否通过(warn 视为不通过,但不改变整体可用性判定)。 */
  ok: boolean;
  severity: Severity;
  detail: string;
  /** 不通过时的修复建议。 */
  suggestion?: string;
}

/** doctor 推荐的 SandboxProvider 后端(对应设计文档 §5 / §10.6)。 */
export type RecommendedBackend = 'docker' | 'docker-wsl2' | 'none';

/** 主机平台与资源信息(可注入以便测试,真实采集见 ./realProbe.ts)。 */
export interface PlatformInfo {
  /** os.platform():'linux' | 'darwin' | 'win32' | ... */
  platform: string;
  /** os.release() */
  release: string;
  /** os.version() */
  version: string;
  /** os.arch() */
  arch: string;
  /** Linux 内核版本(uname -r),供 gVisor/Firecracker 判断预留;非 Linux 或采集失败为 null。 */
  kernelVersion: string | null;
  cpuCount: number;
  totalMemoryBytes: number;
  /** 目标盘(neoba 工作目录所在盘)剩余空间;采集失败为 null。 */
  targetDiskFreeBytes: number | null;
}

/** 单条数据面路径检测结果(v0.2 §10.6)。 */
export interface DataPlanePathCheck {
  kind: string;
  path: string;
  location: string;
  crossBoundary: boolean;
  severity: Severity;
  detail: string;
}

/** .wslconfig 资源限额读取结果(缺失不阻塞)。 */
export interface WslConfigInfo {
  found: boolean;
  memory: string | null;
  processors: string | null;
  /** 文件存在但解析异常时的说明;正常为 null。 */
  parseError: string | null;
}

/** 结构化环境报告。 */
export interface DoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  platform: PlatformInfo;
  checks: CheckResult[];
  recommendedBackend: RecommendedBackend;
  /** 后端判定理由(人类可读)。 */
  backendReason: string;
  /** Codex 基座前置条件是否满足(userns 等,v0.2 §5);仅 Linux/WSL2 上可判定。 */
  codexReady: boolean;
  /** codexReady=false 时的原因;true 时为 null。 */
  codexReadyReason: string | null;
  /** OpenCode 基座前置是否满足(无 userns 要求,仅容器后端可达,P3)。 */
  opencodeReady: boolean;
  /** opencodeReady=false 时的原因;true 时为 null。 */
  opencodeReadyReason: string | null;
  /** OS keyring(libsecret secret-tool)是否可用,M6;仅 Linux 可判定,
   * win/mac 为 N/A(不阻塞,secret 后端走平台默认)。 */
  keyringReady: boolean;
  /** keyringReady=false 时的原因(含"N/A:平台不适用");true 时为 null。 */
  keyringReadyReason: string | null;
  /** microsandbox CLI(msb,Firecracker microVM 后端)是否可用,M7;
   * 仅 Linux 可判定(KVM 前置),win/mac 为 N/A(不阻塞,可选后端)。 */
  microsandboxReady: boolean;
  /** microsandboxReady=false 时的原因(含"N/A:平台不适用");true 时为 null。 */
  microsandboxReadyReason: string | null;
  /** 数据面路径跨界检测结果(可能为空数组 = 未配置数据面路径)。 */
  dataPlane: DataPlanePathCheck[];
  /** 数据面是否存在跨界路径(error 级)。 */
  dataPlaneCrossBoundary: boolean;
  /** %UserProfile%\.wslconfig 资源限额。 */
  wslconfig: WslConfigInfo;
}

export interface DoctorOptions {
  probe: ExecProbe;
  /** 注入平台信息则跳过真实采集(测试用);缺省时经 realProbe.collectSystemInfo 采集。 */
  systemInfo?: PlatformInfo;
  /** 用于磁盘剩余空间检测的目标路径,默认 process.cwd()。 */
  targetPath?: string;
  /** 时间源,默认 () => new Date()。 */
  now?: () => Date;
  /** 数据面路径清单(workdir / 工件仓库 / docker context 等);缺省视为未配置。 */
  dataPlanePaths?: { kind: string; path: string }[];
  /** .wslconfig 内容;null=文件不存在;undefined=真实读取 %UserProfile%\.wslconfig。 */
  wslconfigContent?: string | null;
}
