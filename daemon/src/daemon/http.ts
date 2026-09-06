/**
 * localhost HTTP 绑定(node:http,零依赖):仅监听 127.0.0.1。
 *
 * POST / —— 单端点 JSON-RPC 2.0。中间件强制 Bearer token 校验(缺失/错误 →
 * 401 + 类型化错误结构),请求体大小限制(超限 → 413 + JSON-RPC error),
 * 所有错误统一 {code, message, data} 结构。
 *
 * GET 白名单(M4 观测线):
 *   /            只读 dashboard 静态页(无鉴权:静态壳,无内嵌秘密;
 *                数据面由页面持 token 自行调用);
 *   /openapi.json  OpenAPI 3.1 文档(api-doc.ts 生成,无鉴权:纯结构描述);
 *   /events/stream  SSE 事件流(必须鉴权:Bearer 头或 ?token= 兜底)。
 * 其余 GET / 其它方法保持 405。
 *
 * TLS 推迟(占位,不实现):当前威胁模型 = 仅 127.0.0.1 监听 + Bearer token,
 * 明文本机回环已满足;跨主机暴露前须补 http.tls(node:tls / 反向代理二选一)。
 * 在此之前 ?token= 的 SSE 鉴权不得用于非本机场景(query 会进访问日志与
 * 浏览器历史)。
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { InvalidHandshake, SessionError } from '../session/index.ts';
import { CapabilityError, PresetInvalid } from '../capability/index.ts';
import { ArtifactError, ArtifactNotFound, InvalidArtifactPath } from '../artifacts/index.ts';
import type { Event, EventLog } from '../events/index.ts';
import { RPC, RpcError } from './errors.ts';
import {
  errorResponse,
  parseJsonRpcRequest,
  successResponse,
  toRpcError,
  type JsonRpcErrorObject,
} from './jsonrpc.ts';
import { resolveIdentity } from './identity.ts';
import type { RequestIdentity, TokenRegistry } from './identity.ts';
import { DEFAULT_TENANT } from './operations.ts';
import { openapiDocument } from './api-doc.ts';
import { DASHBOARD_HTML } from './dashboard/index.ts';

export const DEFAULT_PORT = 7917;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** SSE 心跳间隔(注释行保活,防中间层空闲断连);0 = 关闭。 */
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

export type OperationHandler = (
  method: string,
  params: unknown,
  identity: RequestIdentity,
) => Promise<unknown>;

export interface HttpBindingOptions {
  readonly port: number;
  readonly host?: string;
  /** bootstrap token(= admin 身份,现语义)。 */
  readonly token: string;
  /** per-session token 注册表(M3 双 token 模型;缺省 = 仅 admin)。 */
  readonly tokens?: TokenRegistry;
  readonly maxBodyBytes?: number;
  readonly handler: OperationHandler;
  /** 未知 method 的判定:handler 抛出的 InvalidParams(method 字段)之外的。 */
  readonly isKnownMethod?: (method: string) => boolean;
  /** 事件日志(/events/stream 的重放 + 订阅源;缺省 = 该端点报 501)。 */
  readonly events?: EventLog;
  /** SSE 心跳间隔 ms(0 = 关闭;缺省 15s)。 */
  readonly sseHeartbeatMs?: number;
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

/** GET 白名单的静态文本响应(dashboard / 出错页同用)。 */
function sendHtml(res: ServerResponse, status: number, body: string): void {
  const bytes = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
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
    // #16 兜底:客户端在 POST body 读取中途断开时,req emit 'error' 使
    // readBody 的 for-await 抛出;若不加 catch,`void handleRequest(...)`
    // 形成 unhandled rejection(Node ≥15 默认直接击穿整进程)。这里对
    // handleRequest 的 promise 挂顶层 catch:未开始写响应时归一为 JSON-RPC
    // error(toRpcError 保持 {code, message, data} 约定,真内部错误 → -32603);
    // 响应已开始写/连接已坏时无法再写 JSON,仅 destroy 连接并留错误日志。
    // req/res 各挂一个 error 监听兜底,防止 body 读取窗口外的流错误在无人
    // 处理时升级为 uncaughtException(for-await 的 rejection 仍照常抛出,
    // 由下方 catch 消化,不影响归一逻辑)。
    req.on('error', () => {});
    res.on('error', () => {});
    void handleRequest(req, res, opts, maxBodyBytes).catch((err: unknown) => {
      if (res.writableEnded || res.headersSent || res.destroyed) {
        // 响应流已不可写 JSON:断开连接收尾,不让单连接故障影响 daemon 存活。
        res.destroy();
        console.error('[daemon:http] 请求处理异常且响应已开始,连接已断开:', err);
        return;
      }
      try {
        sendJson(res, 500, errorResponse(null, toRpcError(err)));
      } catch {
        res.destroy();
      }
    });
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
  // GET 白名单(M4 观测线);其余方法(含未白名单的 GET)保持 405。
  if (req.method === 'GET') {
    await handleGet(req, res, opts);
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, errorResponse(null, {
      code: RPC.INVALID_REQUEST,
      message: `仅支持 POST(JSON-RPC 2.0),收到 ${req.method ?? 'unknown'}`,
      data: { code: 'METHOD_NOT_ALLOWED', method: req.method ?? null },
    }));
    return;
  }
  // 中间件:Bearer token 强制校验(先于读 body)。bootstrap = admin,
  // 其余查会话 token 注册表(M3 双 token 模型);都不中 → 401。
  const presented = bearerToken(req);
  if (presented === null) {
    sendJson(res, 401, errorResponse(null, unauthorized('missing_token')));
    return;
  }
  const identity = resolveIdentity(presented, opts.token, opts.tokens);
  if (identity === null) {
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
    const result = await opts.handler(method, params, identity);
    sendJson(res, 200, successResponse(id, result));
  } catch (err) {
    const error = toRpcError(err);
    sendJson(res, httpStatusFor(err), errorResponse(id, error));
  }
}

