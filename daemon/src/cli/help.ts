/**
 * 帮助/版本渲染(纯函数)。命令清单直接来自注册表 map,新增命令自动进 help。
 */

import type { Command } from './types.ts';

export function renderHelp(
  commands: Readonly<Record<string, Command>>,
  version: string,
): string {
  const entries = Object.values(commands);
  const width = Math.max(...entries.map((c) => c.name.length), 0);
  const lines = [
    `neoba ${version} — neoba daemon 命令行壳(§3.10 人肉调试与兜底)`,
    '',
    '用法: neoba <命令> [参数]',
    '',
    '命令:',
  ];
  for (const c of entries) {
    lines.push(`  ${c.name.padEnd(width)}  ${c.summary}`);
  }
  lines.push(
    '',
    '全局参数:',
    '  --help     显示本帮助',
    '  --version  显示版本',
  );
  return lines.join('\n');
}

export function renderVersion(version: string): string {
  return `neoba ${version}`;
}

/**
 * 单命令帮助(issue #28):`neoba <命令> --help` 在命令层拦截后输出。
 * 取舍:help.ts 没有分命令长文档,这里复用注册表的单行 usage(含该命令
 * 全部合法 flag,与 parseArgs 白名单同源维护)+ 顶层 help 指引。
 */
export function renderCommandHelp(command: Command): string {
  return [
    `${command.name} — ${command.summary}`,
    '',
    `用法: ${command.usage}`,
    '',
    '运行 neoba --help 查看全部命令。',
  ].join('\n');
}
