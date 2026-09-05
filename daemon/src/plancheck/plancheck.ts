/**
 * PlanCheck 语义检查(§3.5c:确定性代码非 AI):
 *
 *   结构校验(parse.ts)→ 语义检查(本文件):
 *   - 引用解析:节点预设存在;输出绑定/反馈边/证据声明的节点存在;
 *   - 契约类型匹配:输入绑定 from S.outputs.X → S 的预设声明输出端口 X、
 *     消费节点预设声明输入端口 X,两侧 io type 全等;
 *   - 依赖成环检测:只对 inputs 依赖边(反馈边是受控回路,由引擎的
 *     max_traversals 界定,不构成静态环);
 *   - 禁授能力检查:各节点预设基线授予命中 forbidden_caps(通配语义写死)
 *     即违规;顺带校验 cap 在注册表存在;
 *   - 模型准入检查:预设声明 model.tier 时,准入 ∩ tier_fit>0 的候选非空;
 *   - 重试/幂等组合:预设未声明 idempotent 时 retry.on 不允许 timeout
 *     (副作用型操作默认不自动重试,§3.5 失败语义);
 *   - 验收项可追溯:每个 acceptance 至少被一个 output 覆盖 —— 带显式
 *     artifact:<name> 引用的项逐引用解析(须命中 required output 或证据
 *     声明);无引用项由"存在带证据(must_exist+sha256_recorded)的 required
 *     output"覆盖;required output 自身必须有匹配证据声明。
 *
 * 所有结构问题也走 issue 通道(checkWorkflow / checkIntent 不抛错,只报
 * 清单),便于 CLI 一次打全;需要类型化文档的调用方(引擎)另用 parse*。
 */
import { matchAnyCapPattern } from './match.ts';
import { parseIntent, parseOutputBinding, parseWorkflow } from './parse.ts';
import type {
  CheckResult,
  Issue,
  IntentDoc,
  PlanCheckContext,
  WorkflowDoc,
} from './types.ts';

function issue(code: string, field: string, message: string): Issue {
  return { code, field, message };
}

/** 输出端口查询:preset.io_contracts.outputs 里找 name。 */
function outputPort(
  preset: PlanCheckContext['presets'][string],
  name: string,
): { readonly name: string; readonly type: string } | undefined {
  return preset.io_contracts.outputs.find((p) => p.name === name);
}

function inputPort(
  preset: PlanCheckContext['presets'][string],
  name: string,
): { readonly name: string; readonly type: string } | undefined {
  return preset.io_contracts.inputs.find((p) => p.name === name);
}

/** 完整检查:结构 + 语义;永不因文档内容抛错(问题全走 issues)。 */
export function checkWorkflow(raw: unknown, ctx: PlanCheckContext): CheckResult & { readonly doc: WorkflowDoc | null } {
  const issues: Issue[] = [];
  let doc: WorkflowDoc | null = null;
  try {
    doc = parseWorkflow(raw);
  } catch (err) {
    const details = (err as { readonly issues?: readonly { field: string; message: string }[] }).issues ?? [];
    for (const d of details) issues.push(issue('schema_invalid', d.field, d.message));
    if (details.length === 0) {
      issues.push(issue('schema_invalid', 'root', err instanceof Error ? err.message : String(err)));
    }
    return { ok: false, issues, doc: null };
  }
  issues.push(...semanticChecks(doc, ctx));
  return { ok: issues.length === 0, issues, doc };
}

/** IntentSpec 结构检查(语义在 workflow 侧联动,这里只验结构)。 */
export function checkIntent(raw: unknown): CheckResult & { readonly doc: IntentDoc | null } {
  const issues: Issue[] = [];
  let doc: IntentDoc | null = null;
  try {
    doc = parseIntent(raw);
  } catch (err) {
    const details = (err as { readonly issues?: readonly { field: string; message: string }[] }).issues ?? [];
    for (const d of details) issues.push(issue('schema_invalid', d.field, d.message));
    if (details.length === 0) {
      issues.push(issue('schema_invalid', 'root', err instanceof Error ? err.message : String(err)));
    }
    return { ok: false, issues, doc: null };
  }
  return { ok: true, issues, doc };
}

// ---------------------------------------------------------------- 语义检查

