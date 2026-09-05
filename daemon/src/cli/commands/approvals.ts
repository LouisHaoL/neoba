/**
 * neoba approvals:审批台账查询(§3.3 人机入口,读侧)。
 * 缺省只列 pending(等人定案的);--all 带已定案全量;--json 出结构化。
 */
import { join } from 'node:path';

import { flagBool, flagString, parseArgs } from '../args.ts';
import { connectOrExplain, rpcCall } from '../rpc.ts';
import type { Command, CliDeps } from '../types.ts';

interface ApprovalRecordLike {
  readonly reqId?: unknown;
  readonly agentId?: unknown;
  readonly cap?: unknown;
  readonly scope?: unknown;
  readonly reason?: unknown;
  readonly status?: unknown;
  readonly submittedAt?: unknown;
  readonly decidedBy?: unknown;
  readonly decisionSource?: unknown;
}

export const approvalsCommand: Command = {
  name: 'approvals',
  summary: '查看审批台账(缺省 pending;--all 全量)',
  usage: 'neoba approvals [--all] [--state-dir DIR] [--json]',
  async run(args, { io, deps }) {
    const { flags } = parseArgs(args, ['state-dir']);
    const asJson = flagBool(flags, 'json');
    const all = flagBool(flags, 'all');
    const stateDir = flagString(flags, 'state-dir') ?? join(deps.homedir(), '.neoba');

    const endpoint = await connectOrExplain(deps, io, stateDir);
    if (endpoint === null) return 1;
    const outcome = await rpcCall<{ approvals?: ApprovalRecordLike[] }>(deps, endpoint, 'approvals.list', {
      status: all ? 'all' : 'pending',
    });
    if (!outcome.ok) {
      io.err(`neoba approvals: [${outcome.code}] ${outcome.message}`);
      return 1;
    }
    const approvals = outcome.result.approvals ?? [];
    if (asJson) {
      io.out(JSON.stringify({ approvals }, null, 2));
      return 0;
    }
    if (approvals.length === 0) {
      io.out(all ? '审批台账为空' : '没有待定案的审批单');
      return 0;
    }
    for (const record of approvals) {
      const line = [
        String(record.reqId ?? '?'),
        String(record.status ?? '?'),
        `${String(record.cap ?? '?')}:${String(record.scope ?? '?')}`,
        String(record.agentId ?? '?'),
        `by=${String(record.decidedBy ?? '-')}`,
        String(record.reason ?? ''),
      ].join('  ');
      io.out(line);
    }
    io.out(`共 ${approvals.length} 条(${all ? '全量' : '待定案'});定案:neoba approve|deny <req_id>`);
    return 0;
  },
};
