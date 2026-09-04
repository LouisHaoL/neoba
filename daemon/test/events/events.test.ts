/**
 * 事件日志测试(§6 事件溯源 / §3.3 审计同一份):
 * 1. 追加-重放一致(含 reopen 后 seq 续接)
 * 2. seq 单调递增
 * 3. 崩溃截断:末行半行丢弃 + 修剪;末行合法缺换行 → 接受并补封
 * 4. 并发 append 不丢不乱(串行化)
 * 5. 订阅 onEvent(内存转发)与退订
 * 6. readByPrincipal 四层过滤查询
 * 7. 可选分片(shardByTask)与默认单文件
 * 8. 前向兼容:未知字段透传、未知事件类型跳过(onSkipped)
 * 9. 对外错误:未知 type / 已关闭 / 中途损坏
 * 全部使用临时目录。
 */
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  EVENT_LOG_VERSION,
  EventCorrupt,
  EventLog,
  EventLogClosed,
  InvalidEvent,
  shardByTask,
  type Event,
  type EventLogOptions,
  type Principal,
  type ReplayOptions,
} from '../../src/events/index.ts';

const roots: string[] = [];

interface LogFixture {
  root: string;
  log: EventLog;
}

async function makeLog(opts?: EventLogOptions): Promise<LogFixture> {
  const root = await mkdtemp(join(tmpdir(), 'neoba-events-'));
  roots.push(root);
  const log = await EventLog.open(root, opts);
  return { root, log };
}

/** 读默认单文件日志的原始字节。 */
function rawFile(root: string): Promise<Buffer> {
  return readFile(join(root, 'events.jsonl'));
}

async function collect(log: EventLog, opts?: ReplayOptions): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of log.replay(opts)) out.push(ev);
  return out;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

const tenant: Principal = { tenant: 'acme', session: 'sess-1', task: 'task-42', agent: 'task-42/impl-01' };
const taskLevel: Principal = { tenant: 'acme', session: 'sess-1', task: 'task-42', agent: null };
const otherTask: Principal = { tenant: 'acme', session: 'sess-1', task: 'task-7', agent: null };
const daemonLevel: Principal = { tenant: 'default', session: null, task: null, agent: null };

