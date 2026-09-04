/**
 * session 模块测试(§3.0):
 * 1. session.init 合法/非法校验 + 未知字段忽略(§3.0 规则 1)
 * 2. semver 比较 + 版本兼容:相邻 major 放行、不相邻拒绝、minor 漂移 warning
 * 3. 能力协商与降级说明(含 daemon 关闭 broadcast 的降级)
 * 4. 文档类 kind→版本映射协商(§3.0 v0.2 补充)与按 kind 报告的错误
 * 5. 会话注册表:lookup / list / close / expire
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DocumentKindMismatch,
  InvalidHandshake,
  SessionDuplicate,
  SessionRegistry,
  VersionIncompatible,
  buildDegradations,
  buildSessionResponse,
  checkDocumentKind,
  checkDocumentKindSupported,
  checkProtocolCompat,
  REQUIRED_DOCUMENT_KINDS,
  compareSemver,
  defaultProfile,
  handleSessionInit,
  parseSemver,
  parseSessionInit,
} from '../../src/session/index.ts';
import { DEFAULT_DOCUMENT_KINDS } from '../../src/session/semver.ts';

const PROFILE = defaultProfile('0.1.0');

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    method: 'session.init',
    params: {
      protocol: '1.0',
      role: 'orchestrator',
      principal: { tenant: 'default', session: 'sess-8f3a' },
      harness: 'claude-code',
      capabilities: { broadcast: false, async_events: true, interactive_approval: true },
      ...overrides,
    },
    ...{},
  };
}

// ---------------------------------------------------------------- 合法/非法

describe('session.init 校验', () => {
  it('合法请求解析出全部字段', () => {
    const req = parseSessionInit(validRequest());
    assert.equal(req.method, 'session.init');
    assert.equal(req.params.protocol, '1.0');
    assert.equal(req.params.role, 'orchestrator');
    assert.deepEqual(req.params.principal, { tenant: 'default', session: 'sess-8f3a' });
    assert.equal(req.params.harness, 'claude-code');
    assert.equal(req.params.capabilities.broadcast, false);
    assert.equal(req.params.capabilities.async_events, true);
  });

  it('role 三枚举均合法', () => {
    for (const role of ['orchestrator', 'planner', 'observer']) {
      const req = parseSessionInit(validRequest({ role }));
      assert.equal(req.params.role, role);
    }
  });

  const base = validRequest()['params'] as Record<string, unknown>;
  const invalid: Array<[string, unknown, string]> = [
    ['method 错误', { method: 'session.hello' }, 'method'],
    ['缺 params', null, 'params'],
    ['protocol 非 1.0', { protocol: '2.0' }, 'protocol'],
    ['role 非法', { role: 'worker' }, 'role'],
    ['缺 principal', { principal: undefined }, 'principal'],
    ['principal 缺 session', { principal: { tenant: 'default' } }, 'principal.session'],
    ['principal 空 tenant', { principal: { tenant: '', session: 's' } }, 'principal.tenant'],
    ['缺 harness', { harness: '' }, 'harness'],
    ['缺 capabilities', { capabilities: undefined }, 'capabilities'],
    ['capabilities 非对象', { capabilities: true }, 'capabilities'],
    ['capability 位非布尔', { capabilities: { broadcast: 'yes' } }, 'capabilities.broadcast'],
  ];
  for (const [name, override, field] of invalid) {
    it(`非法: ${name}`, () => {
      const methodOverride =
        override !== null && typeof (override as Record<string, unknown>)['method'] === 'string'
          ? { method: (override as Record<string, unknown>)['method'] as string }
          : {};
      const doc =
        override === null
          ? { method: 'session.init' }
          : { ...validRequest(), ...methodOverride, params: { ...base, ...override } };
      assert.throws(
        () => parseSessionInit(doc),
        (err: unknown) =>
          err instanceof InvalidHandshake && err.field.startsWith(field.split('.')[0] ?? field),
      );
    });
  }

  it('未知字段忽略:顶层/params/capabilities 内未知键不报错、不透传', () => {
    const doc = validRequest();
    doc['extra_top'] = 1;
    (doc['params'] as Record<string, unknown>)['unknown_param'] = { x: 1 };
    ((doc['params'] as Record<string, unknown>)['capabilities'] as Record<string, unknown>)[
      'telepathy'
    ] = true;
    const req = parseSessionInit(doc);
    assert.equal(req.params.role, 'orchestrator');
    assert.equal('unknown_param' in req.params, false);
    assert.equal('telepathy' in req.params.capabilities, false);
  });

  it('capabilities 缺省键按 undefined(= 不支持)处理', () => {
    const req = parseSessionInit(validRequest({ capabilities: {} }));
    assert.equal(req.params.capabilities.broadcast, undefined);
  });
});

// ---------------------------------------------------------------- 版本兼容

describe('semver 与版本兼容策略(§3.0 v0.2)', () => {
  it('parseSemver 接受 1.0 / 1.0.0,拒绝垃圾输入', () => {
    assert.deepEqual(parseSemver('1.0'), { major: 1, minor: 0, patch: 0 });
    assert.deepEqual(parseSemver('2.13.7'), { major: 2, minor: 13, patch: 7 });
    assert.equal(parseSemver('v1.0'), null);
    assert.equal(parseSemver('1'), null);
  });

  it('compareSemver 按 major→minor→patch 三态比较', () => {
    assert.equal(compareSemver(parseSemver('1.0')!, parseSemver('1.0.0')!), 0);
    assert.equal(compareSemver(parseSemver('1.2')!, parseSemver('1.10')!), -1);
    assert.equal(compareSemver(parseSemver('2.0')!, parseSemver('1.9.9')!), 1);
    assert.equal(compareSemver(parseSemver('1.0.1')!, parseSemver('1.0')!), 1);
  });

  it('major 相同:exact 无 warning;minor 漂移放行并带 warning', () => {
    const exact = checkProtocolCompat('1.0', ['1.0']);
    assert.equal(exact.compatible, true);
    assert.equal(exact.level, 'exact');
    assert.equal(exact.warning, null);

    const drift = checkProtocolCompat('1.0', ['1.4']);
    assert.equal(drift.compatible, true);
    assert.equal(drift.level, 'minor-drift');
    assert.match(drift.warning as string, /minor/);
  });

  it('major 相邻(差 1)放行并带 warning;不相邻(差 >= 2)拒绝', () => {
    const adjacent = checkProtocolCompat('1.0', ['2.0']);
    assert.equal(adjacent.compatible, true);
    assert.equal(adjacent.level, 'major-adjacent');
    assert.match(adjacent.warning as string, /相邻/);

    const far = checkProtocolCompat('1.0', ['3.0']);
    assert.equal(far.compatible, false);
    assert.equal(far.level, 'incompatible');
  });

  it('取最接近的命中:exact 优先于漂移', () => {
    const r = checkProtocolCompat('1.2', ['1.2', '1.4', '2.0']);
    assert.equal(r.level, 'exact');
    assert.equal(r.matched, '1.2');
  });

  it('握手时协议不兼容抛类型化 VersionIncompatible', () => {
    const profile: typeof PROFILE = {
      ...PROFILE,
      supportedProtocols: ['3.0'],
    };
    assert.throws(
      () => buildSessionResponse(profile, parseSessionInit(validRequest())),
      (err: unknown) =>
        err instanceof VersionIncompatible &&
        err.code === 'PROTOCOL_VERSION_REJECTED' &&
        err.clientVersion === '1.0' &&
        err.supported.includes('3.0'),
    );
  });

  it('握手时 minor 漂移:应答放行,warning 经旁路携带(schema 应答无 warnings 字段)', () => {
    const profile: typeof PROFILE = { ...PROFILE, supportedProtocols: ['1.2'] };
    const registry = new SessionRegistry();
    const result = handleSessionInit(validRequest(), profile, registry);
    assert.equal(result.response.protocol, '1.0');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] as string, /minor/);
    assert.deepEqual(result.session.warnings, result.warnings);
  });
});

// ---------------------------------------------------------------- 能力协商降级

describe('能力协商与降级说明', () => {
  it('双方都支持 → 无降级', () => {
    const req = parseSessionInit(
      validRequest({ capabilities: { broadcast: true, async_events: true, interactive_approval: true } }),
    );
    const { response } = buildSessionResponse(PROFILE, req);
    assert.deepEqual(response.degradations, []);
    assert.deepEqual(response.capabilities, {
      broadcast: true,
      async_events: true,
      interactive_approval: true,
    });
  });

  it('接入方不支持 broadcast → 降级为逐个点对点投递', () => {
    const req = parseSessionInit(validRequest());
    const { response } = buildSessionResponse(PROFILE, req);
    const d = response.degradations.find((x) => x.feature === 'broadcast');
    assert.ok(d);
    assert.match(d.reason, /点对点/);
  });

  it('接入方请求 broadcast 但 daemon 已关闭 → 给出 daemon 关闭的降级说明', () => {
    const profile: typeof PROFILE = {
      ...PROFILE,
      capabilities: { ...PROFILE.capabilities, broadcast: false },
    };
    const req = parseSessionInit(validRequest({ capabilities: { broadcast: true } }));
    const { response } = buildSessionResponse(profile, req);
    const d = response.degradations.find((x) => x.feature === 'broadcast');
    assert.ok(d);
    assert.match(d.reason, /daemon 已关闭/);
  });

  it('双方都不支持 → 不产生降级说明(无人需要)', () => {
    const profile: typeof PROFILE = {
      ...PROFILE,
      capabilities: { ...PROFILE.capabilities, broadcast: false },
    };
    const req = parseSessionInit(validRequest({ capabilities: { broadcast: false } }));
    const { response } = buildSessionResponse(profile, req);
    assert.equal(response.degradations.find((x) => x.feature === 'broadcast'), undefined);
  });

  it('buildDegradations 纯函数:协商后能力 = 双方 AND', () => {
    const degs = buildDegradations(
      { broadcast: false },
      { broadcast: true, async_events: false, interactive_approval: false },
    );
    assert.equal(degs.length, 1);
    assert.equal(degs[0]?.feature, 'broadcast');
  });
});

// ---------------------------------------------------------------- 完整握手 + kind 映射

describe('完整握手与会话登记', () => {
  it('握手成功:应答字段齐全(spec_version/daemon_version/capabilities/document_kinds/degradations)', () => {
    const registry = new SessionRegistry();
    const result = handleSessionInit(validRequest(), PROFILE, registry, {
      now: new Date('2026-09-04T10:00:00Z'),
    });
    assert.equal(result.response.spec_version, '1.0');
    assert.equal(result.response.daemon_version, '0.1.0');
    assert.equal(result.response.protocol, '1.0');
    assert.ok(Array.isArray(result.response.degradations));
    for (const kind of REQUIRED_DOCUMENT_KINDS) {
      assert.deepEqual(result.response.document_kinds[kind], ['1.0'], kind);
    }
    // 文档类 kind→版本映射(§3.0 v0.2 补充)是应答必需字段,并落在会话记录
    assert.deepEqual(result.response.document_kinds, DEFAULT_DOCUMENT_KINDS);
    assert.deepEqual(result.session.documentKinds, DEFAULT_DOCUMENT_KINDS);
    assert.equal(result.session.connectedAt, '2026-09-04T10:00:00.000Z');
    assert.equal(registry.lookup('default', 'sess-8f3a')?.role, 'orchestrator');
  });

  it('重复握手同 tenant 同 session id → SessionDuplicate', () => {
    const registry = new SessionRegistry();
    handleSessionInit(validRequest(), PROFILE, registry);
    assert.throws(
      () => handleSessionInit(validRequest(), PROFILE, registry),
      (err: unknown) => err instanceof SessionDuplicate,
    );
  });

  it('带 ttlMs 的握手写入 expiresAt', () => {
    const registry = new SessionRegistry();
    const now = new Date('2026-09-04T10:00:00Z');
    handleSessionInit(validRequest(), PROFILE, registry, { now, ttlMs: 60_000 });
    assert.equal(registry.lookup('default', 'sess-8f3a')?.expiresAt, '2026-09-04T10:01:00.000Z');
  });
});

describe('文档类 kind→版本映射协商(§3.0 v0.2 补充)', () => {
  it('版本交集命中:取双方都支持的版本', () => {
    const r = checkDocumentKind('workflow', ['1.0', '1.1'], ['1.0']);
    assert.equal(r.compatible, true);
    assert.equal(r.matched, '1.0');
    assert.equal(r.kindSupported, true);
  });

  it('版本无交集 → 不兼容(kind 级仍是支持的)', () => {
    const r = checkDocumentKind('preset', ['2.0'], ['1.0']);
    assert.equal(r.compatible, false);
    assert.equal(r.matched, null);
    assert.equal(r.kindSupported, true);
  });

  it('kind 不在 daemon 映射 → checkDocumentKindSupported 报 kindSupported=false', () => {
    const r = checkDocumentKindSupported('scheduler', ['1.0'], DEFAULT_DOCUMENT_KINDS);
    assert.equal(r.compatible, false);
    assert.equal(r.kindSupported, false);
  });

  it('映射不匹配的错误语义 = 按 kind 报告(kind + 期望版本 + 支持列表)', () => {
    const supported = DEFAULT_DOCUMENT_KINDS['workflow'] ?? [];
    const err = new DocumentKindMismatch('workflow', '2.0', supported, true);
    assert.equal(err.code, 'DOCUMENT_KIND_MISMATCH');
    assert.match(err.message, /kind=workflow/);
    assert.match(err.message, /2\.0/);
    assert.match(err.message, /1\.0/);
    assert.equal(err.expected, '2.0');
    assert.deepEqual(err.supported, supported);
    // 可转成 handshake 应答 errors 数组项的协议结构(schema documentKindMismatchError)
    assert.deepEqual(err.toProtocol(), {
      code: 'document_kind_version_mismatch',
      kind: 'workflow',
      expected: '2.0',
      supported,
    });
  });

  it('内置映射覆盖 preset/intent/workflow/artifact-manifest 四个 kind', () => {
    for (const kind of ['preset', 'intent', 'workflow', 'artifact-manifest']) {
      const r = checkDocumentKindSupported(kind, ['1.0'], DEFAULT_DOCUMENT_KINDS);
      assert.equal(r.compatible, true, kind);
    }
  });
});

// ---------------------------------------------------------------- 会话注册表

describe('会话注册表', () => {
  function record(session: string, expiresAt: string | null = null) {
    return {
      tenant: 'default',
      session,
      role: 'orchestrator' as const,
      harness: 'claude-code',
      capabilities: { broadcast: true, async_events: true, interactive_approval: true },
      warnings: [],
      documentKinds: DEFAULT_DOCUMENT_KINDS,
      connectedAt: '2026-09-04T10:00:00.000Z',
      expiresAt,
    };
  }

  it('register/lookup/list/close', () => {
    const registry = new SessionRegistry();
    registry.register(record('a'));
    registry.register(record('b'));
    registry.register({ ...record('c'), tenant: 'acme' });
    assert.equal(registry.size, 3);
    assert.equal(registry.lookup('default', 'a')?.session, 'a');
    assert.equal(registry.lookup('acme', 'a'), undefined);
    assert.equal(registry.list().length, 3);
    assert.equal(registry.list('acme').length, 1);
    assert.equal(registry.close('default', 'a'), true);
    assert.equal(registry.close('default', 'a'), false);
    assert.equal(registry.lookup('default', 'a'), undefined);
  });

  it('重复登记同 tenant 同 session → SessionDuplicate;跨 tenant 同名允许', () => {
    const registry = new SessionRegistry();
    registry.register(record('a'));
    assert.throws(() => registry.register(record('a')), SessionDuplicate);
    registry.register({ ...record('a'), tenant: 'acme' });
    assert.equal(registry.size, 2);
  });

  it('expire 只回收已过期会话,返回其 session id', () => {
    const registry = new SessionRegistry();
    registry.register(record('live', '2026-09-04T12:00:00Z'));
    registry.register(record('dead', '2026-09-04T09:00:00Z'));
    registry.register(record('forever', null));
    const expired = registry.expire(new Date('2026-09-04T10:00:00Z'));
    assert.deepEqual(expired, ['dead']);
    assert.equal(registry.lookup('default', 'dead'), undefined);
    assert.equal(registry.lookup('default', 'live')?.session, 'live');
    assert.equal(registry.lookup('default', 'forever')?.session, 'forever');
  });
});
