/**
 * engine 模块的对外类型化错误(与 session / events 模块同一约定:
 * 所有对外错误都带稳定 code,不允许抛裸字符串或裸 Error)。
 */
export class EngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 同 taskId 的执行已在进行(未到终态)。 */
export class RunDuplicate extends EngineError {
  readonly taskId: string;
  constructor(taskId: string) {
    super('RUN_DUPLICATE', `任务 ${taskId} 已有进行中的工作流执行`);
    this.taskId = taskId;
  }
}

/** taskId 无进行中/挂起的执行可 resume / cancel。 */
export class RunUnknown extends EngineError {
  readonly taskId: string;
  constructor(taskId: string) {
    super('RUN_UNKNOWN', `任务 ${taskId} 无进行中的工作流执行`);
    this.taskId = taskId;
  }
}

/** resume 要求执行处于 paused 状态。 */
export class RunNotPaused extends EngineError {
  readonly taskId: string;
  readonly status: string;
  constructor(taskId: string, status: string) {
    super('RUN_NOT_PAUSED', `任务 ${taskId} 未处于 paused 状态(当前 ${status}),无法 resume`);
    this.taskId = taskId;
    this.status = status;
  }
}

/** workflow 引用了未注册的 preset(引擎侧防御;PlanCheck 前置时可拦)。 */
export class PresetUnknown extends EngineError {
  readonly preset: string;
  constructor(preset: string) {
    super('PRESET_UNKNOWN', `preset 未注册: ${preset}`);
    this.preset = preset;
  }
}

/** 输入依赖成环(引擎侧防御;PlanCheck 前置时可拦)。 */
export class WorkflowCycle extends EngineError {
  constructor(detail: string) {
    super('WORKFLOW_CYCLE', `workflow 输入依赖成环: ${detail}`);
  }
}
