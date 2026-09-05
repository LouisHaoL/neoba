/**
 * WorkflowSpec / IntentSpec 结构校验与类型化解析(P0 冻结 Schema 的手写子集,
 * 运行时零第三方依赖;ajv 只在协议 examples 校验脚本里用)。
 *
 * 结构问题逐条收集、一次报全(WorkflowInvalid / IntentInvalid);语义检查
 * (契约匹配 / 成环 / 禁授 / 准入 / 可追溯)在 plancheck.ts,基于本模块的
 * 类型化文档。字段模式全部取自 protocol/schemas/*.json 的冻结 pattern。
 */
import { IntentInvalid, WorkflowInvalid } from './errors.ts';
import type { IntentConstraints, IntentDoc, RetryTrigger, WorkflowDoc, WorkflowNodeSpec } from './types.ts';

const NODE_ID_RE = /^[a-z][a-z0-9_-]*$/;
const PRESET_NAME_RE = /^[a-z0-9][a-z0-9._/-]*$/;
const OUTPUT_BINDING_RE = /^[a-z0-9_-]+\.outputs\.[a-z0-9_-]+$/;
const CAP_ID_RE = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;
const CAP_WILDCARD_RE = /^[a-z][a-z0-9-*]*:\*$/;
const MODEL_PATTERN_RE = /^(\*|[A-Za-z0-9][A-Za-z0-9._-]*(\/\*)?)$/;
const RETRY_ON: readonly RetryTrigger[] = ['crash', 'timeout'];

interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** 结构校验主循环:root 必须是对象;api 常量;禁 protocol/spec_version 混用。 */
function checkDocRoot(raw: unknown, api: string, issues: FieldIssue[]): Record<string, unknown> | null {
  if (!isPlainObject(raw)) {
    issues.push({ field: 'root', message: '必须是 JSON 对象' });
    return null;
  }
  if (raw['api'] !== api) {
    issues.push({ field: 'api', message: `必须为 "${api}"` });
  }
  if (raw['protocol'] !== undefined || raw['spec_version'] !== undefined) {
    issues.push({ field: 'root', message: '文档类首层只用 api,禁止 protocol/spec_version' });
  }
  return raw;
}

function unknownFields(raw: Record<string, unknown>, allowed: readonly string[], field: string, issues: FieldIssue[]): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      issues.push({ field: `${field}.${key}`, message: '未知字段(additionalProperties: false)' });
    }
  }
}

// ---------------------------------------------------------------- IntentSpec

const INTENT_KEYS = ['api', 'goal', 'acceptance', 'constraints'] as const;
const CONSTRAINT_KEYS = ['max_parallel', 'budget_tokens', 'forbidden_caps', 'allowed_models'] as const;

