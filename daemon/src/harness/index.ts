/**
 * harness 模块(§4 多基座集成 Adapter,P1 单基座:Claude Code)。
 * 事件归一化:基座逐行 JSON 输出 -> §3.6 统一事件;运行时零第三方依赖。
 */
export { ClaudeCodeAdapter, argsDigest, sha256Hex } from './claude-code-adapter.ts';
export type { ClaudeCodeAdapterOptions } from './claude-code-adapter.ts';
export type {
  ArtifactReadyEvent,
  ErrorEvent,
  MessageDeltaEvent,
  ParseErrorEvent,
  StreamAssistantLine,
  StreamContentBlock,
  StreamJsonLine,
  StreamPartialLine,
  StreamResultLine,
  StreamSystemLine,
  StreamTextBlock,
  StreamToolResultBlock,
  StreamToolUseBlock,
  StreamUsage,
  StreamUserLine,
  ToolCallEvent,
  ToolInventory,
  ToolInventoryEvent,
  UnifiedErrorKind,
  UnifiedEvent,
  UnlistedToolEvent,
  UsageEvent,
} from './types.ts';