// ---------------------------------------------------------------- GET 白名单(M4)

/**
 * GET 白名单:/ = dashboard 静态页、/openapi.json = OpenAPI 3.1 文档(两者
 * 无鉴权:纯静态壳/结构描述,不含任何秘密与数据)、/events/stream = SSE
 * 事件流(必须鉴权);其余 GET 保持 405。
 */
async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HttpBindingOptions,
): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/') {
    sendHtml(res, 200, DASHBOARD_HTML);
    return;
  }
  if (pathname === '/openapi.json') {
    sendJson(res, 200, openapiDocument());
    return;
  }
  if (pathname === '/events/stream') {
    await handleEventStream(req, res, opts);
    return;
  }
  sendJson(res, 405, errorResponse(null, {
    code: RPC.INVALID_REQUEST,
    message: `未知 GET 路径: ${pathname}(白名单:/、/openapi.json、/events/stream)`,
    data: { code: 'METHOD_NOT_ALLOWED', method: 'GET', path: pathname },
  }));
}

/**
 * SSE 事件流:冷启动先 replay 既有事件(按身份命名空间过滤)再推 live,
 * 心跳注释行保活。鉴权:EventSource 无法自定义请求头,支持 `?token=` 兜底
 * (与 Bearer 头同一套 resolveIdentity)—— 仅 localhost 监听前提下可用,
 * 见文件头 TLS 占位说明。
 */
async function handleEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HttpBindingOptions,
): Promise<void> {
  if (opts.events === undefined) {
    sendJson(res, 501, errorResponse(null, {
      code: RPC.INTERNAL,
      message: 'http 绑定未接入事件日志(events)',
      data: { code: 'EVENTS_NOT_WIRED' },
    }));
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const presented = url.searchParams.get('token') ?? bearerToken(req);
  if (presented === null) {
    sendJson(res, 401, errorResponse(null, unauthorized('missing_token')));
    return;
  }
  const identity = resolveIdentity(presented, opts.token, opts.tokens);
  if (identity === null) {
    sendJson(res, 401, errorResponse(null, unauthorized('invalid_token')));
    return;
  }
  // 订阅命名空间与 events.list 同语义:admin 全量;session 身份锁死绑定
  // (tenant, session),daemon 级(session=null)事件对其不可见。
  const inScope = identity.kind === 'session'
    ? (ev: Event): boolean =>
        ev.principal.tenant === (identity.tenant ?? DEFAULT_TENANT) &&
        ev.principal.session === (identity.session ?? '')
    : (): boolean => true;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  });
  let closed = false;
  const writeFrame = (chunk: string): void => {
    if (closed) return;
    try {
      res.write(chunk);
    } catch {
      // 断连由 res 'close' 事件收尾,写失败不炸进程。
    }
  };
  const send = (ev: Event): void => {
    writeFrame(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };

  // 去重键:seq 仅分片内单调,叠加 ts/principal 维度保证跨分片唯一。
  // 重放窗口结束后清空,live 通道从此独占(此后事件必不在重放中)。
  const seen = new Set<string>();
  const dedupeKey = (ev: Event): string =>
    `${ev.ts}#${ev.seq}#${ev.type}#${ev.principal.tenant}#${ev.principal.session ?? ''}#${ev.principal.task ?? ''}#${ev.principal.agent ?? ''}`;

  // 先订阅再重放:重放窗口内新追加的事件不丢(live 先到 → 重放侧按去重键跳过)。
  const unsubscribe = opts.events.onEvent((ev) => {
    if (!inScope(ev)) return;
    const key = dedupeKey(ev);
    if (seen.has(key)) return;
    seen.add(key);
    send(ev);
  });
  const heartbeatMs = opts.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  const heartbeat = heartbeatMs > 0
    ? setInterval(() => writeFrame(': keepalive\n\n'), heartbeatMs)
    : null;
  heartbeat?.unref?.();
  res.on('close', () => {
    closed = true;
    unsubscribe();
    if (heartbeat !== null) clearInterval(heartbeat);
  });

  writeFrame('retry: 3000\n\n');
  try {
    for await (const ev of opts.events.replay()) {
      if (closed) break;
      if (!inScope(ev)) continue;
      const key = dedupeKey(ev);
      if (seen.has(key)) continue;
      seen.add(key);
      send(ev);
    }
  } catch {
    // 重放读盘异常:live 通道继续,不让单连接拖垮 daemon。
  }
  seen.clear();
  writeFrame(': replay-done\n\n');
}

/** 关停:停止接受新请求并断开 keep-alive 连接,close 完成(即 flush 点)后 resolve。 */
export function stopHttpBinding(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    setTimeout(() => server.closeAllConnections?.(), 50).unref();
  });
}
