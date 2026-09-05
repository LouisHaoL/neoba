/**
 * Codex 基座 Adapter(§4 多基座集成,P3;事件流取样见 spike #1 C7)。
 *
 * 消费 `codex exec --json` 的实验性 JSONL 事件流,翻译为 §3.6 统一事件:
 * - thread.started → tool_inventory 载体事件(Codex 流不带工具清单,
 *   inventory 以 sessionId=thread_id 承载会话事实,tools/mcp 为空集,
 *   permissionMode/model 显式 null —— 不伪造唯一事实源);
 * - item.started / item.updated:中间态,消化不外发(权威终态在
 *   item.completed,外发中间态会导致 message_delta/tool_call 重复计数);
 * - item.completed:item.type 分派 —— agent_message→message_delta、
 *   command_execution→tool_call(args_digest 摘 command)、
 *   mcp_tool_call→tool_call(摘要 arguments)、reasoning 消化;
 *   其余 item 类型 → parse_error(不炸流);
 * - turn.completed → usage(cost_estimate 显式 null,Codex 流无计费字段;
 *   cached_input_tokens 进 extra);
 * - turn.failed → error(kind=turn_failed)。
 */
import { createHash } from 'node:crypto';
import { argsDigest } from './claude-code-adapter.ts';
import type {
  ToolInventory,
  UnifiedEvent,
} from './types.ts';

export interface CodexAdapterOptions {
  /** 可注入时钟(测试);默认系统时钟。 */
  readonly now?: () => Date;
  /** 容器内 agent 实例 id;缺省 null。 */
  readonly agent?: string;
}

/** Codex item.completed 的 item 形(字段宽松,§3.0 忽略未知字段)。 */
interface CodexItem {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly text?: unknown;
  readonly command?: unknown;
  readonly arguments?: unknown;
  readonly tool?: unknown;
}

interface CodexLine {
  readonly type?: unknown;
  readonly thread_id?: unknown;
  readonly item?: unknown;
  readonly usage?: unknown;
  readonly error?: unknown;
  readonly message?: unknown;
}

export class CodexAdapter {
  readonly base = 'codex' as const;
  private readonly now: () => Date;
  private readonly agent: string | null;
  private inventory: ToolInventory | null;

  constructor(options: CodexAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.agent = options.agent ?? null;
    this.inventory = null;
  }

  getInventory(): ToolInventory | null {
    return this.inventory;
  }

  /** 逐行翻译:坏行 parse_error 不抛异常;未知 type 忽略(§3.0 前向兼容)。 */
  translate(line: string): UnifiedEvent[] {
    const trimmed = line.trim();
    if (trimmed === '') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return [this.parseError('codex --json 行不是合法 JSON', trimmed)];
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return [this.parseError('codex --json 行不是 JSON 对象', trimmed)];
    }
    const msg = parsed as CodexLine;
    switch (msg.type) {
      case 'thread.started': {
        const threadId = typeof msg.thread_id === 'string' ? msg.thread_id : null;
        this.inventory = {
          tools: [],
          mcpServers: [],
          permissionMode: null,
          model: null,
          sessionId: threadId,
        };
        return [
          {
            event: 'tool_inventory',
            ts: this.stamp(),
            agent: this.agent,
            tools: [],
            mcp_servers: [],
            permission_mode: null,
            model: null,
            session_id: threadId,
          },
        ];
      }
      case 'item.completed': {
        if (typeof msg.item !== 'object' || msg.item === null) {
          return [this.parseError('item.completed 缺 item 对象', trimmed)];
        }
        return this.translateItem(msg.item as CodexItem, trimmed);
      }
      case 'turn.completed': {
        const usage = (typeof msg.usage === 'object' && msg.usage !== null ? msg.usage : {}) as Record<string, unknown>;
        const tokensIn = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0;
        const tokensOut = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0;
        const extra: Record<string, unknown> = {};
        if (typeof usage['cached_input_tokens'] === 'number') {
          extra['cached_input_tokens'] = usage['cached_input_tokens'];
        }
        return [
          {
            event: 'usage',
            ts: this.stamp(),
            agent: this.agent,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            cost_estimate: null, // Codex 事件流无计费字段:显式 null(省略≠null)。
            ...(Object.keys(extra).length > 0 ? { extra } : {}),
          },
        ];
      }
      case 'turn.failed': {
        const detail = typeof msg.error === 'object' && msg.error !== null
          ? String((msg.error as Record<string, unknown>)['message'] ?? '')
          : typeof msg.error === 'string'
            ? msg.error
            : '';
        return [
          {
            event: 'error',
            ts: this.stamp(),
            agent: this.agent,
            kind: 'turn_failed',
            detail,
          },
        ];
      }
      case 'turn.started':
      case 'item.started':
      case 'item.updated':
        return []; // 中间态:权威事实在 item.completed / turn.completed。
      default:
        return []; // 未知顶层 type:忽略(§3.0 前向兼容)。
    }
  }

  // ---------------------------------------------------------------- item 分派

  private translateItem(item: CodexItem, raw: string): UnifiedEvent[] {
    const itemId = typeof item.id === 'string' ? item.id : null;
    switch (item.type) {
      case 'agent_message': {
        const text = typeof item.text === 'string' ? item.text : '';
        if (text === '') return [];
        return [{ event: 'message_delta', ts: this.stamp(), agent: this.agent, text }];
      }
      case 'reasoning':
        return []; // 推理摘要:消化(观测无关状态)。
      case 'command_execution':
        return [
          {
            event: 'tool_call',
            ts: this.stamp(),
            agent: this.agent,
            tool: 'command_execution',
            args_digest: argsDigest({ command: item.command }),
            tool_use_id: itemId,
          },
        ];
      case 'mcp_tool_call':
        return [
          {
            event: 'tool_call',
            ts: this.stamp(),
            agent: this.agent,
            tool: typeof item.tool === 'string' ? item.tool : 'mcp_tool_call',
            args_digest: argsDigest(item.arguments),
            tool_use_id: itemId,
          },
        ];
      default:
        return [this.parseError(`未知 item 类型: ${typeof item.type === 'string' ? item.type : '(缺失)'}`, raw)];
    }
  }

  private parseError(detail: string, rawLine: string): UnifiedEvent {
    return {
      event: 'parse_error',
      ts: this.stamp(),
      agent: this.agent,
      detail,
      raw_digest: createHash('sha256').update(rawLine.trim(), 'utf8').digest('hex'),
    };
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}
