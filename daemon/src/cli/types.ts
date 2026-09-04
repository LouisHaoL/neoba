/**
 * neoba CLI 壳(§6 服务为核,工具为壳 / §3.10 CLI = 人肉调试与兜底)。
 * 本文件只放壳层的类型:注入的 IO、依赖与命令注册表条目。
 * 壳不做业务:命令实现 = 解析参数 + 调既有模块(daemon/doctor/artifacts/bindings)。
 */

/** 注入的输出通道;每个命令只允许经 io 打印,便于测试捕获。 */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/** 真实进程 IO:每条调用补一个换行(命令侧按整行语义使用)。 */
export const processIo: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

/** 单条命令的注册表条目:map 结构,便于测试与未来子命令扩展。 */
export interface Command {
  readonly name: string;
  readonly summary: string;
  /** 单命令帮助行(完整用法示例)。 */
  readonly usage: string;
  /** 返回进程退出码;0 = 成功。 */
  run(args: readonly string[], ctx: CommandContext): Promise<number>;
}

export interface CommandContext {
  readonly io: CliIo;
  readonly deps: CliDeps;
}

/** prune 命令用到的工件仓库最小接口(只读对账 + GC),便于测试用假仓库。 */
export interface CasRepoLike {
  reconcile(): Promise<{
    manifests: number;
    objects: number;
    missing: string[];
    corrupted: string[];
    unreferenced: string[];
  }>;
  prune(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * 命令可触达的全部外部依赖(默认实现见 deps.ts);测试注入替身。
 * 壳层绝不直接 import child_process / 网络,一律走这里。
 */
export interface CliDeps {
  /** neoba 包版本(--version 输出)。 */
  readonly version: string;
  startDaemon(opts: unknown): Promise<unknown>;
  runDoctor(opts: { probe: CliDeps['execProbe'] }): Promise<unknown>;
  writeConfig(report: unknown, configPath: string): Promise<unknown>;
  defaultConfigPath(): string;
  /** doctor 的命令探针(默认真实 execProbe;测试注入假探针)。 */
  execProbe(cmd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  openRepository(root: string): Promise<CasRepoLike>;
  /** 拉起 MCP 桥子进程;返回子进程句柄(mcp 命令在本地收窄类型做管道转发)。 */
  spawnBridge(opts: {
    baseUrl: string;
    tokenFile?: string;
    token?: string;
    cwd?: string;
  }): unknown;
  fetch: typeof fetch;
  homedir(): string;
  /** 读文本文件;不存在返回 null(状态目录不存在要优雅,不抛)。 */
  readTextFile(path: string): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;
}
