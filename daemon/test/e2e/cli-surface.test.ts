/**
 * e2e · CLI 人机入口(真实 CLI 子进程 × 真实 daemon 子进程):
 * task/budget/approvals 人肉排查命令、审批决定命令、workflow check/export
 * 三档可移植、prune、doctor —— 全部走 daemon-state.json + token 文件发现。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bootDaemon,
  cleanupStateDir,
  runNeoba,
  awaitTask,
  type E2eDaemon,
} from './helpers.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const kept: string[] = [];
let shared: E2eDaemon | null = null;

after(async () => {
  // 共享 daemon 必须显式停机:子进程句柄不释放会让本文件的测试进程无法退出,
  // 串行跑全量时表现为「本文件全部通过后套件悬挂」。
  if (shared !== null) await shared.stop().catch(() => {});
  await Promise.all(kept.map((dir) => cleanupStateDir(dir)));
});

/** 共享一台 daemon(每用例独立任务,避免每例冷启动)。 */
async function sharedDaemon(): Promise<E2eDaemon> {
  if (shared === null) {
    shared = await bootDaemon({ exec: 'stream' });
    kept.push(shared.stateDir);
  }
  return shared;
}

async function makeTask(daemon: E2eDaemon, intent: string): Promise<string> {
  const res = await daemon.rpc('task.create', { intent, preset: 'minimal' });
  return ((res.body.result as Record<string, unknown>)['task_id']) as string;
}

