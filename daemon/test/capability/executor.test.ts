/**
 * 基线授予执行器测试(P1:只有基线授予,无审批流):
 * manifest 生成正确(source=baseline/ttl=null)、挂载意图、审计经 sink 发出、
 * 错误集、grant/revoke 原语、revoke 后查询为空、decision_source 的 schema 合规。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AgentIdInvalid,
  AgentUnknown,
  BaselineAlreadyApplied,
  CapUnknown,
  GrantDuplicate,
  GrantExecutor,
  RegistryInvalid,
  ScopeNotGrantable,
  defaultRegistry,
  minimalPresetDoc,
  parsePreset,
} from '../../src/capability/index.ts';
import type { BaselineGrantSpec, GrantAuditEvent } from '../../src/capability/index.ts';

const REG = defaultRegistry();
const NOW = new Date('2026-09-04T12:00:00Z');

function presetWith(grants: BaselineGrantSpec[]) {
  return parsePreset(minimalPresetDoc({ baseline_grants: grants }));
}

/** 收集 sink 事件的最小内存 sink。 */
function makeSink(): { events: GrantAuditEvent[]; sink: (e: GrantAuditEvent) => Promise<void> } {
  const events: GrantAuditEvent[] = [];
  return { events, sink: async (e) => void events.push(e) };
}

describe('基线授予生成(P1)', () => {
  it('按预设置入基线:grants 带 source=baseline、ttl=null,manifest 字段齐全', async () => {
    const ex = new GrantExecutor(REG, { now: () => NOW });
    const { manifest, mountIntents } = await ex.applyBaseline(
      'task-42/e2e-tester-01',
      presetWith([
        { cap: 'fs:workdir', scope: 'rw' },
        { cap: 'mcp:playwright', scope: 'write' },
      ]),
    );
    assert.equal(manifest.protocol, '1.0');
    assert.equal(manifest.spec_version, '1.0');
    assert.equal(manifest.agent_id, 'task-42/e2e-tester-01');
    assert.deepEqual(
      manifest.grants.map((g) => [g.cap, g.scope, g.source, g.ttl]),
      [
        ['fs:workdir', 'rw', 'baseline', null],
        ['mcp:playwright', 'write', 'baseline', null],
      ],
    );
    assert.equal(mountIntents.length, 2);
    // 审计:每条授予一条 granted,at 取注入时钟
    assert.equal(manifest.audit.length, 2);
    assert.equal(manifest.audit[0]?.event, 'granted');
    assert.equal(manifest.audit[0]?.at, '2026-09-04T12:00:00.000Z');
    // 查询口径一致
    assert.deepEqual(ex.grantsOf('task-42/e2e-tester-01'), manifest.grants);
    assert.deepEqual(ex.manifest('task-42/e2e-tester-01'), manifest);
  });

  it('挂载意图:fs_path 带路径模板,mcp_server 带工具清单', async () => {
    const ex = new GrantExecutor(REG, { now: () => NOW });
    const { mountIntents } = await ex.applyBaseline(
      'task-42/e2e-tester-01',
      presetWith([
        { cap: 'fs:workdir', scope: 'rw' },
        { cap: 'mcp:playwright', scope: 'write' },
      ]),
    );
    const fsIntent = mountIntents.find((m) => m.cap === 'fs:workdir');
    assert.deepEqual(fsIntent, {
      cap: 'fs:workdir',
      scope: 'rw',
      kind: 'fs_path',
      pathTemplate: '${task.workdir}',
      tools: null,
    });
    const mcpIntent = mountIntents.find((m) => m.cap === 'mcp:playwright');
    assert.equal(mcpIntent?.kind, 'mcp_server');
    assert.equal(mcpIntent?.pathTemplate, null);
    assert.ok((mcpIntent?.tools ?? []).includes('screenshot'));
  });

  it('granted 审计经注入 sink 发出,decision_source 为 schema 合法的 auto_rule:baseline', async () => {
    const { events, sink } = makeSink();
    const ex = new GrantExecutor(REG, { sink, now: () => NOW });
    await ex.applyBaseline('task-1/a', presetWith([{ cap: 'fs:workdir', scope: 'rw' }]));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'granted');
    assert.equal(events[0]?.agentId, 'task-1/a');
    assert.equal(events[0]?.cap, 'fs:workdir');
    assert.equal(events[0]?.decision_source, 'auto_rule:baseline');
    // schema 冻结 pattern:自动放行来源必须形如 auto_rule:{id}
    assert.match(events[0]?.decision_source as string, /^(auto_rule:[^\s]+|manual:[^\s]+)$/);
  });

  it('失败集:未知 cap / scope 不可授 / 重复条目 / agent_id 非法 / 重复 applyBaseline', async () => {
    const ex = new GrantExecutor(REG, { now: () => NOW });
    await assert.rejects(
      ex.applyBaseline('task-1/a', presetWith([{ cap: 'mcp:nonexistent', scope: 'read' }])),
      (err: unknown) => err instanceof CapUnknown && err.cap === 'mcp:nonexistent',
    );
    await assert.rejects(
      ex.applyBaseline('task-1/a', presetWith([{ cap: 'mcp:github', scope: 'rw' }])),
      (err: unknown) => err instanceof ScopeNotGrantable && err.scope === 'rw',
    );
    await assert.rejects(
      ex.applyBaseline(
        'task-1/a',
        presetWith([
          { cap: 'fs:workdir', scope: 'rw' },
          { cap: 'fs:workdir', scope: 'rw' },
        ]),
      ),
      GrantDuplicate,
    );
    // 失败后不残留半套授予
    assert.equal(ex.manifest('task-1/a'), undefined);
    await assert.rejects(ex.applyBaseline('bad-agent-id', presetWith([])), AgentIdInvalid);
    await ex.applyBaseline('task-1/a', presetWith([]));
    await assert.rejects(
      ex.applyBaseline('task-1/a', presetWith([])),
      BaselineAlreadyApplied,
    );
  });

  it('空 baseline_grants 也是合法基线(最小化不变量)', async () => {
    const ex = new GrantExecutor(REG, { now: () => NOW });
    const { manifest, mountIntents } = await ex.applyBaseline('task-2/empty', presetWith([]));
    assert.deepEqual(manifest.grants, []);
    assert.deepEqual(mountIntents, []);
  });
});

