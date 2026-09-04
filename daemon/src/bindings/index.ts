/**
 * MCP 绑定桥(§3.10):stdio MCP server ↔ daemon localhost JSON-RPC API。
 * 帧格式 = 换行分隔 JSON(MCP stdio 规范);运行时零第三方依赖。
 */
export { createMcpBridge, MCP_PROTOCOL_VERSIONS } from './mcp.ts';
export type { McpBridge, McpBridgeOptions, McpServerInfo } from './mcp.ts';
export { createDaemonHttpClient, DaemonCallError } from './client.ts';
export type { DaemonCaller, DaemonHttpClientOptions } from './client.ts';
export { spawnBridge, bridgeCliPath, BASE_URL_ENV, TOKEN_FILE_ENV, TOKEN_ENV } from './spawn.ts';
export type { SpawnBridgeOptions } from './spawn.ts';
