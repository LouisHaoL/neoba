/**
 * e2e 子进程测试工具:拉起/驱动真实 daemon 进程与 CLI/桥进程。
 *
 * 与进程内测试(golden / daemon.test)的分工:这里一切经进程边界 ——
 * daemon 是 `node test/e2e/boot.ts` 子进程(注入假基座,见 boot.ts),
 * CLI 是 `node src/cli/main.ts` 子进程,状态发现走 <stateDir>/daemon-state.json
 * + token 文件(与真用户的 neoba status/mcp 完全同一条路径)。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { spawnBridge } from '../../src/bindings/index.ts';
import type { ChildProcess } from 'node:child_process';

const DAEMON_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));

export const BOOT_SCRIPT = join(DAEMON_ROOT, 'test', 'e2e', 'boot.ts');
export const CLI_SCRIPT = join(DAEMON_ROOT, 'src', 'cli', 'main.ts');

const READY_PREFIX = 'NEOBA_E2E_READY ';
const BOOT_TIMEOUT_MS = 15_000;
const POLL_MS = 50;

// ---------------------------------------------------------------- 进程工具

export interface ProcOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 收尽 stdout/stderr 直到进程退出(带超时兜底,超时杀进程防挂死)。 */
export async function waitExit(proc: ChildProcess, timeoutMs = 20_000): Promise<ProcOutcome> {
  return await new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
    proc.stdout?.on('data', (c: Buffer) => stdout.push(c));
    proc.stderr?.on('data', (c: Buffer) => stderr.push(c));
    proc.on('close', (code) => finish(code));
  });
}

export interface RunNeobaOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** 跑一次 `neoba <args>`(真实 CLI 子进程);返回退出码与输出。 */
export async function runNeoba(args: readonly string[], opts: RunNeobaOptions = {}): Promise<ProcOutcome> {
  const proc = spawn(process.execPath, [CLI_SCRIPT, ...args], {
    cwd: opts.cwd ?? DAEMON_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return await waitExit(proc, opts.timeoutMs);
}

// ---------------------------------------------------------------- daemon 子进程

export interface BootOptions {
  /** 状态目录;缺省 mkdtemp 新建(重启恢复用例传同一路径复用)。 */
  readonly stateDir?: string;
  readonly exec?: 'echo' | 'stream' | 'fail' | 'slow';
  /** preset 文档 JSON 数组文件路径(透传 NEOBA_E2E_PRESETS)。 */
  readonly presets?: string;
  /** stream 档假基座的产物内容。 */
  readonly execBase?: string;
  readonly sseHeartbeatMs?: number;
  readonly gcIntervalMs?: number;
  readonly reclaimIntervalMs?: number;
}

export interface E2eDaemon {
  readonly proc: ChildProcess;
  readonly baseUrl: string;
  readonly stateDir: string;
  readonly token: string;
  readonly pid: number;
  /** JSON-RPC 调用(bootstrap admin token)。 */
  rpc(method: string, params?: unknown, token?: string): Promise<{ status: number; body: RpcBody }>;
  /** 进程内通道优雅停机(stdin `{"op":"stop"}` → 同一条 stop() 路径)。 */
  stop(): Promise<ProcOutcome>;
  /** 硬杀(模拟崩溃)。 */
  kill(): void;
}

export type RpcBody = Record<string, unknown> & {
  result?: unknown;
  error?: { code: number | string; message?: string; data?: unknown };
};

export function tempStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'neoba-e2e-'));
}

