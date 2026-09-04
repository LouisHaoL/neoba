import assert from 'node:assert/strict';

import test from 'node:test';

import { normalizeWindowsOutput } from '../../src/doctor/checks.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import {
  assertCheck,
  failResult,
  fakeProbe,
  okResult,
  winInfo,
} from './helpers.ts';

const NUL = String.fromCharCode(0);
const BOM = String.fromCharCode(0xfeff);
const BS = String.fromCharCode(92);
const WSL_UNC_PREFIX = BS + BS + 'wsl$' + BS;

/** 模拟 wsl.exe --status 的 UTF-16LE 输出经 utf8 解码后的形态(BOM + 逐字符 NUL 间隔)。 */
const wslStatusReal =
  BOM + '默认版本' + NUL + ' ' + NUL + ':' + NUL + ' ' + NUL + '2' + NUL;

test('normalizeWindowsOutput 剥离 BOM 与 NUL', () => {
  const cleaned = normalizeWindowsOutput(wslStatusReal);
  assert.ok(!cleaned.includes(NUL));
  assert.ok(!cleaned.includes(BOM));
  assert.ok(cleaned.includes('默认版本'));
  assert.match(cleaned, /2/);
  // 普通文本不受影响
  assert.equal(normalizeWindowsOutput('plain'), 'plain');
});

const wslOkRoutes = () => ({
  'wsl.exe --status': okResult(wslStatusReal),
  'wsl.exe unshare --user true': okResult(''),
  'wsl.exe docker --version': okResult('Docker version 27.3.1, build a...\n'),
  'wsl.exe docker info': okResult('Server Version: 27.3.1\n'),
  'powershell.exe -NoProfile -Command (Get-CimInstance Win32_ComputerSystem).HypervisorPresent':
    okResult('True\n'),
  'docker --version': okResult('Docker version 27.3.1, build a...\n'),
  'docker info': okResult('ok\n'),
  'docker compose version': okResult('Docker Compose version v2.29.7\n'),
});

test('Windows + WSL2 + WSL 内 docker 可用:推荐 docker-wsl2', async () => {
  const report = await runDoctor({
    probe: fakeProbe(wslOkRoutes()),
    systemInfo: winInfo(), wslconfigContent: null,
  });

  assert.equal(report.recommendedBackend, 'docker-wsl2');
  assertCheck(report.checks, 'wsl-status', 'ok');
  assertCheck(report.checks, 'wsl-docker-cli', 'ok');
  assertCheck(report.checks, 'wsl-docker-daemon', 'ok');
  assertCheck(report.checks, 'virtualization', 'ok');
  assertCheck(report.checks, 'platform', 'ok');
  // Windows 上不做 Linux 内核检测
  assert.ok(!report.checks.some((c) => c.id === 'linux-kernel'));
});

test('Windows 无 WSL:WSL 专项失败(跳过式结果),后端视 host docker 而定', async () => {
  const routes = {
    'wsl.exe --status': failResult('WSL 未安装', -1),
    'docker --version': failResult('not found', 127),
    'docker info': failResult('not found', 127),
    'docker compose version': failResult('not found', 127),
    'docker-compose --version': failResult('not found', 127),
  };
  const report = await runDoctor({ probe: fakeProbe(routes), systemInfo: winInfo(), wslconfigContent: null });

  assertCheck(report.checks, 'wsl-status', 'fail');
  // 依赖 WSL 的检测项以"跳过"形态失败,但仍然出现在报告中
  const cli = report.checks.find((c) => c.id === 'wsl-docker-cli');
  const daemon = report.checks.find((c) => c.id === 'wsl-docker-daemon');
  assert.ok(cli !== undefined && daemon !== undefined);
  assert.ok(cli.detail.includes('跳过'));
  // 虚拟化检测执行失败也不阻塞,仅 warn
  assertCheck(report.checks, 'virtualization', 'warn');
  assert.equal(report.recommendedBackend, 'none');
});

test('Windows 有 WSL2 但 WSL 内无 docker,host Docker Desktop 可用:退化为 docker', async () => {
  const routes = {
    'wsl.exe --status': okResult(wslStatusReal),
    'wsl.exe docker --version': failResult('docker: command not found', 127),
    'powershell.exe -NoProfile -Command (Get-CimInstance Win32_ComputerSystem).HypervisorPresent':
      okResult('True\n'),
    'docker --version': okResult('Docker version 27.3.1, build a...\n'),
    'docker info': okResult('ok\n'),
    'docker compose version': okResult('Docker Compose version v2.29.7\n'),
  };
  const report = await runDoctor({ probe: fakeProbe(routes), systemInfo: winInfo(), wslconfigContent: null });

  assertCheck(report.checks, 'wsl-docker-cli', 'fail');
  assert.equal(report.recommendedBackend, 'docker');
  assert.ok(report.backendReason.includes('WSL2 内 Docker 不可用'));
});

