/**
 * JSON-RPC 2.0 消息结构与统一错误映射(§6 daemon localhost API)。
 *
 * 请求 {jsonrpc?, id?, method, params?} → 响应 {jsonrpc:'2.0', id, result | error}。
 * 错误统一为 {code, message, data} 结构:
 *   - 协议层(解析失败/方法不存在/参数非法)用 JSON-RPC 保留码;
 *   - 鉴权失败用 -32001,data.reason 区分 missing_token / invalid_token;
 *   - 模块层(session/capability/events/artifacts)的类型化错误统一落到
 *     data = {name, code, ...错误自带字段},由 errorData 泛化提取。
 */

import { RPC, RpcError } from './errors.ts';

export interface JsonRpcRequest {
  readonly id: string | number | null;
  readonly method: string;
  readonly params: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

export type ParseOutcome =
  | { readonly ok: true; readonly request: JsonRpcRequest }
  | { readonly ok: false; readonly error: JsonRpcErrorObject };

/** 解析一条 JSON-RPC 请求文本;非法返回 -32700 / -32600 错误结构。 */
export function parseJsonRpcRequest(text: string): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: { code: RPC.PARSE_ERROR, message: '请求体不是合法 JSON', data: undefined },
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error: { code: RPC.INVALID_REQUEST, message: '请求必须是 JSON 对象', data: undefined },
    };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj['method'] !== 'string' || obj['method'].length === 0) {
    return {
      ok: false,
      error: { code: RPC.INVALID_REQUEST, message: '缺少 method 字符串', data: undefined },
    };
  }
  const id = obj['id'];
  const request: JsonRpcRequest = {
    id: typeof id === 'string' || typeof id === 'number' || id === null ? id : null,
    method: obj['method'],
    params: obj['params'],
  };
  return { ok: true, request };
}

export function successResponse(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function errorResponse(id: string | number | null, error: JsonRpcErrorObject): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error };
}

/**
 * 泛化提取类型化错误的自有字段(name/code 之外的可枚举字符串/数字字段,
 * 如 field/detail/issues/cap/scope/agentId),构成 error.data。
 */
export function errorData(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof Error)) {
    return { name: 'NonError', value: String(err) };
  }
  const data: Record<string, unknown> = { name: err.name };
  for (const [key, value] of Object.entries(err)) {
    if (key === 'rpcCode' || key === 'httpStatus' || key === 'data') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      data[key] = value;
    } else if (Array.isArray(value)) {
      data[key] = value;
    }
  }
  return data;
}

/** 应用层(域)错误统一落在 -32000:类型化错误必带字符串 code,进 data。 */
export const DOMAIN_ERROR = -32000;

/** 任意异常 → 统一 JSON-RPC error 结构。 */
export function toRpcError(err: unknown): JsonRpcErrorObject {
  if (err instanceof RpcError) {
    return { code: err.rpcCode, message: err.message, data: err.data };
  }
  if (err instanceof Error) {
    const data = errorData(err);
    // 模块层类型化错误(SessionError/CapabilityError/ArtifactError/…)都带
    // 字符串 code;裸 Error(真内部错误)才是 -32603。
    if (typeof (err as { code?: unknown }).code === 'string') {
      return { code: DOMAIN_ERROR, message: err.message, data };
    }
    return { code: RPC.INTERNAL, message: err.message, data };
  }
  return { code: RPC.INTERNAL, message: String(err), data: undefined };
}
