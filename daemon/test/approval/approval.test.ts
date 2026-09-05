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
