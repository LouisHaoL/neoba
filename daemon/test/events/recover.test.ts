/**
 * 恢复对账测试(§6:重放 + 对账,TTL 从落盘时间戳重推导,correction 入同一份日志):
 * 1. ttlDeadline:绝对 ttl / 相对 duration(以落盘 ts 为基准)/ 无 TTL
 * 2. collectInFlight / findExpired:生命周期进出、TTL 过期集合
 * 3. recover + 假 reconciler:对账、correction 落盘、daemon.recovered 收尾
 * 4. 流中未知事件类型:跳过计数,合法事件正常恢复
 * 5. reconciler 报 corrected 但未 emit → 兜底补记
 * 全部使用临时目录。
 */
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  EventLog,
  collectInFlight,
  findExpired,
  recover,
  recoverFromLog,
  ttlDeadline,
  type Event,
  type InFlightResource,
  type Principal,
  type ReconcileContext,
} from '../../src/events/index.ts';

const roots: string[] = [];

async function makeLog() {
  const root = await mkdtemp(join(tmpdir(), 'neoba-recover-'));
  roots.push(root);
  const log = await EventLog.open(root);
  return { root, log };
}

async function collect(log: EventLog): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of log.replay()) out.push(ev);
  return out;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

const agent1: Principal = { tenant: 'acme', session: 'sess-1', task: 'task-42', agent: 'task-42/impl-01' };
const daemonLevel: Principal = { tenant: 'default', session: null, task: null, agent: null };

const NOW = '2026-09-04T18:00:00Z';

async function seedTypicalScenario(log: EventLog): Promise<void> {
  // 容器:sbx-live 仍在跑(无 TTL);sbx-dead 已销毁
  await log.append({
    type: 'sandbox.created',
    principal: agent1,
    payload: { sandboxId: 'sbx-live', backend: 'docker', image: 'neoba-worker:latest' },
    ts: '2026-09-04T17:00:00Z',
  });
  await log.append({
    type: 'sandbox.created',
    principal: agent1,
    payload: { sandboxId: 'sbx-dead', duration: '1h' },
    ts: '2026-09-04T16:00:00Z', // duration 1h → 17:00 到期;已销毁,不在 in-flight
  });
  await log.append({
    type: 'sandbox.destroyed',
    principal: agent1,
    payload: { sandboxId: 'sbx-dead', reason: 'completed' },
    ts: '2026-09-04T16:30:00Z',
  });
  // 授权:绝对 ttl 已过期(17:30 < 18:00)
  await log.append({
    type: 'grant.granted',
    principal: agent1,
    payload: {
      cap: 'mcp:github', scope: 'write', source: 'escalation:req-7',
      ttl: '2026-09-04T17:30:00Z', decisionSource: 'manual:orchestrator',
    },
    ts: '2026-09-04T17:00:00Z',
  });
  // 授权:相对 duration "2h",以落盘 ts 17:30 重推导 → 19:30,未过期
  await log.append({
    type: 'grant.granted',
    principal: agent1,
    payload: {
      cap: 'fs:workdir', scope: 'rw', source: 'baseline',
      duration: '2h', decisionSource: 'auto_rule:baseline',
    },
    ts: '2026-09-04T17:30:00Z',
  });
}

describe('TTL 重推导(ttlDeadline)', () => {
  it('绝对 ttl 直接生效;相对 duration 以事件落盘 ts 为基准;无 TTL 为 null', async () => {
    const { log } = await makeLog();
    const abs = await log.append({
      type: 'grant.granted',
      principal: agent1,
      payload: { cap: 'mcp:github', scope: 'write', source: 'escalation:req-7', ttl: '2026-09-04T18:00:00Z', decisionSource: 'manual:orchestrator' },
      ts: '2026-09-04T17:00:00Z',
    });
    const rel = await log.append({
      type: 'sandbox.created',
      principal: agent1,
      payload: { sandboxId: 'sbx-1', duration: '90m' },
      ts: '2026-09-04T17:00:00Z',
    });
    const none = await log.append({
      type: 'sandbox.created',
      principal: agent1,
      payload: { sandboxId: 'sbx-2' },
      ts: '2026-09-04T17:00:00Z',
    });
    await log.close();

    assert.equal(ttlDeadline(abs), '2026-09-04T18:00:00.000Z');
    assert.equal(ttlDeadline(rel), '2026-09-04T18:30:00.000Z'); // 17:00 + 90m
    assert.equal(ttlDeadline(none), null);
  });
});

describe('in-flight 收集与过期集合', () => {
  it('collectInFlight 跟随生命周期;findExpired 只留 TTL 已过期者', async () => {
    const { log } = await makeLog();
    await seedTypicalScenario(log);

    const inFlight = await collectInFlight(log.replay(), NOW);
    assert.deepEqual(
      inFlight.map((r) => r.key).sort(),
      ['grant:task-42/impl-01:fs:workdir', 'grant:task-42/impl-01:mcp:github', 'sandbox:sbx-live'],
    );

    const expired = await findExpired(log.replay(), NOW);
    // 只有绝对 ttl 过期的 grant;sandbox-live 无 TTL;fs:workdir 的 2h 从 17:30 重推导未到期
    assert.deepEqual(expired.map((r) => r.key), ['grant:task-42/impl-01:mcp:github']);
    assert.equal(expired[0]?.deadline, '2026-09-04T17:30:00.000Z');
    assert.equal(expired[0]?.ttlExpired, true);
    await log.close();
  });
});

