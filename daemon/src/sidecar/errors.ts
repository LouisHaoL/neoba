/**
 * sidecar 模块对外类型化错误(惯例对齐 src/capability/errors.ts:
 * 对外错误一律是这些类的实例,不抛裸字符串 / 裸 Error)。
 */
export class SidecarError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * spawn 硬规则违规(§4.4 / spike #1 E6):启动命令或基座配置中出现
 * bypass 类标志 / bypassPermissions 模式。生成后校验必炸,不静默剥离。
 */
export class BypassFlagDetected extends SidecarError {
  readonly token: string;

  constructor(token: string, where: string) {
    super(
      'BYPASS_FLAG_DETECTED',
      `spawn 硬规则违规(§4.4):${where} 出现 bypass 类标志/模式 "${token}"`,
    );
    this.token = token;
  }
}

/** 生成器输入非法(路径模板无法解析、permissionMode 越界等)。 */
export class SidecarConfigInvalid extends SidecarError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('SIDECAR_CONFIG_INVALID', `sidecar 配置非法: ${issues.join('; ')}`);
    this.issues = [...issues];
  }
}

/** manifest 授予的 mcp_server cap 在 catalog 中无启动规格(fail-closed,不静默跳过)。 */
export class McpServerNotInCatalog extends SidecarError {
  readonly cap: string;

  constructor(cap: string) {
    super(
      'MCP_SERVER_NOT_IN_CATALOG',
      `授予了 ${cap} 但 mcpCatalog 中没有启动规格(§3.3 物理性:宁可失败,不可静默不挂载)`,
    );
    this.cap = cap;
  }
}

/** 产物中出现凭据明文(§3.8 铁律,assertNoSecretPlaintext 校验失败)。 */
export class SecretPlaintextLeak extends SidecarError {
  constructor() {
    super('SECRET_PLAINTEXT_LEAK', '产物中出现凭据明文(§3.8:配置产物永不携带 secret 值)');
  }
}
