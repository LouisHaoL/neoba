/**
 * neoba doctor - 跨平台环境检测入口。
 *
 * 用法概要:
 *   const report = await runDoctor({ probe: execProbe });
 *   console.log(renderReport(report));
 *   await writeConfig(report, defaultConfigPath());
 *
 * 设计约定(设计文档 v0.2 §5 / §10.6 / §11):
 * - 所有外部命令经注入的 ExecProbe 执行,单项失败不影响整体;
 * - Windows 沙箱后端 = WSL2 内 Docker,doctor 产出 recommendedBackend 供 daemon 选 SandboxProvider;
 * - Codex 基座前置条件(userns)单独以 codexReady 报告;
 * - 数据面路径跨界为 error 级(性能悬崖),记入 dataPlane 与 dataPlaneCrossBoundary。
 */

import type {
  CheckResult,
  DataPlanePathCheck,
  DoctorOptions,
  DoctorReport,
  ExecProbe,
  WslConfigInfo,
} from './types.ts';

import {
  checkDiskSpace,
  checkDockerCli,
  checkDockerCompose,
  checkDockerDaemon,
  checkDockerSeccompUserns,
  checkKeyring,
  checkLinuxKernel,
  checkMicrosandboxCli,
  checkPlatform,
  checkResources,
  checkUserns,
  checkVirtualization,
  checkWslDockerCli,
  checkWslDockerDaemon,
  checkWslStatus,
  makeDataPlaneCheck,
  makeWslconfigCheck,
  type CheckContext,
  type CheckFn,
} from './checks.ts';
import { recommendBackend } from './backend.ts';
import { classifyDataPlanePath } from './dataplane.ts';
import {
  defaultWslconfigPath,
  parseWslConfig,
  readWslconfig,
} from './wslconfig.ts';
import { renderReport } from './render.ts';
import { defaultConfigPath, writeConfig } from './config.ts';
import { collectSystemInfo, execProbe } from './realProbe.ts';

export { defaultConfigPath, writeConfig } from './config.ts';
export { renderReport } from './render.ts';
export { recommendBackend } from './backend.ts';
export { collectSystemInfo, execProbe } from './realProbe.ts';
export { normalizeWindowsOutput } from './checks.ts';
export { MSB_PROBE_ARGS, checkMicrosandboxCli } from './checks.ts';
export { classifyDataPlanePath, collectDataPlanePaths } from './dataplane.ts';
export {
  defaultWslconfigPath,
  parseWslConfig,
  readWslconfig,
} from './wslconfig.ts';
export type {
  CheckResult,
  DataPlanePathCheck,
  DoctorReport,
  ExecProbe,
  ExecResult,
  PlatformInfo,
  RecommendedBackend,
  Severity,
  WslConfigInfo,
} from './types.ts';
export type { NeobaConfig } from './config.ts';

async function runCheck(fn: CheckFn, ctx: CheckContext): Promise<CheckResult> {
  try {
    return await fn(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: fn.name || 'unknown-check',
      ok: false,
      severity: 'fail',
      detail: `检测执行异常: ${message}`,
    };
  }
}

function buildDataPlaneReport(
  paths: { kind: string; path: string }[],
  platformName: string,
): { entries: DataPlanePathCheck[]; crossBoundary: boolean } {
  const entries: DataPlanePathCheck[] = paths.map(({ kind, path }) => {
    const c = classifyDataPlanePath(path, { platform: platformName });
    return {
      kind,
      path,
      location: c.location,
      crossBoundary: c.crossBoundary,
      severity: c.crossBoundary ? 'fail' : 'ok',
      detail: c.detail,
    };
  });
  return {
    entries,
    crossBoundary: entries.some((e) => e.crossBoundary),
  };
}

function buildWslconfigReport(content: string | null): WslConfigInfo {
  if (content === null) {
    return { found: false, memory: null, processors: null, parseError: null };
  }
  const parsed = parseWslConfig(content);
  return {
    found: true,
    memory: parsed.memory,
    processors: parsed.processors,
    parseError: parsed.parseError,
  };
}

