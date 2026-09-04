/**
 * capability 模块的对外类型化错误。所有对外错误都必须是这些类的实例,
 * 不允许抛裸字符串或裸 Error。
 */
export class CapabilityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 能力注册表文档非法:携带全部问题清单(一次报全,便于修文件)。 */
export class RegistryInvalid extends CapabilityError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      'CAPABILITY_REGISTRY_INVALID',
      `能力注册表非法 (${issues.length} 处): ${issues.join('; ')}`,
    );
    this.issues = [...issues];
  }
}

/** 预设文档非法:携带全部问题清单。 */
export class PresetInvalid extends CapabilityError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('PRESET_INVALID', `预设非法 (${issues.length} 处): ${issues.join('; ')}`);
    this.issues = [...issues];
  }
}

/** 注册表中不存在该能力 id。 */
export class CapUnknown extends CapabilityError {
  readonly cap: string;

  constructor(cap: string) {
    super('CAP_UNKNOWN', `注册表中不存在能力 ${cap}`);
    this.cap = cap;
  }
}

/** 申请的 scope 不在该能力的 grantable_scopes 内。 */
export class ScopeNotGrantable extends CapabilityError {
  readonly cap: string;
  readonly scope: string;
  readonly grantable: readonly string[];

  constructor(cap: string, scope: string, grantable: readonly string[]) {
    super(
      'SCOPE_NOT_GRANTABLE',
      `能力 ${cap} 不可授 scope "${scope}" (可授: ${grantable.join('/')})`,
    );
    this.cap = cap;
    this.scope = scope;
    this.grantable = [...grantable];
  }
}

/** agent_id 不符合 schema 格式(<task>/<实例名>)。 */
export class AgentIdInvalid extends CapabilityError {
  readonly agentId: string;

  constructor(agentId: string) {
    super(
      'AGENT_ID_INVALID',
      `agent_id 非法: ${JSON.stringify(agentId)} (格式 <task>/<实例名>)`,
    );
    this.agentId = agentId;
  }
}

/** 基线授予中出现重复的 cap+scope 条目。 */
export class GrantDuplicate extends CapabilityError {
  readonly cap: string;
  readonly scope: string;

  constructor(cap: string, scope: string) {
    super('GRANT_DUPLICATE', `重复授予: ${cap} @ ${scope}`);
    this.cap = cap;
    this.scope = scope;
  }
}

/** 操作的 agent 未注册(无任何授予记录)。 */
export class AgentUnknown extends CapabilityError {
  readonly agentId: string;

  constructor(agentId: string) {
    super('AGENT_UNKNOWN', `agent 未注册: ${agentId}`);
    this.agentId = agentId;
  }
}

/** 该 agent 已置入过基线授予,不允许重复 applyBaseline。 */
export class BaselineAlreadyApplied extends CapabilityError {
  readonly agentId: string;

  constructor(agentId: string) {
    super('BASELINE_ALREADY_APPLIED', `agent 已有基线授予: ${agentId}`);
    this.agentId = agentId;
  }
}