/** 结构校验并解析 IntentSpec;问题一次报全(IntentInvalid)。 */
export function parseIntent(raw: unknown): IntentDoc {
  const issues: FieldIssue[] = [];
  const root = checkDocRoot(raw, 'intent/1.0', issues);
  if (root === null) throw new IntentInvalid(issues);
  unknownFields(root, INTENT_KEYS, 'root', issues);

  if (!isNonEmptyString(root['goal'])) {
    issues.push({ field: 'goal', message: '必须是非空字符串' });
  }
  const acceptance = root['acceptance'];
  if (!Array.isArray(acceptance) || acceptance.length === 0 || acceptance.some((a) => !isNonEmptyString(a))) {
    issues.push({ field: 'acceptance', message: '必须是非空字符串的非空数组' });
  }
  const constraints: {
    max_parallel?: number;
    budget_tokens?: number;
    forbidden_caps?: readonly string[];
    allowed_models?: readonly string[];
  } = {};
  const rawConstraints = root['constraints'];
  if (!isPlainObject(rawConstraints)) {
    issues.push({ field: 'constraints', message: '必须是对象' });
  } else {
    unknownFields(rawConstraints, CONSTRAINT_KEYS, 'constraints', issues);
    const maxParallel = rawConstraints['max_parallel'];
    if (maxParallel !== undefined && (!isInt(maxParallel) || maxParallel < 1)) {
      issues.push({ field: 'constraints.max_parallel', message: '必须是 ≥1 的整数' });
    } else if (maxParallel !== undefined) {
      constraints.max_parallel = maxParallel;
    }
    const budget = rawConstraints['budget_tokens'];
    if (budget !== undefined && (!isInt(budget) || budget < 0)) {
      issues.push({ field: 'constraints.budget_tokens', message: '必须是 ≥0 的整数' });
    } else if (budget !== undefined) {
      constraints.budget_tokens = budget;
    }
    const forbidden = rawConstraints['forbidden_caps'];
    if (forbidden !== undefined) {
      if (!Array.isArray(forbidden) || forbidden.some((c) => !isNonEmptyString(c) || (!CAP_ID_RE.test(c) && !CAP_WILDCARD_RE.test(c) && c !== '*'))) {
        issues.push({ field: 'constraints.forbidden_caps', message: '必须是 cap id / "*" / "ns:*" 的数组' });
      } else {
        constraints.forbidden_caps = Object.freeze([...(forbidden as string[])]);
      }
    }
    const allowed = rawConstraints['allowed_models'];
    if (allowed !== undefined) {
      if (!Array.isArray(allowed) || allowed.some((m) => !isNonEmptyString(m) || !MODEL_PATTERN_RE.test(m))) {
        issues.push({ field: 'constraints.allowed_models', message: '必须是模型名 / "*" / "provider/*" 的数组' });
      } else {
        constraints.allowed_models = Object.freeze([...(allowed as string[])]);
      }
    }
  }
  if (issues.length > 0) throw new IntentInvalid(issues);
  return {
    api: 'intent/1.0',
    goal: root['goal'] as string,
    acceptance: Object.freeze([...(acceptance as string[])]),
    constraints,
  };
}

// ---------------------------------------------------------------- WorkflowSpec

const WORKFLOW_KEYS = ['api', 'intent_ref', 'nodes', 'outputs', 'feedback', 'evidence'] as const;
const NODE_KEYS = ['id', 'preset', 'timeout', 'retry', 'inputs', 'parallel'] as const;
const RETRY_KEYS = ['max', 'on'] as const;
const BINDING_KEYS = ['from'] as const;
const OUTPUT_KEYS = ['from', 'required'] as const;
const FEEDBACK_KEYS = ['from', 'to', 'max_traversals'] as const;
const EVIDENCE_KEYS = ['node', 'artifact', 'must_exist', 'sha256_recorded'] as const;