/** 汇总所有检测项并生成结构化报告。 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const probe = options.probe;
  const info =
    options.systemInfo ??
    (await collectSystemInfo(probe, options.targetPath ?? process.cwd()));
  const ctx: CheckContext = { probe, info };

  const dataPlanePaths = options.dataPlanePaths ?? [];
  const wslconfigContent = await resolveWslconfigContent(options, probe);
  const wslconfigInfo = buildWslconfigReport(wslconfigContent.content);
  if (wslconfigContent.parseIssue) wslconfigInfo.parseError = wslconfigContent.parseIssue;

  const checks: CheckResult[] = [];

  // 通用检测(全平台)
  for (const fn of [checkPlatform, checkResources, checkDiskSpace]) {
    checks.push(await runCheck(fn, ctx));
  }

  // OS keyring(M6):linux 探测 secret-tool;win/mac 输出 N/A 不算失败。
  const keyringResult = await runCheck(checkKeyring, ctx);
  checks.push(keyringResult);

  // microsandbox CLI(M7):可选 Firecracker 后端,linux 探测 msb;
  // win/mac 输出 N/A 不算失败,也不参与后端判定(docker 仍优先)。
  const msbResult = await runCheck(checkMicrosandboxCli, ctx);
  checks.push(msbResult);

  // Docker(host 侧,全平台;Windows 上对应 Docker Desktop)
  for (const fn of [checkDockerCli, checkDockerDaemon, checkDockerCompose]) {
    checks.push(await runCheck(fn, ctx));
  }

  // 数据面路径跨界(v0.2 §10.6)与 .wslconfig 限额(缺失不阻塞)
  checks.push(await runCheck(makeDataPlaneCheck(dataPlanePaths), ctx));
  if (info.platform === 'win32') {
    checks.push(await runCheck(makeWslconfigCheck(wslconfigContent.content), ctx));
  }

  let usernsResult: CheckResult | null = null;
  let seccompResult: CheckResult | null = null;

  if (info.platform === 'linux') {
    checks.push(await runCheck(checkLinuxKernel, ctx));
    usernsResult = await runCheck(checkUserns, ctx);
    checks.push(usernsResult);
    seccompResult = await runCheck(checkDockerSeccompUserns, ctx);
    checks.push(seccompResult);
  }

  if (info.platform === 'win32') {
    checks.push(await runCheck(checkVirtualization, ctx));
    const wsl = await runCheck(checkWslStatus, ctx);
    checks.push(wsl);
    if (wsl.ok) {
      checks.push(await runCheck(checkWslDockerCli, ctx));
      checks.push(await runCheck(checkWslDockerDaemon, ctx));
      usernsResult = await runCheck(checkUserns, ctx);
      checks.push(usernsResult);
    } else {
      checks.push({
        id: 'wsl-docker-cli',
        ok: false,
        severity: 'fail',
        detail: 'WSL 不可用,跳过 WSL 内 docker CLI 检测',
        suggestion: wsl.suggestion,
      });
      checks.push({
        id: 'wsl-docker-daemon',
        ok: false,
        severity: 'fail',
        detail: 'WSL 不可用,跳过 WSL 内 docker daemon 检测',
        suggestion: wsl.suggestion,
      });
    }
  }

  const decision = recommendBackend(checks, info.platform);
  let reason = decision.reason;
  // microsandbox 探测联动(M7):可用时在判定理由里提示可选后端;
  // 缺失时保持原理由(docker 优先的 M6 语义零漂移)。
  if (info.platform === 'linux' && msbResult.ok) {
    reason += ';microsandbox CLI 亦可用(可选 Firecracker microVM 后端,经 sandbox.provider=microsandbox 启用)';
  }
  if (dataPlanePaths.length > 0 && decision.backend !== 'none') {
    reason += dataPlaneReportCross(info.platform, dataPlanePaths)
      ? ';注意:存在跨界数据面路径(error 级),需迁移到 WSL2 原生文件系统'
      : ';数据面路径均在原生文件系统内';
  }

  const dataPlane = buildDataPlaneReport(dataPlanePaths, info.platform);
  const codexReady = computeCodexReady(
    info.platform,
    usernsResult,
    seccompResult,
    checks,
  );
  const opencodeReady = computeOpencodeReady(info.platform, checks);
  // keyring 仅 Linux 可判定;win/mac 为 N/A,不算失败也不算可用。
  const keyringReady = info.platform === 'linux' && keyringResult.ok;

  return {
    schemaVersion: 1,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    platform: info,
    checks,
    recommendedBackend: decision.backend,
    backendReason: reason,
    codexReady,
    codexReadyReason: codexReady ? null : codexNotReadyReason(
      info.platform,
      usernsResult,
      seccompResult,
      checks,
    ),
    opencodeReady,
    opencodeReadyReason: opencodeReady ? null : opencodeNotReadyReason(info.platform, checks),
    keyringReady,
    keyringReadyReason: keyringReady
      ? null
      : keyringNotReadyReason(info.platform, keyringResult),
    // microsandbox 仅 Linux 可判定;win/mac 为 N/A,不算失败也不算可用。
    microsandboxReady: info.platform === 'linux' && msbResult.ok,
    microsandboxReadyReason: info.platform === 'linux' && msbResult.ok
      ? null
      : msbNotReadyReason(info.platform, msbResult),
    dataPlane: dataPlane.entries,
    dataPlaneCrossBoundary: dataPlane.crossBoundary,
    wslconfig: wslconfigInfo,
  };
}

/** keyringReady=false 的原因;win/mac 给 N/A 说明(不算失败)。 */
function keyringNotReadyReason(
  platformName: string,
  keyring: CheckResult,
): string {
  if (platformName !== 'linux') {
    return `N/A:${platformName} 不使用 libsecret keyring,secret 后端走平台默认(win32=DPAPI,其余=AES 文件)`;
  }
  return `secret-tool 不可用: ${keyring.detail}`;
}

