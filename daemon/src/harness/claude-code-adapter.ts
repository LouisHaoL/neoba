/**
 * Claude Code 基座 Adapter(§4:事件归一化,P1 单基座)。
 *
 * 消费 `claude -p --output-format stream-json --verbose` 的逐行 JSON 输出,
 * 翻译为 §3.6 统一事件。设计要点:
 *
 * - 唯一事实源(§3.6 v0.2 / spike #1 F3):init/system 事件里的
 *   tools / mcp_servers / permissionMode 是 tool_inventory 权威清单;
 *   清单外工具的 tool_call 照常翻译并追加 unlisted_tool 标志事件(不丢弃);
 *   模型文本(含"已完成/已修改"式自述)只产生 message_delta 观测,
 *   绝不产生状态/工件事件 —— 只有 tool_use / 文件系统事实才算数。
 * - 纯函数化逐行接口:translate(line) -> UnifiedEvent[],坏行发
 *   parse_error 不抛异常;跨行状态只有权威清单一份。
 * - usage 归一:result 行为权威口径(聚合值,避免与 assistant 逐条
 *   usage 重复计数);cost_estimate 无计费信息(订阅制)时显式 null。
 */
import { createHash } from 'node:crypto';
import type {
  StreamAssistantLine,
  StreamContentBlock,
  StreamJsonLine,
  StreamPartialLine,
  StreamResultLine,
  StreamSystemLine,
  StreamTextBlock,
  StreamToolUseBlock,
  ToolInventory,
  UnifiedEvent,
} from './types.ts';

export interface ClaudeCodeAdapterOptions {
  /** 可注入时钟(测试);默认系统时钟。 */
  readonly now?: () => Date;
  /** 容器内 agent 实例 id;缺省 null(事件仍带 agent 字段,取值 null)。 */
  readonly agent?: string;
  /**
   * 工件目录根(容器内绝对路径,如 /home/worker/work/artifacts)。
   * 给出时,Write/Edit 类 tool_use 命中该前缀 → 追加 artifact_ready 提示
   * 事件(sha256 显式 null,权威哈希由 sidecar 文件系统事实回填)。
   */
  readonly artifactsRoot?: string;
}

/** Claude Code 内建写文件类工具(命中才判 artifact_ready)。 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** stream-json 里 MCP 工具名形如 mcp__<server>__<tool>。 */
const MCP_TOOL_RE = /^mcp__([^_]+(?:__[^_]+)*?)__([^_]+)$/;

