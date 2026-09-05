/**
 * doctor keyring 检测(M6):linux 探测 secret-tool 可用性;
 * win/mac 输出 N/A 不算失败;渲染同步。
 */
import assert from 'node:assert/strict';

import test from 'node:test';

import { runDoctor } from '../../src/doctor/index.ts';
import { KEYRING_PROBE_ARGS } from '../../src/doctor/checks.ts';
import { renderReport } from '../../src/doctor/render.ts';
import {
  assertCheck,
  fakeProbe,
  linuxInfo,
  okResult,
  winInfo,
} from './helpers.ts';

const PROBE_LINE = ['secret-tool', ...KEYRING_PROBE_ARGS].join(' ');

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
    [PROBE_LINE]: okResult(''),
    ...overrides,
  };
}

test('Linux secret-tool 可用(lookup 退出码 0)→ keyringReady=true', async () => {
  const report = await runDoctor({
    probe: fakeProbe(linuxRoutes({ [PROBE_LINE]: okResult('some-value\n') })),
    systemInfo: linuxInfo(),
  });
  assertCheck(report.checks, 'keyring', 'ok');
  assert.equal(report.keyringReady, true);
  assert.equal(report.keyringReadyReason, null);
  assert.ok(renderReport(report).includes('Secrets keyring: 可用'));
});

test('Linux lookup 无匹配(退出码 1)也算工具可用', async () => {
  const report = await runDoctor({
    probe: fakeProbe(linuxRoutes({
      [PROBE_LINE]: { code: 1, stdout: '', stderr: '' },
    })),
    systemInfo: linuxInfo(),
  });
  assertCheck(report.checks, 'keyring', 'ok');
  assert.equal(report.keyringReady, true);
});

test('Linux secret-tool 缺失 → keyring 检测 fail,keyringReady=false 并给建议', async () => {
  const routes = linuxRoutes();
  delete routes[PROBE_LINE]; // 未命中 → 假探针回 127(命令不存在)
  const report = await runDoctor({ probe: fakeProbe(routes), systemInfo: linuxInfo() });
  assertCheck(report.checks, 'keyring', 'fail');
  assert.equal(report.keyringReady, false);
  const check = report.checks.find((c) => c.id === 'keyring');
  assert.ok(check?.suggestion?.includes('libsecret'));
  assert.ok(report.keyringReadyReason?.includes('secret-tool'));
  assert.ok(renderReport(report).includes('Secrets keyring: 不可用'));
});

test('win32 → keyring 检测 unknown(N/A 不算失败),keyringReady=false 但非错误', async () => {
  const report = await runDoctor({
    probe: fakeProbe({
      'wsl.exe --status': okResult('Default Version: 2'),
      'wsl.exe docker --version': okResult('Docker version 27.3.1\n'),
      'wsl.exe docker info': okResult(''),
      'wsl.exe unshare --user true': okResult(''),
      'powershell.exe -NoProfile -Command (Get-CimInstance Win32_ComputerSystem).HypervisorPresent':
        okResult('True'),
    }),
    systemInfo: winInfo(),
  });
  assertCheck(report.checks, 'keyring', 'unknown');
  const check = report.checks.find((c) => c.id === 'keyring');
  assert.ok(check?.detail.includes('N/A'));
  assert.equal(report.keyringReady, false);
  assert.ok(report.keyringReadyReason?.startsWith('N/A'));
});
