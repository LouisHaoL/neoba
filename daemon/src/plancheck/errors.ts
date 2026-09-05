/**
 * plancheck 模块的对外类型化错误(约定同 capability/errors.ts)。
 */
export class PlanCheckError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 携带全部问题清单的文档非法基类(一次报全,便于修文件)。 */
export class DocInvalid extends PlanCheckError {
  readonly issues: readonly { readonly field: string; readonly message: string }[];

  constructor(code: string, kind: string, issues: readonly { readonly field: string; readonly message: string }[]) {
    super(
      code,
      `${kind}非法 (${issues.length} 处): ${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`,
    );
    this.issues = [...issues];
  }
}

/** IntentSpec 结构非法。 */
export class IntentInvalid extends DocInvalid {
  constructor(issues: readonly { readonly field: string; readonly message: string }[]) {
    super('INTENT_INVALID', 'IntentSpec', issues);
  }
}

/** WorkflowSpec 结构非法。 */
export class WorkflowInvalid extends DocInvalid {
  constructor(issues: readonly { readonly field: string; readonly message: string }[]) {
    super('WORKFLOW_INVALID', 'WorkflowSpec', issues);
  }
}
