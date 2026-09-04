/** SandboxProvider 类型化错误。上层(编排引擎/绑定层)按 code 分支,不解析错误文案。 */

export type SandboxErrorCode =
  | "provider_unavailable" // 后端不可达(docker daemon 未运行 / CLI 缺失)
  | "command_failed" // 后端 CLI 执行失败(非可达类)
  | "invalid_state" // 句柄状态不允许该操作(如对 stopped/removed exec)
  | "prerequisite_not_met" // 基座前置条件不可满足(§5 v0.2:显式拒绝,不静默降级)
  | "invalid_spec" // SandboxSpec 违反硬规则(如 secret/config 挂载试图 rw)
  | "not_supported"; // 能力未实现(snapshot/restore、网络 allowlist、资源池排队)

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }
}

/** Docker 不可达。message 恒含 "neoba doctor" 提示。 */
export class ProviderUnavailableError extends SandboxError {
  constructor(message: string) {
    super("provider_unavailable", `${message}(提示:运行 neoba doctor 检查沙箱环境)`);
    this.name = "ProviderUnavailableError";
  }
}

/** 后端命令执行失败且非"不可达"类。 */
export class CommandFailedError extends SandboxError {
  constructor(message: string) {
    super("command_failed", message);
    this.name = "CommandFailedError";
  }
}

/** 句柄状态不允许该操作。 */
export class InvalidStateError extends SandboxError {
  constructor(message: string) {
    super("invalid_state", message);
    this.name = "InvalidStateError";
  }
}

/** 基座前置条件不可满足,create 显式拒绝。message 说明缺什么,恒含 "neoba doctor" 提示。 */
export class PrerequisiteNotMetError extends SandboxError {
  constructor(message: string) {
    super("prerequisite_not_met", `${message}(提示:运行 neoba doctor 检测环境前置)`);
    this.name = "PrerequisiteNotMetError";
  }
}

/** SandboxSpec 违反硬规则(如 secret/config 挂载试图 rw)。 */
export class InvalidSpecError extends SandboxError {
  constructor(message: string) {
    super("invalid_spec", message);
    this.name = "InvalidSpecError";
  }
}

/** 能力未实现。 */
export class NotSupportedError extends SandboxError {
  constructor(message: string) {
    super("not_supported", message);
    this.name = "NotSupportedError";
  }
}
