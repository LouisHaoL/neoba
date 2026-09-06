/**
 * 工件自动 GC 测试(M5,plan/collect 分离):
 * 1. retention 解析边界(forever / days 合法区间 / days=0 / 负数 / 非数字 / 缺字段 / 未知 mode)
 * 2. plan 纯决策:孤儿判定(in-use = 全部指针可达集)、days 到期 × 任务终态矩阵
 * 3. collect:孤儿清扫、到期 manifest 删除(对象留给下轮)、forever/非终态不删
 * 4. 非法 retention(盘上脏值)按 forever 处理,读路径不炸
 * 5. artifact.gc 事件落盘(payload = plan 摘要)
 * 6. collect 对损坏 manifest / 损坏对象容错
 * 7. 竞态防线(#13):孤儿删除前二次复核、deleteManifest 带期望版本、并发重发布不盲删
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  ArtifactRepository,
  RETAIN_FOREVER,
  collectArtifactGc,
  parseRetentionPolicy,
  planArtifactGc,
  retentionFromDiskValue,
  serializeRetentionPolicy,
  NotPublished,
} from '../../src/artifacts/index.ts';
import type { GcPlanInput, ManifestListing } from '../../src/artifacts/index.ts';
import { EventLog } from '../../src/events/index.ts';
import type { Event } from '../../src/events/index.ts';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeRepo(
  options: Parameters<typeof ArtifactRepository.open>[1] = {},
): Promise<{ root: string; repo: ArtifactRepository }> {
  const root = await mkdtemp(join(tmpdir(), 'neoba-gc-'));
  roots.push(root);
  const repo = await ArtifactRepository.open(root, options);
  return { root, repo };
}

const ns = { tenant: 'acme', task: 'task-1' };

/** 直接改盘上 manifest 指针:回拨发布时间 / 篡改 retention 落盘值。 */
async function pokeManifest(
  root: string,
  tenant: string,
  task: string,
  node: string,
  name: string,
  patch: { readonly ageDays?: number; readonly retention?: string | null },
): Promise<void> {
  const pointer = join(root, 'manifests', tenant, task, node, name);
  const manifest = JSON.parse(await readFile(pointer, 'utf8')) as Record<string, unknown>;
  if (patch.ageDays !== undefined) {
    manifest['publishedAt'] = new Date(
      Date.parse(String(manifest['publishedAt'])) - patch.ageDays * 86_400_000,
    ).toISOString();
  }
  if (patch.retention !== undefined) manifest['retention'] = patch.retention;
  await writeFile(pointer, JSON.stringify(manifest));
}

function listing(partial: Partial<ManifestListing>): ManifestListing {
  return {
    id: partial.id ?? 't/task/n/x',
    tenant: partial.tenant ?? 't',
    task: partial.task ?? 'task',
    node: partial.node ?? 'n',
    name: partial.name ?? 'x',
    version: partial.version ?? 1,
    publishedAt: partial.publishedAt ?? new Date().toISOString(),
    retention: partial.retention ?? null,
    objects: partial.objects ?? [],
  };
}

function planInput(
  partial: Partial<GcPlanInput>,
): GcPlanInput {
  return {
    manifests: partial.manifests ?? [],
    objects: partial.objects ?? [],
    now: partial.now ?? new Date().toISOString(),
    isTerminal: partial.isTerminal ?? (() => false),
  };
}

const DAY = 86_400_000;

// ---------------------------------------------------------------- retention 解析

