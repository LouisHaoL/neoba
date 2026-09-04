/**
 * capability 模块(§3.1 能力注册表 / §3.2 预设 / §3.3 授予清单,§9 P1 范围)。
 *
 * 注册表加载与校验(含内置默认注册表)、预设解析(JSON)、基线授予执行器
 * (grant manifest 生成 + 挂载意图输出 + grant/revoke 原语 + sink 审计)、
 * 协议硬底线纯函数。挂载执行不在本模块(Provisioner/sidecar 职责)。
 * 运行时零第三方依赖。
 */
export {
  defaultRegistry,
  loadCapabilityRegistry,
  loadCapabilityRegistryFile,
  PROTOCOL,
  SPEC_VERSION,
} from './registry.ts';
export { parsePreset, parsePresetFile, minimalPresetDoc, API } from './preset.ts';
export { CAP_ID_OR_WILDCARD_RE } from './validation.ts';
export { GrantExecutor, BASELINE_SOURCE, DEFAULT_DECISION_SOURCE } from './executor.ts';
export type { GrantExecutorOptions } from './executor.ts';
export { hardlineVerdict, hardlineAllowsAuto } from './hardline.ts';
export type { HardlineVerdict } from './hardline.ts';
export {
  CapabilityError,
  RegistryInvalid,
  PresetInvalid,
  CapUnknown,
  ScopeNotGrantable,
  AgentIdInvalid,
  AgentUnknown,
  BaselineAlreadyApplied,
  GrantDuplicate,
} from './errors.ts';
export type {
  AuditEntry,
  AuditEventKind,
  Base,
  BaselineApplyResult,
  BaselineGrantSpec,
  CapKind,
  CapabilityEntry,
  CapabilityRegistryDoc,
  EscalationPolicy,
  EventSink,
  Grant,
  GrantAuditEvent,
  GrantConstraint,
  GrantManifest,
  IoPort,
  LoadedRegistry,
  ModelPreset,
  MountIntent,
  Preset,
  RiskLevel,
  Scope,
  Tier,
} from './types.ts';
