/**
 * neoba doctor - %UserProfile%\.wslconfig 解析(纯函数)。
 *
 * 只关心 [wsl2] 小节的 memory / processors 两个限额键;文件缺失不阻塞检测。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { ExecProbe } from './types.ts';

export interface ParsedWslConfig {
  memory: string | null;
  processors: string | null;
  parseError: string | null;
}

export function parseWslConfig(content: string): ParsedWslConfig {
  let memory: string | null = null;
  let processors: string | null = null;
  let section = '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1]?.trim().toLowerCase() ?? '';
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv === null) continue;
    if (section !== 'wsl2') continue;
    const key = kv[1]?.trim().toLowerCase() ?? '';
    const value = kv[2] ?? '';
    if (key === 'memory') memory = value;
    if (key === 'processors') processors = value;
  }
  return { memory, processors, parseError: null };
}

export function defaultWslconfigPath(homedirPath: string = homedir()): string {
  return join(homedirPath, '.wslconfig');
}

/** 真实读取 .wslconfig;不存在或不可读返回 null(缺失不阻塞)。 */
export async function readWslconfig(
  probe: ExecProbe,
  configPath: string = defaultWslconfigPath(),
): Promise<{ found: boolean; content: string | null }> {
  // probe 参数保留以满足注入一致性;文件读取本身无外部命令
  void probe;
  try {
    const content = await readFile(configPath, 'utf8');
    return { found: true, content };
  } catch {
    return { found: false, content: null };
  }
}
