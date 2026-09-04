/**
 * CLI 依赖的默认装配:把壳接到既有模块(daemon / doctor / artifacts / bindings)。
 * 业务逻辑全在那些模块里;这里只做转发,不改行为。
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { startDaemon } from '../daemon/index.ts';
import type { DaemonHandle, DaemonOptions } from '../daemon/index.ts';
import { runDoctor, writeConfig, defaultConfigPath, execProbe } from '../doctor/index.ts';
import type { DoctorReport } from '../doctor/index.ts';
import { ArtifactRepository } from '../artifacts/index.ts';
import { spawnBridge } from '../bindings/index.ts';
import type { CliDeps } from './types.ts';

/** daemon 包的 package.json(版本号来源,随本模块位置解析)。 */
export function packageJsonPath(): string {
  return fileURLToPath(new URL('../../package.json', import.meta.url));
}

/** 读 package.json 的 version;读不到回退 0.0.0(--version 永不抛)。 */
export async function loadPackageVersion(): Promise<string> {
  try {
    const raw = await readFile(packageJsonPath(), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 组装默认依赖:真实 daemon / doctor / CAS 仓库 / MCP 桥。 */
export async function defaultDeps(overrides: Partial<CliDeps> = {}): Promise<CliDeps> {
  const deps: CliDeps = {
    version: await loadPackageVersion(),
    startDaemon: (opts) => startDaemon(opts as DaemonOptions),
    runDoctor: (opts) => runDoctor({ probe: opts.probe }),
    writeConfig: (report, configPath) =>
      writeConfig(report as DoctorReport, configPath),
    defaultConfigPath: () => defaultConfigPath(),
    execProbe: (cmd, args) => execProbe(cmd, [...args]),
    openRepository: (root) => ArtifactRepository.open(root),
    spawnBridge: (opts) => spawnBridge(opts),
    fetch: (input, init) => fetch(input, init),
    homedir: () => osHomedir(),
    readTextFile,
    fileExists,
    ...overrides,
  };
  return deps;
}

export type { DaemonHandle, DaemonOptions };
