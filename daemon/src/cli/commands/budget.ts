/**
 * neoba budget:预算台账的人机入口(§3.5f hard 处置)。
 *   neoba budget <task_id> status          查预算快照
 *   neoba budget <task_id> raise --limit N 续预算(之后 task <id> resume 续跑)
 */
import { join } from 'node:path';

import { CliUsageError, flagCount, flagBool, flagString, parseArgs } from '../args.ts';
import { connectOrExplain, rpcCall } from '../rpc.ts';
import type { Command, CliDeps } from '../types.ts';

interface BudgetSnapshotLike {
  readonly limit_tokens?: unknown;
  readonly soft_tokens?: unknown;
  readonly observed_tokens?: unknown;
  readonly level?: unknown;
}

export const budgetCommand: Command = {
  name: 'budget',
  summary: '任务预算:status / raise(续预算后 task resume)',
  usage: 'neoba budget <task_id> <status|raise --limit N> [--state-dir DIR] [--json]',
  async run(args, { io, deps }) {
    const { flags, positionals } = parseArgs(args, ['state-dir', 'limit']);
    const asJson = flagBool(flags, 'json');
    const taskId = positionals[0];
    const action = positionals[1];
    if (taskId === undefined || taskId === '') {
      throw new CliUsageError('缺少 task_id');
    }
    const stateDir = flagString(flags, 'state-dir') ?? join(deps.homedir(), '.neoba');

    const endpoint = await connectOrExplain(deps, io, stateDir);
    if (endpoint === null) return 1;

    if (action === 'status') {
      const outcome = await rpcCall<{ budget: BudgetSnapshotLike | null }>(deps, endpoint, 'budget.status', {
        task_id: taskId,
      });
      if (!outcome.ok) {
        io.err(`neoba budget: [${outcome.code}] ${outcome.message}`);
        return 1;
      }
      if (asJson) {
        io.out(JSON.stringify(outcome.result, null, 2));
        return 0;
      }
      const budget = outcome.result.budget;
      if (budget === null) {
        io.out(`${taskId} 未配置预算`);
        return 0;
      }
      io.out(
        `${taskId}  level=${String(budget.level)}  observed=${String(budget.observed_tokens)}/${String(budget.limit_tokens)}(soft ${String(budget.soft_tokens)})`,
      );
      return 0;
    }

    if (action === 'raise') {
      const limit = flagCount(flags, 'limit');
      if (limit === undefined) {
        throw new CliUsageError('raise 需要 --limit N(新 hard limit,非负整数)');
      }
      const outcome = await rpcCall<Record<string, unknown>>(deps, endpoint, 'budget.raise', {
        task_id: taskId,
        limit_tokens: limit,
      });
      if (!outcome.ok) {
        io.err(`neoba budget: [${outcome.code}] ${outcome.message}`);
        return 1;
      }
      if (asJson) {
        io.out(JSON.stringify(outcome.result, null, 2));
        return 0;
      }
      io.out(
        `${taskId} 续预算 → limit=${String(outcome.result['limit_tokens'])} re_armed=${String(outcome.result['re_armed'])};续跑:neoba task ${taskId} resume`,
      );
      return 0;
    }

    throw new CliUsageError('缺少动作或动作非法(可用: status / raise)');
  },
};
