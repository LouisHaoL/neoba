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

/** 默认单次调用超时,与 CLI 侧 cli/rpc.ts 的 RPC_TIMEOUT_MS 对齐。 */
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/** signal 为可选取消通道(MCP 桥的 notifications/cancelled 会透传)。 */
export type DaemonCaller = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;

export interface DaemonHttpClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  /** 单次调用超时毫秒;缺省 10s(与 cli/rpc.ts 口径一致)。 */
  readonly timeoutMs?: number;
}

/** 单端点 JSON-RPC 2.0 over HTTP 客户端。 */
export function createDaemonHttpClient(opts: DaemonHttpClientOptions): DaemonCaller {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  let nextId = 1;
  return async (method: string, params: unknown, signal?: AbortSignal): Promise<unknown> => {
    // 超时与外部取消(notifications/cancelled)共用一个 AbortController:
    // fetch 挂 signal,半死的 daemon 不再让调用永挂。
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : null;
    const onExternalAbort = () => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      let res: Response;
      try {
        res = await doFetch(`${base}/`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${opts.token}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          // 超时/取消与「连接失败」分开报,便于上游区分重试语义。
          throw new DaemonCallError({
            code: -32000,
            message: timedOut
              ? `daemon 调用超时(${timeoutMs}ms): ${method}`
              : `daemon 调用被取消: ${method}`,
            data: { code: timedOut ? 'DAEMON_TIMEOUT' : 'DAEMON_CANCELLED' },
            status: 0,
          });
        }
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
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener('abort', onExternalAbort);
    }
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
