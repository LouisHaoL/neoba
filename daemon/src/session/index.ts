/**
 * session 模块(§3.0 握手与版本协商)。
 *
 * session.init 校验、daemon 应答(能力集 + 降级说明)、版本兼容策略
 * (semver 比较 + 相邻 major 规则 + minor 漂移 warning)、活跃会话表。
 * 运行时零第三方依赖。
 */
export { parseSessionInit, buildSessionResponse, handleSessionInit, negotiateCapability, buildDegradations, defaultProfile, SPEC_VERSION } from './handshake.ts';
export { SessionRegistry } from './registry.ts';
export { parseSemver, compareSemver, checkProtocolCompat, checkDocumentKind, checkDocumentKindSupported, DEFAULT_DOCUMENT_KINDS, REQUIRED_DOCUMENT_KINDS, DOC_VERSION_RE } from './semver.ts';
export { validateDocumentKinds } from './handshake.ts';
export type { SemVer, CompatLevel, CompatResult, DocumentKindCompatResult } from './semver.ts';
export { SessionError, InvalidHandshake, VersionIncompatible, ProfileInvalid, SessionDuplicate, DocumentKindMismatch } from './errors.ts';
export type {
  ClientCapabilities,
  DaemonCapabilities,
  DaemonProfile,
  Degradation,
  DocumentKind,
  DocumentKindMismatchError,
  DocumentKindVersions,
  DocumentKindsMapping,
  HandshakeFeature,
  HandshakeResult,
  PrincipalScope,
  SessionInitParams,
  SessionInitRequest,
  SessionInitResponse,
  SessionRecord,
  SessionRole,
} from './types.ts';
