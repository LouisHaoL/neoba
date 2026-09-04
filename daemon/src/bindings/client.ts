/**
 * daemon HTTP 客户端(MCP 桥 → daemon localhost API 的传输层)。
 * 零第三方依赖,用全局 fetch;错误统一转成 DaemonCallError(code/message/data)。
 */

export interface DaemonCallErrorInit {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
  readonly status: number;
}

/** daemon 返回的 JSON-RPC error / HTTP 层失败。 */
export class DaemonCallError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly status: number;

  constructor(init: DaemonCallErrorInit) {
    super(init.message);
    this.name = new.target.name;
    this.code = init.code;
    this.data = init.data;
    this.status = init.status;
  }
}

export type DaemonCaller = (method: string, params: unknown) => Promise<unknown>;

export interface DaemonHttpClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

/** 单端点 JSON-RPC 2.0 over HTTP 客户端。 */
export function createDaemonHttpClient(opts: DaemonHttpClientOptions): DaemonCaller {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  let nextId = 1;
  return async (method: string, params: unknown): Promise<unknown> => {
    let res: Response;
    try {
      res = await doFetch(`${base}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${opts.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      });
    } catch (err) {
      throw new DaemonCallError({
        code: -32000,
        message: `daemon 不可达(${base}): ${String(err)}`,
        data: { code: 'DAEMON_UNREACHABLE' },
        status: 0,
      });
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (res.status === 401) {
      const error = asErrorObject(record['error']);
      throw new DaemonCallError({
        code: error?.code ?? -32001,
        message: error?.message ?? '鉴权失败(token 缺失或不正确)',
        data: error?.data,
        status: res.status,
      });
    }
    const error = asErrorObject(record['error']);
    if (error !== null) {
      throw new DaemonCallError({ code: error.code, message: error.message, data: error.data, status: res.status });
    }
    if (!res.ok) {
      throw new DaemonCallError({
        code: -32000,
        message: `daemon HTTP ${res.status}`,
        data: { code: 'HTTP_ERROR', status: res.status },
        status: res.status,
      });
    }
    return record['result'];
  };
}

interface FlatError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

function asErrorObject(value: unknown): FlatError | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['code'] !== 'number' || typeof record['message'] !== 'string') return null;
  return { code: record['code'], message: record['message'], data: record['data'] };
}
