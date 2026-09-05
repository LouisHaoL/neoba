/**
 * modelscore 模块的对外类型化错误(约定同 capability/errors.ts)。
 */
export class ModelScoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 评分注册表文档非法:携带全部问题清单(一次报全)。 */
export class ModelRegistryInvalid extends ModelScoreError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      'MODEL_REGISTRY_INVALID',
      `模型评分注册表非法 (${issues.length} 处): ${issues.join('; ')}`,
    );
    this.issues = [...issues];
  }
}

/** 反馈引用的模型不在注册表中。 */
export class ModelUnknown extends ModelScoreError {
  readonly model: string;

  constructor(model: string) {
    super('MODEL_UNKNOWN', `模型评分注册表中不存在模型 ${model}`);
    this.model = model;
  }
}

/** 模型准入一票否决(安全面,§3.9:评分只是排序,准入不过直接拒)。 */
export class ModelNotAdmitted extends ModelScoreError {
  readonly model: string;
  readonly pattern: string;

  constructor(model: string, pattern: string) {
    super(
      'MODEL_NOT_ADMITTED',
      `模型 ${model} 未通过准入 allowlist(拒绝规则: ${pattern})`,
    );
    this.model = model;
    this.pattern = pattern;
  }
}
