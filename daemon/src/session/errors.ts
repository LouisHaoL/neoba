/**
 * session 模块的对外类型化错误。所有对外错误都必须是这些类的实例,
 * 不允许抛裸字符串或裸 Error。
 */
export class SessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** session.init 请求结构非法(缺字段 / 字段类型或取值不符 schema)。 */
export class InvalidHandshake extends SessionError {
  readonly field: string;
  readonly detail: string;

  constructor(field: string, detail: string) {
    super('SESSION_INIT_INVALID', `session.init 非法: ${field}: ${detail}`);
    this.field = field;
    this.detail = detail;
  }
}

/** 协议版本不兼容:major 不同且不相邻(不在 daemon 支持的相邻两个 major 内)。
 *  按 §3.0 v0.2 拒绝握手。 */
export class VersionIncompatible extends SessionError {
  readonly clientVersion: string;
  readonly supported: readonly string[];

  constructor(clientVersion: string, supported: readonly string[]) {
    super(
      'PROTOCOL_VERSION_REJECTED',
      `协议版本不兼容: 接入方 ${clientVersion}, ` +
        `daemon 支持 ${supported.join('/')} (仅支持相邻两个 major)`,
    );
    this.clientVersion = clientVersion;
    this.supported = [...supported];
  }
}

/** daemon 侧握手配置本身非法(如 daemon_version 不是 semver)。 */
export class ProfileInvalid extends SessionError {
  readonly field: string;

  constructor(field: string, detail: string) {
    super('SESSION_PROFILE_INVALID', `daemon 握手配置非法: ${field}: ${detail}`);
    this.field = field;
  }
}

/** 同一 tenant 下重复登记同一 session id。 */
export class SessionDuplicate extends SessionError {
  readonly tenant: string;
  readonly session: string;

  constructor(tenant: string, session: string) {
    super(
      'SESSION_DUPLICATE',
      `会话已存在: ${tenant}/${session} (先 close 再重新握手)`,
    );
    this.tenant = tenant;
    this.session = session;
  }
}

/** 文档类 kind 版本不匹配(§3.0 v0.2 补充):按 kind 报告(kind + 期望版本 +
 *  支持列表),不是协议级不匹配——不要与 VersionIncompatible 混用。
 *  附带 toProtocol():转成 handshake 应答 errors 数组项的协议结构。 */
export class DocumentKindMismatch extends SessionError {
  readonly kind: string;
  readonly expected: string;
  readonly supported: readonly string[];
  readonly kindSupported: boolean;

  constructor(
    kind: string,
    expected: string,
    supported: readonly string[],
    kindSupported: boolean,
  ) {
    super(
      'DOCUMENT_KIND_MISMATCH',
      kindSupported
        ? `文档类版本不匹配: kind=${kind}, 期望 ${expected}, ` +
          `daemon 支持 ${supported.join('/')}`
        : `未知文档类 kind: ${kind}, daemon 映射不含该 kind (期望版本 ${expected})`,
    );
    this.kind = kind;
    this.expected = expected;
    this.supported = [...supported];
    this.kindSupported = kindSupported;
  }

  /** handshake 应答 errors 数组项(schema documentKindMismatchError)。 */
  toProtocol(): {
    code: 'document_kind_version_mismatch';
    kind: string;
    expected: string;
    supported: readonly string[];
  } {
    return {
      code: 'document_kind_version_mismatch',
      kind: this.kind,
      expected: this.expected,
      supported: this.supported,
    };
  }
}
