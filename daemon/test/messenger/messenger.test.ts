/**
 * messenger 模块测试(§3.4):
 * 1. 三类消息投递语义(direct 双向 / broadcast 全员 / feedback 结构化)
 * 2. 未注册收件人 → dead letter 队列 + 取回
 * 3. 广播能力关与开(NotSupportedError)
 * 4. traversal 计数(per-(from,to,ref))与超限判定
 * 5. handler 抛错(同步/异步)不影响后续投递
 * 6. 并发 send 顺序性
 * 7. validateMsg 校验失败集 + RFC3339 断言
 * 全内存,不触盘;sink 用内存数组桩。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_ID_RE,
  InvalidAgentId,
  InvalidMsg,
  Messenger,
  NotSupportedError,
  RFC3339_UTC_RE,
  isRfc3339Utc,
  validateMsg,
} from '../../src/messenger/index.ts';
import type {
  EventSink,
  MessengerOptions,
  MessengerSinkEvent,
  StoredMessage,
} from '../../src/messenger/index.ts';

/** 排空微任务队列,等待 queueMicrotask 调度的投递完成。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function direct(
  to: string,
  body: Record<string, unknown> = { n: 1 },
  priority?: string,
): Record<string, unknown> {
  return { protocol: '1.0', spec_version: '1.0', type: 'msg.direct', to, body, ...(priority !== undefined ? { priority } : {}) };
}

function broadcast(topic = 'deps-changed', body: Record<string, unknown> = { changed: true }): Record<string, unknown> {
  return { protocol: '1.0', spec_version: '1.0', type: 'msg.broadcast', topic, body };
}

function feedback(
  to: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocol: '1.0',
    spec_version: '1.0',
    type: 'msg.feedback',
    to,
    kind: 'correction',
    ref: 'artifact:test_report',
    body: '登录用例断言反了,重做',
    traversal: 1,
    ...overrides,
  };
}

/** 固定时钟:ts 可断言。 */
const FIXED = new Date('2026-09-04T18:00:00Z');

function newMessenger(opts: MessengerOptions = {}): Messenger {
  return new Messenger({ now: () => FIXED, ...opts });
}

// ---------------------------------------------------------------- 三型投递

describe('三型消息投递语义', () => {
  it('msg.direct:主控→子、子→主控 双向点对点', async () => {
    const m = newMessenger();
    const got: StoredMessage[] = [];
    m.register('task-42/impl-01', (msg) => {
      got.push(msg);
    });
    const gotMaster: StoredMessage[] = [];
    m.register('task-42/orchestrator', (msg) => {
      gotMaster.push(msg);
    });

    const sent = m.send(direct('task-42/impl-01', { cmd: 'start' }));
    assert.equal(sent.type, 'msg.direct');
    assert.equal(sent.to, 'task-42/impl-01');
    assert.equal(sent.from, 'orchestrator', '未指定 from 时缺省主控');
    assert.equal(sent.priority, 'normal');
    await flush();

    assert.equal(got.length, 1);
    assert.deepEqual(got[0]!.body, { cmd: 'start' });
    assert.equal(gotMaster.length, 0, '点对点不外溢');

    // 子→主控反向,from 显式指定
    m.send(direct('task-42/orchestrator', { done: true }), 'task-42/impl-01');
    await flush();
    assert.equal(gotMaster.length, 1);
    assert.equal(gotMaster[0]!.from, 'task-42/impl-01');
  });

  it('盖章:id(uuid)/ ts(RFC3339 UTC)/ seq 单调', async () => {
    const m = newMessenger();
    m.register('task-42/a', () => {});
    const s1 = m.send(direct('task-42/a'));
    const s2 = m.send(direct('task-42/a'));
    assert.equal(s1.ts, '2026-09-04T18:00:00.000Z');
    assert.ok(RFC3339_UTC_RE.test(s1.ts));
    assert.match(s1.id, /^[0-9a-f-]{36}$/);
    assert.ok(s2.seq > s1.seq);
  });

  it('msg.broadcast:投给全部注册者,消息本体一致', async () => {
    const m = newMessenger({ broadcastEnabled: true });
    const a: StoredMessage[] = [];
    const b: StoredMessage[] = [];
    m.register('task-42/impl-01', (msg) => void a.push(msg));
    m.register('task-42/e2e-01', (msg) => void b.push(msg));

    const sent = m.send(broadcast('deps-changed', { pkg: 'zod' }), 'task-42/orchestrator');
    await flush();

    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0]!.id, sent.id);
    assert.equal(b[0]!.id, sent.id);
    assert.equal(a[0]!.type, 'msg.broadcast');
    const first = a[0]!;
    assert.ok('topic' in first && first.topic === 'deps-changed');
    assert.ok(!('to' in first), 'broadcast 无 to 字段');
  });

  it('msg.feedback:结构化纠偏按 to 投递,body 为字符串', async () => {
    const m = newMessenger();
    const got: StoredMessage[] = [];
    m.register('task-42/impl-01', (msg) => void got.push(msg));

    m.send(feedback('task-42/impl-01'));
    await flush();

    assert.equal(got.length, 1);
    const f = got[0]!;
    assert.equal(f.type, 'msg.feedback');
    assert.equal(f.kind, 'correction');
    assert.equal(f.ref, 'artifact:test_report');
    assert.equal(f.body, '登录用例断言反了,重做');
    assert.equal(f.traversal, 1);
  });
});