describe('事件日志:追加-重放一致', () => {
  it('append 回填 v/seq/ts,重放逐字段一致;reopen 后 seq 续接', async () => {
    const { root, log } = await makeLog();

    const e1 = await log.append({
      type: 'sandbox.created',
      principal: tenant,
      payload: { sandboxId: 'sbx-1', image: 'neoba-worker:latest', backend: 'docker', duration: '2h' },
    });
    assert.equal(e1.v, EVENT_LOG_VERSION);
    assert.equal(e1.seq, 1);
    assert.match(e1.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(e1.principal, tenant);

    const e2 = await log.append({
      type: 'grant.granted',
      principal: tenant,
      payload: {
        cap: 'mcp:github', scope: 'write', source: 'escalation:req-7',
        ttl: '2026-09-04T18:00:00Z', decisionSource: 'manual:orchestrator',
      },
      ts: '2026-09-04T16:00:00Z',
    });
    assert.equal(e2.ts, '2026-09-04T16:00:00Z'); // 显式 ts 不被覆盖
    assert.equal(e2.seq, 2);

    await log.append({
      type: 'artifact.published',
      principal: taskLevel,
      payload: { node: 'impl', name: 'patch', sha256: 'a'.repeat(64), size: 120, kind: 'file' },
    });
    await log.close();

    // reopen:新实例重放同一目录
    const reopened = await EventLog.open(root);
    const events = await collect(reopened);
    assert.equal(events.length, 3);
    assert.deepEqual(events[0], e1);
    assert.deepEqual(events[1], e2);
    assert.equal(events[2]?.type, 'artifact.published');

    // seq 从上次落盘位置续接
    const e4 = await reopened.append({
      type: 'daemon.started',
      principal: daemonLevel,
      payload: { pid: 1234 },
    });
    assert.equal(e4.seq, 4);
    await reopened.close();
  });

  it('seq 严格单调递增', async () => {
    const { log } = await makeLog();
    let prev = 0;
    for (let i = 0; i < 10; i++) {
      const ev = await log.append({
        type: 'sandbox.execed',
        principal: tenant,
        payload: { sandboxId: 'sbx-1', argsDigest: `cmd-${i}` },
      });
      assert.ok(ev.seq > prev);
      prev = ev.seq;
    }
    assert.equal(prev, 10);
    await log.close();
  });
});

describe('事件日志:崩溃截断处理', () => {
  it('末行半行(非法 JSON)重放丢弃,repair 修剪回最后一个完整行,后续 seq 不重号', async () => {
    const { root, log } = await makeLog();
    for (let i = 0; i < 3; i++) {
      await log.append({
        type: 'node.started',
        principal: taskLevel,
        payload: { nodeId: `n${i}`, attempt: 1 },
      });
    }
    const goodBytes = (await rawFile(root)).length;
    await log.close();

    // 模拟进程崩溃留下的半行(写了一半的 JSON,无换行符)
    await appendFile(join(root, 'events.jsonl'), '{"v":"1.0","seq":4,"ts":"2026-09-04T1');

    const reopened = await EventLog.open(root);
    const events = await collect(reopened);
    assert.equal(events.length, 3); // 半行被丢弃
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);

    // 修剪:文件回到崩溃前大小(半行被移除)
    assert.equal((await rawFile(root)).length, goodBytes);

    // 修剪后追加从 4 续号,不重号
    const e4 = await reopened.append({
      type: 'node.completed',
      principal: taskLevel,
      payload: { nodeId: 'n2', attempt: 1, outputs: [{ name: 'patch', sha256: 'b'.repeat(64) }] },
    });
    assert.equal(e4.seq, 4);
    await reopened.close();

    const third = await EventLog.open(root);
    assert.deepEqual((await collect(third)).map((e) => e.seq), [1, 2, 3, 4]);
    await third.close();
  });

  it('repair=false 时不修剪:重放仍丢弃半行,但文件字节保持原样', async () => {
    const { root, log } = await makeLog({ repair: false });
    await log.append({ type: 'daemon.started', principal: daemonLevel, payload: { pid: 1 } });
    await log.close();
    await appendFile(join(root, 'events.jsonl'), '{"seq":2,"half');

    const size = (await rawFile(root)).length;
    const reopened = await EventLog.open(root, { repair: false });
    const events = await collect(reopened);
    assert.equal(events.length, 1);
    assert.equal((await rawFile(root)).length, size); // 未修剪
    await reopened.close();
  });

  it('末行是合法 JSON 但缺换行符(完整事件被崩溃吃掉结尾):接受并补封换行', async () => {
    const { root, log } = await makeLog();
    await log.append({ type: 'daemon.started', principal: daemonLevel, payload: { pid: 7 } });
    await log.close();

    const complete = JSON.stringify({
      v: EVENT_LOG_VERSION, seq: 2, ts: '2026-09-04T10:00:00Z',
      type: 'daemon.started', principal: daemonLevel, payload: { pid: 8 },
    });
    await appendFile(join(root, 'events.jsonl'), complete); // 无 '\n'

    const reopened = await EventLog.open(root);
    const events = await collect(reopened);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.seq, 2);
    assert.equal((events[1]?.payload as { pid?: number }).pid, 8);

    // 补封换行后,后续追加不会拼到同一行
    await reopened.append({ type: 'daemon.started', principal: daemonLevel, payload: { pid: 9 } });
    await reopened.close();

    const third = await EventLog.open(root);
    const all = await collect(third);
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((e) => e.seq), [1, 2, 3]);
    await third.close();
  });

  it('中途损坏(非法 JSON 但有换行符结尾)不是截断形态,抛 EventCorrupt', async () => {
    const { root, log } = await makeLog();
    await log.append({ type: 'daemon.started', principal: daemonLevel, payload: { pid: 1 } });
    await log.close();
    await appendFile(join(root, 'events.jsonl'), 'garbage-not-json\n');

    const reopened = await EventLog.open(root);
    await assert.rejects(collect(reopened), EventCorrupt);
    await reopened.close();
  });
});