describe('retention 解析(daemon 侧行为定型)', () => {
  it('合法值:forever / days 整数 >= 1', () => {
    assert.deepEqual(parseRetentionPolicy(undefined), {
      policy: RETAIN_FOREVER,
      warnings: [],
    });
    // 缺省(null)是合法的 forever,不告警。
    assert.deepEqual(parseRetentionPolicy(null), { policy: RETAIN_FOREVER, warnings: [] });
    assert.deepEqual(parseRetentionPolicy({ mode: 'forever' }), {
      policy: RETAIN_FOREVER,
      warnings: [],
    });
    assert.deepEqual(parseRetentionPolicy({ mode: 'days', days: 7 }), {
      policy: { mode: 'days', days: 7 },
      warnings: [],
    });
    assert.deepEqual(parseRetentionPolicy({ mode: 'days', days: 1 }), {
      policy: { mode: 'days', days: 1 },
      warnings: [],
    });
  });

  it('越界与类型非法一律降级 forever + warning', () => {
    for (const bad of [
      { mode: 'days', days: 0 }, // days=0
      { mode: 'days', days: -3 }, // 负数
      { mode: 'days', days: 1.5 }, // 非整数
      { mode: 'days', days: '7' }, // 非数字
      { mode: 'days' }, // 缺字段
      { mode: 'week' }, // 未知 mode
      {},
      'days',
      42,
      true,
    ]) {
      const result = parseRetentionPolicy(bad);
      assert.deepEqual(result.policy, RETAIN_FOREVER, JSON.stringify(bad));
      assert.ok(result.warnings.length === 1, `${JSON.stringify(bad)} 应有一条告警`);
    }
  });

  it('落盘值往返;null = 未声明不告警;脏值降级 + 告警', () => {
    assert.deepEqual(retentionFromDiskValue(null), {
      policy: RETAIN_FOREVER,
      warnings: [],
    });
    assert.deepEqual(retentionFromDiskValue('forever'), {
      policy: RETAIN_FOREVER,
      warnings: [],
    });
    assert.deepEqual(retentionFromDiskValue('days:30'), {
      policy: { mode: 'days', days: 30 },
      warnings: [],
    });
    assert.equal(serializeRetentionPolicy({ mode: 'days', days: 30 }), 'days:30');
    assert.equal(serializeRetentionPolicy(RETAIN_FOREVER), 'forever');
    for (const dirty of ['days:0', 'days:-1', 'days:abc', 'weekly', '']) {
      const result = retentionFromDiskValue(dirty);
      assert.deepEqual(result.policy, RETAIN_FOREVER, dirty);
      assert.ok(result.warnings.length === 1, `${dirty} 应有一条告警`);
    }
  });
});

// ---------------------------------------------------------------- publish 透传

describe('publish retention 透传(非法降级 + 告警)', () => {
  it('合法 days 策略落盘并可读回;非法值降级 forever 且 PublishResult 带告警', async () => {
    const warnings: string[] = [];
    const { repo } = await makeRepo({ onWarning: (m) => warnings.push(m) });

    await repo.publish(ns, 'n', 'keep', 'body', { retention: { mode: 'days', days: 3 } });
    const keep = await repo.resolve(ns, 'n', 'keep');
    assert.deepEqual(keep?.retention, { mode: 'days', days: 3 });

    const bad = await repo.publish(ns, 'n', 'oops', 'body', {
      retention: { mode: 'days', days: 0 },
    });
    assert.ok(bad.retentionWarnings && bad.retentionWarnings.length === 1);
    const oops = await repo.resolve(ns, 'n', 'oops');
    assert.deepEqual(oops?.retention, RETAIN_FOREVER); // 降级 forever,不抛
    assert.equal(warnings.length, 1); // onWarning 钩子收到同一条告警

    // 未声明 retention:读回 null(旧数据形态),语义 = forever。
    await repo.publish(ns, 'n', 'plain', 'body');
    assert.equal((await repo.resolve(ns, 'n', 'plain'))?.retention, null);
  });
});

// ---------------------------------------------------------------- plan(纯决策)

