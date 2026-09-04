/**
 * 能力注册表加载(§3.1,结构按 capability-registry.schema.json):
 * 从 JSON 文档/文件加载,校验 id 唯一、kind 与字段匹配(fs_path 必有
 * path_template)、risk_level/scopes 取值合法;内置最小默认注册表
 * (fs:workdir + 2 个 mcp 示例)供开箱使用。运行时零第三方依赖,
 * 校验为手写 schema 子集(ajv 仅 devDependency,不进运行时)。
 */
import { readFile } from 'node:fs/promises';
import { RegistryInvalid } from './errors.ts';
import {
  CAP_ID_RE,
  CAP_KINDS,
  Issues,
  RISK_LEVELS,
  SCOPES,
  SPEC_VERSION_RE,
  checkEnum,
  checkPattern,
  isNonEmptyString,
  isPlainObject,
} from './validation.ts';
import type {
  CapKind,
  CapabilityEntry,
  CapabilityRegistryDoc,
  LoadedRegistry,
  RiskLevel,
  Scope,
} from './types.ts';

export const PROTOCOL = '1.0';
export const SPEC_VERSION = '1.0';

/** 解析并校验注册表 JSON 文档(结构按 schema;一次报出全部问题)。 */
export function loadCapabilityRegistry(raw: unknown): LoadedRegistry {
  const issues = new Issues();
  if (!isPlainObject(raw)) {
    throw new RegistryInvalid(['root: 必须是 JSON 对象']);
  }
  issues.addIf(raw['protocol'] !== PROTOCOL, 'protocol', '必须为 "1.0"');
  checkPattern(issues, 'spec_version', raw['spec_version'], SPEC_VERSION_RE, '\\d+.\\d+(.\\d+)?');

  const items = raw['capabilities'];
  if (!Array.isArray(items)) {
    issues.add('capabilities', '必须是数组');
    throw new RegistryInvalid(issues.all);
  }

  const capabilities: CapabilityEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const field = `capabilities[${i}]`;
    if (!isPlainObject(item)) {
      issues.add(field, '必须是对象');
      continue;
    }
    const idOk = checkPattern(issues, `${field}.id`, item['id'], CAP_ID_RE, '<namespace>:<name>');
    if (idOk) {
      const id = item['id'] as string;
      if (seen.has(id)) issues.add(`${field}.id`, `重复的能力 id "${id}"`);
      seen.add(id);
    }
    const kindOk = checkEnum(issues, `${field}.kind`, item['kind'], CAP_KINDS);
    issues.addIf(
      !isNonEmptyString(item['description']),
      `${field}.description`,
      '必须是非空字符串',
    );
    // tools(schema 可选):出现时必须是非空字符串数组。
    if (item['tools'] !== undefined) {
      const tools = item['tools'];
      const bad =
        !Array.isArray(tools) ||
        tools.some((t) => !isNonEmptyString(t));
      issues.addIf(bad, `${field}.tools`, '必须是非空字符串数组');
    }
    // risk_level(schema 可选):出现时必须合法。
    if (item['risk_level'] !== undefined) {
      checkEnum(issues, `${field}.risk_level`, item['risk_level'], RISK_LEVELS);
    }
    // grantable_scopes(required):非空、无重复、取值合法。
    const scopes = item['grantable_scopes'];
    if (
      !Array.isArray(scopes) ||
      scopes.length === 0 ||
      scopes.some((s) => typeof s !== 'string' || !SCOPES.includes(s))
    ) {
      issues.add(
        `${field}.grantable_scopes`,
        `必须是非空且无重复的 scope 数组 (${SCOPES.join('/')})`,
      );
    } else if (new Set(scopes).size !== scopes.length) {
      issues.add(`${field}.grantable_scopes`, '必须是无重复的 scope 数组');
    }
    // path_template:fs_path 必有(schema if/then);出现时必须非空字符串。
    if (kindOk && (item['kind'] as CapKind) === 'fs_path') {
      issues.addIf(
        !isNonEmptyString(item['path_template']),
        `${field}.path_template`,
        'kind=fs_path 必须给出路径模板',
      );
    } else if (item['path_template'] !== undefined) {
      issues.addIf(
        !isNonEmptyString(item['path_template']),
        `${field}.path_template`,
        '必须是非空字符串',
      );
    }
    const scopesOk =
      Array.isArray(scopes) &&
      scopes.length > 0 &&
      scopes.every((s) => typeof s === 'string' && SCOPES.includes(s));
    if (!idOk || !kindOk || !scopesOk) continue;
    capabilities.push({
      id: item['id'] as string,
      kind: item['kind'] as CapKind,
      description: isNonEmptyString(item['description']) ? item['description'] : '',
      ...(Array.isArray(item['tools'])
        ? { tools: Object.freeze([...(item['tools'] as string[])]) }
        : {}),
      ...(item['risk_level'] !== undefined
        ? { risk_level: item['risk_level'] as RiskLevel }
        : {}),
      grantable_scopes: Object.freeze([...(scopes as Scope[])]),
      ...(isNonEmptyString(item['path_template'])
        ? { path_template: item['path_template'] as string }
        : {}),
    });
  }

  if (!issues.isEmpty) throw new RegistryInvalid(issues.all);
  const frozen: readonly CapabilityEntry[] = Object.freeze(capabilities);
  const index = new Map(frozen.map((c) => [c.id, c]));
  return {
    protocol: PROTOCOL,
    spec_version: (raw['spec_version'] as string) ?? SPEC_VERSION,
    capabilities: frozen,
    get: (id: string) => index.get(id),
  };
}

/** 从 JSON 文件加载注册表(文件不存在 / JSON 非法 → RegistryInvalid)。 */
export async function loadCapabilityRegistryFile(path: string): Promise<LoadedRegistry> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new RegistryInvalid([`root: 注册表文件读取失败 ${String(err)}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    throw new RegistryInvalid([`root: 注册表不是合法 JSON (${String(err)})`]);
  }
  return loadCapabilityRegistry(raw);
}

// ---------------------------------------------------------------- 默认注册表

const DEFAULT_DOC: CapabilityRegistryDoc = {
  protocol: '1.0',
  spec_version: '1.0',
  capabilities: [
    {
      id: 'fs:workdir',
      kind: 'fs_path',
      description: '任务工作目录',
      risk_level: 'low',
      grantable_scopes: ['ro', 'rw'],
      path_template: '${task.workdir}',
    },
    {
      id: 'mcp:playwright',
      kind: 'mcp_server',
      description: '浏览器自动化:页面操作、截图、端到端验证',
      tools: ['navigate', 'click', 'fill', 'screenshot', 'snapshot'],
      risk_level: 'medium',
      grantable_scopes: ['read', 'write'],
    },
    {
      id: 'mcp:github',
      kind: 'mcp_server',
      description: 'GitHub 仓库/issue/PR 读写',
      tools: ['create_pr', 'list_issues', 'get_file', 'push_commit'],
      risk_level: 'medium',
      grantable_scopes: ['read', 'write', 'admin'],
    },
  ],
};

let cachedDefault: LoadedRegistry | null = null;

/** 内置最小默认注册表(fs:workdir + mcp 示例),进程内缓存、不可变。 */
export function defaultRegistry(): LoadedRegistry {
  if (cachedDefault === null) cachedDefault = loadCapabilityRegistry(DEFAULT_DOC);
  return cachedDefault;
}
