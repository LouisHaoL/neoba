/**
 * 审批流测试(§3.3):分层策略评估(builtin<global<preset<session,require
 * 优先)、协议硬底线不可豁免、自动放行(TTL 授予 + auto_rule 审计)、人工
 * 定案(manual 审计 + 窄化)、TTL 到期回收、重复 req_id / 未知单。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ApprovalBoard,
  BUILTIN_LAYER,
  RequestDuplicate,
  RequestUnknown,
  evaluateRequest,
  policyStack,
  presetPolicyLayer,
} from '../../src/approval/index.ts';
import type { ApprovalEventInput, PolicyLayer, ToolRequestSpec } from '../../src/approval/index.ts';
import type { Event } from '../../src/events/index.ts';
import {
  CapUnknown,
  GrantExecutor,
  ScopeNotGrantable,
  defaultRegistry,
  minimalPresetDoc,
  parsePreset,
} from '../../src/capability/index.ts';
import type { LoadedRegistry } from '../../src/capability/index.ts';

// ---------------------------------------------------------------- fixtures

/** 带扩展能力(risk 分级)的注册表。 */
function registry(): LoadedRegistry {
  return defaultRegistry(); // fs:workdir(low) / mcp:playwright(medium) / mcp:github(medium, admin)
}

function highRiskRegistry(): LoadedRegistry {
  // 手写注入 high 风险能力(hardline 场景)。
  const capabilities = [
    {
      id: 'mcp:prod-db',
      kind: 'mcp_server',
      description: '生产库',
      risk_level: 'high',
      grantable_scopes: ['read', 'write', 'admin'],
    },
    {
      id: 'mcp:no-risk-declared',
      kind: 'mcp_server',
      description: '未声明风险等级',
      grantable_scopes: ['read', 'write'],
    },
  ] as const;
  return {
    protocol: '1.0',
    spec_version: '1.0',
    capabilities,
    get(id: string) {
      return capabilities.find((c) => c.id === id);
    },
  } as unknown as LoadedRegistry;
}