// ---------------------------------------------------------------- 未注册收件人

describe('未注册收件人:dead letter 队列', () => {
  it('收件人未注册 → 入 dead letter,不调用任何 handler,仍进 history/审计', async () => {
    const m = newMessenger();
    const seen: string[] = [];
    m.register('task-42/other', (msg) => void seen.push(msg.id));
    const events: MessengerSinkEvent[] = [];
    const m2 = new Messenger({ now: () => FIXED, sink: ((e: MessengerSinkEvent) => void events.push(e)) as EventSink });
    m2.register('task-42/other', (msg) => void seen.push(msg.id));

    m.send(direct('task-42/ghost'));
    m2.send(feedback('task-42/ghost'));
    await flush();

    assert.equal(seen.length, 0);
    assert.equal(m.deadLetters().length, 1);
    const dl = m.deadLetters()[0]!;
    assert.equal(dl.reason, 'recipient_not_registered');
    assert.ok('to' in dl.message && dl.message.to === 'task-42/ghost');
    assert.equal(m.history().length, 1, 'dead letter 也进历史');
    assert.equal(events.length, 1, 'dead letter 也回调 sink');
  });

  it('takeDeadLetters 消费取回;注册后重发可正常投递', async () => {
    const m = newMessenger();
    m.send(direct('task-42/late', { v: 1 }));
    assert.equal(m.deadLetters().length, 1);

    const taken = m.takeDeadLetters();
    assert.equal(taken.length, 1);
    assert.equal(m.deadLetters().length, 0);

    const got: StoredMessage[] = [];
    m.register('task-42/late', (msg) => void got.push(msg));
    m.send(taken[0]!.message); // 取回后按调用方决定重发
    await flush();
    assert.equal(got.length, 1);
    assert.deepEqual(got[0]!.body, { v: 1 });
  });

  it('register 后 send 正常路由;unregister 后再 send 回到 dead letter', async () => {
    const m = newMessenger();
    let n = 0;
    m.register('task-42/x', () => void n++);
    m.send(direct('task-42/x'));
    await flush();
    assert.equal(n, 1);
    assert.equal(m.unregister('task-42/x'), true);
    assert.equal(m.unregister('task-42/x'), false, '重复 unregister 是 no-op');
    m.send(direct('task-42/x'));
    await flush();
    assert.equal(n, 1);
    assert.equal(m.deadLetters().length, 1);
  });

  it('register 非法 agent id 抛 InvalidAgentId', () => {
    const m = newMessenger();
    assert.throws(() => m.register('no-slash', () => {}), InvalidAgentId);
    assert.throws(() => m.register('/leading', () => {}), InvalidAgentId);
  });
});

// ---------------------------------------------------------------- 广播能力

describe('广播能力(协商开关)', () => {
  it('broadcastEnabled=false(缺省)→ NotSupportedError,且无副作用', () => {
    const m = newMessenger();
    const got: StoredMessage[] = [];
    m.register('task-42/a', (msg) => void got.push(msg));
    assert.throws(() => m.send(broadcast()), NotSupportedError);
    assert.equal(m.history().length, 0, '被拒消息不留痕');
    assert.equal(m.deadLetters().length, 0);
  });

  it('broadcastEnabled=true(握手协商通过)→ 正常广播', async () => {
    const m = newMessenger({ broadcastEnabled: true });
    let n = 0;
    m.register('task-42/a', () => void n++);
    m.send(broadcast());
    await flush();
    assert.equal(n, 1);
  });

  it('零注册者广播是 no-op 不报错', async () => {
    const m = newMessenger({ broadcastEnabled: true });
    const sent = m.send(broadcast());
    await flush();
    assert.equal(m.history().length, 1);
    assert.ok(sent.id);
  });
});