describe('applyBaseline 审计补偿(#30:事件日志与实际授予对账)', () => {
  it('中途失败:此前已落 granted 审计的条目补发 reclaimed,agent 不残留半套授予', async () => {
    const { events, sink } = makeSink();
    const ex = new GrantExecutor(REG, { sink, now: () => NOW });
    await assert.rejects(
      ex.applyBaseline('task-30/a', presetWith([
        { cap: 'fs:workdir', scope: 'rw' },
        { cap: 'mcp:nonexistent', scope: 'read' }, // 第二条才炸
      ])),
      CapUnknown,
    );
    // 事件序:第一条 granted 后紧跟补偿 reclaimed(授予整体回滚)
    assert.deepEqual(
      events.map((e) => [e.cap, e.event]),
      [['fs:workdir', 'granted'], ['fs:workdir', 'reclaimed']],
    );
    // agent 已摘除,查询口径同样干净
    assert.equal(ex.manifest('task-30/a'), undefined);
    assert.deepEqual(ex.grantsOf('task-30/a'), []);
  });

  it('重试成功后无"双 granted 无回收"背离:同一 cap 事件序 granted→reclaimed→granted', async () => {
    const { events, sink } = makeSink();
    const ex = new GrantExecutor(REG, { sink, now: () => NOW });
    await assert.rejects(
      ex.applyBaseline('task-30/b', presetWith([
        { cap: 'fs:workdir', scope: 'rw' },
        { cap: 'mcp:nonexistent', scope: 'read' },
      ])),
      CapUnknown,
    );
    const { manifest } = await ex.applyBaseline('task-30/b', presetWith([
      { cap: 'fs:workdir', scope: 'rw' },
    ]));
    assert.deepEqual(manifest.grants, [
      { cap: 'fs:workdir', scope: 'rw', source: 'baseline', ttl: null },
    ]);
    // sink 事件序对账:失败轮 granted + 补偿 reclaimed,成功轮一条 granted ——
    // 不存在两条 granted 之间无回收的序列。
    assert.deepEqual(
      events.map((e) => [e.cap, e.event]),
      [
        ['fs:workdir', 'granted'],
        ['fs:workdir', 'reclaimed'],
        ['fs:workdir', 'granted'],
      ],
    );
    // 重试是新 state:manifest 快照只含成功轮的 granted 审计。
    assert.deepEqual(
      manifest.audit.map((a) => [a.cap, a.event]),
      [['fs:workdir', 'granted']],
    );
  });
});