describe('GC plan(纯决策,可 dry-run)', () => {
  it('孤儿 = 在盘对象 − 全部 manifest 指针可达集', () => {
    const plan = planArtifactGc(planInput({
      manifests: [
        listing({ objects: ['aa', 'bb'] }),
        listing({ id: 't/task/n/y', objects: ['cc'] }),
      ],
      objects: ['aa', 'cc', 'dd', 'ee'],
    }));
    assert.equal(plan.scannedManifests, 2);
    assert.equal(plan.scannedObjects, 4);
    assert.equal(plan.inUseObjects, 3);
    assert.deepEqual(plan.orphanedObjects, ['dd', 'ee']);
    assert.deepEqual(plan.expiredManifests, []);
  });

  it('days 到期 × 任务终态矩阵:只有「到期且终态」可删', () => {
    const old = new Date(Date.now() - 10 * DAY).toISOString();
    const manifests = [
      listing({ id: 't/old-terminal/n/x', task: 'old-terminal', publishedAt: old, retention: { mode: 'days', days: 7 }, objects: ['a'] }),
      listing({ id: 't/old-running/n/x', task: 'old-running', publishedAt: old, retention: { mode: 'days', days: 7 }, objects: ['b'] }),
      listing({ id: 't/old-forever/n/x', task: 'old-terminal', publishedAt: old, retention: RETAIN_FOREVER, objects: ['c'] }),
      listing({ id: 't/old-null/n/x', task: 'old-terminal', publishedAt: old, retention: null, objects: ['d'] }),
      listing({ id: 't/new-terminal/n/x', task: 'new-terminal', retention: { mode: 'days', days: 7 }, objects: ['e'] }),
    ];
    const terminal = new Set(['old-terminal', 'new-terminal', 'old-forever', 'old-null']);
    const plan = planArtifactGc(planInput({
      manifests,
      objects: ['a', 'b', 'c', 'd', 'e', 'orphan'],
      isTerminal: (taskId) => terminal.has(taskId),
    }));
    assert.deepEqual(plan.expiredManifests, ['t/old-terminal/n/x']);
    // 本轮待删 manifest 引用的对象仍是 in-use(下轮才变孤儿可扫)。
    assert.deepEqual(plan.orphanedObjects, ['orphan']);
  });

  it('未知任务保守按非终态;时间戳坏保守不删', () => {
    const old = new Date(Date.now() - 100 * DAY).toISOString();
    const plan = planArtifactGc(planInput({
      manifests: [
        listing({ id: 't/ghost/n/x', task: 'ghost-task', publishedAt: old, retention: { mode: 'days', days: 1 } }),
        listing({ id: 't/badts/n/x', task: 'badts', publishedAt: 'not-a-timestamp', retention: { mode: 'days', days: 1 } }),
      ],
      isTerminal: () => false,
    }));
    assert.deepEqual(plan.expiredManifests, []);
  });
});

// ---------------------------------------------------------------- collect(执行)