// ---------------------------------------------------------------- traversal

describe('traversal 计数与超限判定', () => {
  it('per-(from,to,ref) 三元组独立计数', () => {
    const m = newMessenger();
    m.register('task-42/impl-01', () => {});
    m.send(feedback('task-42/impl-01', { traversal: 1 }), 'task-42/tester-01');
    m.send(feedback('task-42/impl-01', { traversal: 2 }), 'task-42/tester-01');
    m.send(feedback('task-42/impl-01', { ref: 'artifact:patch', traversal: 5 }), 'task-42/tester-01');
    m.send(feedback('task-42/impl-02', { traversal: 9 }), 'task-42/tester-01');
    m.send(feedback('task-42/impl-01', { traversal: 3 }), 'task-42/orchestrator');

    assert.equal(m.traversalOf('task-42/tester-01', 'task-42/impl-01', 'artifact:test_report'), 2);
    assert.equal(m.traversalOf('task-42/tester-01', 'task-42/impl-01', 'artifact:patch'), 5);
    assert.equal(m.traversalOf('task-42/tester-01', 'task-42/impl-02', 'artifact:test_report'), 9);
    assert.equal(m.traversalOf('task-42/orchestrator', 'task-42/impl-01', 'artifact:test_report'), 3);
    assert.equal(m.traversalOf('task-42/tester-01', 'task-42/impl-01', 'artifact:unknown'), null);
  });

  it('exceedsMaxTraversal 只返回布尔,升级动作留给调用方', () => {
    const m = newMessenger();
    m.register('task-42/impl-01', () => {});
    m.send(feedback('task-42/impl-01', { traversal: 2 }), 'task-42/tester-01');

    // max_traversals: 2 → traversal=2 不超,再打一次(3)才超
    assert.equal(m.exceedsMaxTraversal('task-42/tester-01', 'task-42/impl-01', 'artifact:test_report', 2), false);
    m.send(feedback('task-42/impl-01', { traversal: 3 }), 'task-42/tester-01');
    assert.equal(m.exceedsMaxTraversal('task-42/tester-01', 'task-42/impl-01', 'artifact:test_report', 2), true);
    assert.equal(m.exceedsMaxTraversal('task-42/tester-01', 'task-42/impl-01', 'artifact:test_report', 3), false);
    assert.equal(m.exceedsMaxTraversal('a/b', 'c/d', 'artifact:x', 0), false, '无记录不超限');
  });

  it('计数取历史最大值(容忍乱序)', () => {
    const m = newMessenger();
    m.register('task-42/i', () => {});
    m.send(feedback('task-42/i', { traversal: 3 }), 'task-42/t');
    m.send(feedback('task-42/i', { traversal: 1 }), 'task-42/t');
    assert.equal(m.traversalOf('task-42/t', 'task-42/i', 'artifact:test_report'), 3);
  });
});

// ---------------------------------------------------------------- 容错

describe('handler 抛错不影响后续', () => {
  it('同步抛错被捕获落账,同批后续消息照常投递', async () => {
    const m = newMessenger();
    const got: number[] = [];
    m.register('task-42/bad', () => {
      throw new Error('boom');
    });
    m.register('task-42/good', (msg) => void got.push(msg.seq));

    m.send(direct('task-42/bad'));
    m.send(direct('task-42/good'));
    await flush();

    assert.deepEqual(got.length, 1);
    assert.equal(m.failures().length, 1);
    const f = m.failures()[0]!;
    assert.equal(f.stage, 'handler');
    assert.equal(f.error, 'boom');
    assert.equal(f.target, 'task-42/bad');
    assert.equal(m.history().length, 2, '失败消息仍在历史');
  });

  it('Promise 拒绝同样被捕获', async () => {
    const m = newMessenger();
    m.register('task-42/async-bad', async () => {
      throw new Error('async boom');
    });
    m.send(direct('task-42/async-bad'));
    await flush();
    await flush();
    assert.equal(m.failures().length, 1);
    assert.equal(m.failures()[0]!.stage, 'handler');
    assert.equal(m.failures()[0]!.error, 'async boom');
  });

  it('订阅者与 sink 抛错不影响投递', async () => {
    let n = 0;
    const sink: EventSink = () => {
      throw new Error('sink down');
    };
    const m = newMessenger({ sink });
    m.onMessage(() => {
      throw new Error('sub down');
    });
    m.register('task-42/a', () => void n++);
    m.send(direct('task-42/a'));
    await flush();
    assert.equal(n, 1);
    const stages = m.failures().map((f) => f.stage).sort();
    assert.deepEqual(stages, ['sink', 'subscriber']);
  });

  it('sink 返回 rejected Promise 不炸通道', async () => {
    const sink: EventSink = () => Promise.reject(new Error('disk full'));
    const m = newMessenger({ sink });
    m.register('task-42/a', () => {});
    m.send(direct('task-42/a'));
    await flush();
    await flush();
    assert.equal(m.failures()[0]!.stage, 'sink');
  });
});

