/**
 * neoba-mcp 桥(§3.10 MCP 绑定):stdio 上的 MCP server,把 daemon localhost
 * JSON-RPC API 映射为 MCP 工具。
 *
 * 帧格式选型:MCP stdio 规范即「换行分隔 JSON」(每条 JSON-RPC 消息一行 UTF-8,
 * 以 \n 结束,消息内不含裸换行)——不是 Content-Length 头(LSP 风格),
 * 手写解析最简且与官方 SDK 行为一致。
 *
 * session.init 映射策略:MCP initialize 握手成功后桥自动替接入方完成一次
 * neoba session.init(role=orchestrator,harness=neoba-mcp-bridge,tenant=default,
 * session=mcp-<rand>),并缓存会话身份,后续 task/artifacts 工具调用自动注入
 * tenant/session;另暴露显式 session_init 工具供覆盖(换 principal / 重新握手)。
 *
 * 协议版本协商:客户端 protocolVersion 在支持列表内则原样回,否则回服务端最新。
 * 协议层错误(parse/未知方法/参数非法)走 JSON-RPC error;工具执行失败走
 * result.isError=true(MCP 约定),不混用。
 */
import { randomBytes } from 'node:crypto';
import type { DaemonCaller } from './client.ts';
import { DaemonCallError } from './client.ts';

/** 支持的 MCP 协议版本(升序,末位 = 服务端最新,协商回退目标)。 */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
];

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpBridgeOptions {
  /** 入向字节流(进程 stdin 或注入的假 stdio)。 */
  readonly input: AsyncIterable<Uint8Array>;
  /** 出向文本流(每条响应一行 JSON)。 */
  readonly output: { write(chunk: string): unknown };
  /** daemon 调用通道(HTTP 客户端或测试桩)。 */
  readonly callDaemon: DaemonCaller;
  readonly serverInfo?: McpServerInfo;
  readonly supportedVersions?: readonly string[];
  /** initialize 后自动 session.init(默认 true)。 */
  readonly autoSession?: boolean;
  /** auto-session / session_init 的缺省 tenant;缺省 'default'。 */
  readonly tenant?: string;
  /** 注入随机源(测试);缺省 crypto.randomBytes。 */
  readonly random?: () => string;
}

export interface McpBridge {
  start(): void;
  /** 处理一行(测试可直接喂);返回应答 JSON 文本,通知/空行返回 null。 */
  handleLine(line: string): Promise<string | null>;
  /** 当前缓存的 neoba 会话身份(auto-session / session_init 后非空)。 */
  session(): { tenant: string; session: string } | null;
  /** 等待 auto-session 完成或不成功(测试同步点)。 */
  sessionReady(): Promise<void>;
  close(): Promise<void>;
}

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** 调用前是否注入缓存的会话身份(tenant/session 缺省时)。 */
  readonly needsSession: boolean;
}