describe('GC collect(执行 + 事件落盘)', () => {
  it('孤儿清扫:指针已删的对象变孤儿,collect 清掉,在用对象不受影响', async () => {
    const { repo } = await makeRepo();
    await repo.publish(ns, 'n', 'live', 'live-body');
    await repo.publish(ns, 'n', 'doomed', 'doomed-body');
    assert.ok(await repo.deleteManifest('acme/task-1/n/doomed'));

    // doomed 指针已删 → doomed-body 已无指针可达 → 本轮即被清扫。
    const first = await collectArtifactGc(repo, { isTerminal: () => true });
    assert.equal(first.plan.orphanedObjects.length, 1);
    assert.equal(first.removedManifests, 0);
    assert.equal(first.removedObjects, 1);
    await assert.doesNotReject(repo.read(ns, 'n', 'live'));

    // 第二轮:干净状态,无删除。
    const second = await collectArtifactGc(repo, { isTerminal: () => true });
    assert.equal(second.plan.orphanedObjects.length, 0);
    assert.equal(second.removedObjects, 0);
  });

  it('days 到期且任务终态:manifest 被删,其对象留给下一轮', async () => {
    const { root, repo } = await makeRepo();
    await repo.publish(ns, 'n', 'expired', 'old-body', { retention: { mode: 'days', days: 7 } });
    await pokeManifest(root, ns.tenant, ns.task, 'n', 'expired', { ageDays: 10 });
    await repo.publish(ns, 'n', 'fresh', 'new-body', { retention: { mode: 'days', days: 7 } });

    let rounds = 0;
    const terminalTasks = new Set([ns.task]);
    const first = await collectArtifactGc(repo, {
      isTerminal: (taskId) => terminalTasks.has(taskId),
      emit: () => {
        rounds += 1;
      },
    });
    assert.deepEqual(first.plan.expiredManifests, ['acme/task-1/n/expired']);
    assert.equal(first.removedManifests, 1);
    assert.equal(first.removedObjects, 0); // old-body 本轮仍在用(指针在时算的 in-use)
    // 指针已删:读路径按「从未发布」报错(交付通道随 GC 收口),但对象本轮不动。
    await assert.rejects(repo.read(ns, 'n', 'expired'), NotPublished);
    await assert.doesNotReject(repo.read(ns, 'n', 'fresh')); // 未到期不删

    // 第二轮:old-body 变孤儿被扫,expired 读路径随之 NotPublished(仓库层报错)。
    const second = await collectArtifactGc(repo, {
      isTerminal: (taskId) => terminalTasks.has(taskId),
      emit: () => {
        rounds += 1;
      },
    });
    assert.equal(second.removedObjects, 1);
    assert.equal(rounds, 2); // 每轮各落一个事件(由 emit 计数验证)
    const ref = await repo.resolve(ns, 'n', 'expired');
    assert.equal(ref, null); // 指针已删
  });

  it('forever 不删;非终态不删;非法 retention(days=0 落盘)按 forever', async () => {
    const { root, repo } = await makeRepo();
    await repo.publish(ns, 'n', 'forever-art', 'keep-me', { retention: RETAIN_FOREVER });
    // 非终态任务用独立 task 段,避免与终态闸共用命名空间混淆。
    const runningNs = { tenant: ns.tenant, task: 'task-running' };
    await repo.publish(runningNs, 'n', 'running-art', 'still-running', { retention: { mode: 'days', days: 1 } });
    await repo.publish(ns, 'n', 'dirty-art', 'dirty-retention');
    await pokeManifest(root, ns.tenant, ns.task, 'n', 'forever-art', { ageDays: 100 });
    await pokeManifest(root, runningNs.tenant, runningNs.task, 'n', 'running-art', { ageDays: 100 });
    await pokeManifest(root, ns.tenant, ns.task, 'n', 'dirty-art', { ageDays: 100, retention: 'days:0' });

    const terminal = new Set([ns.task]);
    const result = await collectArtifactGc(repo, {
      isTerminal: (taskId) => terminal.has(taskId),
    });
    assert.deepEqual(result.plan.expiredManifests, []); // forever / 非终态 / 脏值 全不删
    assert.equal(result.removedManifests, 0);
    await assert.doesNotReject(repo.read(ns, 'n', 'forever-art'));
    await assert.doesNotReject(repo.read(runningNs, 'n', 'running-art'));
    await assert.doesNotReject(repo.read(ns, 'n', 'dirty-art'));
  });

  it('artifact.gc 事件落盘,payload 带 plan 摘要', async () => {
    const { repo } = await makeRepo();
    const eventsRoot = await mkdtemp(join(tmpdir(), 'neoba-gc-events-'));
    roots.push(eventsRoot);
    const events = await EventLog.open(join(eventsRoot, 'events'));
    await repo.publish(ns, 'n', 'doc', 'body');
    await repo.deleteManifest('acme/task-1/n/doc');

    await collectArtifactGc(repo, {
      isTerminal: () => true,
      emit: (input) => events.append(input),
      principal: { tenant: 'acme', session: null, task: null, agent: null },
    });
    await events.close();

    const reopened = await EventLog.open(join(eventsRoot, 'events'));
    const seen: Event[] = [];
    for await (const ev of reopened.replay()) seen.push(ev);
    await reopened.close();
    const gcEvents = seen.filter((ev) => ev.type === 'artifact.gc');
    assert.equal(gcEvents.length, 1);
    const gc = gcEvents[0];
    assert.ok(gc);
    assert.deepEqual(gc.principal, { tenant: 'acme', session: null, task: null, agent: null });
    const payload = gc.payload as unknown as Record<string, unknown>;
    assert.equal(payload['scanned'], 0); // 指针已删,下轮扫描为 0
    assert.equal(payload['orphaned'], 1);
    assert.equal(payload['removedObjects'], 1);
    assert.equal(payload['removedManifests'], 0);
  });

  it('容错:损坏 manifest 指针 / 损坏对象字节都不炸 collect', async () => {
    const { root, repo } = await makeRepo();
    await repo.publish(ns, 'n', 'good', 'good-body');
    await repo.publish(ns, 'n', 'broken-pointer', 'x');
    // 损坏指针:JSON 垃圾(目录布局内)。
    await writeFile(
      join(root, 'manifests', ns.tenant, ns.task, 'n', 'broken-pointer'),
      '{{{not-json',
    );
    // 杂散文件(不在四段布局上)。
    await mkdir(join(root, 'manifests', 'stray'), { recursive: true });
    await writeFile(join(root, 'manifests', 'stray', 'junk'), 'junk');
    // 损坏孤儿对象:命名合法但字节与名不符 → 按名判定孤儿,照删不读字节。
    const fakeSha = 'dead' + 'ab'.repeat(30);
    await mkdir(join(root, 'objects', 'de', 'ad'), { recursive: true });
    await writeFile(join(root, 'objects', 'de', 'ad', fakeSha), 'corrupt');
    // 在用对象被篡改:不影响 GC 决策(仍不删,留给 verify 报)。
    const sha = (await repo.resolve(ns, 'n', 'good'))?.rootSha256;
    assert.ok(sha);

    const result = await collectArtifactGc(repo, {
      isTerminal: () => true,
      emit: () => {}, // 发射通道不炸也要能跑通
    });
    assert.equal(result.plan.scannedManifests, 1); // 损坏指针被跳过
    assert.equal(result.removedManifests, 0);
    assert.ok(result.plan.orphanedObjects.length >= 1); // 篡改的孤儿对象按名清扫
    await assert.doesNotReject(repo.read(ns, 'n', 'good'));
  });
});