function board(options: Partial<ConstructorParameters<typeof ApprovalBoard>[0]> = {}) {
  const events: ApprovalEventInput[] = [];
  const grants = new GrantExecutor(options.registry ?? registry());
  const layers = options.layers ?? (() => []);
  const b = new ApprovalBoard({
    registry: options.registry ?? registry(),
    grants,
    emit: (ev) => {
      events.push(ev);
    },
    layers,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { board: b, grants, events };
}

function request(overrides: Partial<ToolRequestSpec> = {}): ToolRequestSpec {
  return {
    from: 'task-42/e2e-tester-01',
    reqId: 'req-7',
    cap: 'mcp:playwright',
    reason: '需要截图验证登录流程渲染结果',
    scope: 'write',
    duration: '2h',
    ...overrides,
  };
}

// ---------------------------------------------------------------- 策略评估

describe('approval/policy 分层评估', () => {
  it('内置缺省:清单外一律 require', () => {
    const verdict = evaluateRequest([BUILTIN_LAYER], 'mcp:playwright', 'write');
    assert.equal(verdict.outcome, 'require');
  });

  it('特异性裁决:session 精确 auto 覆盖 preset 通配 require', () => {
    const stack = policyStack({
      preset: { id: 'preset:e2e-tester', policy: { auto_approve: [], require_approval: ['mcp:*'] } },
      session: { id: 'session:main', policy: { auto_approve: ['mcp:playwright'], require_approval: [] } },
    });
    const verdict = evaluateRequest(stack, 'mcp:playwright', 'write', 'medium');
    assert.equal(verdict.outcome, 'auto');
    assert.equal(verdict.ruleId, 'session:main');
    // 非精确命中的 cap 仍落 preset 通配 require。
    assert.equal(evaluateRequest(stack, 'mcp:github', 'write', 'medium').outcome, 'require');
  });

  it('同特异性 require 胜(从严)', () => {
    const stack = policyStack({
      global: { auto_approve: ['*'], require_approval: ['mcp:github'] },
    });
    assert.equal(evaluateRequest(stack, 'mcp:github', 'write', 'medium').outcome, 'require');
    assert.equal(evaluateRequest(stack, 'fs:workdir', 'rw', 'low').outcome, 'auto');
  });

  it('层内命名空间通配压过整串通配', () => {
    const stack = policyStack({
      preset: { id: 'preset:x', policy: { auto_approve: ['mcp:*'], require_approval: ['*'] } },
    });
    assert.equal(evaluateRequest(stack, 'mcp:playwright', 'read', 'medium').outcome, 'auto');
    assert.equal(evaluateRequest(stack, 'fs:workdir', 'rw', 'low').outcome, 'require');
  });

  it('硬底线不可豁免:high+write 层栈再宽也 require', () => {
    const wide = policyStack({
      session: { id: 'session:loose', policy: { auto_approve: ['*'], require_approval: [] } },
    });
    const verdict = evaluateRequest(wide, 'mcp:prod-db', 'write', 'high');
    assert.equal(verdict.outcome, 'require');
    assert.equal(verdict.ruleId, 'hardline:forbidden');
    // 特异性再高也压不过硬底线(精确 auto 命中同样被拦)。
    const specific = policyStack({
      session: { id: 'session:loose', policy: { auto_approve: ['mcp:prod-db'], require_approval: [] } },
    });
    assert.equal(evaluateRequest(specific, 'mcp:prod-db', 'admin', 'high').ruleId, 'hardline:forbidden');
  });

  it('硬底线 fail-closed:risk 缺失一律 require', () => {
    const wide = policyStack({
      session: { id: 'session:loose', policy: { auto_approve: ['*'], require_approval: [] } },
    });
    const verdict = evaluateRequest(wide, 'mcp:no-risk-declared', 'read', undefined);
    assert.equal(verdict.outcome, 'require');
    assert.equal(verdict.ruleId, 'hardline:unknown_risk');
  });
});

// ---------------------------------------------------------------- Board

describe('approval/board 自动放行', () => {
  it('auto 层命中 → 即刻授予 + TTL + auto_rule 审计 + 事件对', async () => {
    const preset = parsePreset(
      minimalPresetDoc({
        name: 'e2e-tester',
        escalation_policy: { auto_approve: ['mcp:playwright'], require_approval: ['*'] },
      }),
    );
    const { board: b, grants, events } = board({
      layers: () => [presetPolicyLayer('e2e-tester', preset)],
      now: () => new Date('2026-09-05T00:00:00Z'),
    });
    const result = await b.submit(request());
    assert.equal(result.status, 'auto_granted');
    if (result.status !== 'auto_granted') return;
    assert.equal(result.record.decisionSource, 'auto_rule:preset:e2e-tester');
    const grant = grants.grantsOf('task-42/e2e-tester-01')[0];
    assert.equal(grant?.source, 'escalation:req-7');
    assert.equal(grant?.ttl, '2026-09-05T02:00:00.000Z'); // 2h
    assert.deepEqual(
      events.map((e) => e.type),
      ['approval.requested', 'approval.decided'],
    );
    // grant 审计经 GrantExecutor sink 无注入(默认无 sink),manifest 有记录。
    assert.equal(result.manifest.grants.length, 1);
    assert.equal(result.manifest.audit[0]?.decision_source, 'auto_rule:preset:e2e-tester');
  });

  it('未命中 auto → pending,等人定案', async () => {
    const { board: b } = board();
    const result = await b.submit(request({ reqId: 'req-8' }));
    assert.equal(result.status, 'pending');
    assert.deepEqual(b.listPending().map((r) => r.reqId), ['req-8']);
  });

  it('重复 req_id 抛 RequestDuplicate;cap/scope 非法直接抛', async () => {
    const { board: b } = board();
    await b.submit(request());
    await assert.rejects(b.submit(request()), RequestDuplicate);
    await assert.rejects(b.submit(request({ reqId: 'req-9', cap: 'nope:nope' })), CapUnknown);
    await assert.rejects(
      b.submit(request({ reqId: 'req-9', scope: 'admin' })),
      (err: unknown) => err instanceof ScopeNotGrantable && err.cap === 'mcp:playwright',
    );
  });
});

describe('approval/board 人工定案', () => {
  it('granted + narrowedTo:manual 审计 + constraint 窄化', async () => {
    const { board: b, grants, events } = board({ now: () => new Date('2026-09-05T00:00:00Z') });
    await b.submit(request({ reqId: 'req-10' }));
    const result = await b.decide('req-10', 'granted', 'orchestrator:main', {
      narrowedTo: '${task.workdir}/screenshots',
    });
    assert.equal(result.status, 'granted');
    if (result.status !== 'granted') return;
    assert.equal(result.record.decisionSource, 'manual:orchestrator:main');
    const grant = grants.grantsOf('task-42/e2e-tester-01')[0];
    assert.equal(grant?.constraint?.['fs_scope_narrowed_to'], '${task.workdir}/screenshots');
    const decided = events.find((e) => e.type === 'approval.decided');
    assert.ok(decided && (decided.payload as { decision?: string }).decision === 'granted');
    assert.equal(b.listPending().length, 0);
  });

  it('denied:无授予,事件照记', async () => {
    const { board: b, grants, events } = board();
    await b.submit(request({ reqId: 'req-11' }));
    const result = await b.decide('req-11', 'denied', 'orchestrator:main');
    assert.equal(result.status, 'denied');
    assert.equal(grants.grantsOf('task-42/e2e-tester-01').length, 0);
    assert.ok(events.some((e) => e.type === 'approval.decided'));
  });

  it('定案后重复定案 / 未知单 → RequestUnknown', async () => {
    const { board: b } = board();
    await b.submit(request({ reqId: 'req-12' }));
    await b.decide('req-12', 'granted', 'o');
    await assert.rejects(b.decide('req-12', 'denied', 'o'), RequestUnknown);
    await assert.rejects(b.decide('req-404', 'granted', 'o'), RequestUnknown);
  });
});

describe('approval/board TTL 回收', () => {
  it('到期 escalation 授予被回收,基线授予不受影响', async () => {
    let now = Date.parse('2026-09-05T00:00:00Z');
    const { board: b, grants } = board({
      registry: highRiskRegistry(),
      layers: () => [], // 全 require → 走人工
      now: () => new Date(now),
    });
    // 人工批一条 1h 的 mcp:prod-db write(硬底线允许人工批)。
    await b.submit(request({ reqId: 'req-13', cap: 'mcp:prod-db', scope: 'write', duration: '1h' }));
    await b.decide('req-13', 'granted', 'orchestrator:main');
    assert.equal(grants.grantsOf('task-42/e2e-tester-01').length, 1);
    // 未到期:回收 0。
    now += 30 * 60_000;
    assert.equal(await b.reclaimExpired(), 0);
    // 到期:回收 1。
    now += 31 * 60_000;
    assert.equal(await b.reclaimExpired(), 1);
    assert.equal(grants.grantsOf('task-42/e2e-tester-01').length, 0);
  });

  it('pending 单不受 reclaim 影响(只回收已授予)', async () => {
    const { board: b } = board({ now: () => new Date(Date.parse('2026-09-05T00:00:00Z') + 10 * 3600_000) });
    await b.submit(request({ reqId: 'req-14' }));
    assert.equal(await b.reclaimExpired(), 0);
    assert.equal(b.listPending().length, 1);
  });
});

describe('approval/board 层栈兜底', () => {
  it('layers 工厂不含 builtin 时自动补栈底(从严缺省生效)', async () => {
    const { board: b } = board({ layers: () => [] });
    const result = await b.submit(request({ reqId: 'req-15' }));
    assert.equal(result.status, 'pending');
  });

  it('presetPolicyLayer 取预设的 escalation_policy', () => {
    const preset = parsePreset(
      minimalPresetDoc({
        name: 'coder',
        escalation_policy: { auto_approve: ['fs:workdir'], require_approval: ['*'] },
      }),
    );
    const layer = presetPolicyLayer('coder', preset);
    assert.equal(layer.id, 'preset:coder');
    assert.deepEqual(layer.policy.auto_approve, ['fs:workdir']);
  });
});

// ---------------------------------------------------------------- issue #14

/** 台账事件(测试注入)→ 落盘 Event 形状(带 seq / ts / principal)。
 *  principal 拆存与 makeApprovalEmit 一致:agent = 实例名,task = 任务 id。 */
function asEvents(inputs: readonly ApprovalEventInput[], agentId: string): Event[] {
  const idx = agentId.indexOf('/');
  return inputs.map((e, i) => ({
    v: '1.0',
    seq: i + 1,
    ts: new Date(Date.parse('2026-09-05T00:00:00Z') + i * 1_000).toISOString(),
    type: e.type,
    principal: {
      tenant: 'default',
      session: 'main',
      task: idx > 0 ? agentId.slice(0, idx) : null,
      agent: idx > 0 ? agentId.slice(idx + 1) : agentId,
    },
    payload: e.payload as never,
  }));
}

describe('approval/board 事件重放重建(#14)', () => {
  it('pending 单 → 新 board 重放事件 → decide 成功(重启后不再 RequestUnknown)', async () => {
    const first = board({ now: () => new Date('2026-09-05T00:00:00Z') });
    await first.board.submit(request({ reqId: 'req-20' }));
    const logged = asEvents(first.events, 'task-42/e2e-tester-01');

    const second = board({ now: () => new Date('2026-09-05T00:00:00Z') });
    const report = second.board.restoreFromEvents(logged);
    assert.deepEqual(report, { restored: 1, skipped: 0 });
    assert.deepEqual(second.board.listPending().map((r) => r.reqId), ['req-20']);

    const result = await second.board.decide('req-20', 'granted', 'orchestrator:main');
    assert.equal(result.status, 'granted');
    const grant = second.grants.grantsOf('task-42/e2e-tester-01')[0];
    assert.equal(grant?.source, 'escalation:req-20');
    assert.equal(grant?.ttl, '2026-09-05T02:00:00.000Z'); // duration 随事件重放,2h
    assert.equal(second.board.listPending().length, 0);
  });

  it('旧事件缺 duration 向前兼容重建;decided 闭合状态;无主 decided 计 skipped', () => {
    const { board: b } = board();
    const report = b.restoreFromEvents([
      {
        v: '1.0',
        seq: 1,
        ts: '2026-09-05T00:00:00.000Z',
        type: 'approval.requested',
        principal: { tenant: 'default', session: 'main', task: 'task-42', agent: 'e2e-tester-01' },
        // 旧版 payload 无 duration → 保守缺省 1h 重建,旧 pending 单仍可定案。
        payload: { reqId: 'req-old', cap: 'mcp:playwright', scope: 'write', reason: '旧格式' },
      },
      {
        v: '1.0',
        seq: 2,
        ts: '2026-09-05T00:01:00.000Z',
        type: 'approval.decided',
        principal: { tenant: 'default', session: 'main', task: 'task-42', agent: 'e2e-tester-01' },
        payload: { reqId: 'req-old', decision: 'granted', decisionSource: 'manual:boss' },
      },
      {
        v: '1.0',
        seq: 3,
        ts: '2026-09-05T00:02:00.000Z',
        type: 'approval.decided',
        principal: { tenant: 'default', session: 'main', task: 'task-42', agent: 'e2e-tester-01' },
        payload: { reqId: 'req-orphan', decision: 'denied', decisionSource: 'manual:boss' },
      },
    ]);
    assert.deepEqual(report, { restored: 1, skipped: 1 });
    const record = b.listAll().find((r) => r.reqId === 'req-old');
    assert.equal(record?.status, 'granted');
    assert.equal(record?.agentId, 'task-42/e2e-tester-01'); // principal 重组完整 agentId
    assert.equal(record?.duration, '1h');
    assert.equal(record?.decidedBy, 'boss');
    assert.equal(record?.decisionSource, 'manual:boss');
    assert.equal(record?.submittedAt, '2026-09-05T00:00:00.000Z');
    assert.equal(record?.decidedAt, '2026-09-05T00:01:00.000Z');
    assert.equal(b.listPending().length, 0);
  });

  it('auto 放行的 decided 重放后 decision_source / decidedBy 还原', async () => {
    const preset = parsePreset(
      minimalPresetDoc({
        name: 'e2e-tester',
        escalation_policy: { auto_approve: ['mcp:playwright'], require_approval: ['*'] },
      }),
    );
    const first = board({
      layers: () => [presetPolicyLayer('e2e-tester', preset)],
      now: () => new Date('2026-09-05T00:00:00Z'),
    });
    await first.board.submit(request({ reqId: 'req-21' }));
    const second = board({ layers: () => [presetPolicyLayer('e2e-tester', preset)] });
    second.board.restoreFromEvents(asEvents(first.events, 'task-42/e2e-tester-01'));
    const record = second.board.listAll().find((r) => r.reqId === 'req-21');
    assert.equal(record?.status, 'granted');
    assert.equal(record?.decisionSource, 'auto_rule:preset:e2e-tester');
    assert.equal(record?.decidedBy, 'daemon');
  });
});

describe('approval/board reqId 并发去重(#14)', () => {
  it('并发同 reqId 双提交:只一份成功,只落一份 requested 事件', async () => {
    const { board: b, events } = board();
    const results = await Promise.allSettled([
      b.submit(request({ reqId: 'req-30' })),
      b.submit(request({ reqId: 'req-30' })),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const dup = rejected[0];
    assert.ok(dup !== undefined && dup.status === 'rejected' && dup.reason instanceof RequestDuplicate);
    assert.equal(events.filter((e) => e.type === 'approval.requested').length, 1);
    assert.equal(b.listPending().length, 1);
  });

  it('事件落盘失败:占位回滚,同 reqId 可重新提交', async () => {
    let emitBroken = true;
    const grants = new GrantExecutor(registry());
    const b = new ApprovalBoard({
      registry: registry(),
      grants,
      emit: (ev) => {
        if (emitBroken) throw new Error('log io boom');
        void ev;
      },
      layers: () => [],
    });
    await assert.rejects(b.submit(request({ reqId: 'req-31' })), /log io boom/);
    assert.equal(b.listPending().length, 0);
    emitBroken = false;
    const result = await b.submit(request({ reqId: 'req-31' }));
    assert.equal(result.status, 'pending');
  });
});

describe('approval/board decide 先授予后定案(#14)', () => {
  it('授予失败:单子保持 pending 可重试,不落 decided 事件', async () => {
    const realGrants = new GrantExecutor(registry());
    let failGrant = true;
    const flaky = {
      grant: (agentId: string, spec: Parameters<GrantExecutor['grant']>[1]) => {
        if (failGrant) return Promise.reject(new Error('AGENT_ID_INVALID: 模拟授予失败'));
        return realGrants.grant(agentId, spec);
      },
      revoke: realGrants.revoke.bind(realGrants),
      manifest: realGrants.manifest.bind(realGrants),
      allGrants: realGrants.allGrants.bind(realGrants),
      grantsOf: realGrants.grantsOf.bind(realGrants),
    } as unknown as GrantExecutor;
    const events: ApprovalEventInput[] = [];
    const b = new ApprovalBoard({
      registry: registry(),
      grants: flaky,
      emit: (ev) => {
        events.push(ev);
      },
      layers: () => [],
    });
    await b.submit(request({ reqId: 'req-32' }));
    // 第一次定案:授予侧失败 → 抛错,状态未动,可重试。
    await assert.rejects(b.decide('req-32', 'granted', 'orchestrator:main'), /AGENT_ID_INVALID/);
    assert.deepEqual(b.listPending().map((r) => r.reqId), ['req-32']);
    assert.ok(!events.some((e) => e.type === 'approval.decided'));
    // 重试:授予成功 → 正常定案落事件。
    failGrant = false;
    const result = await b.decide('req-32', 'granted', 'orchestrator:main');
    assert.equal(result.status, 'granted');
    assert.equal(realGrants.grantsOf('task-42/e2e-tester-01')[0]?.source, 'escalation:req-32');
    assert.ok(events.some((e) => e.type === 'approval.decided'));
    assert.equal(b.listPending().length, 0);
  });
});
