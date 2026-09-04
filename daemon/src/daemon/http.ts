/**
 * localhost HTTP 绑定(node:http,零依赖):仅监听 127.0.0.1,单端点
 * JSON-RPC 2.0 over HTTP POST。中间件强制 Bearer token 校验(缺失/错误 →
 * 401 + 类型化错误结构),请求体大小限制(超限 → 413 + JSON-RPC error),
 * 所有错误统一 {code, message, data} 结构。
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { InvalidHandshake, SessionError } from '../session/index.ts';
import { CapabilityError, PresetInvalid } from '../capability/index.ts';
import { ArtifactError, ArtifactNotFound, InvalidArtifactPath } from '../artifacts/index.ts';
import { RPC, RpcError } from './errors.ts';
import {
  errorResponse,
  parseJsonRpcRequest,
  successResponse,
  toRpcError,
  type JsonRpcErrorObject,
} from './jsonrpc.ts';
import { tokensMatch } from './token.ts';

export const DEFAULT_PORT = 7917;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export type OperationHandler = (method: string, params: unknown) => Promise<unknown>;

export interface HttpBindingOptions {
  readonly port: number;
  readonly host?: string;
  readonly token: string;
  readonly maxBodyBytes?: number;
  readonly handler: OperationHandler;
  /** 未知 method 的判定:handler 抛出的 InvalidParams(method 字段)之外的。 */
  readonly isKnownMethod?: (method: string) => boolean;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match === null ? null : (match[1]?.trim() ?? null);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.byteLength),
    'connection': 'close',
  });
  res.end(bytes);
}

function unauthorized(reason: 'missing_token' | 'invalid_token'): JsonRpcErrorObject {
  return {
    code: RPC.UNAUTHORIZED,
    message: reason === 'missing_token' ? '缺少 Bearer token' : 'Bearer token 不正确',
    data: { code: 'UNAUTHORIZED', reason },
  };
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<{ text?: string; tooLarge?: boolean }> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true };
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) return { tooLarge: true };
    chunks.push(buf);
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
}

/** 起一个仅监听 localhost 的 JSON-RPC HTTP server;listening 后 resolve。 */
export function startHttpBinding(opts: HttpBindingOptions): Promise<Server> {
  const host = opts.host ?? DEFAULT_HOST;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const server = createServer((req, res) => {
    void handleRequest(req, res, opts, maxBodyBytes);
  });
  return new Promise<Server>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(
        err.code === 'EADDRINUSE'
          ? new RpcError(-32000, `端口 ${opts.port} 被占用: ${err.message}`, {
              data: { code: 'PORT_IN_USE', port: opts.port },
              httpStatus: 500,
            })
          : err,
      );
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port, host);
  });
}

/**
 * HTTP 状态码映射:RPC 层错误带自己的状态;模块层类型化错误按语义归类
 * (结构非法 → 400,不存在 → 404,语义冲突 → 409);其余为真内部错误 → 500。
 */
function httpStatusFor(err: unknown): number {
  if (err instanceof RpcError) return err.httpStatus;
  if (
    err instanceof InvalidHandshake ||
    err instanceof PresetInvalid ||
    err instanceof InvalidArtifactPath
  ) {
    return 400;
  }
  if (err instanceof ArtifactNotFound) return 404;
  if (
    err instanceof SessionError ||
    err instanceof CapabilityError ||
    err instanceof ArtifactError
  ) {
    return 409;
  }
  return 500;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HttpBindingOptions,
  maxBodyBytes: number,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, errorResponse(null, {
      code: RPC.INVALID_REQUEST,
      message: `仅支持 POST(JSON-RPC 2.0),收到 ${req.method ?? 'unknown'}`,
      data: { code: 'METHOD_NOT_ALLOWED', method: req.method ?? null },
    }));
    return;
  }
  // 中间件:Bearer token 强制校验(先于读 body)。
  const presented = bearerToken(req);
  if (presented === null) {
    sendJson(res, 401, errorResponse(null, unauthorized('missing_token')));
    return;
  }
  if (!tokensMatch(presented, opts.token)) {
    sendJson(res, 401, errorResponse(null, unauthorized('invalid_token')));
    return;
  }

  const body = await readBody(req, maxBodyBytes);
  if (body.tooLarge === true) {
    sendJson(res, 413, errorResponse(null, {
      code: RPC.PAYLOAD_TOO_LARGE,
      message: `请求体超过大小限制 ${maxBodyBytes} 字节`,
      data: { code: 'PAYLOAD_TOO_LARGE', max_bytes: maxBodyBytes },
    }));
    return;
  }
  const parsed = parseJsonRpcRequest(body.text ?? '');
  if (!parsed.ok) {
    const status = parsed.error.code === RPC.PARSE_ERROR ? 400 : 400;
    sendJson(res, status, errorResponse(null, parsed.error));
    return;
  }
  const { id, method, params } = parsed.request;
  if (opts.isKnownMethod !== undefined && !opts.isKnownMethod(method)) {
    sendJson(res, 404, errorResponse(id, {
      code: RPC.METHOD_NOT_FOUND,
      message: `未知方法: ${method}`,
      data: { code: 'METHOD_NOT_FOUND', method },
    }));
    return;
  }
  try {
    const result = await opts.handler(method, params);
    sendJson(res, 200, successResponse(id, result));
  } catch (err) {
    const error = toRpcError(err);
    sendJson(res, httpStatusFor(err), errorResponse(id, error));
  }
}

/** 关停:停止接受新请求并断开 keep-alive 连接,close 完成(即 flush 点)后 resolve。 */
export function stopHttpBinding(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    setTimeout(() => server.closeAllConnections?.(), 50).unref();
  });
}
