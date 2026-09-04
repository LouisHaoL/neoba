/**
 * neoba doctor 测试 - 假探针与平台信息夹具。
 */

import assert from 'node:assert/strict';

import type {
  ExecProbe,
  ExecResult,
  PlatformInfo,
} from '../../src/doctor/types.ts';

export function okResult(stdout = ''): ExecResult {
  return { code: 0, stdout, stderr: '' };
}

export function failResult(stderr = 'error', code = 1): ExecResult {
  return { code, stdout: '', stderr };
}

/**
 * 按完整命令行(“cmd arg1 arg2”)路由的假探针;未命中返回 code=127。
 */
export function fakeProbe(routes: Record<string, ExecResult>): ExecProbe {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    const hit = routes[key];
    if (hit !== undefined) return hit;
    return { code: 127, stdout: '', stderr: `not found: ${key}` };
  };
}

export function assertCheck(
  checks: { id: string; ok: boolean; severity: string }[],
  id: string,
  expectedSeverity: 'ok' | 'warn' | 'fail' | 'unknown',
): void {
  if (expectedSeverity === 'unknown') {
    const c = checks.find((x) => x.id === id);
    assert.ok(c !== undefined, `missing check: ${id}`);
    assert.equal(c.severity, 'unknown', `check ${id} severity`);
    return;
  }
  const c = checks.find((x) => x.id === id);
  assert.ok(c !== undefined, `missing check: ${id}`);
  assert.equal(c.severity, expectedSeverity, `check ${id} severity`);
  assert.equal(c.ok, expectedSeverity === 'ok', `check ${id} ok flag`);
}

export function linuxInfo(overrides: Partial<PlatformInfo> = {}): PlatformInfo {
  return {
    platform: 'linux',
    release: '6.8.0-40-generic',
    version: '#40-Ubuntu SMP',
    arch: 'x64',
    kernelVersion: '6.8.0-40-generic',
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    targetDiskFreeBytes: 120 * 1024 ** 3,
    ...overrides,
  };
}

export function winInfo(overrides: Partial<PlatformInfo> = {}): PlatformInfo {
  return {
    platform: 'win32',
    release: '10.0.22631',
    version: 'Windows 11 Pro',
    arch: 'x64',
    kernelVersion: null,
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    targetDiskFreeBytes: 120 * 1024 ** 3,
    ...overrides,
  };
}
