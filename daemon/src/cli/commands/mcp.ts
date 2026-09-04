/**
 * neoba mcp:拉起 stdio MCP 桥(透传 spawnBridge;桥本体在 src/bindings)。
 * token 从状态目录读(daemon 每次启动写 <stateDir>/token);
 * daemon 地址从 daemon-state.json 的 port 推导,--port 可覆盖。
 */

import { join } from 'node:path';

import { flagInt, flagString, parseArgs } from '../args.ts';
import type { Command } from '../types.ts';

const STATE_FILE_NAME = 'daemon-state.json';
const DEFAULT_PORT = 7917;

export const mcpCommand: Command = {
  name: 'mcp',
  summary: '拉起 stdio MCP 桥(连本地 daemon,token 从状态目录读)',
  usage: 'neoba mcp [--state-dir DIR] [--port N]',
  async run(args, { io, deps }) {
    const { flags } = parseArgs(args, ['state-dir', 'port']);
    const stateDir =
      flagString(flags, 'state-dir') ?? join(deps.homedir(), '.neoba');
    const tokenFile = join(stateDir, 'token');

    let port = flagInt(flags, 'port');
    if (port === undefined) {
      const raw = await deps.readTextFile(join(stateDir, STATE_FILE_NAME));
      if (raw !== null) {
        try {
          const state = JSON.parse(raw) as { port?: unknown };
          if (typeof state.port === 'number') port = state.port;
        } catch {
          // 状态文件损坏时回退默认端口
        }
      }
    }
    const baseUrl = `http://127.0.0.1:${port ?? DEFAULT_PORT}`;

    if (!(await deps.fileExists(tokenFile))) {
      io.err(
        `neoba: 读不到 token(${tokenFile});请先启动 daemon(neoba start)再拉桥`,
      );
      return 1;
    }

    const child = deps.spawnBridge({ baseUrl, tokenFile }) as {
      stdin: NodeJS.WritableStream | null;
      stdout: NodeJS.ReadableStream | null;
      stderr: NodeJS.ReadableStream | null;
      on(event: string, listener: (...args: unknown[]) => void): unknown;
    };
    if (process.stdin.readable && child.stdin !== null) {
      process.stdin.pipe(child.stdin);
    }
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);

    return await new Promise<number>((resolve) => {
      child.on('error', (err: unknown) => {
        io.err(`neoba: MCP 桥进程异常: ${err instanceof Error ? err.message : String(err)}`);
        resolve(1);
      });
      child.on('exit', (code: unknown) => {
        resolve(typeof code === 'number' ? code : 1);
      });
    });
  },
};
