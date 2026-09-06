/**
 * neoba approve / deny:审批定案(§3.3 人机入口,写侧)。
 * granted 可带 --narrow-to 窄化授权(如只授 workdir 子目录,强制 ro)。
 */
import { join } from 'node:path';

import { CliUsageError, flagString, parseArgs } from '../args.ts';
import { connectOrExplain, rpcCall } from '../rpc.ts';
import type { Command, CliDeps } from '../types.ts';

function decideCommand(name: 'approve' | 'deny'): Command {
  const decision = name === 'approve' ? 'granted' : 'denied';
  const summary = name === 'approve'
    ? '批准审批单(可 --narrow-to 窄化授权)'
    : '驳回审批单';
  const usage = name === 'approve'
    ? 'neoba approve <req_id> [--by NAME] [--narrow-to PATH] [--state-dir DIR]'
    : 'neoba deny <req_id> [--by NAME] [--state-dir DIR]';
  return {
    name,
    summary,
    usage,
    async run(args, { io, deps }) {
      const { flags, positionals } = parseArgs(args, ['state-dir', 'by', 'narrow-to'], ['state-dir', 'by', 'narrow-to']);
      const reqId = positionals[0];
      if (reqId === undefined || reqId === '') {
        throw new CliUsageError('缺少 req_id');
      }
      const by = flagString(flags, 'by') ?? 'cli';
      const narrowedTo = flagString(flags, 'narrow-to');
      const stateDir = flagString(flags, 'state-dir') ?? join(deps.homedir(), '.neoba');

      const endpoint = await connectOrExplain(deps, io, stateDir);
      if (endpoint === null) return 1;
      const outcome = await rpcCall<{ decision?: string }>(deps, endpoint, 'approvals.decide', {
        req_id: reqId,
        decision,
        by,
        ...(narrowedTo !== undefined ? { narrowed_to: narrowedTo } : {}),
      });
      if (!outcome.ok) {
        io.err(`neoba ${name}: [${outcome.code}] ${outcome.message}`);
        return 1;
      }
      io.out(`${reqId} → ${outcome.result.decision ?? decision}(by=${by})`);
      return 0;
    },
  };
}

export const approveCommand: Command = decideCommand('approve');
export const denyCommand: Command = decideCommand('deny');
