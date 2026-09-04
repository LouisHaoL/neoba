#!/usr/bin/env node
/**
 * neoba CLI 入口(§3.10):人肉调试与兜底壳。
 *
 *   neoba start [--state-dir DIR] [--port N] [--foreground]
 *   neoba status [--state-dir DIR] [--json]
 *   neoba doctor [--write] [--json]
 *   neoba prune [--state-dir DIR] [--yes]
 *   neoba mcp   [--state-dir DIR] [--port N]
 *
 * 库用法(测试/嵌入式):
 *   const code = await runCli(argv, io, deps);
 * 全局:--help / --version;未知命令报错并列出可用命令(退出码 2)。
 */

import { pathToFileURL } from 'node:url';

import { CliUsageError } from './args.ts';
import { defaultDeps } from './deps.ts';
import { renderHelp, renderVersion } from './help.ts';
import { commandRegistry } from './registry.ts';
import { processIo } from './types.ts';
import type { CliDeps, CliIo } from './types.ts';

/**
 * 路由 + 执行:纯 IO 经参数注入,便于测试。
 * 退出码约定:0 成功;1 运行失败(端口占用/daemon 不在/状态损坏等);
 * 2 用法错误(未知命令/未知选项/缺值/--daemonize)。
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const commands = commandRegistry();

  const first = argv[0];
  if (first === undefined || first === '--help' || first === '-h') {
    io.out(renderHelp(commands, deps.version));
    return 0;
  }
  if (first === '--version' || first === '-V') {
    io.out(renderVersion(deps.version));
    return 0;
  }

  if (first.startsWith('-')) {
    io.err(`neoba: 未知全局选项 ${first}`);
    io.err(renderHelp(commands, deps.version));
    return 2;
  }

  const command = commands[first];
  if (command === undefined) {
    io.err(`neoba: 未知命令 "${first}"`);
    io.err(`可用命令: ${Object.keys(commands).join(', ')}`);
    io.err('运行 neoba --help 查看详情');
    return 2;
  }

  try {
    return await command.run(argv.slice(1), { io, deps });
  } catch (err) {
    if (err instanceof CliUsageError) {
      io.err(`neoba ${command.name}: ${err.message}`);
      io.err(`用法: ${command.usage}`);
      return 2;
    }
    io.err(`neoba ${command.name}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** 直接执行入口(node src/cli/main.ts 或 bin shim);被 import 时不触发。 */
async function main(): Promise<void> {
  const invoked = process.argv[1];
  if (invoked === undefined) return;
  if (import.meta.url !== pathToFileURL(invoked).href) return;
  const deps = await defaultDeps();
  process.exitCode = await runCli(process.argv.slice(2), processIo, deps);
}

main().catch((err: unknown) => {
  processIo.err(
    `neoba: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