describe('recover 对账流程(假 reconciler)', () => {
  it('逐个 in-flight 对账,过期者回收记 correction,daemon.recovered 收尾', async () => {
    const { log } = await makeLog();
    await seedTypicalScenario(log);

    const reconciled: string[] = [];
    const report = await recoverFromLog(log, (ctx: ReconcileContext) => {
      const r: InFlightResource = ctx.resource;
      reconciled.push(r.key);
      if (r.ttlExpired) {
        // TTL 已过期 → 回收(实态),重放态的"仍持有"作废,记 correction
        void ctx.emitCorrection({
          reason: 'ttl_expired_reclaimed',
          expected: 'grant active',
          observed: 'expired at ' + r.deadline, // '…T17:30:00.000Z'
        });
        return { verdict: 'corrected' };
      }
      // 未过期容器查实态:一致
      return { verdict: 'consistent' };
    }, { now: NOW });

    // 重放 5 条(seedTypicalScenario);in-flight 3;过期 1;correction 1
    assert.equal(report.replayed, 5);
    assert.equal(report.inFlight, 3);
    assert.equal(report.expired, 1);
    assert.equal(report.corrected, 1);
    assert.equal(report.skipped, 0);
    // 每个 in-flight 资源都被对账(含无 TTL 的容器)
    assert.equal(reconciled.length, 3);

    const all = await collect(log);
    // 5 条原始 + 1 correction + 1 daemon.recovered
    assert.equal(all.length, 7);
    const correction = all[5];
    assert.equal(correction?.type, 'correction');
    assert.deepEqual(correction?.payload, {
      refSeq: 4,
      target: 'grant:task-42/impl-01:mcp:github',
      reason: 'ttl_expired_reclaimed',
      expected: 'grant active',
      observed: 'expired at 2026-09-04T17:30:00.000Z',
    });
    assert.deepEqual(correction?.principal, agent1); // principal 继承 in-flight 事件

    const recovered = all[6];
    assert.equal(recovered?.type, 'daemon.recovered');
    assert.deepEqual(recovered?.payload, { replayed: 5, inFlight: 3, corrected: 1, expired: 1 });
    await log.close();
  });

  it('reconciler 报 corrected 但未 emit correction → 兜底补记,审计不留空洞', async () => {
    const { log } = await makeLog();
    await log.append({
      type: 'sandbox.created',
      principal: agent1,
      payload: { sandboxId: 'sbx-1' },
      ts: '2026-09-04T17:00:00Z',
    });

    const report = await recover(log.replay(), () => ({ verdict: 'corrected', detail: 'container gone' }), log, {
      now: NOW,
    });
    assert.equal(report.corrected, 1);

    const all = await collect(log);
    const correction = all[1] as Event<'correction'>;
    assert.equal(correction.type, 'correction');
    assert.equal(correction.payload.reason, 'container gone');
    assert.equal(correction.payload.target, 'sandbox:sbx-1');
    assert.equal(all[2]?.type, 'daemon.recovered');
    await log.close();
  });

  it('日志文件中的未知事件类型被跳过(supported 计数),合法事件正常恢复', async () => {
    const { root, log } = await makeLog();
    await log.append({
      type: 'sandbox.created',
      principal: agent1,
      payload: { sandboxId: 'sbx-1' },
      ts: '2026-09-04T17:00:00Z',
    });
    await log.close();
    // 模拟新版本 daemon 写入的、旧版本不认识的事件类型 + 一条合法事件
    const unknownLine = JSON.stringify({
      v: '1.0', seq: 2, ts: NOW,
      type: 'portal.opened', principal: daemonLevel, payload: { whatever: 1 },
    });
    const knownLine = JSON.stringify({
      v: '1.0', seq: 3, ts: NOW,
      type: 'daemon.started', principal: daemonLevel, payload: { pid: 5 },
    });
    await appendFile(join(root, 'events.jsonl'), unknownLine + '\n' + knownLine + '\n');
    const reopened = await EventLog.open(root);

    const skipped: string[] = [];
    const report = await recoverFromLog(reopened, () => ({ verdict: 'consistent' }), {
      now: NOW,
      onSkipped: (info) => skipped.push(info.type),
    });
    assert.deepEqual(skipped, ['portal.opened']);
    assert.equal(report.replayed, 2);
    assert.equal(report.skipped, 1);
    assert.equal(report.inFlight, 1);
    assert.equal(report.corrected, 0);

    const all = await collect(reopened);
    // 2 条原始合法事件(未知行被重放层摘除)+ 1 daemon.recovered
    assert.equal(all.length, 3);
    assert.equal(all[2]?.type, 'daemon.recovered');
    assert.deepEqual(all[2]?.payload, { replayed: 2, inFlight: 1, corrected: 0, expired: 0 });
    await reopened.close();
  });
});