test('WSL 默认版本为 1:warn,不推荐 docker-wsl2', async () => {
  const statusV1 =
    BOM + '默认版本' + NUL + ':' + NUL + ' ' + NUL + '1' + NUL;
  const routes = {
    ...wslOkRoutes(),
    'wsl.exe --status': okResult(statusV1),
  };
  const report = await runDoctor({ probe: fakeProbe(routes), systemInfo: winInfo(), wslconfigContent: null });

  assertCheck(report.checks, 'wsl-status', 'warn');
  // 默认版本非 2 视为不满足前置,WSL 内 docker 检测以"跳过"形态失败
  const cli = report.checks.find((c) => c.id === 'wsl-docker-cli');
  assert.ok(cli !== undefined && cli.detail.includes('跳过'));
  // WSL 前置不满足,但该场景下 host Docker Desktop 可用 → 退化为 docker
  assert.equal(report.recommendedBackend, 'docker');
});

test('虚拟化检测失败仅 warn,不影响 docker-wsl2 判定', async () => {
  const routes = {
    ...wslOkRoutes(),
    'powershell.exe -NoProfile -Command (Get-CimInstance Win32_ComputerSystem).HypervisorPresent':
      failResult('Access denied', 1),
  };
  const report = await runDoctor({ probe: fakeProbe(routes), systemInfo: winInfo(), wslconfigContent: null });

  assertCheck(report.checks, 'virtualization', 'warn');
  assert.equal(report.recommendedBackend, 'docker-wsl2');
});

test('单项检测抛异常被兜底为 fail,不影响整体报告', async () => {
  const probe = async (cmd: string, args: string[]) => {
    if (cmd === 'wsl.exe') throw new Error('probe exploded');
    return { code: 0, stdout: 'Docker version 27.3.1, build a...\n', stderr: '' };
  };
  const report = await runDoctor({ probe, systemInfo: winInfo(), wslconfigContent: null });
  const wsl = report.checks.find((c) => c.id === 'checkWslStatus');
  assert.ok(wsl !== undefined);
  assert.equal(wsl.severity, 'fail');
  assert.ok(wsl.detail.includes('检测执行异常'));
  // WSL 检测崩溃但 host 侧 Docker Desktop 可用,退化为 docker
  assert.equal(report.recommendedBackend, 'docker');
  // 其余项仍完成了检测
  assertCheck(report.checks, 'docker-cli', 'ok');
});

test('数据面跨界路径:error 级,后端理由纳入提示', async () => {
  const report = await runDoctor({
    probe: fakeProbe(wslOkRoutes()),
    systemInfo: winInfo(),
    wslconfigContent: null,
    dataPlanePaths: [
      { kind: 'workdir', path: 'D:' + BS + 'neoba' + BS + 'work' },
      { kind: 'artifact-repo', path: WSL_UNC_PREFIX + 'Ubuntu-24.04' + BS + 'home' + BS + 'u' + BS + 'repo' },
    ],
  });

  assertCheck(report.checks, 'data-plane', 'fail');
  assert.equal(report.dataPlaneCrossBoundary, true);
  const dp = report.checks.find((c) => c.id === 'data-plane');
  assert.ok(dp?.detail.includes('workdir=D:' + BS + 'neoba' + BS + 'work'));
  assert.ok(report.backendReason.includes('跨界'));
  // 数据面明细:wsl$ 原生 ok,盘符跨界
  assert.equal(report.dataPlane.length, 2);
  assert.ok(report.dataPlane.some((e) => e.location === 'wsl-native' && !e.crossBoundary));
  assert.ok(report.dataPlane.some((e) => e.location === 'windows-drive' && e.crossBoundary));
});

test('/mnt/d 跨界与 WSL 原生路径混合:同样 error 级', async () => {
  const report = await runDoctor({
    probe: fakeProbe(wslOkRoutes()),
    systemInfo: winInfo(),
    wslconfigContent: null,
    dataPlanePaths: [
      { kind: 'workdir', path: '/mnt/d/work' },
      { kind: 'docker-context', path: '/home/u/.docker' },
    ],
  });

  assertCheck(report.checks, 'data-plane', 'fail');
  assert.ok(report.dataPlane.some((e) => e.location === 'wsl-mnt-bridge'));
});

test('.wslconfig 存在:解析 memory/processors', async () => {
  const report = await runDoctor({
    probe: fakeProbe(wslOkRoutes()),
    systemInfo: winInfo(),
    wslconfigContent: '[wsl2]\r\nmemory=6GB\r\nprocessors=4\r\n# comment\r\n',
  });

  assertCheck(report.checks, 'wslconfig', 'ok');
  assert.equal(report.wslconfig.found, true);
  assert.equal(report.wslconfig.memory, '6GB');
  assert.equal(report.wslconfig.processors, '4');
  const wc = report.checks.find((c) => c.id === 'wslconfig');
  assert.ok(wc?.detail.includes('6GB'));
});

test('.wslconfig 缺失:unknown 且不阻塞 docker-wsl2 判定', async () => {
  const report = await runDoctor({
    probe: fakeProbe(wslOkRoutes()),
    systemInfo: winInfo(),
    wslconfigContent: null,
  });

  assertCheck(report.checks, 'wslconfig', 'unknown');
  assert.equal(report.wslconfig.found, false);
  assert.equal(report.recommendedBackend, 'docker-wsl2');
});

test('WSL2 全链路可用时 codexReady=true(含 WSL 内 userns)', async () => {
  const report = await runDoctor({
    probe: fakeProbe(wslOkRoutes()),
    systemInfo: winInfo(),
    wslconfigContent: null,
  });

  assertCheck(report.checks, 'userns', 'ok');
  assert.equal(report.codexReady, true);
});
