/**
 * CLI 命令注册表:map 结构,name -> {name, summary, usage, run}。
 * 新增命令 = 新增一个 commands/*.ts + 在这里登记一行;help 自动带上。
 */

import { approveCommand, denyCommand } from './commands/decide.ts';
import { approvalsCommand } from './commands/approvals.ts';
import { budgetCommand } from './commands/budget.ts';
import { doctorCommand } from './commands/doctor.ts';
import { mcpCommand } from './commands/mcp.ts';
import { pruneCommand } from './commands/prune.ts';
import { startCommand } from './commands/start.ts';
import { statusCommand } from './commands/status.ts';
import { taskCommand } from './commands/task.ts';
import { workflowCommand } from './commands/workflow.ts';
import type { Command } from './types.ts';

export function commandRegistry(): Record<string, Command> {
  const commands: Command[] = [
    startCommand,
    statusCommand,
    doctorCommand,
    pruneCommand,
    mcpCommand,
    taskCommand,
    budgetCommand,
    approvalsCommand,
    approveCommand,
    denyCommand,
    workflowCommand,
  ];
  const map: Record<string, Command> = {};
  for (const c of commands) map[c.name] = c;
  return map;
}
