/**
 * 预设解析(§3.2,结构按 preset.schema.json,含 v0.2 的 idempotent)。
 * 根类型 = 文档类(§3 总则决议):首层只用 api,禁止 protocol/spec_version。
 *
 * 格式取舍(零第三方依赖约束):本期只支持 JSON,YAML 不做极简自研解析
 * (子集化 YAML 的坑多于收益,协议结构是 P0 冻结物,不该被手写解析器
 * 的歧义定义);设计产物以 preset.json 落盘,YAML 由后续引入受审依赖
 * 或上游工具转换。parsePreset(raw: unknown) 收 JSON 对象。
 */
import { PresetInvalid } from './errors.ts';
import {
  ARTIFACT_NAME_RE,
  BASES,
  CAP_ID_OR_WILDCARD_RE,
  CAP_ID_RE,
  IO_TYPE_RE,
  Issues,
  PRESET_NAME_RE,
  SCOPES,
  TIERS,
  checkEnum,
  checkPattern,
  checkPatternArray,
  isNonEmptyString,
  isPlainObject,
} from './validation.ts';
import type {
  Base,
  BaselineGrantSpec,
  IoPort,
  Preset,
  Scope,
  Tier,
} from './types.ts';

export const API = 'preset/1.0';

/** 解析并校验预设 JSON 文档(一次报出全部问题;idempotent 缺省 false)。 */
export function parsePreset(raw: unknown): Preset {
  const issues = new Issues();
  if (!isPlainObject(raw)) {
    throw new PresetInvalid(['root: 必须是 JSON 对象']);
  }

  // 文档类根类型:首层只用 api,protocol/spec_version 禁止出现(schema not)。
  issues.addIf(
    raw['protocol'] !== undefined,
    'protocol',
    '文档类根类型禁止携带 protocol(版本走 api 轴)',
  );
  issues.addIf(
    raw['spec_version'] !== undefined,
    'spec_version',
    '文档类根类型禁止携带 spec_version(版本走 api 轴)',
  );
  issues.addIf(raw['api'] !== API, 'api', '必须为 "preset/1.0"');
  checkPattern(
    issues,
    'name',
    raw['name'],
    PRESET_NAME_RE,
    '^[a-z0-9][a-z0-9._/-]*$',
  );
  issues.addIf(!isNonEmptyString(raw['description']), 'description', '必须是非空字符串');
  checkEnum(issues, 'base', raw['base'], BASES);

  // skills:字符串数组(可为空)。
  if (raw['skills'] !== undefined) {
    const skills = raw['skills'];
    issues.addIf(
      !Array.isArray(skills) || skills.some((s) => !isNonEmptyString(s)),
      'skills',
      '必须是非空字符串数组',
    );
  }

  // model(可选):tier 必填,fallback 可选。
  if (raw['model'] !== undefined) {
    const model = raw['model'];
    if (!isPlainObject(model)) {
      issues.add('model', '必须是对象');
    } else {
      checkEnum(issues, 'model.tier', model['tier'], TIERS);
      if (model['fallback'] !== undefined) {
        const fallback = model['fallback'];
        issues.addIf(
          !Array.isArray(fallback) || fallback.some((t) => !TIERS.includes(t as string)),
          'model.fallback',
          `必须是 tier 数组 (${TIERS.join('/')})`,
        );
      }
    }
  }

  // idempotent(可选布尔,schema default false)。
  issues.addIf(
    raw['idempotent'] !== undefined && typeof raw['idempotent'] !== 'boolean',
    'idempotent',
    '必须是布尔值',
  );

  // baseline_grants(required):{ cap, scope } 数组。
  const baseline = raw['baseline_grants'];
  if (!Array.isArray(baseline)) {
    issues.add('baseline_grants', '必须是数组');
  } else {
    for (let i = 0; i < baseline.length; i++) {
      const grant = baseline[i];
      const field = `baseline_grants[${i}]`;
      if (!isPlainObject(grant)) {
        issues.add(field, '必须是对象');
        continue;
      }
      checkPattern(issues, `${field}.cap`, grant['cap'], CAP_ID_RE, '<namespace>:<name>');
      checkEnum(issues, `${field}.scope`, grant['scope'], SCOPES);
    }
  }

  // io_contracts(required):inputs/outputs 各为 { name, type } 数组。
  const io = raw['io_contracts'];
  if (!isPlainObject(io)) {
    issues.add('io_contracts', '必须是对象');
  } else {
    for (const direction of ['inputs', 'outputs'] as const) {
      const ports = io[direction];
      if (!Array.isArray(ports)) {
        issues.add(`io_contracts.${direction}`, '必须是数组');
        continue;
      }
      for (let i = 0; i < ports.length; i++) {
        const port = ports[i];
        const field = `io_contracts.${direction}[${i}]`;
        if (!isPlainObject(port)) {
          issues.add(field, '必须是对象');
          continue;
        }
        checkPattern(issues, `${field}.name`, port['name'], ARTIFACT_NAME_RE, '^[a-z][a-z0-9_-]*$');
        checkPattern(issues, `${field}.type`, port['type'], IO_TYPE_RE, '^[a-z][a-z0-9_.:-]*$');
      }
    }
  }

  // escalation_policy(required):auto_approve / require_approval,元素为
  // cap_id_or_wildcard(精确 id / "*" / "ns:*",common.schema.json)。
  const escalation = raw['escalation_policy'];
  if (!isPlainObject(escalation)) {
    issues.add('escalation_policy', '必须是对象');
  } else {
    for (const key of ['auto_approve', 'require_approval'] as const) {
      checkPatternArray(
        issues,
        `escalation_policy.${key}`,
        escalation[key],
        CAP_ID_OR_WILDCARD_RE,
        'cap_id | "*" | "<namespace>:*"',
      );
    }
  }

  if (!issues.isEmpty) throw new PresetInvalid(issues.all);

  const skills = raw['skills'];
  const model = raw['model'];
  const fallback =
    isPlainObject(model) && Array.isArray(model['fallback'])
      ? Object.freeze([...(model['fallback'] as Tier[])])
      : undefined;
  return {
    api: API,
    name: raw['name'] as string,
    description: raw['description'] as string,
    base: raw['base'] as Base,
    ...(isPlainObject(model)
      ? { model: { tier: model['tier'] as Tier, ...(fallback !== undefined ? { fallback } : {}) } }
      : {}),
    skills: Array.isArray(skills) ? Object.freeze([...(skills as string[])]) : [],
    idempotent: raw['idempotent'] === true,
    baseline_grants: Object.freeze(
      (baseline as Record<string, unknown>[]).map((g) => ({
        cap: g['cap'] as string,
        scope: g['scope'] as Scope,
      })),
    ),
    io_contracts: {
      inputs: readPorts((io as Record<string, unknown>)['inputs']),
      outputs: readPorts((io as Record<string, unknown>)['outputs']),
    },
    escalation_policy: {
      auto_approve: Object.freeze([
        ...((escalation as Record<string, unknown>)['auto_approve'] as string[]),
      ]),
      require_approval: Object.freeze([
        ...((escalation as Record<string, unknown>)['require_approval'] as string[]),
      ]),
    },
  };
}

function readPorts(value: unknown): readonly IoPort[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.map((p) => {
      const port = p as Record<string, unknown>;
      return { name: port['name'] as string, type: port['type'] as string };
    }),
  );
}

/** 从 JSON 文件加载预设(文件不存在 / JSON 非法 → PresetInvalid)。 */
export async function parsePresetFile(path: string): Promise<Preset> {
  const { readFile } = await import('node:fs/promises');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new PresetInvalid([`root: 预设文件读取失败 ${String(err)}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    throw new PresetInvalid([`root: 预设不是合法 JSON (${String(err)})`]);
  }
  return parsePreset(raw);
}

/** 供测试/示例构造最小合法预设骨架(文档类根:无 protocol/spec_version)。 */
export function minimalPresetDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    api: 'preset/1.0',
    name: 'e2e-tester',
    description: '端到端测试执行者',
    base: 'any',
    skills: [],
    baseline_grants: [{ cap: 'fs:workdir', scope: 'rw' }],
    io_contracts: { inputs: [], outputs: [] },
    escalation_policy: { auto_approve: [], require_approval: ['*'] },
    ...overrides,
  };
}