function semanticChecks(doc: WorkflowDoc, ctx: PlanCheckContext): Issue[] {
  const issues: Issue[] = [];
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  const presetOf = (nodeId: string) => {
    const node = nodeById.get(nodeId);
    if (node === undefined) return undefined;
    return ctx.presets[node.preset];
  };

  // 1. 节点预设解析。
  for (const node of doc.nodes) {
    if (ctx.presets[node.preset] === undefined) {
      issues.push(issue('preset_unknown', `nodes(${node.id}).preset`, `预设 "${node.preset}" 在本地不存在`));
    }
  }

  // 2. 输入绑定:引用节点存在 + 契约类型匹配。
  for (const node of doc.nodes) {
    for (const [i, binding] of (node.inputs ?? []).entries()) {
      const f = `nodes(${node.id}).inputs[${i}]`;
      const ref = parseOutputBinding(binding.from);
      if (ref === null) continue; // 结构层已报
      if (!nodeById.has(ref.node)) {
        issues.push(issue('binding_node_unknown', `${f}.from`, `绑定的上游节点 "${ref.node}" 不存在`));
        continue;
      }
      const sourcePreset = presetOf(ref.node);
      const consumerPreset = ctx.presets[node.preset];
      const outPort = sourcePreset !== undefined ? outputPort(sourcePreset, ref.artifact) : undefined;
      if (outPort === undefined) {
        issues.push(
          issue('output_port_unknown', `${f}.from`, `节点 "${ref.node}" 的预设未声明输出端口 "${ref.artifact}"`),
        );
      }
      if (consumerPreset !== undefined && outPort !== undefined) {
        const inPort = inputPort(consumerPreset, ref.artifact);
        if (inPort === undefined) {
          issues.push(
            issue('input_port_unknown', f, `节点 "${node.id}" 的预设未声明输入端口 "${ref.artifact}"`),
          );
        } else if (inPort.type !== outPort.type) {
          issues.push(
            issue(
              'contract_type_mismatch',
              f,
              `契约类型不匹配: "${ref.node}.outputs.${ref.artifact}" 是 ${outPort.type},` +
                `"${node.id}" 的输入端口声明为 ${inPort.type}`,
            ),
          );
        }
      }
    }
  }

  // 3. 依赖成环检测(inputs 依赖边;反馈边除外)。
  issues.push(...detectCycles(doc));

  // 4. 反馈边:节点存在、不自环。
  for (const [i, edge] of doc.feedback.entries()) {
    const f = `feedback[${i}]`;
    if (!nodeById.has(edge.from)) {
      issues.push(issue('feedback_node_unknown', `${f}.from`, `反馈源节点 "${edge.from}" 不存在`));
    }
    if (!nodeById.has(edge.to)) {
      issues.push(issue('feedback_node_unknown', `${f}.to`, `反馈目标节点 "${edge.to}" 不存在`));
    }
    if (edge.from === edge.to) {
      issues.push(issue('feedback_self', f, '反馈边不能自环'));
    }
  }

  // 5. 编排级输出:节点存在 + 端口存在;required 项必须有匹配证据声明。
  for (const [i, out] of doc.outputs.entries()) {
    const f = `outputs[${i}]`;
    const ref = parseOutputBinding(out.from);
    if (ref === null) continue;
    if (!nodeById.has(ref.node)) {
      issues.push(issue('output_node_unknown', `${f}.from`, `输出引用的节点 "${ref.node}" 不存在`));
      continue;
    }
    const sourcePreset = presetOf(ref.node);
    if (sourcePreset !== undefined && outputPort(sourcePreset, ref.artifact) === undefined) {
      issues.push(issue('output_port_unknown', `${f}.from`, `节点 "${ref.node}" 的预设未声明输出端口 "${ref.artifact}"`));
    }
    if (out.required) {
      const hasEvidence = doc.evidence.some(
        (e) => e.node === ref.node && e.artifact === ref.artifact && e.must_exist && e.sha256_recorded,
      );
      if (!hasEvidence) {
        issues.push(
          issue(
            'evidence_missing',
            f,
            `required 输出 "${out.from}" 缺少证据声明(must_exist + sha256_recorded,§3.5 evidence)`,
          ),
        );
      }
    }
  }

  // 6. 证据声明:节点存在 + artifact 是该节点预设的输出端口。
  for (const [i, decl] of doc.evidence.entries()) {
    const f = `evidence[${i}]`;
    if (!nodeById.has(decl.node)) {
      issues.push(issue('evidence_node_unknown', `${f}.node`, `证据引用的节点 "${decl.node}" 不存在`));
      continue;
    }
    const preset = presetOf(decl.node);
    if (preset !== undefined && outputPort(preset, decl.artifact) === undefined) {
      issues.push(
        issue('evidence_port_unknown', `${f}.artifact`, `节点 "${decl.node}" 的预设未声明输出端口 "${decl.artifact}"`),
      );
    }
  }

  // 7. 禁授能力检查(基线授予不得命中 forbidden_caps)+ cap 存在性。
  const forbidden = ctx.intent?.constraints.forbidden_caps;
  for (const node of doc.nodes) {
    const preset = ctx.presets[node.preset];
    if (preset === undefined) continue;
    for (const grant of preset.baseline_grants) {
      if (ctx.registry.get(grant.cap) === undefined) {
        issues.push(issue('cap_unknown', `nodes(${node.id}).preset`, `能力 "${grant.cap}" 不在注册表中`));
      }
      if (forbidden !== undefined && matchAnyCapPattern(grant.cap, forbidden)) {
        issues.push(
          issue('cap_forbidden', `nodes(${node.id}).preset`, `基线授予 "${grant.cap}" 命中禁授清单`),
        );
      }
    }
  }

  // 8. 模型准入检查(有 models 注册表才做)。
  if (ctx.models !== undefined) {
    const allowed = ctx.intent?.constraints.allowed_models ?? ['*'];
    for (const node of doc.nodes) {
      const tier = ctx.presets[node.preset]?.model?.tier;
      if (tier === undefined) continue;
      const candidate = ctx.models.entries.some(
        (m) => m.tier_fit[tier] > 0 && allowed.some((pattern) => matchModelPatternFor(m.model, pattern)),
      );
      if (!candidate) {
        issues.push(
          issue(
            'model_admission_empty',
            `nodes(${node.id}).preset`,
            `tier "${tier}" 在准入 allowlist 下无可用模型`,
          ),
        );
      }
    }
  }

  // 9. 重试/幂等组合(§3.5 失败语义:副作用型操作默认不自动重试)。
  for (const node of doc.nodes) {
    const preset = ctx.presets[node.preset];
    if (node.retry === undefined || preset === undefined) continue;
    if (node.retry.on.includes('timeout') && !preset.idempotent) {
      issues.push(
        issue(
          'retry_timeout_requires_idempotent',
          `nodes(${node.id}).retry`,
          `节点 "${node.id}" 预设未声明 idempotent: true,timeout 不可重试`,
        ),
      );
    }
  }

  // 10. 验收项可追溯(有 intent 才做)。
  if (ctx.intent !== undefined) {
    const coveredByRequiredOutput = doc.outputs.some((out) => {
      if (!out.required) return false;
      const ref = parseOutputBinding(out.from);
      if (ref === null) return false;
      return doc.evidence.some(
        (e) => e.node === ref.node && e.artifact === ref.artifact && e.must_exist && e.sha256_recorded,
      );
    });
    const evidenceArtifacts = new Set(doc.evidence.map((e) => `${e.node}.${e.artifact}`));
    for (const [i, acceptance] of ctx.intent.acceptance.entries()) {
      const refs = [...acceptance.matchAll(/artifact:([a-z][a-z0-9_-]*)/g)].map((m) => m[1]);
      if (refs.length > 0) {
        for (const artifact of refs) {
          const inRequiredOutput = doc.outputs.some((out) => {
            const ref = parseOutputBinding(out.from);
            return out.required && ref !== null && ref.artifact === artifact;
          });
          const inEvidence = [...evidenceArtifacts].some((key) => key.endsWith(`.${artifact}`));
          if (!inRequiredOutput && !inEvidence) {
            issues.push(
              issue(
                'acceptance_artifact_unresolved',
                `intent.acceptance[${i}]`,
                `验收项引用的 artifact:${artifact} 未被 required 输出或证据声明覆盖`,
              ),
            );
          }
        }
      } else if (!coveredByRequiredOutput) {
        issues.push(
          issue(
            'acceptance_uncovered',
            `intent.acceptance[${i}]`,
            '验收项不可追溯:workflow 缺少带证据声明的 required 输出',
          ),
        );
      }
    }
  }

  return issues;
}

/** inputs 依赖边成环检测(忽略反馈边;DFS 三色标记)。 */
function detectCycles(doc: WorkflowDoc): Issue[] {
  const deps = new Map<string, string[]>();
  for (const node of doc.nodes) {
    const sources: string[] = [];
    for (const binding of node.inputs ?? []) {
      const ref = parseOutputBinding(binding.from);
      if (ref !== null && ref.node !== node.id) sources.push(ref.node);
    }
    deps.set(node.id, sources);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(doc.nodes.map((n) => [n.id, WHITE]));
  const issues: Issue[] = [];
  const stack: string[] = [];
  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      const c = color.get(dep) ?? BLACK;
      if (c === GRAY) {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep];
        issues.push(issue('dependency_cycle', 'nodes', `输入依赖成环: ${cycle.join(' → ')}`));
      } else if (c === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const node of doc.nodes) {
    if (color.get(node.id) === WHITE) visit(node.id);
  }
  return issues;
}

/** 模型名通配(与 modelscore.matchModelPattern 同规则;此处避免模块环依赖)。 */
function matchModelPatternFor(model: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) return model.startsWith(pattern.slice(0, -1));
  return model === pattern;
}
