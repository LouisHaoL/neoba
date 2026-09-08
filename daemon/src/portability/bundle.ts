/**
 * 可移植性与导出(§3.5g):workflow check / export 的实现底座。
 *
 * 三档导出(设计 §3.5g 表格):
 *   minimal = workflow 本体(内含用到的 cap 清单及用途描述);
 *   brief   = + capability manifest 快照(description/tools/risk_level);
 *   full    = + preset 文件、基线 grant 清单、环境搭建指引(MCP server
 *             安装规格、镜像依赖 —— 安装规格而非工具本体)。
 * 任何档位都附带 README:列出目标机需自行补充(凭据类型与用途、本地路径、
 * 模型准入要求)。
 *
 * 铁律:任何档位不含凭据 —— secret 永不离开 tenant(§3.8),导出包中只
 * 允许"此处需要什么类型的凭据"的占位说明。scrub() 对所有导出 JSON 做防御性
 * 擦除:命中凭据语义的键一律替换为占位串,并把引用记入 README 的凭据清单。
 *
 * 预设加载只认 JSON(零第三方依赖,YAML 不做自研解析,见 capability/preset.ts
 * 头注);目录里的 .yaml/.yml 不再静默忽略(#30):单列一条带转 JSON 指引的
 * 明确错误 —— 按目录约定放置 YAML 的新用户此前只会得到"0 预设"而无提示。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parsePreset, PresetInvalid } from '../capability/index.ts';
import { isPlainObject } from '../capability/validation.ts';
import type { LoadedRegistry, Preset } from '../capability/types.ts';
import { loadModelRegistry } from '../modelscore/index.ts';
import type { LoadedModelRegistry } from '../modelscore/types.ts';

export type ExportLevel = 'minimal' | 'brief' | 'full';

export const EXPORT_LEVELS: readonly ExportLevel[] = ['minimal', 'brief', 'full'];

// ---------------------------------------------------------------- 加载

export interface PresetLoadError {
  readonly path: string;
  readonly message: string;
}

export interface PresetLoadReport {
  readonly presets: Readonly<Record<string, Preset>>;
  readonly errors: readonly PresetLoadError[];
}

/** 从若干目录加载 JSON 预设(递归扫描;按 preset.name 索引;重名后者报错不覆盖)。 */
export async function loadPresetsFromDirs(dirs: readonly string[]): Promise<PresetLoadReport> {
  const presets: Record<string, Preset> = {};
  const errors: PresetLoadError[] = [];
  for (const dir of dirs) {
    let jsonFiles: string[];
    let yamlFiles: string[];
    try {
      const dirents = await readdir(dir, { withFileTypes: true, recursive: true });
      jsonFiles = dirents
        .filter((d) => d.isFile() && d.name.endsWith('.json'))
        .map((d) => join(d.parentPath, d.name))
        .sort();
      // .yaml/.yml 明确报错(#30):装载器零依赖只认 JSON,不静默忽略 ——
      // 提示转成等价 .json(仓库 presets/planner.json、e2e-tester.json 即样例)。
      yamlFiles = dirents
        .filter((d) => d.isFile() && (d.name.endsWith('.yaml') || d.name.endsWith('.yml')))
        .map((d) => join(d.parentPath, d.name))
        .sort();
    } catch {
      errors.push({ path: dir, message: `预设目录不可读: ${dir}` });
      continue;
    }
    for (const path of yamlFiles) {
      errors.push({
        path,
        message:
          '预设文件不支持 YAML:装载器零依赖只认 JSON;请把该 .yaml/.yml 转成内容等价的 .json ' +
          '(字段结构参考 presets/planner.json),或等待后续 YAML 支持',
      });
    }
    for (const path of jsonFiles) {
      try {
        // 同目录常放 workflow/intent 文档:api 轴不是 preset/1.0 的直接跳过,不报错。
        const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
        if (isPlainObject(raw) && raw['api'] !== undefined && raw['api'] !== 'preset/1.0') continue;
        const preset = parsePreset(raw);
        if (presets[preset.name] !== undefined) {
          errors.push({ path, message: `预设名 "${preset.name}" 重复,后加载者被忽略` });
          continue;
        }
        presets[preset.name] = preset;
      } catch (err) {
        const detail = err instanceof PresetInvalid ? err.issues.join('; ') : err instanceof Error ? err.message : String(err);
        errors.push({ path, message: detail });
      }
    }
  }
  return { presets, errors };
}

