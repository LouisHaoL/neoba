/**
 * 桥进程模式:spawnBridge({baseUrl, tokenFile}) 以 stdio 方式拉起
 * src/bindings/cli.ts 子进程(neoba-mcp 桥),鉴权 token 从 tokenFile 读
 * (或经 NEOBA_TOKEN 环境变量直接注入)。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

export const BASE_URL_ENV = 'NEOBA_BASE_URL';
export const TOKEN_FILE_ENV = 'NEOBA_TOKEN_FILE';
export const TOKEN_ENV = 'NEOBA_TOKEN';

/** cli.ts 的绝对路径(随本模块位置解析,便于被外部包引用)。 */
export function bridgeCliPath(): string {
  return fileURLToPath(new URL('./cli.ts', import.meta.url));
}

export interface SpawnBridgeOptions {
  readonly baseUrl: string;
  /** token 文件路径(cli.ts 从这里读 token);与 token 二选一。 */
  readonly tokenFile?: string;
  /** 直接注入 token(测试优先,免落盘)。 */
  readonly token?: string;
  readonly cwd?: string;
}

/** 拉起桥进程;stdio 全管道,返回 ChildProcess(调用方负责 stdin/stdout 收发与 kill)。 */
export function spawnBridge(opts: SpawnBridgeOptions): ChildProcess {
  if (opts.tokenFile === undefined && opts.token === undefined) {
    throw new Error('spawnBridge 需要 tokenFile 或 token 之一');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [BASE_URL_ENV]: opts.baseUrl,
  };
  if (opts.tokenFile !== undefined) env[TOKEN_FILE_ENV] = opts.tokenFile;
  if (opts.token !== undefined) {
    env[TOKEN_ENV] = opts.token;
    delete env[TOKEN_FILE_ENV];
  }
  return spawn(process.execPath, [bridgeCliPath()], {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
