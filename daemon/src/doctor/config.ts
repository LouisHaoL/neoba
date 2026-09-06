/**
 * neoba doctor - `--write` 语义:把推荐后端与关键检测结论写入 JSON 配置。
 *
 * 合并规则:已存在的配置只合并不覆盖——
 * - 用户已设置 sandbox.provider 时保持原值,推荐结果只落在 doctor 小节;
 * - doctor 小节由 doctor 全权维护,每次运行整体刷新;
 * - 其余顶层用户字段原样保留。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir as osHomedir } from 'node:os';

import type { DoctorReport } from './types.ts';

/**
 * neoba daemon 配置(此处只约束 doctor 关心的字段,其余透传)。
 * presets/registry/models(#6):CLI start 装配外部编排文档的等价 config 字段,
 * 相对路径相对本 config 文件所在目录解析;CLI flag > config > 缺省(内置
 * minimal、无 registry、models 走 daemon 缺省)。装载器同源 workflow check。
 */
export interface NeobaConfig {
  /** 预设目录(载入其中全部 *.json,递归,同 workflow check --presets)。 */
  presets?: string;
  /** 能力注册表 JSON 文件。 */
  registry?: string;
  /** 模型评分表 JSON 文件。 */
  models?: string;
  sandbox?: { provider?: string; [key: string]: unknown };
  doctor?: {
    lastRunAt?: string;
    recommendedBackend?: string;
    backendReason?: string;
    platformName?: string;
    arch?: string;
    kernelVersion?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function defaultConfigPath(homedir: string = osHomedir()): string {
  return join(homedir, '.neoba', 'config.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readExisting(configPath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
  } catch {
    // 损坏的配置不覆盖:交给调用方看到异常配置自行处理,这里当作空配置合并
  }
  return {};
}

export async function writeConfig(
  report: DoctorReport,
  configPath: string,
): Promise<NeobaConfig> {
  const existing = await readExisting(configPath);

  const existingSandbox = isRecord(existing['sandbox']) ? existing['sandbox'] : {};
  const existingDoctor = isRecord(existing['doctor']) ? existing['doctor'] : {};

  // 用户已显式设置 provider 则不覆盖
  const sandbox: Record<string, unknown> =
    existingSandbox['provider'] === undefined
      ? { ...existingSandbox, provider: report.recommendedBackend }
      : { ...existingSandbox };

  const doctor: Record<string, unknown> = {
    ...existingDoctor,
    lastRunAt: report.generatedAt,
    recommendedBackend: report.recommendedBackend,
    backendReason: report.backendReason,
    platformName: report.platform.platform,
    arch: report.platform.arch,
    kernelVersion: report.platform.kernelVersion,
    codexReady: report.codexReady,
    dataPlaneCrossBoundary: report.dataPlaneCrossBoundary,
    wslconfigMemory: report.wslconfig.memory,
    wslconfigProcessors: report.wslconfig.processors,
  };

  const next: Record<string, unknown> = {
    ...existing,
    sandbox,
    doctor,
  };

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next as NeobaConfig;
}
