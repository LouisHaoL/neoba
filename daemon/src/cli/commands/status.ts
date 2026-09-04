/**
 * neoba status:读状态目录的 daemon-state.json 与 token 文件存在性,
 * 尝试连 HTTP 探活,输出一行摘要(人读默认,--json 出结构化)。
 * 状态目录不存在 / 状态文件损坏都优雅报错(退出码 1),不抛异常。
 */

import { join } from 'node:path';

import { flagBool, flagString, parseArgs } from '../args.ts';
import type { Command, CliDeps } from '../types.ts';

const STATE_FILE_NAME = 'daemon-state.json';
const TOKEN_FILE_NAME = 'token';
const PROBE_TIMEOUT_MS = 1500;

interface DaemonStateFile {
  pid?: unknown;
  version?: unknown;
  port?: unknown;
  startedAt?: unknown;
  stoppedAt?: unknown;
}

/** HTTP 探活:任何 HTTP 响应(含 401/405)都算 daemon 活着;网络错误 = 不在。 */
export async function probeAlive(
  fetchFn: CliDeps['fetch'],
  baseUrl: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await fetchFn(baseUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

export const statusCommand: Command = {
  name: 'status',
  summary: '查看 daemon 状态(状态文件 + token + HTTP 探活)',
  usage: 'neoba status [--state-dir DIR] [--json]',
  async run(args, { io, deps }) {
    const { flags } = parseArgs(args, ['state-dir']);
    const asJson = flagBool(flags, 'json');
    const stateDir =
      flagString(flags, 'state-dir') ?? join(deps.homedir(), '.neoba');
    const statePath = join(stateDir, STATE_FILE_NAME);
    const tokenPath = join(stateDir, TOKEN_FILE_NAME);

    const raw = await deps.readTextFile(statePath);
    if (raw === null) {
      const message = `未找到 daemon 状态文件(${statePath});daemon 未运行或从未启动`;
      if (asJson) {
        io.out(JSON.stringify(
          { stateDir, stateFile: false, tokenFile: false, running: false, alive: false, error: message },
          null,
          2,
        ));
      } else {
        io.err(`neoba: ${message}`);
      }
      return 1;
    }

    let state: DaemonStateFile;
    try {
      state = JSON.parse(raw) as DaemonStateFile;
    } catch {
      const message = `daemon 状态文件损坏(不是合法 JSON): ${statePath}`;
      if (asJson) {
        io.out(JSON.stringify(
          { stateDir, stateFile: true, tokenFile: false, running: false, alive: false, error: message },
          null,
          2,
        ));
      } else {
        io.err(`neoba: ${message}`);
      }
      return 1;
    }

    const pid = typeof state.pid === 'number' ? state.pid : null;
    const port = typeof state.port === 'number' ? state.port : null;
    const version = typeof state.version === 'string' ? state.version : null;
    const startedAt = typeof state.startedAt === 'string' ? state.startedAt : null;
    const stoppedAt = typeof state.stoppedAt === 'string' ? state.stoppedAt : null;
    const tokenFile = await deps.fileExists(tokenPath);
    const alive =
      stoppedAt === null && port !== null
        ? await probeAlive(deps.fetch, `http://127.0.0.1:${port}`)
        : false;
    const running = stoppedAt === null && alive;

    if (asJson) {
      io.out(JSON.stringify(
        {
          stateDir,
          stateFile: true,
          tokenFile,
          pid,
          version,
          port,
          startedAt,
          stoppedAt,
          alive,
          running,
        },
        null,
        2,
      ));
    } else if (running) {
      io.out(
        `neoba daemon 运行中 pid=${pid ?? '?'} port=${port ?? '?'} version=${version ?? '?'} token=${tokenFile ? '有' : '缺'} stateDir=${stateDir}`,
      );
    } else {
      io.out(
        `neoba daemon 未运行(stoppedAt=${stoppedAt ?? '未记录'} alive=${alive ? 'yes' : 'no'}) stateDir=${stateDir}`,
      );
    }
    return running ? 0 : 1;
  },
};
