/**
 * CLI 配置装载(M6):生产组装(startDaemon 等)首次接通配置文件。
 *
 * 查找顺序(宽松缺省:不存在/损坏一律回退,不抛):
 *   1. <cwd>/neoba.config.json   项目级配置(仓库约定);
 *   2. ~/.neoba/config.json      用户级配置(doctor --write 的落点)。
 *
 * 该函数 M7 的 provider factory 也要共用,故独立成 cli/config.ts 并导出。
 * 结构约束复用 doctor/config.ts 的 NeobaConfig(daemon 配置只有一份形状)。
 */
import { readFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

import type { NeobaConfig } from '../doctor/config.ts';
import type { SecretStoreFactoryConfig } from '../secrets/factory.ts';

/** 项目级配置文件名(相对 cwd)。 */
export const PROJECT_CONFIG_FILE = 'neoba.config.json';

/** 配置装载结果:config 为宽松缺省的配置对象;path 为实际命中的文件。 */
export interface LoadedNeobaConfig {
  readonly config: NeobaConfig;
  /** 命中的配置文件路径;两处都不存在(或都损坏)为 null。 */
  readonly path: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function tryReadJson(
  path: string,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // 损坏的配置不抛(宽松缺省):doctor --write 侧已有同样取舍。
    return null;
  }
}

/** 按查找顺序装载配置;找不到任何文件返回空配置(path=null)。 */
export async function loadNeobaConfigDetailed(
  opts?: { cwd?: string; homedir?: string },
): Promise<LoadedNeobaConfig> {
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.homedir ?? osHomedir();
  for (const path of [join(cwd, PROJECT_CONFIG_FILE), join(home, '.neoba', 'config.json')]) {
    const parsed = await tryReadJson(path);
    if (parsed !== null) {
      return { config: parsed as NeobaConfig, path };
    }
  }
  return { config: {}, path: null };
}

/** 宽松入口:只要配置对象(M7 provider factory 同用)。 */
export async function loadNeobaConfig(
  opts?: { cwd?: string; homedir?: string },
): Promise<NeobaConfig> {
  return (await loadNeobaConfigDetailed(opts)).config;
}

/**
 * 取 config 的 secrets 小节;缺省 / 非对象 → undefined(调用方保持现行为,
 * 不注入 SecretStore)。小节存在但字段非法时由工厂抛类型化错误,这里不拦。
 */
export function readSecretsConfig(
  config: NeobaConfig | undefined,
): SecretStoreFactoryConfig | undefined {
  const section = config?.['secrets'];
  if (!isRecord(section)) return undefined;
  return section as SecretStoreFactoryConfig;
}