const TOOLS: readonly McpToolDef[] = [
  {
    name: 'session_init',
    description:
      '与 neoba daemon 完成 neoba 协议握手(session.init):校验版本、协商能力、登记会话。' +
      '桥在 MCP initialize 后会自动握手一次,需要更换 principal/角色时才用本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        protocol: { type: 'string', description: 'neoba 协议版本,当前冻结 "1.0"' },
        role: { type: 'string', enum: ['orchestrator', 'planner', 'observer'] },
        tenant: { type: 'string' },
        session: { type: 'string' },
        harness: { type: 'string' },
      },
    },
    needsSession: false,
  },
  {
    name: 'capabilities_list',
    description: '列出 neoba 能力注册表(§3.1)。',
    inputSchema: { type: 'object', properties: {} },
    needsSession: false,
  },
  {
    name: 'task_create',
    description:
      '创建 neoba 任务(P1 单节点):按预设置入基线授予,返回 agent_id 与 grant manifest。',
    inputSchema: {
      type: 'object',
      required: ['intent', 'preset'],
      properties: {
        intent: { type: 'string', description: '任务意图摘要' },
        preset: { type: 'string', description: '预设名(如 minimal)' },
        tenant: { type: 'string' },
        session: { type: 'string' },
      },
    },
    needsSession: true,
  },
  {
    name: 'task_status',
    description: '查询单个 neoba 任务的记录与状态。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
    needsSession: false,
  },
  {
    name: 'task_list',
    description: '列出全部 neoba 任务(重启后由事件重放恢复)。',
    inputSchema: { type: 'object', properties: {} },
    needsSession: false,
  },
  {
    name: 'artifacts_publish',
    description: '发布工件进 neoba CAS 仓库(发布即写屏障)。',
    inputSchema: {
      type: 'object',
      required: ['task', 'node', 'name'],
      properties: {
        task: { type: 'string' },
        node: { type: 'string' },
        name: { type: 'string' },
        content: { type: 'string', description: '单文件内容(与 files 二选一)' },
        files: {
          type: 'array',
          description: '目录型工件的文件清单',
          items: {
            type: 'object',
            required: ['path', 'content'],
            properties: { path: { type: 'string' }, content: { type: 'string' } },
          },
        },
        tenant: { type: 'string' },
        session: { type: 'string' },
      },
    },
    needsSession: true,
  },
  {
    name: 'artifacts_resolve',
    description: '解析工件当前 manifest 指针(版本/sha256/条目)。',
    inputSchema: {
      type: 'object',
      required: ['task', 'node', 'name'],
      properties: {
        task: { type: 'string' },
        node: { type: 'string' },
        name: { type: 'string' },
        tenant: { type: 'string' },
        session: { type: 'string' },
      },
    },
    needsSession: true,
  },
  {
    name: 'artifacts_read',
    description: '读取工件内容(utf8 或 base64)。',
    inputSchema: {
      type: 'object',
      required: ['task', 'node', 'name'],
      properties: {
        task: { type: 'string' },
        node: { type: 'string' },
        name: { type: 'string' },
        entry_path: { type: 'string', description: '目录型工件的条目路径' },
        tenant: { type: 'string' },
        session: { type: 'string' },
      },
    },
    needsSession: true,
  },
  {
    name: 'grants_of',
    description: '查询某 agent 的 grant manifest(基线授予清单 + 审计)。',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: { agent_id: { type: 'string' } },
    },
    needsSession: false,
  },
  // ---- P2 操作面(桥工具全集补齐,§6 daemon localhost API 对齐) ----
  {
    name: 'workflow_run',
    description:
      '提交 WorkflowSpec 多节点编排(异步):立即返回 task_id,终态经 task_status / 事件流观察。',
    inputSchema: {
      type: 'object',
      required: ['workflow'],
      properties: {
        workflow: { type: 'object', description: 'WorkflowSpec 文档(workflow/1.0)' },
        intent: { type: 'object', description: 'IntentDoc(intent/1.0,可选)' },
        budget: {
          type: 'object',
          description: '预算约束 {limit_tokens, soft_ratio?}(可选)',
          properties: { limit_tokens: { type: 'integer' }, soft_ratio: { type: 'number' } },
        },
        secret_ids: { type: 'array', items: { type: 'string' }, description: '注入的 secret id 清单' },
        tenant: { type: 'string' },
        session: { type: 'string' },
      },
    },
    needsSession: true,
  },
  {
    name: 'task_pause',
    description: '暂停运行中的编排任务(停在派发边界)。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
    needsSession: false,
  },
  {
    name: 'task_resume',
    description: '恢复暂停/等待中的任务。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
    needsSession: false,
  },
  {
    name: 'task_cancel',
    description: '取消任务(在飞节点协作终止)。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
    needsSession: false,
  },
  {
    name: 'approvals_list',
    description: '列出审批单(status=pending/all,缺省 all)。',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'all'] } },
    },
    needsSession: false,
  },
  {
    name: 'approvals_submit',
    description:
      '提交审批单(tool.request 公面入口):为本会话任务申请能力升级,落台账返回 req_id;' +
      '引擎 v0.x 不做 require_approval 自动挂起,审批闭环由外部经 submit → decide 走通。',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'cap', 'scope', 'duration'],
      properties: {
        task_id: { type: 'string', description: '申请人所属任务 id' },
        cap: { type: 'string', description: '申请的能力(须在注册表内)' },
        scope: { type: 'string', description: '申请的 scope' },
        duration: { type: 'string', description: '授权时长,如 2h' },
        reason: { type: 'string', description: '申请说明' },
        req_id: { type: 'string', description: '审批单 id(缺省自动生成)' },
      },
    },
    needsSession: false,
  },
  {
    name: 'approvals_decide',
    description: '定案审批单(granted/denied);admin 可带 by,窄化用 narrowed_to。',
    inputSchema: {
      type: 'object',
      required: ['req_id', 'decision'],
      properties: {
        req_id: { type: 'string' },
        decision: { type: 'string', enum: ['granted', 'denied'] },
        by: { type: 'string', description: '定案人(admin 身份;session 身份强制记为会话)' },
        narrowed_to: { type: 'string', description: '授予窄化目标' },
      },
    },
    needsSession: false,
  },
  {
    name: 'budget_status',
    description: '查任务预算水位(limit/soft/observed/level)。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
    needsSession: false,
  },
  {
    name: 'budget_raise',
    description: '抬预算上限(熔断后续预算,配合 task_resume)。',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'limit_tokens'],
      properties: { task_id: { type: 'string' }, limit_tokens: { type: 'integer' } },
    },
    needsSession: false,
  },
  {
    name: 'models_list',
    description: '列出 Model Score Registry(分层评分观测)。',
    inputSchema: { type: 'object', properties: {} },
    needsSession: false,
  },
  {
    name: 'models_feedback',
    description: '反馈模型表现(EMA 更新分层评分;§3.9)。',
    inputSchema: {
      type: 'object',
      required: ['model', 'tier', 'success'],
      properties: {
        model: { type: 'string' },
        tier: { type: 'string', enum: ['fast', 'standard', 'heavy'] },
        success: { type: 'boolean' },
        quality: { type: 'number', description: '[0,1]' },
        task_type: { type: 'string' },
        budget_tier: { type: 'string' },
        traversals: { type: 'integer' },
      },
    },
    needsSession: false,
  },
];

