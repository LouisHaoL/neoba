/**
 * neoba workflow check / export(§3.5g 排查与可移植性入口):
 *
 *   check  显式本地入口:输出缺失清单(缺哪个 preset / cap / 模型准入
 *          不通过),移植前后各跑一次;实现底座 = plancheck(§3.5c)。
 *          模型准入口径与 daemon 一致(issue #5):workflow 声明了
 *          model.tier 的节点而未给 --models 注册表时,check 报
 *          models_registry_missing 且退出非 0 —— 不允许「本地过检、
 *          daemon workflow.run 恒校验(空表即拒)时被拒」的假阳性。
 *   export 三档导出(minimal|brief|full)+ README;铁律:任何档位不含
 *          凭据 —— 擦除逻辑在 portability 模块(§3.8)。
 *
 * 两条子命令都是本地命令(不连 daemon):引用只在本地解析,每次都查。
 */

import { CliUsageError, flagBool, flagString, parseArgs } from '../args.ts';
import type { CliIo, Command } from '../types.ts';
import { defaultRegistry, loadCapabilityRegistryFile } from '../../capability/index.ts';
import type { LoadedRegistry } from '../../capability/types.ts';
import { checkIntent, checkWorkflow } from '../../plancheck/index.ts';
import type { IntentDoc, Issue, WorkflowDoc } from '../../plancheck/types.ts';
import type { Preset } from '../../capability/types.ts';
import {
  EXPORT_LEVELS,
  buildExportBundle,
  loadModelsFile,
  loadPresetsFromDirs,
  readJsonDoc,
  writeBundle,
} from '../../portability/index.ts';
import type { ExportLevel, PresetLoadReport } from '../../portability/index.ts';

export const workflowCommand: Command = {
  name: 'workflow',
  summary: '工作流排查与可移植性(§3.5g):check 查缺 / export 三档导出',
  usage:
    'neoba workflow check <workflow.json> [--presets DIR]... [--intent FILE] [--models FILE] [--registry FILE] [--json]\n' +
    '  (预设声明 model.tier 时 check 必须给 --models,否则报 models_registry_missing)\n' +
    '  neoba workflow export <workflow.json> --level minimal|brief|full [--out DIR] [--presets DIR]... [--intent FILE] [--models FILE] [--registry FILE] [--json]',
  async run(args, { io, deps }) {
    const sub = args[0];
    if (sub !== 'check' && sub !== 'export') {
      throw new CliUsageError('第一个参数必须是 check 或 export');
    }
    const rest = args.slice(1);
    const presetDirs = collectValues(rest, 'presets');
    const { flags, positionals } = parseArgs(rest, ['presets', 'intent', 'models', 'registry', 'level', 'out']);
    const file = positionals[0];
    if (file === undefined) throw new CliUsageError('缺少 workflow 文件参数');
    const asJson = flagBool(flags, 'json');

    // ---- 本地引用解析(§3.5g:名字只在本地解析,每次都查)----
    const dirs = presetDirs.length > 0 ? presetDirs : await defaultPresetDirs(deps);
    const loaded = await loadPresetsFromDirs(dirs);
    const registry = await loadRegistry(flags);
    const models = await loadOptionalModels(flags);
    const intent = await loadOptionalIntent(flags);

    const check = checkWorkflow(await readJsonDoc(file), {
      presets: loaded.presets,
      registry,
      ...(intent !== undefined ? { intent } : {}),
      ...(models !== undefined ? { models } : {}),
    });

    if (sub === 'check') {
      return runCheckOutput(io, file, asJson, check, intent, loaded, models !== undefined);
    }
    return runExport(io, file, asJson, flags, check, intent, loaded, registry);
  },
};

// ---------------------------------------------------------------- check

/** checkWorkflow 的返回类型(带类型化文档)。 */
type CheckedWorkflow = ReturnType<typeof checkWorkflow>;

function runCheckOutput(
  io: CliIo,
  file: string,
  asJson: boolean,
  check: CheckedWorkflow,
  intent: IntentDoc | undefined,
  loaded: PresetLoadReport,
  modelsProvided: boolean,
): number {
  // 口径对齐(issue #5):未给 --models 时,声明了 model.tier 的节点无法
  // 做模型准入,与 daemon workflow.run 恒校验的口径不一致 → 报 fail。
  const gate = modelsProvided ? [] : modelsRegistryMissingIssues(check.doc, loaded.presets);
  const issues = [...check.issues, ...gate];
  const ok = check.ok && gate.length === 0 && loaded.errors.length === 0;
  if (asJson) {
    io.out(JSON.stringify({
      ok,
      workflow: file,
      issues,
      preset_errors: loaded.errors,
    }, null, 2));
  } else {
    const nodeCount = check.doc?.nodes.length ?? 0;
    io.out(`工作流 ${file}: ${nodeCount} 节点,已加载预设 ${usedNames(loaded)}`);
    for (const err of loaded.errors) {
      io.out(`⚠ 预设加载失败 ${err.path}: ${err.message}`);
    }
    for (const iss of issues) {
      io.out(`✗ [${iss.code}] ${iss.field}: ${iss.message}`);
    }
    if (ok) {
      io.out(`检查通过,无缺失(§3.5g)。${intent !== undefined ? '(已联动 intent 验收可追溯)' : '(未提供 --intent,验收可追溯检查跳过)'}`);
    } else {
      io.out(`共 ${issues.length + loaded.errors.length} 处缺失/问题;修复后重跑(移植前后各核验一次)。`);
    }
  }
  return ok ? 0 : 1;
}

