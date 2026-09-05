/**
 * OpenCode 基座 Adapter(§4 多基座集成,P3 简化模式)。
 *
 * `opencode run` 输出为纯文本(M2 简化:server API 模式推迟),逐行翻译为
 * message_delta 观测事件;不承诺 tool_call / inventory(基座流不携带清单
 * 与工具事实,getInventory 恒 null —— 不伪造唯一事实源)。
 *
 * 语义边界:文本只是观测不是状态(§3.6 唯一事实源原则);该基座下节点
 * 完成判定完全依赖容器/文件系统事实(exit code + 端口工件)。
 */
import type { ToolInventory, UnifiedEvent } from './types.ts';

export interface OpenCodeAdapterOptions {
  /** 可注入时钟(测试);默认系统时钟。 */
  readonly now?: () => Date;
  /** 容器内 agent 实例 id;缺省 null。 */
  readonly agent?: string;
}

export class OpenCodeAdapter {
  readonly base = 'opencode' as const;
  private readonly now: () => Date;
  private readonly agent: string | null;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.agent = options.agent ?? null;
  }

  getInventory(): ToolInventory | null {
    return null;
  }

  /** 逐行翻译:非空行 → message_delta(纯文本输出,无 JSON 解析)。 */
  translate(line: string): UnifiedEvent[] {
    const text = line.trim();
    if (text === '') return [];
    return [{ event: 'message_delta', ts: this.now().toISOString(), agent: this.agent, text }];
  }
}
