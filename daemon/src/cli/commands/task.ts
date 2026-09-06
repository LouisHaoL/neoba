/**
 * neoba task:任务状态机的人机入口(§6 / §9 P2)。
 *   neoba task <task_id> status            查任务状态
 *   neoba task <task_id> pause             暂停(当前节点跑完后停在派发边界)
 *   neoba task <task_id> resume            恢复(预算熔断续预算后用)
 *   neoba task <task_id> cancel            取消(协作终止,终态 cancelled)
 */
import { join } from 'node:path';

import { CliUsageError, flagBool, flagString, parseArgs } from '../args.ts';
import { connectOrExplain, rpcCall } from '../rpc.ts';
import type { Command, CliDeps } from '../types.ts';

interface TaskRecordLike {
  readonly taskId?: unknown;
  readonly status?: unknown;
  readonly error?: unknown;
  readonly preset?: unknown;
  readonly intent?: unknown;
}

const ACTIONS = ['status', 'pause', 'resume', 'cancel'] as const;
type Action = (typeof ACTIONS)[number];

export const taskCommand: Command = {
  name: 'task',
  summary: '任务操作:status / pause / resume / cancel',
  usage: 'neoba task <task_id> <status|pause|resume|cancel> [--state-dir DIR] [--json]',
  async run(args, { io, deps }) {
    const { flags, positionals } = parseArgs(args, ['state-dir'], ['state-dir', 'json']);
    const asJson = flagBool(flags, 'json');
    const taskId = positionals[0];
    const action = positionals[1];
    if (taskId === undefined || taskId === '') {
      throw new CliUsageError('缺少 task_id');
    }
    if (action === undefined || !(ACTIONS as readonly string[]).includes(action)) {
      throw new CliUsageError(`缺少动作或动作非法(可用: ${ACTIONS.join(' / ')})`);
    }
    const stateDir = flagString(flags, 'state-dir') ?? join(deps.homedir(), '.neoba');

    const endpoint = await connectOrExplain(deps, io, stateDir);
    if (endpoint === null) return 1;

    if (action === 'status') {
      const outcome = await rpcCall<{ task?: TaskRecordLike }>(deps, endpoint, 'task.status', {
        task_id: taskId,
      });
      if (!outcome.ok) {
        io.err(`neoba task: [${outcome.code}] ${outcome.message}`);
        return 1;
      }
      if (asJson) {
        io.out(JSON.stringify(outcome.result, null, 2));
        return 0;
      }
      const task = outcome.result.task ?? {};
      io.out(
        `${String(task.taskId ?? taskId)}  status=${String(task.status ?? '?')}  preset=${String(task.preset ?? '?')}${
          task.error ? `  error=${String(task.error)}` : ''
        }`,
      );
      return 0;
    }

    const method = action === 'pause' ? 'task.pause' : action === 'resume' ? 'task.resume' : 'task.cancel';
    const outcome = await rpcCall<Record<string, unknown>>(deps, endpoint, method, { task_id: taskId });
    if (!outcome.ok) {
      io.err(`neoba task: [${outcome.code}] ${outcome.message}`);
      return 1;
    }
    if (asJson) {
      io.out(JSON.stringify(outcome.result, null, 2));
      return 0;
    }
    io.out(`${taskId} ${action} → ${JSON.stringify(outcome.result)}`);
    return 0;
  },
};
