/**
 * CLI → daemon 的 JSON-RPC 客户端(人机入口的传输层,§3.10 / §6):
 * 从状态目录读 daemon-state.json(端口)+ token 文件,POST 单条请求。
 * 壳不做业务:错误按 {ok:false, error} 回给命令层决定退出码与文案。
 */
import { join } from 'node:path';

import type { CliDeps, CliIo } from './types.ts';

const STATE_FILE_NAME = 'daemon-state.json';
const TOKEN_FILE_NAME = 'token';
const RPC_TIMEOUT_MS = 10_000;

export interface DaemonEndpoint {
  readonly baseUrl: string;
  readonly token: string;
}

export type RpcOutcome<Result = unknown> =
  | { readonly ok: true; readonly result: Result }
  | { readonly ok: false; readonly code: number | string; readonly message: string };

/** 读状态目录拼出 endpoint;daemon 未运行(无状态文件/已标停/无 token)返回 null。 */
export async function resolveEndpoint(
  deps: CliDeps,
  stateDir: string,
): Promise<DaemonEndpoint | null> {
  const raw = await deps.readTextFile(join(stateDir, STATE_FILE_NAME));
  if (raw === null) return null;
  let port: unknown;
  let stoppedAt: unknown;
  try {
    const state = JSON.parse(raw) as Record<string, unknown>;
    port = state['port'];
    stoppedAt = state['stoppedAt'];
  } catch {
    return null;
  }
  if (stoppedAt !== null || typeof port !== 'number') return null;
  const token = await deps.readTextFile(join(stateDir, TOKEN_FILE_NAME));
  if (token === null) return null;
  return { baseUrl: `http://127.0.0.1:${port}`, token: token.trim() };
}

/** 命令侧的统一连接口:不可达时打印原因并回 null(命令层退出码 1)。 */
export async function connectOrExplain(
  deps: CliDeps,
  io: CliIo,
  stateDir: string,
): Promise<DaemonEndpoint | null> {
  const endpoint = await resolveEndpoint(deps, stateDir);
  if (endpoint === null) {
    io.err(`neoba: daemon 未运行(state-dir=${stateDir});先 neoba start 拉起`);
    return null;
  }
  return endpoint;
}

/** 单条 JSON-RPC 调用;HTTP 层错误(连接拒绝/超时)归一为 ok:false。 */
export async function rpcCall<Result = unknown>(
  deps: CliDeps,
  endpoint: DaemonEndpoint,
  method: string,
  params: unknown,
): Promise<RpcOutcome<Result>> {
  let response: Response;
  try {
    response = await deps.fetch(`${endpoint.baseUrl}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      code: 'NETWORK',
      message: `daemon 连接失败(${err instanceof Error ? err.message : String(err)})`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: response.status, message: `daemon 返回非 JSON(HTTP ${response.status})` };
  }
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (record['error'] !== undefined && record['error'] !== null) {
    const error = record['error'] as Record<string, unknown>;
    return {
      ok: false,
      code: typeof error['code'] === 'number' ? error['code'] : String(error['code'] ?? response.status),
      message: String(error['message'] ?? '未知错误'),
    };
  }
  return { ok: true, result: record['result'] as Result };
}