export class ClaudeCodeAdapter {
  readonly base = 'claude-code' as const;
  private readonly now: () => Date;
  private readonly agent: string | null;
  private readonly artifactsRoot: string | null;
  private inventory: ToolInventory | null;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.agent = options.agent ?? null;
    this.artifactsRoot = options.artifactsRoot ?? null;
    this.inventory = null;
  }

  /** 事件时间戳(RFC3339 UTC,§3 总则)。 */
  private stamp(): string {
    return this.now().toISOString();
  }

  /** 当前权威清单快照;尚未见到 init/system 行时为 null。 */
  getInventory(): ToolInventory | null {
    return this.inventory;
  }

  /**
   * 逐行翻译:一行 stream-json -> 零或多条统一事件。
   * 空/非 JSON 行 -> 单条 parse_error;未知 type -> 忽略(§3.0 前向兼容)。
   */
  translate(line: string): UnifiedEvent[] {
    const trimmed = line.trim();
    if (trimmed === '') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      // 不回显原文与解析器报错(JSON.parse 报错含原文片段,§3.8 脱敏)。
      return [
        {
          event: 'parse_error',
          ts: this.stamp(),
          agent: this.agent,
          detail: 'stream-json 行不是合法 JSON',
          raw_digest: sha256Hex(trimmed),
        },
      ];
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return [this.parseError('stream-json 行不是 JSON 对象', trimmed)];
    }
    const msg = parsed as StreamJsonLine;
    switch (msg.type) {
      case 'system':
        return this.translateSystem(msg as StreamSystemLine);
      case 'assistant':
        return this.translateAssistant(msg as StreamAssistantLine);
      case 'stream_event':
        return this.translatePartial(msg as StreamPartialLine);
      case 'result':
        return this.translateResult(msg as StreamResultLine);
      default:
        // user(tool_result 回显)与未知 type:消化不外发(前向兼容)。
        return [];
    }
  }

  // ---------------------------------------------------------------- 各消息类型

  private translateSystem(msg: StreamSystemLine): UnifiedEvent[] {
    if (msg.subtype !== 'init') return [];
    const tools = readStringArray(msg.tools);
    const mcpServers = readServerNames(msg.mcp_servers);
    this.inventory = {
      tools,
      mcpServers,
      permissionMode: typeof msg.permissionMode === 'string' ? msg.permissionMode : null,
      model: typeof msg.model === 'string' ? msg.model : null,
      sessionId: typeof msg.session_id === 'string' ? msg.session_id : null,
    };
    return [
      {
        event: 'tool_inventory',
        ts: this.stamp(),
        agent: this.agent,
        tools,
        mcp_servers: mcpServers,
        permission_mode: this.inventory.permissionMode,
        model: this.inventory.model,
        session_id: this.inventory.sessionId,
      },
    ];
  }

  private translateAssistant(msg: StreamAssistantLine): UnifiedEvent[] {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];
    const events: UnifiedEvent[] = [];
    for (const block of content) {
      if (block.type === 'text') {
        const text = (block as StreamTextBlock).text;
        if (typeof text === 'string' && text !== '') {
          events.push({ event: 'message_delta', ts: this.stamp(), agent: this.agent, text });
        }
      } else if (block.type === 'tool_use') {
        events.push(...this.translateToolUse(block as StreamToolUseBlock));
      }
    }
    return events;
  }

  private translatePartial(msg: StreamPartialLine): UnifiedEvent[] {
    const ev = msg.event;
    if (ev?.type !== 'content_block_delta') return [];
    const delta = ev.delta;
    if (delta?.type !== 'text_delta' || typeof delta.text !== 'string' || delta.text === '') {
      return [];
    }
    return [{ event: 'message_delta', ts: this.stamp(), agent: this.agent, text: delta.text }];
  }

  private translateToolUse(block: StreamContentBlock): UnifiedEvent[] {
    const toolUse = block as StreamToolUseBlock;
    if (block.type !== 'tool_use') return [];
    const tool = typeof toolUse.name === 'string' ? toolUse.name : '';
    if (tool === '') return [];
    const input = toolUse.input;
    const events: UnifiedEvent[] = [
      {
        event: 'tool_call',
        ts: this.stamp(),
        agent: this.agent,
        tool,
        args_digest: argsDigest(input),
        tool_use_id: typeof toolUse.id === 'string' ? toolUse.id : null,
      },
    ];
    // 清单外工具:照常翻译,追加标志事件(唯一事实源:工具清单以 init 为准)。
    const flag = this.unlistedReason(tool);
    if (flag !== null) {
      events.push({
        event: 'unlisted_tool',
        ts: this.stamp(),
        agent: this.agent,
        tool,
        detail: flag,
      });
    }
    // 工件目录写入:tool_use 事实驱动的 artifact_ready 提示(sha256 null)。
    const artifact = this.artifactHit(tool, input);
    if (artifact !== null) events.push(artifact);
    return events;
  }

  private translateResult(msg: StreamResultLine): UnifiedEvent[] {
    const events: UnifiedEvent[] = [];
    const usage = msg.usage ?? {};
    const tokensIn = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const tokensOut = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    const extra: Record<string, unknown> = {};
    if (typeof usage.cache_creation_input_tokens === 'number') {
      extra['cache_creation_input_tokens'] = usage.cache_creation_input_tokens;
    }
    if (typeof usage.cache_read_input_tokens === 'number') {
      extra['cache_read_input_tokens'] = usage.cache_read_input_tokens;
    }
    if (Array.isArray(msg.permission_denials) && msg.permission_denials.length > 0) {
      extra['permission_denials'] = msg.permission_denials.length;
    }
    events.push({
      event: 'usage',
      ts: this.stamp(),
      agent: this.agent,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      // 订阅制 / 无计费信息:cost_estimate 显式 null(省略≠null 约定)。
      cost_estimate: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    });
    if (msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error'))) {
      events.push({
        event: 'error',
        ts: this.stamp(),
        agent: this.agent,
        kind: 'result_error',
        detail: `result subtype=${String(msg.subtype)}: ${summary(msg.result)}`,
      });
    }
    return events;
  }

  // ---------------------------------------------------------------- 清单对照 / 工件

  /** 清单外返回原因描述;清单未建立(未见过 init)不判(无从对照)。 */
  private unlistedReason(tool: string): string | null {
    const inv = this.inventory;
    if (inv === null) return null;
    const mcp = MCP_TOOL_RE.exec(tool);
    if (mcp !== null) {
      const server = mcp[1] ?? '';
      return inv.mcpServers.includes(server)
        ? null
        : `MCP server "${server}" 不在 init 清单中 (${inv.mcpServers.join(', ') || '空'})`;
    }
    return inv.tools.includes(tool) ? null : `内建工具 "${tool}" 不在 init 清单中`;
  }

  private artifactHit(tool: string, input: unknown): UnifiedEvent | null {
    const root = this.artifactsRoot;
    if (root === null || !WRITE_TOOLS.has(tool)) return null;
    if (typeof input !== 'object' || input === null) return null;
    const filePath = (input as Record<string, unknown>)['file_path'];
    if (typeof filePath !== 'string') return null;
    const normalized = filePath.replaceAll('\\', '/');
    const rootNorm = root.replaceAll('\\', '/').replace(/\/+$/, '');
    if (!normalized.startsWith(`${rootNorm}/`)) return null;
    const rel = normalized.slice(rootNorm.length + 1);
    return {
      event: 'artifact_ready',
      ts: this.stamp(),
      agent: this.agent,
      name: rel,
      sha256: null,
      path: normalized,
    };
  }

  private parseError(detail: string, raw: string): UnifiedEvent {
    return {
      event: 'parse_error',
      ts: this.stamp(),
      agent: this.agent,
      detail,
      raw_digest: sha256Hex(raw),
    };
  }
}

// ---------------------------------------------------------------- 纯工具函数

/** sha256 hex(小写)。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 工具入参摘要:sha256(canonical JSON(input)),键递归排序保证同参同摘要;
 * 不回传全量参数(§3.8:事件流对参数脱敏)。
 */
export function argsDigest(input: unknown): string {
  return sha256Hex(JSON.stringify(canonicalize(input)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  return value;
}

/** init.tools:字符串数组;宽松解析,忽略非字符串项。 */
function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return Object.freeze(value.filter((v): v is string => typeof v === 'string'));
}

/**
 * init.mcp_servers:实测为 [{name, status}, ...] 对象数组;兼容字符串数组。
 * 权威清单只取 server 名。
 */
function readServerNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      names.push(item);
    } else if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>)['name'] === 'string') {
      names.push((item as Record<string, unknown>)['name'] as string);
    }
  }
  return Object.freeze(names);
}

/** result 字段摘要(error detail 用,截断防刷屏)。 */
function summary(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}
