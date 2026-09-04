/**
 * daemon 服务壳模块(§6):启动/关闭、localhost JSON-RPC HTTP 绑定、
 * 鉴权 token、任务内存态与事件重放、P1 操作集。
 * 运行时零第三方依赖,仅用 node 内置模块。
 */
export { startDaemon, stopDaemon, defaultPresets, DAEMON_VERSION } from './daemon.ts';
export type { DaemonOptions, DaemonHandle } from './daemon.ts';
export { DEFAULT_PORT, DEFAULT_HOST, DEFAULT_MAX_BODY_BYTES, startHttpBinding, stopHttpBinding } from './http.ts';
export type { HttpBindingOptions, OperationHandler } from './http.ts';
export { Operations, DEFAULT_TENANT, makeGrantSink } from './operations.ts';
export { replayTasks, TaskStore } from './tasks.ts';
export type { TaskRecord, TaskStatus } from './tasks.ts';
export { generateToken, readTokenFile, writeTokenFile, tokensMatch, TOKEN_FILE_NAME } from './token.ts';
export {
  RPC,
  RpcError,
  InvalidParams,
  DaemonError,
  DaemonPortInUse,
  TaskNotFound,
  SessionUnknown,
  PresetUnknown,
} from './errors.ts';
export {
  parseJsonRpcRequest,
  successResponse,
  errorResponse,
  toRpcError,
  errorData,
} from './jsonrpc.ts';
export type {
  JsonRpcRequest,
  JsonRpcErrorObject,
  JsonRpcResponse,
  ParseOutcome,
} from './jsonrpc.ts';