/**
 * 未提供 models 注册表时的准入口径检查(issue #5):任一节点引用的预设
 * 声明了 model.tier → 报 models_registry_missing。workflow 无 model 声明
 * 则维持原状(不传 --models 也过检)。
 */
function modelsRegistryMissingIssues(
  doc: WorkflowDoc | null,
  presets: Readonly<Record<string, Preset>>,
): Issue[] {
  if (doc === null) return [];
  const declared: string[] = [];
  for (const node of doc.nodes) {
    const tier = presets[node.preset]?.model?.tier;
    if (tier === undefined) continue;
    declared.push(`${node.id}(tier=${tier})`);
  }
  if (declared.length === 0) return [];
  return [{
    code: 'models_registry_missing',
    field: 'nodes',
    message:
      `声明了 model.tier 的节点需要 --models 模型注册表(${declared.join(', ')});` +
      'daemon 侧 workflow.run 恒校验模型准入,不传则本地过检、运行仍会被拒',
  }];
}

// ---------------------------------------------------------------- export

async function runExport(
  io: CliIo,
  file: string,
  asJson: boolean,
  flags: Record<string, string | true>,
  check: CheckedWorkflow,
  intent: IntentDoc | undefined,
  loaded: PresetLoadReport,
  registry: LoadedRegistry,
): Promise<number> {
  // 移植前核验:检查不过不导出,坏包不出门。
  if (!check.ok || loaded.errors.length > 0) {
    if (asJson) {
      io.err(JSON.stringify({ ok: false, issues: check.issues, preset_errors: loaded.errors }, null, 2));
    } else {
      for (const err of loaded.errors) io.err(`⚠ 预设加载失败 ${err.path}: ${err.message}`);
      for (const iss of check.issues) io.err(`✗ [${iss.code}] ${iss.field}: ${iss.message}`);
      io.err('检查未通过,拒绝导出(§3.5g:移植前后各跑一次 check)。');
    }
    return 1;
  }

  const level = flagString(flags, 'level');
  if (level === undefined || !EXPORT_LEVELS.includes(level as ExportLevel)) {
    throw new CliUsageError(`--level 必填,取值 ${EXPORT_LEVELS.join('|')}`);
  }
  const outDir = flagString(flags, 'out') ?? 'neoba-export';
  const bundle = buildExportBundle({
    workflow: check.doc as object,
    level: level as ExportLevel,
    presets: loaded.presets,
    registry,
    ...(intent !== undefined ? { intent } : {}),
  });
  const written = await writeBundle(outDir, bundle);

  if (asJson) {
    io.out(JSON.stringify({
      level,
      out: outDir,
      files: written,
      credentials: bundle.credentials,
      missing_caps: bundle.missingCaps,
    }, null, 2));
  } else {
    io.out(`已导出 ${level} 档到 ${outDir}:`);
    for (const path of written) io.out(`  ${path}`);
    if (bundle.credentials.length > 0) {
      io.out(`铁律擦除:${bundle.credentials.length} 处凭据引用已替换为占位说明,详见 README.md。`);
    }
    if (bundle.missingCaps.length > 0) {
      io.out(`注意:${bundle.missingCaps.join(', ')} 不在本地注册表,目标机需补齐定义(见 README.md)。`);
    }
    io.out('目标机导入后请再跑一次 `neoba workflow check` 核验。');
  }
  return 0;
}

// ---------------------------------------------------------------- 装载辅助

async function loadRegistry(flags: Record<string, string | true>): Promise<LoadedRegistry> {
  const path = flagString(flags, 'registry');
  if (path === undefined) return defaultRegistry();
  return loadCapabilityRegistryFile(path);
}

async function loadOptionalModels(flags: Record<string, string | true>) {
  const path = flagString(flags, 'models');
  if (path === undefined) return undefined;
  return loadModelsFile(path);
}

async function loadOptionalIntent(flags: Record<string, string | true>): Promise<IntentDoc | undefined> {
  const path = flagString(flags, 'intent');
  if (path === undefined) return undefined;
  const raw = await readJsonDoc(path);
  const result = checkIntent(raw);
  if (!result.ok || result.doc === null) {
    const detail = result.issues.map((i) => `${i.field}: ${i.message}`).join('; ');
    throw new CliUsageError(`intent 文件非法 ${path}: ${detail}`);
  }
  return result.doc;
}

/** 未给 --presets 时,缺省尝试 ./presets(存在才用;约定优于配置)。 */
async function defaultPresetDirs(deps: { fileExists(path: string): Promise<boolean> }): Promise<string[]> {
  const here = 'presets';
  return (await deps.fileExists(here)) ? [here] : [];
}

/** 收集可重复的值型选项(--presets a --presets b / --presets=a)。 */
function collectValues(args: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? '';
    if (token === `--${name}`) {
      const value = args[i + 1];
      if (value !== undefined) {
        out.push(value);
        i += 1;
      }
    } else if (token.startsWith(`--${name}=`)) {
      out.push(token.slice(name.length + 3));
    }
  }
  return out;
}

function usedNames(loaded: PresetLoadReport): string {
  const names = Object.keys(loaded.presets).sort();
  return names.length > 0 ? names.join(', ') : '(无)';
}
