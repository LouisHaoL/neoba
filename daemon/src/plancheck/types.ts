/**
 * PlanCheck 对外类型(§3.5c:确定性静态校验,非 AI)。
 *
 * WorkflowSpec / IntentSpec 的类型化文档按 workflow.schema.json /
 * intent.schema.json(P0 冻结物)建模;字段名与 schema 严格一致。
 */

// ---------------------------------------------------------------- 文档类型

export type RetryTrigger = 'crash' | 'timeout';

export interface WorkflowNodeSpec {
  readonly id: string;
  readonly preset: string;
  /** 节点级超时,秒。 */
  readonly timeout?: number;
  readonly retry?: { readonly max: number; readonly on: readonly RetryTrigger[] };
  readonly inputs?: readonly { readonly from: string }[];
  /**
   * 并行语义(§3.5 P3 起;字段按 §3.0 增量规则后补):true = 允许与同批就绪的
   * 其他 parallel 节点并发启动;缺省 false = 严格串行派发。
   */
  readonly parallel?: boolean;
}

export interface WorkflowDoc {
  readonly api: 'workflow/1.0';
  readonly intent_ref: string;
  readonly nodes: readonly WorkflowNodeSpec[];
  readonly outputs: readonly { readonly from: string; readonly required: boolean }[];
  readonly feedback: readonly {
    readonly from: string;
    readonly to: string;
    readonly max_traversals: number;
  }[];
  readonly evidence: readonly {
    readonly node: string;
    readonly artifact: string;
    readonly must_exist: boolean;
    readonly sha256_recorded: boolean;
  }[];
}

export interface IntentConstraints {
  readonly max_parallel?: number;
  readonly budget_tokens?: number;
  readonly forbidden_caps?: readonly string[];
  /** v0.2:模型准入 allowlist,default ["*"](schema 语义;显式省略 = 放行全部)。 */
  readonly allowed_models?: readonly string[];
}

export interface IntentDoc {
  readonly api: 'intent/1.0';
  readonly goal: string;
  readonly acceptance: readonly string[];
  readonly constraints: IntentConstraints;
}

// ---------------------------------------------------------------- 校验结果

/** 单条校验结论:code 为稳定机器可读标识,field 为文档内定位,message 人读。 */
export interface Issue {
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface CheckResult {
  /** 无 error 级 issue。 */
  readonly ok: boolean;
  readonly issues: readonly Issue[];
}

// ---------------------------------------------------------------- 校验上下文

/**
 * PlanCheck 上下文:引用解析只在本地(§3.5g——名字只在本地解析,
 * 每次都查,不引入脆弱状态)。presets/registry 必给;models / intent 可选,
 * 缺省时模型准入 / 验收可追溯相应检查跳过。
 */
export interface PlanCheckContext {
  /** 预设集(按 workflow 节点引用名解析)。 */
  readonly presets: Readonly<Record<string, import('../capability/types.ts').Preset>>;
  /** 能力注册表(cap 存在性 / 禁授匹配的事实源)。 */
  readonly registry: import('../capability/types.ts').LoadedRegistry;
  /** 模型评分注册表(§3.9;给出才做模型准入检查)。 */
  readonly models?: import('../modelscore/types.ts').LoadedModelRegistry;
  /** 关联 IntentSpec(给出才做验收可追溯 / 禁授 / 准入取值)。 */
  readonly intent?: IntentDoc;
}
