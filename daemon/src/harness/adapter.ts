/**
 * HarnessAdapter 抽象(§4 多基座集成,P3 起多基座):
 *
 * 每个基座一个 adapter,把基座的输出逐行翻译为 §3.6 统一事件;工厂按
 * base 名构造。适配约定(与 ClaudeCodeAdapter 一致):
 * - translate(line) 纯函数化逐行接口,坏行发 parse_error 不抛异常;
 * - getInventory() 返回当前权威工具清单(§3.6 唯一事实源);基座事件流
 *   不携带清单信息时返回 null(不伪造)。
 */
import type { Base } from '../capability/types.ts';
import { AdapterUnknown } from './errors.ts';
import { ClaudeCodeAdapter } from './claude-code-adapter.ts';
import { CodexAdapter } from './codex-adapter.ts';
import { OpenCodeAdapter } from './opencode-adapter.ts';
import { DEFAULT_BASE, resolveBase } from './commands.ts';
import type { ToolInventory, UnifiedEvent } from './types.ts';

/** 基座 adapter 统一接口(base + 逐行翻译 + 权威清单)。 */
export interface HarnessAdapter {
  /** 基座标识(落位后,不含 'any')。 */
  readonly base: Exclude<Base, 'any'>;
  /** 逐行翻译:一行基座输出 -> 零或多条统一事件。 */
  translate(line: string): UnifiedEvent[];
  /** 当前权威清单快照;基座未提供清单信息时为 null。 */
  getInventory(): ToolInventory | null;
}

export interface CreateAdapterOptions {
  /** 可注入时钟(透传各 adapter)。 */
  readonly now?: () => Date;
  /** 容器内 agent 实例 id(事件 agent 字段)。 */
  readonly agent?: string;
  /** 工件目录根(claude-code adapter 的 artifact_ready 提示用)。 */
  readonly artifactsRoot?: string;
  /** preset.base = 'any' 时的落位基座(缺省 claude-code)。 */
  readonly defaultBase?: Base;
}

/**
 * 按基座名构造 adapter;'any' 先落位;注册表外的 base 抛 AdapterUnknown
 * (显式拒绝,不静默降级到 claude-code)。
 */
export function createAdapter(base: Base, options: CreateAdapterOptions = {}): HarnessAdapter {
  const resolved = resolveBase(base, options.defaultBase ?? DEFAULT_BASE);
  switch (resolved) {
    case 'claude-code':
      return new ClaudeCodeAdapter({
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
        ...(options.artifactsRoot !== undefined ? { artifactsRoot: options.artifactsRoot } : {}),
      });
    case 'codex':
      return new CodexAdapter({
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
      });
    case 'opencode':
      return new OpenCodeAdapter({
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
      });
    default: {
      const known: readonly string[] = ['claude-code', 'codex', 'opencode'];
      throw new AdapterUnknown(String(base), known);
    }
  }
}