const TOOL_BY_NAME = new Map<string, McpToolDef>(TOOLS.map((tool) => [tool.name, tool]));
const RPC_ERRORS = { PARSE: -32700, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 } as const;

interface JsonRpcMessage {
  readonly id: string | number | null;
  readonly hasId: boolean;
  readonly method: string;
  readonly params: unknown;
}

function parseMessage(line: string): { ok: true; message: JsonRpcMessage } | { ok: false } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false };
  const record = raw as Record<string, unknown>;
  if (typeof record['method'] !== 'string') return { ok: false };
  const id = record['id'];
  return {
    ok: true,
    message: {
      id: typeof id === 'string' || typeof id === 'number' || id === null ? id : null,
      hasId: 'id' in record,
      method: record['method'],
      params: record['params'],
    },
  };
}

function asParamsObject(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

function toolErrorResult(err: unknown): Record<string, unknown> {
  const code = err instanceof DaemonCallError ? err.code : undefined;
  const data = err instanceof DaemonCallError ? err.data : undefined;
  const label =
    err instanceof DaemonCallError
      ? `${err.message} (code=${code}${data === undefined ? '' : `, data=${JSON.stringify(data)}`})`
      : String(err);
  return {
    content: [{ type: 'text', text: label }],
    isError: true,
  };
}

export function createMcpBridge(options: McpBridgeOptions): McpBridge {
  const supported = options.supportedVersions ?? MCP_PROTOCOL_VERSIONS;
  const serverInfo: McpServerInfo =
    options.serverInfo ?? { name: 'neoba-mcp', version: '0.1.0' };
  const autoSession = options.autoSession ?? true;
  const random = options.random ?? (() => randomBytes(4).toString('hex'));

  let initialized = false;
  let negotiatedVersion: string | null = null;
  let sessionIdentity: { tenant: string; session: string } | null = null;
  let sessionSettled: Promise<void> = Promise.resolve();
  let running = false;
  let inputIterator: AsyncIterator<Uint8Array> | null = null;
  let buffer = '';
  const decoder = new TextDecoder();
  const pending = new Set<Promise<unknown>>();
  /** MCP 请求 id → 在飞 daemon 调用的 AbortController(notifications/cancelled 用)。 */
  const inflight = new Map<string | number | null, AbortController>();
  /** 写回队列:并发处理下响应帧经此串行写 stdout,帧与帧不互相穿插。 */
  let writeQueue: Promise<void> = Promise.resolve();

  /** 串行化写回一帧;单帧写回失败(如 stdout 已关)不拖垮其余帧。 */
  function writeBack(text: string): void {
    writeQueue = writeQueue.then(() => {
      options.output.write(text + '\n');
    }).catch(() => {
      // 写回失败只能吞掉:桥没有 stderr 通道,且不能让一帧的 IO 错误炸掉读循环。
    });
  }

  /** notifications/cancelled:abort 对应在飞调用的 controller,清映射。 */
  function cancelInflight(params: unknown): void {
    const p = asParamsObject(params);
    const requestId = p['requestId'];
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return;
    const controller = inflight.get(requestId);
    if (controller === undefined) return;
    inflight.delete(requestId);
    controller.abort();
  }

  function errorResponse(id: string | number | null, code: number, message: string, data?: unknown): Record<string, unknown> {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
  }

  /** 自动握手 + 会话身份缓存;失败不抛(显式 session_init 可重试)。 */
  function startAutoSession(): Promise<void> {
    const tenant = options.tenant ?? 'default';
    const session = `mcp-${random()}`;
    return options
      .callDaemon('session.init', {
        protocol: '1.0',
        role: 'orchestrator',
        principal: { tenant, session },
        harness: 'neoba-mcp-bridge',
        capabilities: {},
      })
      .then(() => {
        sessionIdentity = { tenant, session };
      })
      .catch(() => {
        sessionIdentity = null;
      });
  }

  /** 给需要会话身份的工具注入 tenant/session 缺省值。 */
  function injectSession(args: Record<string, unknown>): Record<string, unknown> {
    if (sessionIdentity === null) return args;
    const merged = { ...args };
    if (merged['tenant'] === undefined) merged['tenant'] = sessionIdentity.tenant;
    if (merged['session'] === undefined) merged['session'] = sessionIdentity.session;
    return merged;
  }

  async function callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const tool = TOOL_BY_NAME.get(name);
    if (tool === undefined) throw new Error(`未知工具: ${name}`);
    if (tool.name === 'session_init') return doExplicitSessionInit(args, signal);
    const merged = tool.needsSession ? injectSession(args) : args;
    return toolResult(await options.callDaemon(name.replaceAll('_', '.'), merged, signal));
  }

  async function doExplicitSessionInit(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const tenant = typeof args['tenant'] === 'string' ? args['tenant'] : options.tenant ?? 'default';
    const session =
      typeof args['session'] === 'string' ? args['session'] : `mcp-${random()}`;
    const request = {
      protocol: typeof args['protocol'] === 'string' ? args['protocol'] : '1.0',
      role: typeof args['role'] === 'string' ? args['role'] : 'orchestrator',
      principal: { tenant, session },
      harness: typeof args['harness'] === 'string' ? args['harness'] : 'neoba-mcp-bridge',
      capabilities: {},
    };
    const result = await options.callDaemon('session.init', request, signal);
    sessionIdentity = { tenant, session };
    return toolResult(result);
  }

  async function dispatch(message: JsonRpcMessage): Promise<Record<string, unknown> | null> {
    const { id, method, params } = message;
    // MCP 通知(no id):initialized 等只消费不应答。
    if (!message.hasId) return null;
    try {
      switch (method) {
        case 'initialize': {
          const p = asParamsObject(params);
          const requested = typeof p['protocolVersion'] === 'string' ? p['protocolVersion'] : '';
          negotiatedVersion = supported.includes(requested) ? requested : supported[supported.length - 1]!;
          initialized = true;
          if (autoSession) {
            sessionSettled = startAutoSession();
            await sessionSettled;
          }
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: negotiatedVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo,
            },
          };
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list': {
          if (!initialized) {
            return errorResponse(id, RPC_ERRORS.INVALID_PARAMS, 'initialize 未完成');
          }
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: TOOLS.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            },
          };
        }
        case 'tools/call': {
          if (!initialized) {
            return errorResponse(id, RPC_ERRORS.INVALID_PARAMS, 'initialize 未完成');
          }
          const p = asParamsObject(params);
          const name = typeof p['name'] === 'string' ? p['name'] : '';
          if (name === '' || !TOOL_BY_NAME.has(name)) {
            return errorResponse(id, RPC_ERRORS.INVALID_PARAMS, `未知工具: ${name || '(缺 name)'}`);
          }
          if (typeof p['arguments'] !== 'object' || p['arguments'] === null || Array.isArray(p['arguments'])) {
            return errorResponse(id, RPC_ERRORS.INVALID_PARAMS, 'params.arguments 必须是对象');
          }
          // 登记 AbortController:notifications/cancelled 或 close 可提前取消
          // 这次在飞的 daemon 调用;无论成败都清映射。
          const controller = new AbortController();
          inflight.set(id, controller);
          try {
            return { jsonrpc: '2.0', id, result: await callTool(name, asParamsObject(p['arguments']), controller.signal) };
          } finally {
            inflight.delete(id);
          }
        }
        default:
          return errorResponse(id, RPC_ERRORS.METHOD_NOT_FOUND, `未知方法: ${method}`);
      }
    } catch (err) {
      // daemon 调用失败是工具执行错误(MCP 约定走 result.isError,不是协议错误)。
      return { jsonrpc: '2.0', id, result: toolErrorResult(err) };
    }
  }

  /** 处理一行:返回应答 JSON 文本(通知/空行/解析失败分别见内注释)。 */
  async function handleLine(line: string): Promise<string | null> {
    const trimmed = line.trim();
    if (trimmed === '') return null;
    const parsed = parseMessage(trimmed);
    if (!parsed.ok) {
      return JSON.stringify(errorResponse(null, RPC_ERRORS.PARSE, '不是合法的 JSON-RPC 消息'));
    }
    if (parsed.message.method === 'notifications/cancelled') {
      // MCP 取消通知:abort 对应在飞 daemon 调用(客户端侧 fetch abort),
      // 错误结果帧照常以原 id 写回(result.isError,MCP 约定),通知本身不应答。
      cancelInflight(parsed.message.params);
      return null;
    }
    if (parsed.message.method.startsWith('notifications/')) return null;
    const response = await dispatch(parsed.message);
    return response === null ? null : JSON.stringify(response);
  }

  return {
    start() {
      if (running) return;
      running = true;
      inputIterator = options.input[Symbol.asyncIterator]();
      void (async () => {
        try {
          while (true) {
            const next = await inputIterator.next();
            if (next.done === true) break;
            buffer += decoder.decode(next.value, { stream: true });
            let nl = buffer.indexOf('\n');
            while (nl !== -1) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              // 并发处理:每行独立异步执行,不逐行 await——一条挂起的 tools/call
              // 不再阻塞后续帧(ping 等照常应答)。JSON-RPC 响应之间无顺序要求,
              // 写回统一经 writeBack 串行化,stdout 帧不互相穿插。
              const task = handleLine(line)
                .then((out) => {
                  if (out !== null) writeBack(out);
                })
                .catch(() => {
                  // 单帧意外异常(dispatch 已兜底工具错误,这里防序列化等漏网)不拖垮读循环。
                });
              pending.add(task);
              void task.finally(() => {
                pending.delete(task);
              });
              nl = buffer.indexOf('\n');
            }
          }
          // 流已关闭:MCP stdio 规范要求每条消息以 \n 结束,残余无换行碎片
          // 不构成完整帧,按规范丢弃(与官方 stdio 行为一致)。
          buffer = '';
        } catch {
          // 入向流异常结束:与 stdin 关闭同义,桥进程随之收尾。
        }
      })();
    },
    handleLine,
    session: () => sessionIdentity,
    sessionReady: () => sessionSettled,
    async close() {
      running = false;
      // 在飞调用逐个 abort(与 notifications/cancelled 同通道):传输层立即失败、
      // 错误帧写回,pending 随之收敛,allSettled 不再永挂。
      for (const controller of [...inflight.values()]) controller.abort();
      inflight.clear();
      await Promise.allSettled([...pending]);
      await writeQueue;
    },
  };
}