describe('grant / revoke 原语与查询', () => {
  it('grant 后可查,revoke 后查询为空且发 reclaimed 审计', async () => {
    const { events, sink } = makeSink();
    const ex = new GrantExecutor(REG, { sink, now: () => NOW });
    await ex.applyBaseline('task-7/w', presetWith([{ cap: 'fs:workdir', scope: 'ro' }]));
    const grant = await ex.grant('task-7/w', {
      cap: 'mcp:github',
      scope: 'write',
      source: 'escalation:req-7',
      ttl: '2026-09-04T18:00:00Z',
    });
    assert.equal(grant.ttl, '2026-09-04T18:00:00Z');
    assert.equal(ex.grantsOf('task-7/w').length, 2);

    const n = await ex.revoke('task-7/w', 'mcp:github');
    assert.equal(n, 1);
    assert.deepEqual(
      ex.grantsOf('task-7/w').map((g) => g.cap),
      ['fs:workdir'],
    );
    const reclaimed = events.filter((e) => e.event === 'reclaimed');
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.cap, 'mcp:github');
    assert.equal(reclaimed[0]?.decision_source, 'auto_rule:baseline');
  });

  it('revoke 不带 scope 回收该 cap 全部 scope;无匹配返回 0', async () => {
    const ex = new GrantExecutor(REG, { now: () => NOW });
    await ex.applyBaseline('task-8/w', presetWith([{ cap: 'fs:workdir', scope: 'ro' }]));
    await ex.grant('task-8/w', { cap: 'fs:workdir', scope: 'rw', source: 'escalation:req-1' });
    assert.equal(await ex.revoke('task-8/w', 'fs:workdir', 'rw'), 1);
    assert.equal(await ex.revoke('task-8/w', 'fs:workdir', 'admin'), 0);
    assert.equal(await ex.revoke('task-8/w', 'fs:workdir'), 1);
    assert.deepEqual(ex.grantsOf('task-8/w'), []);
  });

  it('未注册 agent:manifest 为 undefined、grantsOf 为空、revoke 抛 AgentUnknown', async () => {
    const ex = new GrantExecutor(REG, { now: () => NOW });
    assert.equal(ex.manifest('task-9/nobody'), undefined);
    assert.deepEqual(ex.grantsOf('task-9/nobody'), []);
    await assert.rejects(ex.revoke('task-9/nobody', 'fs:workdir'), AgentUnknown);
  });

  it('grant 校验:未知 cap / scope 不可授 / 重复授予', async () => {
    const ex = new GrantExecutor(REG, { now: () => NOW });
    await assert.rejects(
      ex.grant('task-1/a', { cap: 'nope:x', scope: 'read', source: 'escalation:req-1' }),
      CapUnknown,
    );
    await assert.rejects(
      ex.grant('task-1/a', { cap: 'mcp:github', scope: 'ro', source: 'escalation:req-1' }),
      ScopeNotGrantable,
    );
    await ex.grant('task-1/a', { cap: 'mcp:github', scope: 'read', source: 'escalation:req-1' });
    await assert.rejects(
      ex.grant('task-1/a', { cap: 'mcp:github', scope: 'read', source: 'escalation:req-2' }),
      GrantDuplicate,
    );
  });

  it('decision_source 可覆盖(如 manual:orchestrator),constraint 透传', async () => {
    const ex = new GrantExecutor(REG, {
      now: () => NOW,
      decisionSource: 'manual:default/sess-8f3a',
      actor: 'orchestrator',
    });
    const grant = await ex.grant('task-3/b', {
      cap: 'fs:workdir',
      scope: 'rw',
      source: 'escalation:req-9',
      constraint: { fs_scope_narrowed_to: '${task.workdir}/screenshots' },
      reqId: 'req-9',
    });
    assert.deepEqual(grant.constraint, { fs_scope_narrowed_to: '${task.workdir}/screenshots' });
    const audit = ex.manifest('task-3/b')?.audit ?? [];
    assert.equal(audit[0]?.by, 'orchestrator');
    assert.equal(audit[0]?.decision_source, 'manual:default/sess-8f3a');
    assert.equal(audit[0]?.req_id, 'req-9');
  });
});

describe('自举一致性', () => {
  it('内置默认注册表文档经自身校验(防手写漂移)', () => {
    // defaultRegistry 内部即走 loadCapabilityRegistry;此处断言无异常且条目数
    assert.ok(defaultRegistry().capabilities.length >= 3);
  });

  it('RegistryInvalid 携带问题清单', () => {
    try {
      defaultRegistry();
    } catch {
      assert.fail('默认注册表必须合法');
    }
    assert.ok(new RegistryInvalid(['a', 'b']).issues.length === 2);
  });
});
