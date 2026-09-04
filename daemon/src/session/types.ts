/**
 * session 模块对外类型(§3.0 握手与版本协商,字段名严格按 handshake.schema.json)。
 */

/** 接入方角色(§3.0:主控 / Planner / 观察者)。 */
export type SessionRole = 'orchestrator' | 'planner' | 'observer';

/** 可选能力协商位(schema clientCapabilities:三个已知键,均可缺省)。 */
export type HandshakeFeature =
  | 'broadcast'
  | 'async_events'
  | 'interactive_approval';

/** 四层 principal 随握手声明的前两层(tenant → session,§3.0 v0.2)。 */
export interface PrincipalScope {
  readonly tenant: string;
  readonly session: string;
}

/** 接入方声明自身支持的可选能力;缺省键按 false 处理。 */
export interface ClientCapabilities {
  readonly broadcast?: boolean;
  readonly async_events?: boolean;
  readonly interactive_approval?: boolean;
}

/** session.init 请求参数(§3.0 示例原文;schema params.required 全集)。 */
export interface SessionInitParams {
  readonly protocol: string;
  readonly role: SessionRole;
  readonly principal: PrincipalScope;
  readonly harness: string;
  readonly capabilities: ClientCapabilities;
}

/** session.init 请求(schema sessionInitRequest)。 */
export interface SessionInitRequest {
  readonly method: 'session.init';
  readonly params: SessionInitParams;
}

/** daemon 侧可选能力集(与本端能力同构,逐项给出支持与否)。 */
export interface DaemonCapabilities {
  readonly broadcast: boolean;
  readonly async_events: boolean;
  readonly interactive_approval: boolean;
}

/** 降级说明单条(schema degradations.items)。 */
export interface Degradation {
  readonly feature: HandshakeFeature;
  readonly reason: string;
}

/** 文档类 kind(handshake.schema.json document_kinds 的四个必需键)。 */
export type DocumentKind = 'preset' | 'intent' | 'workflow' | 'artifact-manifest';

export type DocumentKindVersions = readonly string[];

/** kind→支持版本映射(schema document_kinds;版本轴只到 major.minor)。 */
export type DocumentKindsMapping = Readonly<Record<DocumentKind, DocumentKindVersions>>;

/** 文档类版本不匹配错误(schema documentKindMismatchError):按 kind 报告,
 *  不是协议级不匹配。 */
export interface DocumentKindMismatchError {
  readonly code: 'document_kind_version_mismatch';
  readonly kind: DocumentKind;
  /** 提交方期望的版本(来自文档 api 字段)。 */
  readonly expected: string;
  readonly supported: DocumentKindVersions;
}

/** daemon 应答(schema sessionInitResponse;additionalProperties:false,
 *  因此版本 minor 漂移的 warning 不进应答文档,经 handleSessionInit
 *  的返回值旁路携带并落在 SessionRecord.warnings)。 */
export interface SessionInitResponse {
  readonly protocol: string;
  readonly spec_version: string;
  readonly daemon_version: string;
  readonly capabilities: DaemonCapabilities;
  readonly document_kinds: DocumentKindsMapping;
  readonly errors?: readonly DocumentKindMismatchError[];
  readonly degradations: readonly Degradation[];
}

/** daemon 侧握手配置:版本与能力基线。 */
export interface DaemonProfile {
  /** daemon 参考实现版本号(semver,如 "0.1.0")。 */
  readonly daemonVersion: string;
  /** 结构体规格版本(spec_version,如 "1.0")。 */
  readonly specVersion: string;
  /** daemon 支持的协议版本列表(支持相邻两个 major,§3.0 v0.2)。 */
  readonly supportedProtocols: readonly string[];
  readonly capabilities: DaemonCapabilities;
  /** 文档类 kind→支持版本映射(§3.0 v0.2 补充决议);缺省用 DEFAULT_DOCUMENT_KINDS。
   *  override 必须含全部四个必需 kind,否则握手报 ProfileInvalid。 */
  readonly documentKinds?: Readonly<Record<string, readonly string[]>>;
}

/** 握手完成后 daemon 内登记的一条活跃会话。 */
export interface SessionRecord {
  readonly tenant: string;
  readonly session: string;
  readonly role: SessionRole;
  readonly harness: string;
  /** 协商后能力 = 双方都为 true 的交集(降级后的有效能力)。 */
  readonly capabilities: DaemonCapabilities;
  /** 版本兼容 warning(minor 漂移 / 跨 major 接入),空数组 = 无。 */
  readonly warnings: readonly string[];
  /** 文档类 kind→支持版本映射(随握手协商,§3.0 v0.2 补充决议)。 */
  readonly documentKinds: DocumentKindsMapping;
  readonly connectedAt: string;
  /** 空闲过期时刻(ISO);null = 不自动过期。 */
  readonly expiresAt: string | null;
}

/** handleSessionInit 的返回:应答文档(schema 合法)+ 旁路 warning + 会话记录。 */
export interface HandshakeResult {
  readonly response: SessionInitResponse;
  readonly warnings: readonly string[];
  readonly session: SessionRecord;
}