// ---------------------------------------------------------------- 顺序性

describe('并发 send 顺序性', () => {
  it('批量 send 的投递顺序 = send 调用顺序(seq 升序)', async () => {
    const m = newMessenger();
    const received: number[] = [];
    m.register('task-42/w', (msg) => {
      received.push(msg.seq);
    });
    for (let i = 0; i < 100; i++) m.send(direct('task-42/w', { i }));
    await flush();
    assert.equal(received.length, 100);
    assert.deepEqual(received, [...received].sort((a, b) => a - b));
    assert.equal(received[0], 1);
    assert.equal(received[99], 100);
  });

  it('Promise.all 并发 send 同样保序,且 handler 慢不阻塞 send 返回', async () => {
    const m = newMessenger();
    const delivered: number[] = []; // handler 被调用的顺序
    const completed: number[] = []; // handler 完成的顺序
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolveFirst = r;
    });
    let first = true;
    m.register('task-42/w', (msg) => {
      delivered.push(msg.seq);
      if (first) {
        first = false;
        // 第一条 handler 挂起,验证第二条的投递不被阻塞、顺序仍由队列保证
        void gate.then(() => completed.push(msg.seq));
      } else {
        completed.push(msg.seq);
      }
    });
    await Promise.all([m.send(direct('task-42/w', { i: 0 })), m.send(direct('task-42/w', { i: 1 }))]);
    await flush();
    assert.equal(delivered.length, 2, '第一条 handler 未完成,第二条已被投递');
    assert.ok(delivered[1]! > delivered[0]!, '投递顺序 = send 调用顺序');
    assert.equal(completed.length, 1, '完成顺序可以乱(语义上不承诺 handler 完成序)');
    resolveFirst!();
    await flush();
    assert.equal(completed.length, 2);
  });
});

// ---------------------------------------------------------------- 校验失败集

