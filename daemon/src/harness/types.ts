/**
 * harness adapter 对外类型(§4 多基座集成 / §3.6 统一事件 schema)。
 *
 * 两类模型:
 * 1. 基座消息(Claude Code stream-json 逐行 JSON)——按公开文档语义建模,
 *    字段全部可选 + unknown 宽松解析(§3.0 兼容规则:忽略未知字段);
 * 2. 统一事件(§3.6)——§3.6 冻结五种(tool_call / message_delta /
 *    artifact_ready / usage / error),Adapter 另发三种控制事件
 *    (tool_inventory / unlisted_tool / parse_error):tool_inventory 是
 *    §3.6"唯一事实源"的权威清单载体,unlisted_tool 是清单外工具的标志
 *    事件(不丢弃原 tool_call),parse_error 保证坏行不炸流。
 */

// ---------------------------------------------------------------- 统一事件(§3.6)

/** 事件公共头:ts 为 ISO 8601;agent 为容器内 agent 实例 id(Adapter 可不知,为 null)。 */
interface UnifiedEventBase {
  readonly ts: string;
  readonly agent: string | null;
}

/** §3.6:工具调用事实。args_digest = sha256(canonical JSON(input)),不回传全量参数。 */
export interface ToolCallEvent extends UnifiedEventBase {
  readonly event: 'tool_call';
  readonly tool: string;
  readonly args_digest: string;
  /** 基座侧 tool_use 块 id(便于与 tool_result 对账;基座不给则 null)。 */
  readonly tool_use_id: string | null;
}

/** §3.6:模型文本增量。注意:文本只是观测,不是状态(唯一事实源原则)。 */
export interface MessageDeltaEvent extends UnifiedEventBase {
  readonly event: 'message_delta';
  readonly text: string;
}

/**
 * §3.6:工件就绪。Adapter 只能从 tool_use 事实推断"写入了工件目录下的文件",
 * 无法从事件流算出内容哈希 —— sha256 显式 null(省略≠null 约定),权威哈希
 * 由 sidecar 的文件系统事实(§3.7 落盘即记 sha256)回填,本事件仅作提示。
 */
export interface ArtifactReadyEvent extends UnifiedEventBase {
  readonly event: 'artifact_ready';
  readonly name: string;
  readonly sha256: string | null;
  readonly path: string;
}

/** §3.6:用量。cost_estimate 在订阅制基座(无计费信息)下显式 null。 */
export interface UsageEvent extends UnifiedEventBase {
  readonly event: 'usage';
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost_estimate: number | null;
  /** 附加观测(缓存命中、permission_denials 计数等),不进 §3.6 冻结字段。 */
  readonly extra?: Record<string, unknown>;
}

export type UnifiedErrorKind =
  | 'result_error' // result 行报错(is_error / subtype=error_*)
  | 'harness_crash'
  | (string & {}); // 开放扩展:接收方忽略未知 kind(§3.0)

/** §3.6:错误。 */
export interface ErrorEvent extends UnifiedEventBase {
  readonly event: 'error';
  readonly kind: UnifiedErrorKind;
  readonly detail: string;
}

/**
 * 控制事件:工具清单权威清单(§3.6 唯一事实源:基座 init/system 事件中的
 * tools / mcp_servers / permissionMode,禁止采信模型自述)。
 */
export interface ToolInventoryEvent extends UnifiedEventBase {
  readonly event: 'tool_inventory';
  readonly tools: readonly string[];
  readonly mcp_servers: readonly string[];
  readonly permission_mode: string | null;
  readonly model: string | null;
  readonly session_id: string | null;
}

/** 控制事件:清单外工具标志(不丢弃原 tool_call,只打标)。 */
export interface UnlistedToolEvent extends UnifiedEventBase {
  readonly event: 'unlisted_tool';
  readonly tool: string;
  readonly detail: string;
}

/** 控制事件:单行解析失败(不炸流;不回显原文,只带原文摘要)。 */
export interface ParseErrorEvent extends UnifiedEventBase {
  readonly event: 'parse_error';
  readonly detail: string;
  readonly raw_digest: string;
}

export type UnifiedEvent =
  | ToolCallEvent
  | MessageDeltaEvent
  | ArtifactReadyEvent
  | UsageEvent
  | ErrorEvent
  | ToolInventoryEvent
  | UnlistedToolEvent
  | ParseErrorEvent;

// ---------------------------------------------------------------- 工具清单(权威状态)

/** Adapter 维护的当前权威清单(init/system 事件写入,tool_call 对照)。 */
export interface ToolInventory {
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly permissionMode: string | null;
  readonly model: string | null;
  readonly sessionId: string | null;
}

// ---------------------------------------------------------------- 基座消息(stream-json 建模)

/** Anthropic 风格用量块(init/assistant/result 行都可能携带,字段可缺)。 */
export interface StreamUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

export interface StreamTextBlock {
  readonly type: 'text';
  readonly text?: string;
}

export interface StreamToolUseBlock {
  readonly type: 'tool_use';
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

export interface StreamToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
}

export type StreamContentBlock = StreamTextBlock | StreamToolUseBlock | StreamToolResultBlock | { readonly type: string };

/** assistant 行:完整 assistant 消息(content 块数组)。 */
export interface StreamAssistantLine {
  readonly type: 'assistant';
  readonly session_id?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: readonly StreamContentBlock[];
    readonly model?: string;
    readonly usage?: StreamUsage;
  };
}

/**
 * system 行。实测(sub spike #1 E7)以 subtype=init 为主,携带
 * tools / mcp_servers / permissionMode / model / cwd —— 工具清单权威来源。
 */
export interface StreamSystemLine {
  readonly type: 'system';
  readonly subtype?: string;
  readonly session_id?: string;
  readonly tools?: unknown;
  readonly mcp_servers?: unknown;
  readonly permissionMode?: unknown;
  readonly model?: unknown;
  readonly cwd?: string;
}

/**
 * user 行:基座回显的 tool_result(§3.6 无对应事件,Adapter 消化不外发;
 * 工具成败由容器/文件系统事实判定,见唯一事实源原则)。
 */
export interface StreamUserLine {
  readonly type: 'user';
  readonly session_id?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: readonly StreamContentBlock[];
  };
}

/**
 * result 行:一次 `claude -p` 运行的终态,含聚合 usage / cost /
 * modelUsage / permission_denials。
 */
export interface StreamResultLine {
  readonly type: 'result';
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: unknown;
  readonly usage?: StreamUsage;
  readonly total_cost_usd?: unknown;
  readonly num_turns?: number;
  readonly duration_ms?: number;
  readonly permission_denials?: unknown;
  readonly session_id?: string;
}

/**
 * stream_event 行(`--include-partial-messages` 开启时的部分增量),
 * event 为 Anthropic 流式事件(content_block_delta / text_delta 等)。
 */
export interface StreamPartialLine {
  readonly type: 'stream_event';
  readonly session_id?: string;
  readonly event?: {
    readonly type?: string;
    readonly index?: number;
    readonly delta?: {
      readonly type?: string;
      readonly text?: string;
    };
  };
}

export type StreamJsonLine =
  | StreamAssistantLine
  | StreamSystemLine
  | StreamUserLine
  | StreamResultLine
  | StreamPartialLine
  | { readonly type: string };
