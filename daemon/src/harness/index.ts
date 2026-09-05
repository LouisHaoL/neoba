/**
 * harness 模块(§4 多基座集成 Adapter,P3 起多基座:claude-code / codex / opencode)。
 * 事件归一化:基座逐行输出 -> §3.6 统一事件;运行时零第三方依赖。
 */
export { ClaudeCodeAdapter, argsDigest, sha256Hex } from './claude-code-adapter.ts';
export type { ClaudeCodeAdapterOptions } from './claude-code-adapter.ts';
export { CodexAdapter } from './codex-adapter.ts';
export type { CodexAdapterOptions } from './codex-adapter.ts';
export { OpenCodeAdapter } from './opencode-adapter.ts';
export type { OpenCodeAdapterOptions } from './opencode-adapter.ts';
export { createAdapter } from './adapter.ts';
export type { CreateAdapterOptions, HarnessAdapter } from './adapter.ts';
export { AdapterUnknown } from './errors.ts';
export { DEFAULT_BASE, KNOWN_BASES, baseCommand, resolveBase } from './commands.ts';
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