/** 结构校验并解析 WorkflowSpec;问题一次报全(WorkflowInvalid)。 */
export function parseWorkflow(raw: unknown): WorkflowDoc {
  const issues: FieldIssue[] = [];
  const root = checkDocRoot(raw, 'workflow/1.0', issues);
  if (root === null) throw new WorkflowInvalid(issues);
  unknownFields(root, WORKFLOW_KEYS, 'root', issues);

  if (!isNonEmptyString(root['intent_ref'])) {
    issues.push({ field: 'intent_ref', message: '必须是非空字符串' });
  }

  // nodes:非空数组,字段结构 + id 唯一。
  const nodes: WorkflowNodeSpec[] = [];
  const rawNodes = root['nodes'];
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    issues.push({ field: 'nodes', message: '必须是非空数组' });
  } else {
    const seen = new Set<string>();
    rawNodes.forEach((item, i) => {
      const f = `nodes[${i}]`;
      if (!isPlainObject(item)) {
        issues.push({ field: f, message: '必须是对象' });
        return;
      }
      unknownFields(item, NODE_KEYS, f, issues);
      const id = item['id'];
      if (typeof id !== 'string' || !NODE_ID_RE.test(id)) {
        issues.push({ field: `${f}.id`, message: `必须匹配 ${NODE_ID_RE.source}` });
      } else if (seen.has(id)) {
        issues.push({ field: `${f}.id`, message: `重复的节点 id "${id}"` });
        seen.add(id);
      } else {
        seen.add(id);
      }
      if (typeof item['preset'] !== 'string' || !PRESET_NAME_RE.test(item['preset'])) {
        issues.push({ field: `${f}.preset`, message: `必须匹配 ${PRESET_NAME_RE.source}` });
      }
      const timeout = item['timeout'];
      if (timeout !== undefined && (!isInt(timeout) || timeout < 1)) {
        issues.push({ field: `${f}.timeout`, message: '必须是 ≥1 的整数(秒)' });
      }
      let retry: WorkflowNodeSpec['retry'];
      const rawRetry = item['retry'];
      if (rawRetry !== undefined) {
        if (!isPlainObject(rawRetry)) {
          issues.push({ field: `${f}.retry`, message: '必须是对象' });
        } else {
          unknownFields(rawRetry, RETRY_KEYS, `${f}.retry`, issues);
          const max = rawRetry['max'];
          const on = rawRetry['on'];
          const maxOk = isInt(max) && max >= 0;
          if (!maxOk) issues.push({ field: `${f}.retry.max`, message: '必须是 ≥0 的整数' });
          const onOk =
            Array.isArray(on) &&
            on.length > 0 &&
            on.every((t) => RETRY_ON.includes(t as RetryTrigger)) &&
            new Set(on).size === on.length;
          if (!onOk) {
            issues.push({ field: `${f}.retry.on`, message: `必须是无重复的 ${RETRY_ON.join('/')} 数组` });
          }
          if (maxOk && onOk) retry = { max: max as number, on: Object.freeze([...(on as RetryTrigger[])]) };
        }
      }
      const parallel = item['parallel'];
      if (parallel !== undefined && typeof parallel !== 'boolean') {
        issues.push({ field: `${f}.parallel`, message: '必须是布尔值' });
      }
      let inputs: { readonly from: string }[] | undefined;
      const rawInputs = item['inputs'];
      if (rawInputs !== undefined) {
        if (!Array.isArray(rawInputs)) {
          issues.push({ field: `${f}.inputs`, message: '必须是数组' });
        } else {
          inputs = [];
          rawInputs.forEach((binding, j) => {
            const bf = `${f}.inputs[${j}]`;
            if (!isPlainObject(binding)) {
              issues.push({ field: bf, message: '必须是对象' });
              return;
            }
            unknownFields(binding, BINDING_KEYS, bf, issues);
            const from = binding['from'];
            if (typeof from !== 'string' || !OUTPUT_BINDING_RE.test(from)) {
              issues.push({ field: `${bf}.from`, message: '必须是 <节点>.outputs.<工件名> 形式' });
            } else {
              inputs!.push({ from });
            }
          });
        }
      }
      if (
        typeof id === 'string' &&
        NODE_ID_RE.test(id) &&
        typeof item['preset'] === 'string' &&
        PRESET_NAME_RE.test(item['preset'])
      ) {
        nodes.push({
          id,
          preset: item['preset'],
          ...(timeout !== undefined ? { timeout: timeout as number } : {}),
          ...(retry !== undefined ? { retry } : {}),
          ...(inputs !== undefined ? { inputs: Object.freeze(inputs) } : {}),
          ...(parallel !== undefined ? { parallel: parallel as boolean } : {}),
        });
      }
    });
  }

  const parseBindings = (
    value: unknown,
    field: string,
    keys: readonly string[],
    hasRequired: boolean,
  ): { readonly from: string; readonly required: boolean }[] => {
    const out: { from: string; required: boolean }[] = [];
    if (value === undefined) return out;
    if (!Array.isArray(value)) {
      issues.push({ field, message: '必须是数组' });
      return out;
    }
    value.forEach((item, i) => {
      const f = `${field}[${i}]`;
      if (!isPlainObject(item)) {
        issues.push({ field: f, message: '必须是对象' });
        return;
      }
      unknownFields(item, keys, f, issues);
      const from = item['from'];
      if (typeof from !== 'string' || !OUTPUT_BINDING_RE.test(from)) {
        issues.push({ field: `${f}.from`, message: '必须是 <节点>.outputs.<工件名> 形式' });
        return;
      }
      const required = item['required'];
      if (hasRequired && required !== undefined && typeof required !== 'boolean') {
        issues.push({ field: `${f}.required`, message: '必须是布尔值' });
        return;
      }
      out.push({ from, required: required === true });
    });
    return out;
  };

  const outputs = parseBindings(root['outputs'], 'outputs', OUTPUT_KEYS, true);
  let feedback: WorkflowDoc['feedback'] = Object.freeze([]);
  const rawFeedback = root['feedback'];
  if (rawFeedback !== undefined) {
    if (!Array.isArray(rawFeedback)) {
      issues.push({ field: 'feedback', message: '必须是数组' });
    } else {
      const edges: { from: string; to: string; max_traversals: number }[] = [];
      rawFeedback.forEach((item, i) => {
        const f = `feedback[${i}]`;
        if (!isPlainObject(item)) {
          issues.push({ field: f, message: '必须是对象' });
          return;
        }
        unknownFields(item, FEEDBACK_KEYS, f, issues);
        const from = item['from'];
        const to = item['to'];
        const max = item['max_traversals'];
        let ok = true;
        if (typeof from !== 'string' || !NODE_ID_RE.test(from)) {
          issues.push({ field: `${f}.from`, message: `必须匹配 ${NODE_ID_RE.source}` });
          ok = false;
        }
        if (typeof to !== 'string' || !NODE_ID_RE.test(to)) {
          issues.push({ field: `${f}.to`, message: `必须匹配 ${NODE_ID_RE.source}` });
          ok = false;
        }
        if (!isInt(max) || max < 0) {
          issues.push({ field: `${f}.max_traversals`, message: '必须是 ≥0 的整数' });
          ok = false;
        }
        if (ok) edges.push({ from: from as string, to: to as string, max_traversals: max as number });
      });
      feedback = Object.freeze(edges);
    }
  }

  let evidence: WorkflowDoc['evidence'] = Object.freeze([]);
  const rawEvidence = root['evidence'];
  if (rawEvidence !== undefined) {
    if (!Array.isArray(rawEvidence)) {
      issues.push({ field: 'evidence', message: '必须是数组' });
    } else {
      const decls: WorkflowDoc['evidence'][number][] = [];
      rawEvidence.forEach((item, i) => {
        const f = `evidence[${i}]`;
        if (!isPlainObject(item)) {
          issues.push({ field: f, message: '必须是对象' });
          return;
        }
        unknownFields(item, EVIDENCE_KEYS, f, issues);
        const node = item['node'];
        const artifact = item['artifact'];
        const mustExist = item['must_exist'];
        const shaRecorded = item['sha256_recorded'];
        let ok = true;
        if (typeof node !== 'string' || !NODE_ID_RE.test(node)) {
          issues.push({ field: `${f}.node`, message: `必须匹配 ${NODE_ID_RE.source}` });
          ok = false;
        }
        if (typeof artifact !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(artifact)) {
          issues.push({ field: `${f}.artifact`, message: '必须是合法工件名' });
          ok = false;
        }
        for (const key of ['must_exist', 'sha256_recorded'] as const) {
          if (typeof item[key] !== 'boolean') {
            issues.push({ field: `${f}.${key}`, message: '必须是布尔值(必填)' });
            ok = false;
          }
        }
        if (ok) {
          decls.push({
            node: node as string,
            artifact: artifact as string,
            must_exist: mustExist as boolean,
            sha256_recorded: shaRecorded as boolean,
          });
        }
      });
      evidence = Object.freeze(decls);
    }
  }

  if (issues.length > 0) throw new WorkflowInvalid(issues);
  return {
    api: 'workflow/1.0',
    intent_ref: root['intent_ref'] as string,
    nodes: Object.freeze(nodes),
    outputs: Object.freeze(outputs),
    feedback,
    evidence,
  };
}

/** 解析 `<节点>.outputs.<工件名>` 绑定;不合法返回 null(结构层已报)。 */
export function parseOutputBinding(binding: string): { node: string; artifact: string } | null {
  const idx = binding.indexOf('.outputs.');
  if (idx <= 0) return null;
  return { node: binding.slice(0, idx), artifact: binding.slice(idx + '.outputs.'.length) };
}
