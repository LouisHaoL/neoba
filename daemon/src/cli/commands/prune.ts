/**
 * neoba prune:工件仓库孤儿清理(接 CAS 的 reconcile/prune)。
 * 默认 dry-run:只对账并列出将删对象,不动磁盘;--yes 才真正删除。
 * --plan:打印自动 GC 计划(到期 manifest + 孤儿对象),只决策不执行(M5);
 * 终态判定从事件日志重放重建任务表,读不到日志则一律按非终态保守处理。
 */

import { join } from 'node:path';

import { EventLog } from '../../events/index.ts';
import { replayTasks } from '../../daemon/tasks.ts';
import { isTerminalStatus, planArtifactGc } from '../../artifacts/index.ts';
import { flagBool, flagString, parseArgs } from '../args.ts';
import type { Command } from '../types.ts';

export const pruneCommand: Command = {
  name: 'prune',
  summary: '工件仓库孤儿对象清理(默认 dry-run,--yes 才删;--plan 打印自动 GC 计划)',
  usage: 'neoba prune [--state-dir DIR] [--plan] [--yes]',
  async run(args, { io, deps }) {
    const { flags } = parseArgs(args, ['state-dir']);
    const yes = flagBool(flags, 'yes');
    const planOnly = flagBool(flags, 'plan');
    const stateDir =
      flagString(flags, 'state-dir') ?? join(deps.homedir(), '.neoba');
    const repo = await deps.openRepository(join(stateDir, 'artifacts'));
    try {
      if (planOnly) {
        // 自动 GC 计划(dry-run,只打印不删)。终态判定:重放事件日志重建
        // 任务表;事件日志读不到/为空 → 全部按非终态保守处理(永不判到期)。
        if (repo.listManifests === undefined || repo.listObjects === undefined) {
          io.err('neoba prune --plan: 注入的仓库不支持 listManifests/listObjects,无法出计划');
          return 2;
        }
        const tasks = await replayTaskStore(stateDir);
        const plan = planArtifactGc({
          manifests: await repo.listManifests(),
          objects: await repo.listObjects(),
          now: new Date().toISOString(),
          isTerminal: (taskId) => {
            const record = tasks?.get(taskId);
            return record !== undefined && isTerminalStatus(record.status);
          },
        });
        const lines = [
          `neoba prune --plan(自动 GC 计划,未执行): ` +
            `manifests=${plan.scannedManifests} objects=${plan.scannedObjects} ` +
            `inUse=${plan.inUseObjects}`,
        ];
        if (plan.expiredManifests.length === 0) {
          lines.push('没有到期可删的 manifest(forever / 非终态 / 未到期)');
        } else {
          lines.push(`将删除 manifest ${plan.expiredManifests.length} 个(days 到期且任务终态):`);
          for (const id of plan.expiredManifests) lines.push(`  ${id}`);
          lines.push('  (其对象本轮不动,删后变孤儿,下轮再被清扫)');
        }
        if (plan.orphanedObjects.length === 0) {
          lines.push('没有孤儿对象');
        } else {
          lines.push(`将清扫孤儿对象 ${plan.orphanedObjects.length} 个:`);
          for (const sha of plan.orphanedObjects) lines.push(`  ${sha}`);
        }
        io.out(lines.join('\n'));
        return 0;
      }

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

/** 重放事件日志重建任务表(终态判定用);任何失败都返回 null(保守不删)。 */
async function replayTaskStore(
  stateDir: string,
): Promise<ReturnType<typeof replayTasks> | null> {
  try {
    const events = await EventLog.open(join(stateDir, 'events'));
    try {
      const replayed = [];
      for await (const ev of events.replay()) replayed.push(ev);
      return replayTasks(replayed);
    } finally {
      await events.close().catch(() => {});
    }
  } catch {
    return null;
  }
}
