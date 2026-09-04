/**
 * daemon 服务壳的错误:RPC 层错误(RpcError,携带 JSON-RPC code 与 HTTP 状态)
 * 与启动期错误(DaemonError)。模块层(session/capability/events/artifacts)的
 * 类型化错误原样向上抛,由 jsonrpc.ts 统一映射为 error.data。
 */

/** JSON-RPC 协议保留码 + 本服务的应用码(服务端自定义区段)。 */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHORIZED: -32001,
  PAYLOAD_TOO_LARGE: -32002,
} as const;

/** 带 JSON-RPC 错误码与建议 HTTP 状态的请求层错误。 */
export class RpcError extends Error {
  readonly rpcCode: number;
  readonly httpStatus: number;
  readonly data: unknown;

  constructor(rpcCode: number, message: string, options: { data?: unknown; httpStatus?: number } = {}) {
    super(message);
    this.name = new.target.name;
    this.rpcCode = rpcCode;
    this.httpStatus = options.httpStatus ?? 400;
    this.data = options.data;
  }
}

/** params 结构/取值非法(-32602)。 */
export class InvalidParams extends RpcError {
  constructor(message: string, data?: unknown) {
    super(RPC.INVALID_PARAMS, message, { data, httpStatus: 400 });
  }
}

/** daemon 自身状态错误(启动期):端口被占、状态目录不可用等。 */
export class DaemonError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 监听端口被占用(EADDRINUSE)。 */
export class DaemonPortInUse extends DaemonError {
  readonly port: number;

  constructor(port: number) {
    super('PORT_IN_USE', `端口 ${port} 已被占用(默认端口冲突时请显式注入其它端口)`);
    this.port = port;
  }
}

/** 请求的 task 不存在。 */
export class TaskNotFound extends RpcError {
  readonly taskId: string;

  constructor(taskId: string) {
    super(-32010, `task 不存在: ${taskId}`, {
      data: { code: 'TASK_NOT_FOUND', task_id: taskId },
      httpStatus: 404,
    });
    this.taskId = taskId;
  }
}

/** 声明的 session 在活跃会话表中不存在(principal 无法落到会话)。 */
export class SessionUnknown extends RpcError {
  readonly tenant: string;
  readonly session: string;

  constructor(tenant: string, session: string) {
    super(-32011, `会话不存在: ${tenant}/${session}`, {
      data: { code: 'SESSION_UNKNOWN', tenant, session },
      httpStatus: 404,
    });
    this.tenant = tenant;
    this.session = session;
  }
}

/** task.create 引用的预设名不在 daemon 的预设集中。 */
export class PresetUnknown extends RpcError {
  readonly preset: string;

  constructor(preset: string, known: readonly string[]) {
    super(-32012, `预设不存在: ${preset} (可用: ${known.join('/')})`, {
      data: { code: 'PRESET_UNKNOWN', preset, known },
      httpStatus: 404,
    });
    this.preset = preset;
  }
}