describe('事件日志:并发 append 串行化', () => {
  it('并发 50 条不丢不乱:seq 恰为 1..50,payload 与 seq 一一对应,无拼行', async () => {
    const { root, log } = await makeLog();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        log.append({
          type: 'sandbox.execed',
          principal: tenant,
          payload: { sandboxId: 'sbx-1', argsDigest: `job-${i}`, extra: { n: i } },
        }),
      ),
    );
    // 返回值本身:seq 唯一且覆盖 1..50
    const seqs = results.map((e) => e.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1));

    await log.close();
    const reopened = await EventLog.open(root);
    const events = await collect(reopened);
    assert.equal(events.length, 50);
    for (const ev of events) {
      const n = (ev.payload as { extra?: { n?: number } }).extra?.n;
      assert.equal(ev.seq, (n ?? -1) + 1);
    }

    // 落盘逐行可解析(没有拼行/半行)
    const lines = (await rawFile(root)).toString('utf8').split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 50);
    await reopened.close();
  });
});

describe('事件日志:订阅 onEvent', () => {
  it('append 后内存转发,退订后不再收到;回调抛错不影响追加', async () => {
    const received: Event[] = [];
    let boom = false;
    const { log } = await makeLog({
      onSubscriberError: () => {
        boom = true;
      },
    });
    const unsubscribe = log.onEvent((ev) => received.push(ev));
    log.onEvent(() => {
      throw new Error('subscriber boom');
    });

    await log.append({ type: 'daemon.started', principal: daemonLevel, payload: { pid: 1 } });
    await log.append({ type: 'daemon.started', principal: daemonLevel, payload: { pid: 2 } });
    assert.equal(received.length, 2);
    assert.ok(boom); // 抛错的订阅者被隔离并上报

    unsubscribe();
    await log.append({ type: 'daemon.started', principal: daemonLevel, payload: { pid: 3 } });
    assert.equal(received.length, 2);
    await log.close();
  });
});

describe('事件日志:readByPrincipal 过滤查询', () => {
  it('四层逐级过滤 + 类型过滤', async () => {
    const { log } = await makeLog();
    await log.append({ type: 'daemon.started', principal: daemonLevel, payload: { pid: 1 } });
    await log.append({ type: 'sandbox.created', principal: tenant, payload: { sandboxId: 'a' } });
    await log.append({ type: 'sandbox.created', principal: otherTask, payload: { sandboxId: 'b' } });
    await log.append({
      type: 'grant.granted',
      principal: taskLevel,
      payload: { cap: 'fs:workdir', scope: 'rw', source: 'baseline', ttl: null, duration: null, decisionSource: 'auto_rule:baseline' },
    });

    const byTask = await log.readByPrincipal({ task: 'task-42' });
    assert.deepEqual(byTask.map((e) => e.type), ['sandbox.created', 'grant.granted']);

    const byAgent = await log.readByPrincipal({ task: 'task-42', agent: 'task-42/impl-01' });
    assert.deepEqual(byAgent.map((e) => e.type), ['sandbox.created']);

    const byNullAgent = await log.readByPrincipal({ task: 'task-42', agent: null });
    assert.deepEqual(byNullAgent.map((e) => e.type), ['grant.granted']);

    const byTenant = await log.readByPrincipal({ tenant: 'default' });
    assert.deepEqual(byTenant.map((e) => e.type), ['daemon.started']);

    const byType = await log.readByPrincipal({ types: ['sandbox.created'] });
    assert.equal(byType.length, 2);

    await log.close();
  });
});

describe('事件日志:分片(可选,默认单文件)', () => {
  it('shardByTask 按 tenant/session/task 分文件,seq 各自独立,跨片查询合并', async () => {
    const { root, log } = await makeLog({ shard: shardByTask() });

    const e1 = await log.append({ type: 'sandbox.created', principal: tenant, payload: { sandboxId: 'a' } });
    const e2 = await log.append({ type: 'sandbox.created', principal: otherTask, payload: { sandboxId: 'b' } });
    const e3 = await log.append({ type: 'sandbox.created', principal: tenant, payload: { sandboxId: 'a2' } });
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 1); // 另一个分片文件,seq 独立从 1 起
    assert.equal(e3.seq, 2);

    // 两个任务两个文件
    assert.deepEqual(
      (await readdir(join(root, 'acme', 'sess-1'))).sort(),
      ['task-42.jsonl', 'task-7.jsonl'],
    );

    const byTask = await log.readByPrincipal({ task: 'task-42' });
    assert.equal(byTask.length, 2);

    const all = await collect(log);
    assert.equal(all.length, 3);
    await log.close();
  });

  it('策略返回 null 落入默认单文件', async () => {
    const { root, log } = await makeLog({
      shard: (p) => (p.task === null ? null : `ok/${p.task}.jsonl`),
    });
    await log.append({ type: 'daemon.started', principal: daemonLevel, payload: { pid: 1 } });
    await log.append({ type: 'sandbox.created', principal: otherTask, payload: { sandboxId: 'b' } });
    assert.ok((await stat(join(root, 'events.jsonl'))).isFile());
    assert.ok((await stat(join(root, 'ok', 'task-7.jsonl'))).isFile());
    const all = await collect(log);
    assert.deepEqual(all.map((e) => e.seq), [1, 1]);
    await log.close();
  });
});