export function cleanupStateDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** 拉起 daemon 子进程并等就绪行;失败时带着 stderr 抛错。 */
export async function bootDaemon(opts: BootOptions = {}): Promise<E2eDaemon> {
  const stateDir = opts.stateDir ?? (await tempStateDir());
  const env: NodeJS.ProcessEnv = { ...process.env, NEOBA_E2E_STATE_DIR: stateDir };
  if (opts.exec !== undefined) env['NEOBA_E2E_EXEC'] = opts.exec;
  if (opts.presets !== undefined) env['NEOBA_E2E_PRESETS'] = opts.presets;
  if (opts.execBase !== undefined) env['NEOBA_E2E_EXEC_BASE'] = opts.execBase;
  if (opts.sseHeartbeatMs !== undefined) env['NEOBA_E2E_SSE_MS'] = String(opts.sseHeartbeatMs);
  if (opts.gcIntervalMs !== undefined) env['NEOBA_E2E_GC_MS'] = String(opts.gcIntervalMs);
  if (opts.reclaimIntervalMs !== undefined) env['NEOBA_E2E_RECLAIM_MS'] = String(opts.reclaimIntervalMs);

  const proc = spawn(process.execPath, [BOOT_SCRIPT], {
    cwd: DAEMON_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`boot 超时(${BOOT_TIMEOUT_MS}ms)`)), BOOT_TIMEOUT_MS);
    proc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf(READY_PREFIX);
      if (idx >= 0) {
        clearTimeout(timer);
        const line = buffer.slice(idx + READY_PREFIX.length).split('\n')[0] ?? '';
        try {
          resolve(JSON.parse(line) as Record<string, unknown>);
        } catch (err) {
          reject(new Error(`就绪行非 JSON: ${line}`));
        }
      }
    });
    let stderr = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`boot 进程提前退出(code=${code})\nstderr: ${stderr.slice(-2000)}`));
    });
  });

  const token = String(ready['token']);
  const daemon: E2eDaemon = {
    proc,
    baseUrl: String(ready['baseUrl']),
    stateDir: String(ready['stateDir']),
    token,
    pid: Number(ready['pid']),
    async rpc(method, params, useToken) {
      const res = await fetch(`${daemon.baseUrl}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${useToken ?? token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, body: (await res.json()) as RpcBody };
    },
    stop() {
      proc.stdin!.write('{"op":"stop"}\n');
      return waitExit(proc);
    },
    kill() {
      proc.kill();
    },
  };
  return daemon;
}

// ---------------------------------------------------------------- 状态文件发现

export interface DaemonStateFile {
  readonly pid: number;
  readonly version: string;
  readonly port: number;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
}

export async function readStateFile(stateDir: string): Promise<DaemonStateFile> {
  const raw = await readFile(join(stateDir, 'daemon-state.json'), 'utf8');
  return JSON.parse(raw) as DaemonStateFile;
}

export async function readTokenFile(stateDir: string): Promise<string> {
  return (await readFile(join(stateDir, 'token'), 'utf8')).trim();
}

// ---------------------------------------------------------------- 等待原语

const TERMINAL_TASK_STATUS = new Set(['completed', 'failed', 'cancelled', 'paused']);

/** 轮询 task.status 直到终态(或超时抛错);返回末次应答 result。 */
export async function awaitTask(
  daemon: E2eDaemon,
  taskId: string,
  opts: { until?: readonly string[]; timeoutMs?: number; token?: string } = {},
): Promise<Record<string, unknown>> {
  const until = new Set(opts.until ?? TERMINAL_TASK_STATUS);
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  for (;;) {
    const { body } = await daemon.rpc('task.status', { task_id: taskId }, opts.token);
    if (body.error === undefined || body.error === null) {
      const task = ((body.result as Record<string, unknown>)?.['task'] ?? body.result) as Record<string, unknown>;
      if (until.has(String(task['status']))) return task;
    }
    if (Date.now() > deadline) {
      throw new Error(`awaitTask 超时: task=${taskId} 末次应答=${JSON.stringify(body).slice(0, 500)}`);
    }
    await delay(POLL_MS);
  }
}

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * 收 SSE 流直到谓词命中(或超时):返回已收事件(含命中帧)。
 * tokenSource:'query' 走 ?token=,缺省 Bearer 头。
 */
export async function sseCollect(
  daemon: E2eDaemon,
  opts: {
    until?: (ev: SseEvent) => boolean;
    timeoutMs?: number;
    tokenSource?: 'header' | 'query';
    path?: string;
  } = {},
): Promise<SseEvent[]> {
  const url = new URL(opts.path ?? '/events/stream', daemon.baseUrl);
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (opts.tokenSource === 'query') url.searchParams.set('token', daemon.token);
  else headers['authorization'] = `Bearer ${daemon.token}`;

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  if (!res.ok || res.body === null) {
    throw new Error(`SSE 连接失败: HTTP ${res.status}`);
  }
  const events: SseEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (Date.now() > deadline) break;
      const chunk = await Promise.race([
        reader.read(),
        delay(Math.max(deadline - Date.now(), 1)).then(() => null),
      ]);
      if (chunk === null || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = frame.split('\n');
        let event = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        const sse: SseEvent = { event, data };
        events.push(sse);
        if (opts.until?.(sse) === true) return events;
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  return events;
}

// ---------------------------------------------------------------- MCP 桥子进程

export interface BridgeClient {
  request(method: string, params?: unknown): Promise<{ id: number; body: Record<string, unknown> }>;
  /** 已收到的桥通知行(同一数组实例持续追加)。 */
  readonly notifications: string[];
  stop(): Promise<ProcOutcome>;
}

/** 拉起真实桥子进程(node src/bindings/cli.ts),行 JSON 收发。 */
export function spawnBridgeClient(daemon: E2eDaemon): BridgeClient {
  const proc = spawnBridge({ baseUrl: daemon.baseUrl, token: daemon.token, cwd: DAEMON_ROOT });
  const pending = new Map<number, (body: Record<string, unknown>) => void>();
  const notifications: string[] = [];
  let nextId = 1;
  let lineBuf = '';
  proc.stdout!.on('data', (chunk: Buffer) => {
    lineBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (line === '') continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = msg['id'];
      if (typeof id === 'number') {
        pending.get(id)?.(msg);
        pending.delete(id);
      } else {
        notifications.push(line);
      }
    }
  });
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`bridge 请求超时: ${method}`));
        }, 10_000);
        pending.set(id, (body) => {
          clearTimeout(timer);
          resolve({ id, body });
        });
        proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
      });
    },
    notifications,
    stop: () => waitExit(proc),
  };
}
