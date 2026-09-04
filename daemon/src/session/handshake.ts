/**
 * 握手处理(§3.0):session.init 校验 + daemon 应答生成 + 版本兼容策略落地。
 *
 * parseSessionInit / buildSessionResponse / handleSessionInit。
 * 校验严格按 handshake.schema.json 的字段与取值;§3.0 规则 1
 * "接收方必须忽略未知字段" 在此落地为:未知键一律不校验、不报错、不透传。
 */
import { InvalidHandshake, ProfileInvalid, VersionIncompatible } from './errors.ts';
import {
  checkProtocolCompat,
  DEFAULT_DOCUMENT_KINDS,
  DOC_VERSION_RE,
  parseSemver,
  REQUIRED_DOCUMENT_KINDS,
} from './semver.ts';
import { SessionRegistry } from './registry.ts';
import type {
  ClientCapabilities,
  DaemonCapabilities,
  DaemonProfile,
  Degradation,
  HandshakeFeature,
  HandshakeResult,
  SessionInitRequest,
  SessionInitResponse,
  SessionRole,
} from './types.ts';

export const SPEC_VERSION = '1.0';

const ROLES: readonly SessionRole[] = ['orchestrator', 'planner', 'observer'];
const FEATURES: readonly HandshakeFeature[] = [
  'broadcast',
  'async_events',
  'interactive_approval',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 解析并校验 session.init 请求。schema 之外的字段按 §3.0 规则 1 忽略;
 * 结构非法抛 InvalidHandshake(类型化错误)。
 */
export function parseSessionInit(raw: unknown): SessionInitRequest {
  if (!isPlainObject(raw)) {
    throw new InvalidHandshake('body', '必须是 JSON 对象');
  }
  if (raw['method'] !== 'session.init') {
    throw new InvalidHandshake('method', '必须为 "session.init"');
  }
  const params = raw['params'];
  if (!isPlainObject(params)) {
    throw new InvalidHandshake('params', '必须是对象');
  }
  if (params['protocol'] !== '1.0') {
    throw new InvalidHandshake('protocol', '协议版本冻结为 "1.0"');
  }
  const role = params['role'];
  if (typeof role !== 'string' || !ROLES.includes(role as SessionRole)) {
    throw new InvalidHandshake(
      'role',
      `必须是 ${ROLES.join(' | ')} 之一`,
    );
  }
  const principal = params['principal'];
  if (!isPlainObject(principal)) {
    throw new InvalidHandshake('principal', '必须是对象');
  }
  if (!nonEmptyString(principal['tenant'])) {
    throw new InvalidHandshake('principal.tenant', '必须是非空字符串');
  }
  if (!nonEmptyString(principal['session'])) {
    throw new InvalidHandshake('principal.session', '必须是非空字符串');
  }
  if (!nonEmptyString(params['harness'])) {
    throw new InvalidHandshake('harness', '必须是非空字符串');
  }
  const capabilitiesRaw = params['capabilities'];
  if (!isPlainObject(capabilitiesRaw)) {
    throw new InvalidHandshake('capabilities', '必须是对象');
  }
  const capabilities: Partial<Record<HandshakeFeature, boolean>> = {};
  for (const feature of FEATURES) {
    const value = capabilitiesRaw[feature];
    if (value === undefined) {
      capabilities[feature] = undefined;
      continue;
    }
    if (typeof value !== 'boolean') {
      throw new InvalidHandshake(`capabilities.${feature}`, '必须是布尔值');
    }
    capabilities[feature] = value;
  }
  // 未知字段(含 capabilities 内的未知键)按 §3.0 规则 1 忽略。
  return {
    method: 'session.init',
    params: {
      protocol: '1.0',
      role: role as SessionRole,
      principal: {
        tenant: principal['tenant'] as string,
        session: principal['session'] as string,
      },
      harness: params['harness'] as string,
      capabilities: capabilities as ClientCapabilities,
    },
  };
}

function clientHas(capabilities: ClientCapabilities, feature: HandshakeFeature): boolean {
  return capabilities[feature] === true;
}

const CLIENT_DEGRADE_REASON: Record<HandshakeFeature, string> = {
  broadcast: '接入方不支持广播,广播降级为逐个 msg.direct 点对点投递',
  async_events: '接入方不支持异步事件流,事件改经轮询获取',
  interactive_approval: '接入方不支持实时审批推送,审批请求走逐条拉取',
};

const DAEMON_DEGRADE_REASON: Record<HandshakeFeature, string> = {
  broadcast: 'daemon 已关闭广播能力,广播调用不可用',
  async_events: 'daemon 已关闭异步事件流,事件改经轮询获取',
  interactive_approval: 'daemon 已关闭实时审批推送,审批走逐条拉取',
};

/** 协商单个能力位:有效 = 双方都为 true。 */
export function negotiateCapability(
  client: ClientCapabilities,
  daemon: DaemonCapabilities,
  feature: HandshakeFeature,
): boolean {
  return clientHas(client, feature) && daemon[feature];
}

/** 计算降级说明:有效能力为 false 且任一侧声明需要时逐项说明。 */
export function buildDegradations(
  client: ClientCapabilities,
  daemon: DaemonCapabilities,
): Degradation[] {
  const degradations: Degradation[] = [];
  for (const feature of FEATURES) {
    const effective = negotiateCapability(client, daemon, feature);
    if (effective) continue;
    if (clientHas(client, feature)) {
      degradations.push({ feature, reason: DAEMON_DEGRADE_REASON[feature] });
    } else if (daemon[feature]) {
      degradations.push({ feature, reason: CLIENT_DEGRADE_REASON[feature] });
    }
    // 双方都为 false:无人需要,无需降级说明。
  }
  return degradations;
}

/** 校验 profile 基本合法性并生成 daemon 应答(不落会话表)。 */
export function buildSessionResponse(
  profile: DaemonProfile,
  request: SessionInitRequest,
): { response: SessionInitResponse; warnings: string[] } {
  if (parseSemver(profile.daemonVersion) === null) {
    throw new ProfileInvalid('daemonVersion', `不是合法 semver: ${profile.daemonVersion}`);
  }
  if (profile.supportedProtocols.length === 0) {
    throw new ProfileInvalid('supportedProtocols', '不能为空');
  }
  const documentKinds = profile.documentKinds ?? DEFAULT_DOCUMENT_KINDS;
  validateDocumentKinds(documentKinds);
  const compat = checkProtocolCompat(
    request.params.protocol,
    profile.supportedProtocols,
  );
  if (!compat.compatible) {
    throw new VersionIncompatible(request.params.protocol, profile.supportedProtocols);
  }
  const warnings = compat.warning === null ? [] : [compat.warning];
  const response: SessionInitResponse = {
    protocol: request.params.protocol,
    spec_version: profile.specVersion,
    daemon_version: profile.daemonVersion,
    capabilities: {
      broadcast: profile.capabilities.broadcast,
      async_events: profile.capabilities.async_events,
      interactive_approval: profile.capabilities.interactive_approval,
    },
    document_kinds: documentKinds,
    degradations: buildDegradations(request.params.capabilities, profile.capabilities),
  };
  return { response, warnings };
}

/** document_kinds 映射合法性:schema 要求四个必需 kind,版本列表非空、无重复、
 *  仅 major.minor。 */
export function validateDocumentKinds(mapping: Readonly<Record<string, readonly string[]>>): void {
  for (const kind of REQUIRED_DOCUMENT_KINDS) {
    const versions = mapping[kind];
    if (versions === undefined || versions.length === 0) {
      throw new ProfileInvalid(
        `documentKinds.${kind}`,
        '必需 kind 的支持版本列表缺失或为空',
      );
    }
    if (new Set(versions).size !== versions.length) {
      throw new ProfileInvalid(`documentKinds.${kind}`, '支持版本列表不得重复');
    }
    for (const version of versions) {
      if (!DOC_VERSION_RE.test(version)) {
        throw new ProfileInvalid(
          `documentKinds.${kind}`,
          `版本必须是 major.minor 形式: ${version}`,
        );
      }
    }
  }
}

/**
 * 完整握手:校验请求 → 版本兼容判定(不相邻 major 抛 VersionIncompatible)
 * → 生成应答与降级说明 → 登记活跃会话。
 */
export function handleSessionInit(
  raw: unknown,
  profile: DaemonProfile,
  registry: SessionRegistry,
  options: { now?: Date; ttlMs?: number | null } = {},
): HandshakeResult {
  const request = parseSessionInit(raw);
  const { response, warnings } = buildSessionResponse(profile, request);
  const capabilities: DaemonCapabilities = {
    broadcast: negotiateCapability(request.params.capabilities, profile.capabilities, 'broadcast'),
    async_events: negotiateCapability(
      request.params.capabilities,
      profile.capabilities,
      'async_events',
    ),
    interactive_approval: negotiateCapability(
      request.params.capabilities,
      profile.capabilities,
      'interactive_approval',
    ),
  };
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs === undefined ? null : options.ttlMs;
  const session = registry.register(
    {
      tenant: request.params.principal.tenant,
      session: request.params.principal.session,
      role: request.params.role,
      harness: request.params.harness,
      capabilities,
      warnings,
      documentKinds: response.document_kinds,
      connectedAt: now.toISOString(),
      expiresAt: ttlMs === null ? null : new Date(now.getTime() + ttlMs).toISOString(),
    },
  );
  return { response, warnings, session };
}

/** P1 内置默认 profile:协议 "1.0",全能力开启,内置文档类 kind 映射。 */
export function defaultProfile(daemonVersion: string): DaemonProfile {
  return {
    daemonVersion,
    specVersion: SPEC_VERSION,
    supportedProtocols: ['1.0'],
    capabilities: {
      broadcast: true,
      async_events: true,
      interactive_approval: true,
    },
    documentKinds: DEFAULT_DOCUMENT_KINDS,
  };
}
