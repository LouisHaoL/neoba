/**
 * neoba doctor - 真实探针:唯一的 child_process / node:os 触点。
 *
 * 核心检测逻辑不 import 本文件;测试注入假探针即可。
 */

import { execFile } from 'node:child_process';
import { arch, cpus, platform, release, totalmem, version as osVersion } from 'node:os';
import { statfs } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { ExecProbe, ExecResult, PlatformInfo } from './types.ts';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 10_000;

/** 真实命令探针:命令不存在 / 超时等异常统一折叠为 code=-1,绝不抛出。 */
export const execProbe: ExecProbe = async (cmd, args) => {
  try {
    const r = await execFileAsync(cmd, args, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    // 命令自身非零退出:保留真实退出码与输出
    if (e.code !== undefined && typeof e.code === 'number' && e.code > 0) {
      return {
        code: e.code,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
      };
    }
    const reason =
      e.code === 'ENOENT'
        ? 'command not found'
        : e.killed
          ? 'timeout'
          : (e.message ?? 'probe error');
    return { code: -1, stdout: e.stdout ?? '', stderr: reason };
  }
};

/** 采集平台与资源信息(Linux 内核版本经探针执行 uname -r)。 */
export async function collectSystemInfo(
  probe: ExecProbe,
  targetPath: string,
): Promise<PlatformInfo> {
  const isLinux = platform() === 'linux';
  let kernelVersion: string | null = null;
  if (isLinux) {
    const r = await probe('uname', ['-r']);
    if (r.code === 0 && r.stdout.trim() !== '') {
      kernelVersion = r.stdout.trim().split('\n')[0] ?? null;
    }
  }

  let targetDiskFreeBytes: number | null = null;
  try {
    const s = await statfs(targetPath);
    targetDiskFreeBytes = s.bavail * s.bsize;
  } catch {
    targetDiskFreeBytes = null;
  }

  return {
    platform: platform(),
    release: release(),
    version: osVersion(),
    arch: arch(),
    kernelVersion,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    targetDiskFreeBytes,
  };
}