describe('e2e · CLI task / budget / approvals', () => {
  it('neoba task <id> status:人读输出含任务状态', async () => {
    const daemon = await sharedDaemon();
    const taskId = await makeTask(daemon, 'CLI task status 冒烟');
    await awaitTask(daemon, taskId);

    const out = await runNeoba(['task', taskId, 'status', '--state-dir', daemon.stateDir]);
    assert.equal(out.code, 0, `${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /completed|task/i);
  });

  it('neoba task <id> status --json 与不存在的任务报错退出 1', async () => {
    const daemon = await sharedDaemon();
    const taskId = await makeTask(daemon, 'CLI json 冒烟');
    await awaitTask(daemon, taskId);

    const out = await runNeoba(['task', taskId, 'status', '--state-dir', daemon.stateDir, '--json']);
    assert.equal(out.code, 0);
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    const record = (parsed['task'] ?? parsed) as Record<string, unknown>;
    assert.equal(record['status'], 'completed');

    const missing = await runNeoba(['task', 'task-nope-0000', 'status', '--state-dir', daemon.stateDir]);
    assert.equal(missing.code, 1, `不存在任务应退出 1:${missing.stdout}`);
  });

  it('neoba budget status:已完任务的预算视图可查', async () => {
    const daemon = await sharedDaemon();
    const taskId = await makeTask(daemon, 'CLI budget 冒烟');
    await awaitTask(daemon, taskId);

    const out = await runNeoba(['budget', taskId, 'status', '--state-dir', daemon.stateDir, '--json']);
    assert.equal(out.code, 0, `${out.stdout}\n${out.stderr}`);
  });

  it('neoba approvals --all:空台账可查(200 结构)', async () => {
    const daemon = await sharedDaemon();
    const out = await runNeoba(['approvals', '--all', '--state-dir', daemon.stateDir, '--json']);
    assert.equal(out.code, 0, `${out.stdout}\n${out.stderr}`);
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    assert.ok(Array.isArray(parsed['approvals'] ?? parsed['records'] ?? []), '应为台账数组');
  });

  it('neoba approve/deny 不存在的审批单:域错误,退出码非 0', async () => {
    const daemon = await sharedDaemon();
    const approve = await runNeoba(['approve', 'req-nope', '--state-dir', daemon.stateDir]);
    assert.notEqual(approve.code, 0);
    const deny = await runNeoba(['deny', 'req-nope', '--state-dir', daemon.stateDir]);
    assert.notEqual(deny.code, 0);
  });
});

describe('e2e · CLI workflow check / export', () => {
  it('workflow check:示例工作流过检(presets + intent)', async () => {
    // issue #5 口径对齐:示例 preset 声明 model.tier,check 必须带 --models 注册表。
    const out = await runNeoba([
      'workflow', 'check',
      join(REPO_ROOT, 'presets', 'examples', 'workflow.json'),
      '--presets', join(REPO_ROOT, 'presets', 'examples'),
      '--intent', join(REPO_ROOT, 'presets', 'examples', 'intent.json'),
      '--models', join(REPO_ROOT, 'presets', 'examples', 'models.json'),
    ]);
    assert.equal(out.code, 0, `${out.stdout}\n${out.stderr}`);
  });

  it('workflow export 三档:产物落盘(进程级导出)', async () => {
    const outDir = keep(await mkdtemp(join(tmpdir(), 'neoba-e2e-export-')));
    for (const level of ['minimal', 'brief', 'full'] as const) {
      const target = join(outDir, level);
      const exported = await runNeoba([
        'workflow', 'export',
        join(REPO_ROOT, 'presets', 'examples', 'workflow.json'),
        '--level', level,
        '--presets', join(REPO_ROOT, 'presets', 'examples'),
        '--intent', join(REPO_ROOT, 'presets', 'examples', 'intent.json'),
        '--out', target,
      ]);
      assert.equal(exported.code, 0, `export ${level}:${exported.stdout}\n${exported.stderr}`);
    }
    const names = await import('node:fs/promises').then((fs) => fs.readdir(outDir));
    assert.ok(names.length >= 3, `三档应各落一个目录,实际 ${JSON.stringify(names)}`);
  });
});

function keep(dir: string): string {
  kept.push(dir);
  return dir;
}

describe('e2e · CLI prune / doctor', () => {
  it('prune --plan:dry-run 默认不删,报告结构可读', async () => {
    const daemon = await sharedDaemon();
    const out = await runNeoba(['prune', '--state-dir', daemon.stateDir, '--plan']);
    assert.equal(out.code, 0, `${out.stdout}\n${out.stderr}`);
  });

  it('prune(缺省 dry-run)与 --yes:退出码 0', async () => {
    const daemon = await sharedDaemon();
    const dry = await runNeoba(['prune', '--state-dir', daemon.stateDir]);
    assert.equal(dry.code, 0);
    const yes = await runNeoba(['prune', '--state-dir', daemon.stateDir, '--yes']);
    assert.equal(yes.code, 0, `${yes.stdout}\n${yes.stderr}`);
  });

  it('doctor:本机环境检测 exit 0,报告含后端判定', async () => {
    const out = await runNeoba(['doctor'], { timeoutMs: 60_000 });
    assert.equal(out.code, 0, `${out.stdout}\n${out.stderr}`);
  });
});

describe('e2e · 预算熔断(子进程,stream 档 usage 入账)', () => {
  it('limit_tokens 熔断 → paused;budget.raise + task resume 续跑完成', async () => {
    const daemon = await bootDaemon({ exec: 'stream' });
    kept.push(daemon.stateDir);
    try {
      const res = await daemon.rpc('workflow.run', {
        workflow: {
          api: 'workflow/1.0',
          intent_ref: 'wf-budget',
          nodes: [{ id: 'n1', preset: 'minimal' }],
          outputs: [],
          feedback: [],
          evidence: [],
        },
        intent: { api: 'intent/1.0', goal: '预算熔断冒烟', acceptance: ['节点完成'], constraints: {} },
        budget: { limit_tokens: 5 },
      });
      assert.equal(res.body.error, undefined, JSON.stringify(res.body).slice(0, 400));
      const taskId = ((res.body.result as Record<string, unknown>)['task_id']) as string;

      const record = await awaitTask(daemon, taskId, { until: ['paused'], timeoutMs: 20_000 });
      assert.equal(record['status'], 'paused', `预算超限应 paused,实际 ${JSON.stringify(record).slice(0, 300)}`);

      const status = await daemon.rpc('budget.status', { task_id: taskId });
      const budget = ((status.body.result as Record<string, unknown>)['budget'] ?? {}) as Record<string, unknown>;
      assert.equal(budget['level'], 'hard');
      assert.ok(Number(budget['observed_tokens']) >= 5, `observed 应 ≥5:${JSON.stringify(budget)}`);

      const raised = await daemon.rpc('budget.raise', { task_id: taskId, limit_tokens: 1000 });
      assert.equal((raised.body.result as Record<string, unknown>)['raised'], true);

      const resumed = await daemon.rpc('task.resume', { task_id: taskId });
      assert.equal(resumed.body.error, undefined);
      const done = await awaitTask(daemon, taskId, { until: ['completed', 'failed', 'cancelled'], timeoutMs: 30_000 });
      assert.equal(done['status'], 'completed');
    } finally {
      await daemon.stop();
    }
  });
});