/** 读 JSON 文档(文件不存在 / JSON 非法 → 带路径的 Error,CLI 层转用法/运行错误)。 */
export async function readJsonDoc(path: string): Promise<unknown> {
  const { readFile } = await import('node:fs/promises');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`文件读取失败 ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`不是合法 JSON ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 读模型评分注册表文件(--models);文件不存在返回 undefined,内容非法抛错。 */
export async function loadModelsFile(path: string): Promise<LoadedModelRegistry | undefined> {
  const raw = await readJsonDoc(path);
  return loadModelRegistry(raw);
}

// ---------------------------------------------------------------- 凭据擦除(铁律)

const CREDENTIAL_KEY_RE = /secret|token|password|credential|api_?key|private_?key|apikey/i;
const PLACEHOLDER = '<凭据占位:目标机注入,值不随包导出,见 README>';

export interface CredentialRef {
  /** 键在导出对象中的定位(如 nodes.impl.secret_ids)。 */
  readonly path: string;
  /** README 用的人读说明:此处需要什么类型的凭据。 */
  readonly hint: string;
}

/** 递归擦除:凭据语义键的值替换为占位串,引用记入 creds(§3.5g 铁律)。 */
export function scrubCredentials(value: unknown, creds: CredentialRef[], base = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((v, i) => scrubCredentials(v, creds, `${base}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const path = base === '' ? key : `${base}.${key}`;
      if (CREDENTIAL_KEY_RE.test(key)) {
        creds.push({ path, hint: describeCredential(key, v) });
        out[key] = Array.isArray(v) ? v.map(() => PLACEHOLDER) : PLACEHOLDER;
      } else {
        out[key] = scrubCredentials(v, creds, path);
      }
    }
    return out;
  }
  return value;
}

/** 凭据类型占位说明:只描述"需要什么",绝不携带值。 */
function describeCredential(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    const ids = value.filter((v): v is string => typeof v === 'string');
    if (ids.length > 0) {
      return `${key}: ${ids.length} 个凭据引用(${ids.join(', ')})——目标机需在 SecretStore 准备对应凭据`;
    }
    return `${key}: 凭据引用列表——目标机需在 SecretStore 准备对应凭据`;
  }
  return `${key}: 凭据引用——目标机需在 SecretStore 准备对应凭据`;
}

// ---------------------------------------------------------------- 导出

export interface ExportFile {
  readonly path: string;
  readonly content: string;
}

export interface ExportBundle {
  readonly level: ExportLevel;
  readonly files: readonly ExportFile[];
  /** 铁律擦除命中点(README 凭据一节的数据来源)。 */
  readonly credentials: readonly CredentialRef[];
  /** 本地注册表未收录、目标机需补齐定义的能力 id。 */
  readonly missingCaps: readonly string[];
}

export interface ExportOptions {
  readonly workflow: object;
  readonly level: ExportLevel;
  readonly presets: Readonly<Record<string, Preset>>;
  readonly registry: LoadedRegistry;
  readonly intent?: object;
  /** 导出时间戳(README 落款;缺省取当前时间)。 */
  readonly exportedAt?: string;
}

/** 工作流用到的预设名(按节点出现序去重)。 */
export function usedPresetNames(workflow: { readonly nodes: readonly { readonly preset: string }[] }): string[] {
  const seen: string[] = [];
  for (const node of workflow.nodes) {
    if (!seen.includes(node.preset)) seen.push(node.preset);
  }
  return seen;
}

/** 三档导出:纯函数,产出文件内容;不触盘(写盘见 writeBundle)。 */
export function buildExportBundle(opts: ExportOptions): ExportBundle {
  const creds: CredentialRef[] = [];
  const names = usedPresetNames(opts.workflow as { readonly nodes: readonly { readonly preset: string }[] });
  const usedPresets = names
    .map((name) => opts.presets[name])
    .filter((p): p is Preset => p !== undefined);

  // 用到的能力(预设基线授予的 cap 并集,按首次出现序)。
  const caps: string[] = [];
  for (const preset of usedPresets) {
    for (const grant of preset.baseline_grants) {
      if (!caps.includes(grant.cap)) caps.push(grant.cap);
    }
  }
  const missingCaps = caps.filter((cap) => opts.registry.get(cap) === undefined);

  const files: ExportFile[] = [];
  const pushJson = (path: string, value: unknown): void => {
    files.push({ path, content: `${JSON.stringify(scrubCredentials(value, creds), null, 2)}\n` });
  };

  // minimal:workflow 本体 + 用到的 cap 清单及用途。
  pushJson('workflow.json', opts.workflow);
  pushJson('caps.json', {
    caps: caps.map((cap) => {
      const entry = opts.registry.get(cap);
      return {
        cap,
        description: entry?.description ?? '本地注册表未收录此能力',
        used_by: usedPresets.filter((p) => p.baseline_grants.some((g) => g.cap === cap)).map((p) => p.name),
        ...(entry === undefined ? { missing: true } : {}),
      };
    }),
  });

  // brief+:capability manifest 快照(description/tools/risk_level)。
  if (opts.level === 'brief' || opts.level === 'full') {
    pushJson('capabilities.json', {
      protocol: opts.registry.protocol,
      spec_version: opts.registry.spec_version,
      capabilities: caps.flatMap((cap) => {
        const entry = opts.registry.get(cap);
        if (entry === undefined) return [];
        return [{
          id: entry.id,
          kind: entry.kind,
          description: entry.description,
          ...(entry.tools !== undefined ? { tools: [...entry.tools] } : {}),
          ...(entry.risk_level !== undefined ? { risk_level: entry.risk_level } : {}),
          grantable_scopes: [...entry.grantable_scopes],
          ...(entry.path_template !== undefined ? { path_template: entry.path_template } : {}),
        }];
      }),
    });
  }

  // full+:preset 文件、基线 grant 清单、环境搭建指引。
  if (opts.level === 'full') {
    for (const preset of usedPresets) {
      pushJson(`presets/${preset.name}.json`, presetToDoc(preset));
    }
    pushJson('baseline-grants.json', {
      grants: usedPresets.flatMap((preset) =>
        preset.baseline_grants.map((grant) => ({ preset: preset.name, cap: grant.cap, scope: grant.scope })),
      ),
    });
    files.push({ path: 'environment.md', content: renderEnvironmentMd(usedPresets, opts.registry, caps) });
  }

  files.push({
    path: 'README.md',
    content: renderReadme({
      level: opts.level,
      presetNames: names,
      usedPresets,
      registry: opts.registry,
      caps,
      missingCaps,
      credentials: creds,
      intent: opts.intent,
      exportedAt: opts.exportedAt,
    }),
  });
  return { level: opts.level, files, credentials: creds, missingCaps };
}

/** 把导出包写到目录(mkdir -p;返回写入的绝对路径列表)。 */
export async function writeBundle(outDir: string, bundle: ExportBundle): Promise<string[]> {
  const fs = await import('node:fs/promises');
  await fs.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const file of bundle.files) {
    const path = join(outDir, file.path);
    await fs.mkdir(join(path, '..'), { recursive: true });
    await fs.writeFile(path, file.content, 'utf8');
    written.push(path);
  }
  return written;
}

/** Preset 对象 → preset/1.0 文档(只回放 schema 字段,不含运行时状态)。 */
function presetToDoc(p: Preset): Record<string, unknown> {
  return {
    api: 'preset/1.0',
    name: p.name,
    description: p.description,
    base: p.base,
    ...(p.model !== undefined
      ? {
          model: {
            tier: p.model.tier,
            ...(p.model.fallback !== undefined ? { fallback: [...p.model.fallback] } : {}),
          },
        }
      : {}),
    ...(p.skills.length > 0 ? { skills: [...p.skills] } : {}),
    ...(p.idempotent ? { idempotent: true } : {}),
    baseline_grants: p.baseline_grants.map((g) => ({ cap: g.cap, scope: g.scope })),
    io_contracts: {
      inputs: p.io_contracts.inputs.map((port) => ({ name: port.name, type: port.type })),
      outputs: p.io_contracts.outputs.map((port) => ({ name: port.name, type: port.type })),
    },
    escalation_policy: {
      auto_approve: [...p.escalation_policy.auto_approve],
      require_approval: [...p.escalation_policy.require_approval],
    },
  };
}

// ---------------------------------------------------------------- 渲染

function renderReadme(input: {
  level: ExportLevel;
  presetNames: readonly string[];
  usedPresets: readonly Preset[];
  registry: LoadedRegistry;
  caps: readonly string[];
  missingCaps: readonly string[];
  credentials: readonly CredentialRef[];
  intent: object | undefined;
  exportedAt: string | undefined;
}): string {
  const { level, presetNames, usedPresets, registry, caps, missingCaps, credentials, intent } = input;
  const lines: string[] = [];
  lines.push(`# neoba 工作流导出包(${level} 档)`);
  lines.push('');
  lines.push(`由 \`neoba workflow export --level ${level}\` 生成于 ${input.exportedAt ?? new Date().toISOString()}。`);
  lines.push('目标机导入后请再跑一次 `neoba workflow check`(移植前后各核验一次,§3.5g)。');
  lines.push('');
  lines.push('## 包内容');
  lines.push('- `workflow.json` — 工作流定义(workflow/1.0)');
  lines.push('- `caps.json` — 用到的能力清单及用途描述');
  if (level !== 'minimal') lines.push('- `capabilities.json` — 能力 manifest 快照(description/tools/risk_level)');
  if (level === 'full') {
    for (const name of presetNames) lines.push(`- \`presets/${name}.json\` — 节点预设文件`);
    lines.push('- `baseline-grants.json` — 基线授予清单');
    lines.push('- `environment.md` — 环境搭建指引(镜像依赖、MCP server 安装规格)');
  }
  lines.push('');
  lines.push('## 目标机需自行补充');
  lines.push('');
  lines.push('### 凭据(铁律:本包不含任何凭据,secret 永不离开源 tenant)');
  if (credentials.length === 0) {
    lines.push('- 无。本包未引用凭据。');
  } else {
    for (const cred of credentials) {
      lines.push(`- \`${cred.path}\` — ${cred.hint}`);
    }
  }
  lines.push('');
  lines.push('### 本地路径');
  lines.push('- `fs:workdir` 按 `${task.workdir}` 解析:目标机需准备任务工作目录。');
  const pathCaps = caps.filter((cap) => registry.get(cap)?.path_template !== undefined && cap !== 'fs:workdir');
  if (pathCaps.length > 0) {
    lines.push(`- 其余文件系统能力(${pathCaps.join(', ')})的路径模板见 capabilities.json,导入时按目标机布局改写。`);
  }
  lines.push('');
  lines.push('### 模型准入');
  const tiers = [...new Set(usedPresets.flatMap((p) => (p.model !== undefined ? [p.model.tier] : [])))];
  if (tiers.length === 0) {
    lines.push('- 工作流预设未声明 model.tier,无模型准入要求。');
  } else {
    lines.push(`- 工作流预设声明 tier:${tiers.join(', ')} —— 需经目标机 Model Score Registry 解析准入。`);
    lines.push('  准备 modelscore 注册表文件,并在目标机以 `--models` 提供给 `neoba workflow check`。');
  }
  if (intent !== undefined) {
    const allowed = (intent as { constraints?: { allowed_models?: unknown } }).constraints?.allowed_models;
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes('*')) {
      lines.push(`- intent 限制 allowed_models: ${allowed.join(', ')}`);
    }
  }
  lines.push('');
  if (missingCaps.length > 0) {
    lines.push('### 能力注册表缺口');
    for (const cap of missingCaps) {
      lines.push(`- \`${cap}\` 不随包导出定义:目标机需在能力注册表中补齐该能力(kind/scopes/tools)。`);
    }
    lines.push('');
  }
  lines.push('### 预设文件');
  lines.push(`- 工作流引用预设:${presetNames.length > 0 ? presetNames.map((n) => `\`${n}\``).join(', ') : '(无)'}。`);
  if (level !== 'full') {
    lines.push(`- ${level} 档不含预设文件本体:目标机需自备同名预设(JSON,结构按 preset.schema.json)。`);
  } else {
    lines.push('- full 档已附带 `presets/*.json`,可直接登记进目标机预设目录。');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** 环境搭建指引(full 档):安装规格而非工具本体。 */
function renderEnvironmentMd(usedPresets: readonly Preset[], registry: LoadedRegistry, caps: readonly string[]): string {
  const lines: string[] = [];
  lines.push('# 环境搭建指引');
  lines.push('');
  lines.push('> 本文件只给安装规格(装什么、需要什么能力),不含工具本体与凭据。');
  lines.push('');
  lines.push('## 沙箱镜像');
  lines.push('- 参考镜像:`neoba/sandbox:latest`(daemon 缺省;目标机需可拉取或以等价镜像替换)。');
  const bases = [...new Set(usedPresets.map((p) => p.base))];
  lines.push(`- 工作流预设基座类型:${bases.join(', ')}(any = 基座可替换)。`);
  lines.push('');
  lines.push('## MCP server 安装规格');
  const mcpCaps = caps.filter((cap) => cap.startsWith('mcp:'));
  if (mcpCaps.length === 0) {
    lines.push('- 工作流未引用 mcp:* 能力,无需安装 MCP server。');
  } else {
    for (const cap of mcpCaps) {
      const entry = registry.get(cap);
      lines.push(`### ${cap}`);
      if (entry === undefined) {
        lines.push('- 本地注册表未收录:目标机需自行定义该能力并安装对应 MCP server。');
      } else {
        lines.push(`- 用途:${entry.description}`);
        if (entry.risk_level !== undefined) lines.push(`- risk_level:${entry.risk_level}`);
        if (entry.tools !== undefined) lines.push(`- 需提供的 tools:${entry.tools.join(', ')}`);
        lines.push(`- 可授 scope:${entry.grantable_scopes.join('/')}`);
        lines.push('- 安装:目标机自行安装提供上述 tools 的 MCP server,并登记进能力注册表。');
      }
      lines.push('');
    }
  }
  lines.push('## 预设与授予');
  for (const preset of usedPresets) {
    lines.push(`- \`${preset.name}\`:${preset.description}(基座 ${preset.base}${preset.model !== undefined ? `,tier ${preset.model.tier}` : ''})`);
  }
  lines.push('- 基线授予清单见 `baseline-grants.json`;升级授予走目标机的审批流(§3.3)。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}