describe('事件日志:前向兼容(v0.2 §6 补充)', () => {
  it('未知字段透传保留(不报错不剥离),未知事件类型跳过并经 onSkipped 上报', async () => {
    const { root, log } = await makeLog();
    await log.append({ type: 'daemon.started', principal: daemonLevel, payload: { pid: 1 } });
    await log.close();

    // 升级后版本的日志:带未知顶层字段与未知 payload 字段的合法事件 + 未知事件类型
    const futureEvent = JSON.stringify({
      v: '1.0', seq: 2, ts: '2026-09-04T10:00:00Z',
      type: 'daemon.started', principal: daemonLevel,
      payload: { pid: 2, someNewField: { deep: true } },
      someFutureTopLevelField: 'written-by-newer-daemon',
    });
    const unknownType = JSON.stringify({
      v: '1.0', seq: 3, ts: '2026-09-04T10:01:00Z',
      type: 'portal.opened', principal: daemonLevel, payload: { whatever: 1 },
    });
    await appendFile(join(root, 'events.jsonl'), futureEvent + '\n' + unknownType + '\n');

    const skipped: string[] = [];
    const reopened = await EventLog.open(root);
    const events = await collect(reopened, { onSkipped: (r) => skipped.push(r.type ?? '(?)') });
    // 未知类型被跳过不炸;合法事件正常恢复
    assert.equal(events.length, 2);
    assert.deepEqual(skipped, ['portal.opened']);
    // 未知字段透传保留
    const second = events[1] as unknown as Record<string, unknown>;
    assert.equal(second['someFutureTopLevelField'], 'written-by-newer-daemon');
    assert.deepEqual((second['payload'] as Record<string, unknown>)['someNewField'], { deep: true });
    await reopened.close();
  });

  it('含未知类型的旧日志 reopen 后可继续追加,seq 跳过未知行续号', async () => {
    const { root, log } = await makeLog();
    await log.close();
    const line1 = JSON.stringify({
      v: '1.0', seq: 1, ts: '2026-09-04T10:00:00Z',
      type: 'daemon.started', principal: daemonLevel, payload: { pid: 1 },
    });
    const line2 = JSON.stringify({
      v: '1.0', seq: 2, ts: '2026-09-04T10:01:00Z',
      type: 'budget.unknown.future', principal: daemonLevel, payload: {},
    });
    await appendFile(join(root, 'events.jsonl'), line1 + '\n' + line2 + '\n');

    const reopened = await EventLog.open(root);
    const e3 = await reopened.append({ type: 'daemon.started', principal: daemonLevel, payload: { pid: 3 } });
    assert.equal(e3.seq, 3); // 未知类型行同样消费 seq,nextSeq 据此续号
    await reopened.close();
  });
});

describe('事件日志:对外错误', () => {
  it('append 未知事件类型 / 非对象 payload 被拒绝(append 从严,重放从宽)', async () => {
    const { log } = await makeLog();
    await assert.rejects(
      log.append({
        type: 'nope.nope',
        principal: daemonLevel,
        payload: {},
      } as unknown as Parameters<EventLog['append']>[0]),
      InvalidEvent,
    );
    await assert.rejects(
      // @ts-expect-error 故意传非法 payload
      log.append({ type: 'daemon.started', principal: daemonLevel, payload: 'not-object' }),
      InvalidEvent,
    );
    await log.close();
  });

  it('close 后使用抛 EventLogClosed', async () => {
    const { log } = await makeLog();
    await log.close();
    await assert.rejects(
      log.append({ type: 'daemon.started', principal: daemonLevel, payload: { pid: 1 } }),
      EventLogClosed,
    );
  });
});
