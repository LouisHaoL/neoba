import assert from 'node:assert/strict';

import test from 'node:test';

import { runDoctor } from '../../src/doctor/index.ts';
import { renderReport } from '../../src/doctor/render.ts';
import {
  assertCheck,
  fakeProbe,
  linuxInfo,
  okResult,
} from './helpers.ts';

function linuxRoutes(overrides: Record<string, ReturnType<typeof okResult>> = {}) {
  return {
    'uname -r': okResult('6.8.0-40-generic\n'),
    'docker --version': okResult('Docker version 27.3.1, build a...\n'),
    'docker info': okResult('Server Version: 27.3.1\n'),
    'docker compose version': okResult('Docker Compose version v2.29.7\n'),
    'unshare --user true': okResult(''),
    'docker info --format {{json .SecurityOptions}}':
      okResult('["name=seccomp,profile=unconfined"]\n'),
    // M6:secret-tool 探测(lookup 无匹配也说明工具可用,回退出码 1)
    'secret-tool lookup service neoba': { code: 1, stdout: '', stderr: '' },
    ...overrides,
  };
}

test('Linux + docker 全可用:推荐 docker 后端', async () => {
  const report = await runDoctor({
    probe: fakeProbe(linuxRoutes()),
    systemInfo: linuxInfo(),
    now: () => new Date('2026-09-04T00:00:00Z'),
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generatedAt, '2026-09-04T00:00:00.000Z');
  assert.equal(report.platform.platform, 'linux');
  assert.equal(report.platform.kernelVersion, '6.8.0-40-generic');
  assert.equal(report.recommendedBackend, 'docker');

  assertCheck(report.checks, 'platform', 'ok');
  assertCheck(report.checks, 'linux-kernel', 'ok');
  assertCheck(report.checks, 'docker-cli', 'ok');
  assertCheck(report.checks, 'docker-daemon', 'ok');
  assertCheck(report.checks, 'docker-compose', 'ok');
  assertCheck(report.checks, 'resources', 'ok');
  assertCheck(report.checks, 'disk-space', 'ok');
  assertCheck(report.checks, 'userns', 'ok');
  assertCheck(report.checks, 'docker-seccomp-userns', 'ok');
  assert.equal(report.codexReady, true);
  assert.equal(report.codexReadyReason, null);
  // OpenCode 基座前置(§4 P3):无 userns 要求,docker daemon 可达即满足
  assert.equal(report.opencodeReady, true);
  assert.equal(report.opencodeReadyReason, null);
  // M6:secret-tool 探测路由存在 → keyring 后端可接线
  assert.equal(report.keyringReady, true);
  assert.equal(report.keyringReadyReason, null);

  // Linux 上不应出现 Windows 专项检测
  assert.ok(!report.checks.some((c) => c.id.startsWith('wsl-')));
  // 详情中提取到版本号
  const cli = report.checks.find((c) => c.id === 'docker-cli');
  assert.ok(cli?.detail.includes('27.3.1'));
});

test('userns 不可用:codexReady=false 且给出原因,但 docker 后端不受影响', async () => {
  const report = await runDoctor({
    probe: fakeProbe(linuxRoutes({
      'unshare --user true': { code: 1, stdout: '', stderr: 'unshare: Operation not permitted' },
    })),
    systemInfo: linuxInfo(),
  });

  assertCheck(report.checks, 'userns', 'fail');
  assert.equal(report.codexReady, false);
  assert.ok(report.codexReadyReason?.includes('userns'));
  assert.equal(report.recommendedBackend, 'docker');
});

test('docker seccomp 为默认 profile 且无法确证 userns 放行:标 unknown 并给建议', async () => {
  const report = await runDoctor({
    probe: fakeProbe(linuxRoutes({
      'docker info --format {{json .SecurityOptions}}':
        okResult('["name=seccomp,profile=default"]\n'),
    })),
    systemInfo: linuxInfo(),
  });

  assertCheck(report.checks, 'docker-seccomp-userns', 'unknown');
  const seccomp = report.checks.find((c) => c.id === 'docker-seccomp-userns');
  assert.ok(seccomp?.suggestion?.includes('unconfined'));
  // unknown 不算 fail,Codex 前置按可满足处理,但需人工确认
  assert.equal(report.codexReady, true);
});

test('Linux 无 docker:各 docker 项失败,后端 none 且带建议', async () => {
  const routes = {
    'uname -r': okResult('6.8.0-40-generic\n'),
    'docker --version': { code: 127, stdout: '', stderr: 'command not found' },
    'docker info': { code: 127, stdout: '', stderr: 'command not found' },
    'docker compose version': { code: 127, stdout: '', stderr: 'command not found' },
    'docker-compose --version': { code: 127, stdout: '', stderr: 'command not found' },
  };
  const report = await runDoctor({ probe: fakeProbe(routes), systemInfo: linuxInfo() });

  assert.equal(report.recommendedBackend, 'none');
  assertCheck(report.checks, 'docker-cli', 'fail');
  assertCheck(report.checks, 'docker-daemon', 'fail');
  assertCheck(report.checks, 'docker-compose', 'warn');
  const cli = report.checks.find((c) => c.id === 'docker-cli');
  assert.ok(cli?.suggestion !== undefined);
  // OpenCode 前置随 daemon 不可达而失败,原因可读
  assert.equal(report.opencodeReady, false);
  assert.ok(report.opencodeReadyReason?.includes('docker daemon'));
});

test('Linux docker 装了但 daemon 不可达:后端 none,compose 走 v1 回退', async () => {
  const routes = {
    'uname -r': okResult('6.8.0-40-generic\n'),
    'docker --version': okResult('Docker version 27.3.1, build a...\n'),
    'docker info': { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' },
    'docker compose version': { code: 1, stdout: '', stderr: 'docker: \'compose\' is not a docker command' },
    'docker-compose --version': okResult('docker-compose version 1.29.2, build unknown\n'),
  };
  const report = await runDoctor({ probe: fakeProbe(routes), systemInfo: linuxInfo() });

  assert.equal(report.recommendedBackend, 'none');
  assertCheck(report.checks, 'docker-cli', 'ok');
  assertCheck(report.checks, 'docker-daemon', 'fail');
  assertCheck(report.checks, 'docker-compose', 'ok');
  const daemon = report.checks.find((c) => c.id === 'docker-daemon');
  assert.ok(daemon?.detail.includes('Cannot connect to the Docker daemon'));
  const compose = report.checks.find((c) => c.id === 'docker-compose');
  assert.ok(compose?.detail.includes('1.29.2'));
});

test('资源不足与内核过旧降级为 warn,不改变后端判定', async () => {
  const report = await runDoctor({
    probe: fakeProbe(linuxRoutes()),
    systemInfo: linuxInfo({
      cpuCount: 1,
      totalMemoryBytes: 2 * 1024 ** 3,
      kernelVersion: '3.10.0-1160.el7',
      targetDiskFreeBytes: 5 * 1024 ** 3,
    }),
  });

  assertCheck(report.checks, 'resources', 'warn');
  assertCheck(report.checks, 'linux-kernel', 'warn');
  assertCheck(report.checks, 'disk-space', 'warn');
  assert.equal(report.recommendedBackend, 'docker');
});

test('文本渲染:包含分级图标与推荐后端', async () => {
  const report = await runDoctor({
    probe: fakeProbe(linuxRoutes({
      'docker info': { code: 1, stdout: '', stderr: 'daemon down' },
    })),
    systemInfo: linuxInfo(),
  });
  const text = renderReport(report);
  assert.ok(text.includes('❌ docker-daemon'));
  assert.ok(text.includes('✅ docker-cli'));
  assert.ok(text.includes('推荐后端: none'));
  assert.ok(text.includes('建议:'));
});
