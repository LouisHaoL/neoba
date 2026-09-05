/**
 * doctor microsandbox 探测测试(M7):linux 探测 msb CLI;
 * win/mac 输出 N/A 不算失败;推荐后端仍 docker 优先(联动只追加提示)。
 */
import assert from 'node:assert/strict';

import test from 'node:test';

import { runDoctor } from '../../src/doctor/index.ts';
import { MSB_PROBE_ARGS } from '../../src/doctor/checks.ts';
import { renderReport } from '../../src/doctor/render.ts';
import {
  assertCheck,
  fakeProbe,
  linuxInfo,
  okResult,
  winInfo,
} from './helpers.ts';

const PROBE_LINE = ['msb', ...MSB_PROBE_ARGS].join(' ');

function linuxRoutes(
  overrides: Record<string, { code: number; stdout: string; stderr: string }> = {},
) {
  return {
    'uname -r': okResult('6.8.0-40-generic\n'),
    'docker --version': okResult('Docker version 27.3.1\n'),
    'docker info': okResult('Server Version: 27.3.1\n'),
    'docker compose version': okResult('Docker Compose version v2.29.7\n'),
    'unshare --user true': okResult(''),
    'docker info --format {{json .SecurityOptions}}':
      okResult('["name=seccomp,profile=unconfined"]\n'),
    'secret-tool lookup service neoba': okResult(''),
    [PROBE_LINE]: okResult('msb 0.6.3\n'),
    ...overrides,
  };
}

test('Linux msb 可用 → microsandboxReady=true,推荐后端仍是 docker(理由追加提示)', async () => {
  const report = await runDoctor({
    probe: fakeProbe(linuxRoutes()),
    systemInfo: linuxInfo(),
  });
  assertCheck(report.checks, 'msb-cli', 'ok');
  assert.equal(report.microsandboxReady, true);
  assert.equal(report.microsandboxReadyReason, null);
  assert.equal(report.recommendedBackend, 'docker');
  assert.ok(report.backendReason.includes('microsandbox'));
  assert.ok(renderReport(report).includes('Microsandbox: 可用'));
});

test('Linux msb 版本输出无 "msb" 前缀也能提取版本号', async () => {
  const report = await runDoctor({
    probe: fakeProbe(linuxRoutes({ [PROBE_LINE]: okResult('0.6.3\n') })),
    systemInfo: linuxInfo(),
  });
  const check = report.checks.find((c) => c.id === 'msb-cli');
  assert.ok(check?.detail.includes('0.6.3'));
});

test('Linux msb 缺失 → msb-cli fail,microsandboxReady=false 并给建议;docker 不受影响', async () => {
  const routes = linuxRoutes();
  delete routes[PROBE_LINE]; // 未命中 → 假探针回 127
  const report = await runDoctor({ probe: fakeProbe(routes), systemInfo: linuxInfo() });
  assertCheck(report.checks, 'msb-cli', 'fail');
  assert.equal(report.microsandboxReady, false);
  assert.ok(report.microsandboxReadyReason?.includes('msb'));
  const check = report.checks.find((c) => c.id === 'msb-cli');
  assert.ok(check?.suggestion?.includes('microsandbox'));
  assert.equal(report.recommendedBackend, 'docker');
  assert.ok(!report.backendReason.includes('microsandbox CLI 亦可用'));
});

test('win32 → msb-cli unknown(N/A 不算失败),microsandboxReady=false 但非错误', async () => {
  const report = await runDoctor({
    probe: fakeProbe({
      'wsl.exe --status': okResult('Default Version: 2'),
      'wsl.exe docker --version': okResult('Docker version 27.3.1\n'),
      'wsl.exe docker info': okResult(''),
      'wsl.exe unshare --user true': okResult(''),
      'powershell.exe -NoProfile -Command (Get-CimInstance Win32_ComputerSystem).HypervisorPresent':
        okResult('True'),
      'secret-tool lookup service neoba': okResult(''),
      'msb --version': okResult('msb 0.6.3\n'),
    }),
    systemInfo: winInfo(),
  });
  assertCheck(report.checks, 'msb-cli', 'unknown');
  const check = report.checks.find((c) => c.id === 'msb-cli');
  assert.ok(check?.detail.includes('N/A'));
  assert.equal(report.microsandboxReady, false);
  assert.ok(report.microsandboxReadyReason?.startsWith('N/A'));
});
