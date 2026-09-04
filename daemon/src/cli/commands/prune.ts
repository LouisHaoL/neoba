/**
 * neoba prune:工件仓库孤儿清理(接 CAS 的 reconcile/prune)。
 * 默认 dry-run:只对账并列出将删对象,不动磁盘;--yes 才真正删除。
 */

import { join } from 'node:path';

import { flagBool, flagString, parseArgs } from '../args.ts';
import type { Command } from '../types.ts';

export const pruneCommand: Command = {
  name: 'prune',
  summary: '工件仓库孤儿对象清理(默认 dry-run,--yes 才删)',
  usage: 'neoba prune [--state-dir DIR] [--yes]',
  async run(args, { io, deps }) {
    const { flags } = parseArgs(args, ['state-dir']);
    const yes = flagBool(flags, 'yes');
    const stateDir =
      flagString(flags, 'state-dir') ?? join(deps.homedir(), '.neoba');
    const repo = await deps.openRepository(join(stateDir, 'artifacts'));
    try {
      if (!yes) {
        const report = await repo.reconcile();
        const lines = [
          `neoba prune(dry-run): manifests=${report.manifests} objects=${report.objects} missing=${report.missing.length} corrupted=${report.corrupted.length}`,
        ];
        if (report.unreferenced.length === 0) {
          lines.push('没有孤儿对象,无需清理');
        } else {
          lines.push(`将删除孤儿对象 ${report.unreferenced.length} 个:`);
          for (const sha of report.unreferenced) lines.push(`  ${sha}`);
        }
        lines.push('未删除任何对象;确认无误后加 --yes 执行真正删除');
        io.out(lines.join('\n'));
        return 0;
      }

      const removed = await repo.prune();
      const lines =
        removed.length === 0
          ? ['neoba prune: 没有孤儿对象,未删除任何东西']
          : [`neoba prune: 已删除孤儿对象 ${removed.length} 个:`];
      for (const sha of removed) lines.push(`  ${sha}`);
      io.out(lines.join('\n'));
      return 0;
    } finally {
      await repo.close().catch(() => {});
    }
  },
};