/** microsandboxReady=false 的原因;win/mac 给 N/A 说明(不算失败,可选后端)。 */
function msbNotReadyReason(
  platformName: string,
  msb: CheckResult,
): string {
  if (platformName !== 'linux') {
    return `N/A:${platformName} 不做 microsandbox 探测(Firecracker 后端仅 Linux/KVM),沙箱走平台默认(docker/WSL2)`;
  }
  return `microsandbox CLI(msb)不可用: ${msb.detail}`;
}

function codexNotReadyReason(
  platformName: string,
  userns: CheckResult | null,
  seccomp: CheckResult | null,
  checks: CheckResult[],
): string {
  if (platformName !== 'linux' && platformName !== 'win32') {
    return '非 Linux/Windows 平台,无法判定 Codex 基座前置条件';
  }
  if (userns === null) {
    return platformName === 'win32'
      ? 'WSL2 不可用,未执行 userns 检测'
      : 'userns 检测未执行';
  }
  if (!userns.ok) return `userns 前置不满足: ${userns.detail}`;
  if (platformName === 'linux') {
    const daemonOk = checks.some((c) => c.id === 'docker-daemon' && c.ok);
    if (!daemonOk) return 'docker daemon 不可达,Codex 容器基座无法供给';
    if (seccomp !== null && seccomp.severity === 'fail') {
      return `seccomp 前置不满足: ${seccomp.detail}`;
    }
  } else {
    const wslDaemonOk = checks.some((c) => c.id === 'wsl-docker-daemon' && c.ok);
    if (!wslDaemonOk) return 'WSL2 内 docker daemon 不可达,Codex 容器基座无法供给';
  }
  return '前置条件未全部满足';
}

/**
 * OpenCode 基座前置(§4 P3):无 userns/seccomp 特殊要求,仅要求容器后端
 * 可达(节点执行仍跑在沙箱容器内);Linux 看 docker-daemon,Windows 看
 * WSL2 内 docker daemon。
 */
function computeOpencodeReady(platformName: string, checks: CheckResult[]): boolean {
  if (platformName === 'linux') {
    return checks.some((c) => c.id === 'docker-daemon' && c.ok);
  }
  if (platformName === 'win32') {
    return checks.some((c) => c.id === 'wsl-docker-daemon' && c.ok);
  }
  return false;
}

function opencodeNotReadyReason(platformName: string, checks: CheckResult[]): string {
  if (platformName !== 'linux' && platformName !== 'win32') {
    return '非 Linux/Windows 平台,无法判定 OpenCode 基座前置条件';
  }
  const daemonOk = checks.some((c) => c.id === 'docker-daemon' && c.ok);
  const wslDaemonOk = checks.some((c) => c.id === 'wsl-docker-daemon' && c.ok);
  if (!daemonOk && !wslDaemonOk) {
    return 'docker daemon 不可达(Linux 直查与 WSL2 内均未命中),OpenCode 容器基座无法供给';
  }
  return '前置条件未全部满足';
}

function dataPlaneReportCross(
  platformName: string,
  paths: { kind: string; path: string }[],
): boolean {
  return paths.some(
    (p) => classifyDataPlanePath(p.path, { platform: platformName }).crossBoundary,
  );
}

function computeCodexReady(
  platformName: string,
  userns: CheckResult | null,
  seccomp: CheckResult | null,
  checks: CheckResult[],
): boolean {
  const usernsOk = userns !== null && userns.ok;
  if (platformName === 'linux') {
    const daemonOk = checks.some((c) => c.id === 'docker-daemon' && c.ok);
    const seccompBlocked = seccomp !== null && seccomp.severity === 'fail';
    return usernsOk && daemonOk && !seccompBlocked;
  }
  if (platformName === 'win32') {
    const wslDaemonOk = checks.some((c) => c.id === 'wsl-docker-daemon' && c.ok);
    return usernsOk && wslDaemonOk;
  }
  return false;
}

async function resolveWslconfigContent(
  options: DoctorOptions,
  probe: ExecProbe,
): Promise<{ content: string | null; parseIssue: string | null }> {
  if (options.wslconfigContent !== undefined) {
    return { content: options.wslconfigContent, parseIssue: null };
  }
  try {
    const r = await readWslconfig(probe, defaultWslconfigPath());
    return { content: r.found ? (r.content ?? '') : null, parseIssue: null };
  } catch (err) {
    return {
      content: null,
      parseIssue: err instanceof Error ? err.message : String(err),
    };
  }
}