describe('validateMsg 校验失败集', () => {
  it('非法消息逐项抛 InvalidMsg 且 field 带字段名', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ protocol: '2.0', spec_version: '1.0', type: 'msg.direct', to: 't/a', body: {} }, 'protocol'],
      [{ protocol: '1.0', spec_version: 'v1', type: 'msg.direct', to: 't/a', body: {} }, 'spec_version'],
      [{ protocol: '1.0', type: 'msg.direct', to: 't/a', body: {} }, 'spec_version'],
      [{ protocol: '1.0', spec_version: '1.0', type: 'msg.dropped', to: 't/a', body: {} }, 'type'],
      [{ protocol: '1.0', spec_version: '1.0', type: 'msg.direct', body: {} }, 'to'],
      [{ protocol: '1.0', spec_version: '1.0', type: 'msg.direct', to: 'noslash', body: {} }, 'to'],
      [{ protocol: '1.0', spec_version: '1.0', type: 'msg.direct', to: 't/a', body: 'str' }, 'body'],
      [broadcast(''), 'topic'],
      [{ protocol: '1.0', spec_version: '1.0', type: 'msg.broadcast', topic: 't', body: 1 }, 'body'],
      [{ protocol: '1.0', spec_version: '1.0', type: 'msg.feedback', to: 't/a', ref: 'artifact:x', body: 'b', traversal: 0 }, 'kind'],
      [feedback('t/a', { kind: 'rant' }), 'kind'],
      [feedback('t/a', { ref: 'not-artifact' }), 'ref'],
      [feedback('t/a', { body: '' }), 'body'],
      [feedback('t/a', { traversal: -1 }), 'traversal'],
      [feedback('t/a', { traversal: 1.5 }), 'traversal'],
      [feedback('t/a', { traversal: '1' }), 'traversal'],
      [feedback('t/a', { priority: 'urgent' }), 'priority'],
      [{ protocol: '1.0', spec_version: '1.0', type: 'msg.direct', to: 't/a', body: {}, ts: '2026-09-04 18:00:00' }, 'ts'],
      ['not-an-object' as unknown as Record<string, unknown>, '(root)'],
    ];
    for (const [raw, field] of cases) {
      try {
        validateMsg(raw);
        assert.fail(`应当抛 InvalidMsg: ${field} <- ${JSON.stringify(raw)}`);
      } catch (e) {
        assert.ok(e instanceof InvalidMsg, `${field}: 应抛 InvalidMsg,实际 ${String(e)}`);
        assert.equal(e.field, field);
      }
    }
  });

  it('合法三型 + 未知字段忽略(§3.0 规则 1)', () => {
    assert.equal(validateMsg(direct('task-42/a')).type, 'msg.direct');
    assert.equal(validateMsg(broadcast()).type, 'msg.broadcast');
    const f = validateMsg(feedback('task-42/a', { kind: 'question', traversal: 0 }));
    assert.equal(f.type, 'msg.feedback');
    const loose = validateMsg({ ...direct('task-42/a'), extra_future_field: { x: 1 } });
    assert.equal(loose.type, 'msg.direct');
  });

  it('三型优先级枚举合法值通过', () => {
    for (const p of ['low', 'normal', 'high']) {
      assert.equal(validateMsg(direct('task-42/a', {}, p)).priority, p);
    }
  });

  it('RFC3339 断言与 agent id 正则', () => {
    assert.equal(isRfc3339Utc('2026-09-04T18:00:00Z'), true);
    assert.equal(isRfc3339Utc('2026-09-04T18:00:00.123Z'), true);
    assert.equal(isRfc3339Utc('2026-09-04T18:00:00+08:00'), false);
    assert.equal(isRfc3339Utc('2026-09-04 18:00:00Z'), false);
    assert.equal(isRfc3339Utc(123), false);
    assert.ok(AGENT_ID_RE.test('task-42/e2e-tester-01'));
    assert.ok(AGENT_ID_RE.test('Task_1/a.b-c'));
    assert.ok(!AGENT_ID_RE.test('single'));
    assert.ok(!AGENT_ID_RE.test('a/b/c'));
  });
});

// ---------------------------------------------------------------- 审计与历史

describe('onMessage 审计挂点与 history 查询', () => {
  it('onMessage 每条合法消息回调一次,解订后不再回调', () => {
    const m = newMessenger();
    let n = 0;
    const unsub = m.onMessage(() => void n++);
    m.send(direct('task-42/a'));
    assert.equal(n, 1);
    unsub();
    m.send(direct('task-42/a'));
    assert.equal(n, 1);
  });

  it('history 按过滤条件查询,seq 升序', () => {
    const m = newMessenger({ broadcastEnabled: true });
    m.register('task-42/a', () => {});
    m.send(direct('task-42/a'));
    m.send(broadcast('deps-changed'));
    m.send(feedback('task-42/a', { traversal: 1 }));

    assert.equal(m.history().length, 3);
    assert.equal(m.history({ type: 'msg.direct' }).length, 1);
    assert.equal(m.history({ to: 'task-42/a' }).length, 2);
    assert.equal(m.history({ topic: 'deps-changed' }).length, 1);
    assert.equal(m.history({ kind: 'correction' }).length, 1);
    assert.equal(m.history({ ref: 'artifact:test_report' }).length, 1);
    assert.equal(m.history({ from: 'nobody' }).length, 0);
    const all = m.history();
    const seqs = all.map((x) => x.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });

  it('principal 随 sink 事件透传给持久层', () => {
    const events: MessengerSinkEvent[] = [];
    const m = new Messenger({
      now: () => FIXED,
      principal: { tenant: 'default', session: 'sess-1', task: 'task-42', agent: null },
      sink: (e) => void events.push(e),
    });
    m.register('task-42/a', () => {});
    m.send(direct('task-42/a'));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.principal, { tenant: 'default', session: 'sess-1', task: 'task-42', agent: null });
    assert.equal(events[0]!.type, 'msg.sent');
  });
});