// ---------------------------------------------------------------- 竞态防线(#13)

describe('GC 竞态防线(#13):二次复核 + 版本校验', () => {
  it('「对象已落盘、指针未落」窗口:plan 快照后指针落下,复核救回不误删', async () => {
    const { repo } = await makeRepo();
    // 造历史孤儿:发布后删指针,对象留在 CAS(等待被 dedup 复用)。
    const victim = await repo.publish(ns, 'n', 'victim', 'race-body');
    assert.ok(await repo.deleteManifest('acme/task-1/n/victim'));

    // 包一层 listManifests:第一次扫描(plan 快照)返回时指针尚未落;
    // 随后模拟 publish 的「rename 指针」落地(dedup 路径复用盘上孤儿对象)。
    // recheckOrphans 走仓库内部重扫,不受此包装影响 —— 恰好构成竞态窗口。
    const baseList = repo.listManifests.bind(repo);
    let scanned = false;
    repo.listManifests = async () => {
      const listings = await baseList();
      if (!scanned) {
        scanned = true;
        await repo.publish(
          { tenant: ns.tenant, task: 'task-2' },
          'n',
          'rescued',
          'race-body',
        );
      }
      return listings;
    };

    const result = await collectArtifactGc(repo, { isTerminal: () => true });
    // plan 仍按快照判它孤儿,但删除前复核发现指针已可达 → 救回,不删。
    assert.deepEqual(result.plan.orphanedObjects, [victim.rootSha256]);
    assert.equal(result.rescuedObjects, 1);
    assert.equal(result.removedObjects, 0);
    const ns2 = { tenant: ns.tenant, task: 'task-2' };
    assert.equal(
      (await repo.resolve(ns2, 'n', 'rescued'))?.rootSha256,
      victim.rootSha256,
    );
    await assert.doesNotReject(repo.read(ns2, 'n', 'rescued'));
  });

  it('prune 两轮确认:reconcile 快照后指针落下,复核救回不删', async () => {
    const { repo } = await makeRepo();
    const victim = await repo.publish(ns, 'n', 'victim', 'prune-race');
    assert.ok(await repo.deleteManifest('acme/task-1/n/victim'));

    // 包一层 reconcile:对账快照返回后,模拟 publish 落下引用该对象的新指针。
    const baseReconcile = repo.reconcile.bind(repo);
    repo.reconcile = async () => {
      const report = await baseReconcile();
      await repo.publish(
        { tenant: ns.tenant, task: 'task-2' },
        'n',
        'rescued',
        'prune-race',
      );
      return report;
    };

    const removed = await repo.prune();
    assert.deepEqual(removed, []); // 待删名单里的对象被第二轮复核救回
    const ns2 = { tenant: ns.tenant, task: 'task-2' };
    assert.equal(
      (await repo.resolve(ns2, 'n', 'rescued'))?.rootSha256,
      victim.rootSha256,
    );
    await assert.doesNotReject(repo.read(ns2, 'n', 'rescued'));
  });

  it('collect:plan 快照后到期路径被并发重发布,带期望版本跳过删除', async () => {
    const { root, repo } = await makeRepo();
    await repo.publish(ns, 'n', 'exp', 'old-body', {
      retention: { mode: 'days', days: 7 },
    });
    await pokeManifest(root, ns.tenant, ns.task, 'n', 'exp', { ageDays: 10 });

    // 包一层 listManifests:plan 拿到的是 version 1 的过期快照;
    // 快照返回后模拟并发 publish 落下 version 2 新指针。
    const baseList = repo.listManifests.bind(repo);
    let scanned = false;
    repo.listManifests = async () => {
      const listings = await baseList();
      if (!scanned) {
        scanned = true;
        await repo.publish(ns, 'n', 'exp', 'new-body', {
          retention: { mode: 'days', days: 7 },
        });
      }
      return listings;
    };

    const result = await collectArtifactGc(repo, { isTerminal: () => true });
    // 期望 version 1 ≠ 盘上 version 2 → deleteManifest 跳过,新指针未被盲删。
    assert.deepEqual(result.plan.expiredManifests, ['acme/task-1/n/exp']);
    assert.equal(result.removedManifests, 0);
    const ref = await repo.resolve(ns, 'n', 'exp');
    assert.equal(ref?.version, 2);
    await assert.doesNotReject(repo.read(ns, 'n', 'exp'));
  });

  it('deleteManifest 带版本校验:期望不匹配跳过,全匹配才删', async () => {
    const { repo } = await makeRepo();
    await repo.publish(ns, 'n', 'doc', 'v1');
    const first = await repo.resolve(ns, 'n', 'doc');
    assert.equal(first?.version, 1);
    await repo.publish(ns, 'n', 'doc', 'v2'); // 并发重发布 → version 2

    const id = 'acme/task-1/n/doc';
    // 过期快照(version=1)不能删掉新指针。
    assert.equal(
      await repo.deleteManifest(id, {
        expectedVersion: 1,
        expectedPublishedAt: first?.publishedAt,
      }),
      false,
    );
    assert.equal((await repo.resolve(ns, 'n', 'doc'))?.version, 2);
    // version 匹配但 publishedAt 不匹配 → 同样跳过。
    assert.equal(
      await repo.deleteManifest(id, {
        expectedVersion: 2,
        expectedPublishedAt: first?.publishedAt,
      }),
      false,
    );
    assert.equal((await repo.resolve(ns, 'n', 'doc'))?.version, 2);
    // 全匹配 → 正常删除。
    const current = await repo.resolve(ns, 'n', 'doc');
    assert.ok(current);
    assert.equal(
      await repo.deleteManifest(id, {
        expectedVersion: current.version,
        expectedPublishedAt: current.publishedAt,
      }),
      true,
    );
    assert.equal(await repo.resolve(ns, 'n', 'doc'), null);
  });

  it('deleteManifest 带期望但指针损坏/已消失:保守跳过;不带期望保持幂等盲删', async () => {
    const { root, repo } = await makeRepo();
    await repo.publish(ns, 'n', 'doc', 'body');
    const pointer = join(root, 'manifests', ns.tenant, ns.task, 'n', 'doc');
    await writeFile(pointer, '{{{not-json'); // 指针损坏,无法比对版本

    // 带期望:比对不了就保守跳过,绝不盲删。
    assert.equal(
      await repo.deleteManifest('acme/task-1/n/doc', { expectedVersion: 1 }),
      false,
    );
    // 不带期望:保持旧语义(手工运维路径),损坏指针也按幂等盲删。
    assert.equal(await repo.deleteManifest('acme/task-1/n/doc'), true);
    // 已消失的路径:带期望返回 false(幂等),不带期望同样 false。
    assert.equal(
      await repo.deleteManifest('acme/task-1/n/doc', { expectedVersion: 1 }),
      false,
    );
    assert.equal(await repo.deleteManifest('acme/task-1/n/doc'), false);
  });
});
