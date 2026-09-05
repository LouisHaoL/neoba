/**
 * neoba doctor - 单项检测实现。
 *
 * 约定:每个检测函数只依赖注入的 ExecProbe 与 PlatformInfo,
 * 单项内部异常由 index.ts 统一兜底为 fail,不影响其他检测项。
 */

import type {
  CheckResult,
  ExecProbe,
  PlatformInfo,
  Severity,
} from './types.ts';
import {
  classifyDataPlanePath,
  type DataPlanePathInput,
} from './dataplane.ts';
import { parseWslConfig } from './wslconfig.ts';

export interface CheckContext {
  probe: ExecProbe;
  info: PlatformInfo;
}

export type CheckFn = (ctx: CheckContext) => Promise<CheckResult>;

function make(
  id: string,
  severity: Severity,
  detail: string,
  suggestion?: string,
): CheckResult {
  const result: CheckResult = { id, ok: severity === 'ok', severity, detail };
  if (suggestion !== undefined) result.suggestion = suggestion;
  return result;
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  return trimmed.split('\n')[0] ?? '';
}

// ---------------------------------------------------------------------------
// 平台与内核
// ---------------------------------------------------------------------------

export async function checkPlatform(ctx: CheckContext): Promise<CheckResult> {
  const { info } = ctx;
  const detail =
    `${info.platform} / ${info.arch} / release=${info.release} / version=${info.version}`;
  return make('platform', 'ok', detail);
}

export async function checkLinuxKernel(
  ctx: CheckContext,
): Promise<CheckResult> {
  if (ctx.info.platform !== 'linux') {
    return make('linux-kernel', 'ok', '非 Linux 平台,跳过内核版本检测');
  }
  const stored = ctx.info.kernelVersion;
  if (stored !== null) {
    const parsed = /^(\d+)\.(\d+)/.exec(stored);
    const major = parsed === null ? null : Number(parsed[1]);
    if (major !== null && major < 4) {
      return make(
        'linux-kernel',
        'warn',
        `内核版本 ${stored} 偏旧`,
        'gVisor / Firecracker 后端(预留)要求内核 >= 4.x,建议升级系统内核',
      );
    }
    return make(
      'linux-kernel',
      'ok',
      `内核版本 ${stored}(供 gVisor/Firecracker 判断预留)`,
    );
  }
  const r = await ctx.probe('uname', ['-r']);
  if (r.code === 0 && r.stdout.trim() !== '') {
    return make(
      'linux-kernel',
      'ok',
      `内核版本 ${firstLine(r.stdout)}(供 gVisor/Firecracker 判断预留)`,
    );
  }
  return make(
    'linux-kernel',
    'warn',
    '无法获取 Linux 内核版本',
    '预留字段:确认 uname -r 可用,以便后续 gVisor/Firecracker 后端判断',
  );
}

// ---------------------------------------------------------------------------
// Docker(host 侧)
// ---------------------------------------------------------------------------

export async function checkDockerCli(ctx: CheckContext): Promise<CheckResult> {
  const r = await ctx.probe('docker', ['--version']);
  if (r.code === 0) {
    const m = /Docker version ([^\s,]+)/.exec(r.stdout);
    const version = m?.[1] ?? firstLine(r.stdout);
    return make('docker-cli', 'ok', `docker CLI 可用,版本 ${version}`);
  }
  return make(
    'docker-cli',
    'fail',
    '未找到可用的 docker CLI',
    '安装 Docker Engine(Linux)或 Docker Desktop(macOS / Windows)',
  );
}

export async function checkDockerDaemon(
  ctx: CheckContext,
): Promise<CheckResult> {
  const r = await ctx.probe('docker', ['info']);
  if (r.code === 0) {
    return make('docker-daemon', 'ok', 'docker daemon 可达(docker info 成功)');
  }
  const reason = firstLine(r.stderr) !== '' ? firstLine(r.stderr) : `退出码 ${r.code}`;
  return make(
    'docker-daemon',
    'fail',
    `docker daemon 不可达:${reason}`,
    '启动 docker daemon(Linux: systemctl start docker;桌面平台: 启动 Docker Desktop)',
  );
}

export async function checkDockerCompose(
  ctx: CheckContext,
): Promise<CheckResult> {
  const v2 = await ctx.probe('docker', ['compose', 'version']);
  if (v2.code === 0) {
    return make('docker-compose', 'ok', `docker compose(v2)可用: ${firstLine(v2.stdout)}`);
  }
  const v1 = await ctx.probe('docker-compose', ['--version']);
  if (v1.code === 0) {
    return make('docker-compose', 'ok', `docker-compose(v1)可用: ${firstLine(v1.stdout)}`);
  }
  return make(
    'docker-compose',
    'warn',
    'docker compose 不可用(v1/v2 均未检测到)',
    '安装 Docker Compose 插件(docker-compose-plugin);不影响单容器后端',
  );
}

// ---------------------------------------------------------------------------
// Windows 专项:WSL2 / WSL 内 docker / 虚拟化
// ---------------------------------------------------------------------------

/**
 * wsl.exe 输出可能是 UTF-16LE(每字节后跟 NUL 字符)并带 BOM,
 * 无论如何解码,剥掉 BOM 与 NUL 即可得到可读文本。
 */
const BOM = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0);

export function normalizeWindowsOutput(raw: string): string {
  return raw.split(BOM).join('').split(NUL).join('');
}

export async function checkWslStatus(ctx: CheckContext): Promise<CheckResult> {
  const r = await ctx.probe('wsl.exe', ['--status']);
  const text = normalizeWindowsOutput(r.stdout + '\n' + r.stderr).trim();
  if (r.code !== 0 || text === '') {
    return make(
      'wsl-status',
      'fail',
      'WSL 未安装或不可用',
      '以管理员运行 wsl --install 安装 WSL2,并确认 BIOS 开启虚拟化',
    );
  }
  const m = /(?:Default\s+Version|默认版本)\s*[:：]\s*(\d+)/i.exec(text);
  const defaultVersion = m?.[1];
  if (defaultVersion === '2') {
    return make('wsl-status', 'ok', `WSL 已安装,默认版本 2(${firstLine(text)})`);
  }
  if (defaultVersion === undefined) {
    return make(
      'wsl-status',
      'warn',
      `WSL 已安装,但无法确认默认版本为 2(${firstLine(text)})`,
      '执行 wsl --set-default-version 2 确保默认使用 WSL2',
    );
  }
  return make(
    'wsl-status',
    'warn',
    `WSL 已安装,但默认版本为 ${defaultVersion}(需要 2)`,
    '执行 wsl --set-default-version 2,并 wsl --update 升级 WSL',
  );
}

export async function checkWslDockerCli(
  ctx: CheckContext,
): Promise<CheckResult> {
  const r = await ctx.probe('wsl.exe', ['docker', '--version']);
  if (r.code === 0) {
    return make('wsl-docker-cli', 'ok', `WSL 内 docker CLI 可用: ${firstLine(r.stdout)}`);
  }
  return make(
    'wsl-docker-cli',
    'fail',
    'WSL 内未找到 docker CLI',
    '在 WSL 发行版内安装 Docker Engine,或启用 Docker Desktop 的 WSL 集成',
  );
}

export async function checkWslDockerDaemon(
  ctx: CheckContext,
): Promise<CheckResult> {
  const r = await ctx.probe('wsl.exe', ['docker', 'info']);
  if (r.code === 0) {
    return make('wsl-docker-daemon', 'ok', 'WSL 内 docker daemon 可达(docker info 成功)');
  }
  const reason = firstLine(r.stderr) !== '' ? firstLine(r.stderr) : `退出码 ${r.code}`;
  return make(
    'wsl-docker-daemon',
    'fail',
    `WSL 内 docker daemon 不可达:${reason}`,
    '在 WSL 内启动 docker 服务,或启动 Docker Desktop 并启用 WSL2 后端集成',
  );
}

/** 可选检测:失败不阻塞(仅 Windows)。 */
export async function checkVirtualization(
  ctx: CheckContext,
): Promise<CheckResult> {
  const r = await ctx.probe('powershell.exe', [
    '-NoProfile',
    '-Command',
    '(Get-CimInstance Win32_ComputerSystem).HypervisorPresent',
  ]);
  if (r.code === 0 && r.stdout.includes('True')) {
    return make('virtualization', 'ok', '虚拟化已启用(HypervisorPresent=True)');
  }
  if (r.code === 0 && r.stdout.includes('False')) {
    return make(
      'virtualization',
      'warn',
      '虚拟化未启用(HypervisorPresent=False)',
      '在 BIOS 中开启 VT-x / AMD-V(SVM),否则 WSL2 无法运行',
    );
  }
  return make(
    'virtualization',
    'warn',
    `无法检测虚拟化状态(退出码 ${r.code})`,
    '可选检测,不阻塞;可在任务管理器-性能-CPU 中人工确认"虚拟化: 已启用"',
  );
}

// ---------------------------------------------------------------------------
// 资源
// ---------------------------------------------------------------------------

const MIN_CPU = 2;
const MIN_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const DISK_FAIL_BYTES = 2 * 1024 * 1024 * 1024;
const DISK_WARN_BYTES = 10 * 1024 * 1024 * 1024;

export async function checkResources(ctx: CheckContext): Promise<CheckResult> {
  const { info } = ctx;
  const problems: string[] = [];
  if (info.cpuCount < MIN_CPU) problems.push(`CPU 核数 ${info.cpuCount} < ${MIN_CPU}`);
  if (info.totalMemoryBytes < MIN_MEMORY_BYTES) {
    problems.push(`总内存 ${(info.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB < 4.0 GiB`);
  }
  const summary =
    `CPU ${info.cpuCount} 核, 内存 ${(info.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB`;
  if (problems.length > 0) {
    return make(
      'resources',
      'warn',
      `${summary};${problems.join(';')}`,
      '资源不足会导致多 Worker 并发受限',
    );
  }
  return make('resources', 'ok', summary);
}

export async function checkDiskSpace(ctx: CheckContext): Promise<CheckResult> {
  const free = ctx.info.targetDiskFreeBytes;
  if (free === null) {
    return make(
      'disk-space',
      'warn',
      '无法获取目标盘剩余空间',
      '确认 neoba 工作目录所在盘可访问',
    );
  }
  const gib = (free / 1024 ** 3).toFixed(1);
  if (free < DISK_FAIL_BYTES) {
    return make(
      'disk-space',
      'fail',
      `目标盘剩余空间仅 ${gib} GiB`,
      '清理磁盘:容器镜像与工件仓库需要数 GiB 以上空间',
    );
  }
  if (free < DISK_WARN_BYTES) {
    return make(
      'disk-space',
      'warn',
      `目标盘剩余空间 ${gib} GiB,偏紧`,
      '建议保留 10 GiB 以上供镜像与工件使用',
    );
  }
  return make('disk-space', 'ok', `目标盘剩余空间 ${gib} GiB`);
}

// ---------------------------------------------------------------------------
// userns 能力(Codex 基座前置,v0.2 §5)
// ---------------------------------------------------------------------------

export async function checkUserns(ctx: CheckContext): Promise<CheckResult> {
  const { info } = ctx;
  if (info.platform === 'linux') {
    const r = await ctx.probe('unshare', ['--user', 'true']);
    if (r.code === 0) {
      return make(
        'userns',
        'ok',
        '非特权 userns 可用(clone(CLONE_NEWUSER) 路径畅通)',
      );
    }
    return make(
      'userns',
      'fail',
      `非特权 userns 不可用(退出码 ${r.code})`,
      'Codex 基座前置条件:启用非特权 userns(sysctl kernel.unprivileged_userns_clone=1)或以 rootless 模式运行容器',
    );
  }
  if (info.platform === 'win32') {
    const r = await ctx.probe('wsl.exe', ['unshare', '--user', 'true']);
    if (r.code === 0) {
      return make(
        'userns',
        'ok',
        'WSL2 内非特权 userns 可用(clone(CLONE_NEWUSER) 路径畅通)',
      );
    }
    return make(
      'userns',
      'unknown',
      `无法确认 WSL2 内 userns 能力(退出码 ${r.code})`,
      'WSL 未安装或未运行时无法探测;Codex 基座部署前需在 WSL 内确认 unshare --user true 可用',
    );
  }
  return make('userns', 'unknown', '非 Linux/Windows 平台,跳过 userns 检测');
}

/**
 * Docker seccomp profile 是否放行 userns。
 * 能从 SecurityOptions 确认 unconfined/无 seccomp 才给 ok;
 * 默认 profile 无法确证是否放行 CLONE_NEWUSER → unknown + suggestion。
 */
export async function checkDockerSeccompUserns(
  ctx: CheckContext,
): Promise<CheckResult> {
  const r = await ctx.probe('docker', [
    'info',
    '--format',
    '{{json .SecurityOptions}}',
  ]);
  if (r.code !== 0) {
    return make(
      'docker-seccomp-userns',
      'unknown',
      '无法读取 docker SecurityOptions(daemon 不可达或 CLI 缺失)',
      '启动 docker daemon 后重试;Codex 基座需 seccomp 放行 userns 或使用 unconfined',
    );
  }
  const text = r.stdout.trim();
  const mentionsSeccomp = text.includes('seccomp');
  const unconfined = text.includes('unconfined');
  if (!mentionsSeccomp || unconfined) {
    return make(
      'docker-seccomp-userns',
      'ok',
      `seccomp 不拦截 userns(SecurityOptions=${text || '(空)'})`,
    );
  }
  return make(
    'docker-seccomp-userns',
    'unknown',
    `docker 启用了 seccomp profile(SecurityOptions=${text}),无法远程确证是否放行 CLONE_NEWUSER`,
    'Codex 基座前置:使用 unconfined,或在 seccomp profile 中放行 clone(CLONE_NEWUSER) 相关 syscall',
  );
}

// ---------------------------------------------------------------------------
// OS keyring(libsecret secret-tool,M6,凭据后端前置)
// ---------------------------------------------------------------------------

/** doctor 的 keyring 探测参数(与 KeyringSecretBackend 的 lookup 属性一致)。 */
export const KEYRING_PROBE_ARGS = ['lookup', 'service', 'neoba'] as const;

export async function checkKeyring(ctx: CheckContext): Promise<CheckResult> {
  const platformName = ctx.info.platform;
  // secret-tool 是 Linux(libsecret)专属;win/mac 走各自默认后端
  // (DPAPI / File+AES),N/A 不算失败(unknown 既非 ok 也非 fail)。
  if (platformName !== 'linux') {
    return make(
      'keyring',
      'unknown',
      `N/A:${platformName} 不使用 libsecret keyring,secret 后端走平台默认`,
    );
  }
  // 探测只做一次 lookup(无副作用,不写 keyring):secret-tool 存在且
  // keyring 服务应答即为可用 —— 退出码 0(有匹配)/ 1(无匹配)都算。
  const r = await ctx.probe('secret-tool', [...KEYRING_PROBE_ARGS]);
  if (r.code === 0 || r.code === 1) {
    return make('keyring', 'ok', 'secret-tool(libsecret)可用,keyring 后端可接线');
  }
  const reason = firstLine(r.stderr) !== '' ? firstLine(r.stderr) : `退出码 ${r.code}`;
  return make(
    'keyring',
    'fail',
    `secret-tool 不可用:${reason}`,
    '安装 libsecret 工具(Debian/Ubuntu: apt install libsecret-1-0 libsecret-tools;RHEL: dnf install libsecret),并确认 gnome-keyring 等秘钥环服务在运行',
  );
}

// ---------------------------------------------------------------------------
// microsandbox CLI(Firecracker microVM 后端,M7,可选沙箱后端前置)
// ---------------------------------------------------------------------------

/** doctor 的 msb 探测参数(与 MicrosandboxProvider 的 CLI 同一可执行名)。 */
export const MSB_PROBE_ARGS = ['--version'] as const;

export async function checkMicrosandboxCli(ctx: CheckContext): Promise<CheckResult> {
  const platformName = ctx.info.platform;
  // Firecracker/KVM 是 Linux 专属;win/mac 为 N/A 不算失败(可选后端,
  // Windows 侧 microsandbox 走 WHP,不在 doctor v1 检测范围)。
  if (platformName !== 'linux') {
    return make(
      'msb-cli',
      'unknown',
      `N/A:${platformName} 不做 microsandbox 探测(Firecracker 后端仅 Linux/KVM)`,
    );
  }
  const r = await ctx.probe('msb', [...MSB_PROBE_ARGS]);
  if (r.code === 0) {
    const m = /msb ([^\s,]+)/i.exec(r.stdout) ?? /([0-9]+\.[^\s,]+)/.exec(r.stdout);
    const version = m?.[1] ?? firstLine(r.stdout);
    return make('msb-cli', 'ok', `microsandbox CLI 可用,版本 ${version}`);
  }
  const reason = firstLine(r.stderr) !== '' ? firstLine(r.stderr) : `退出码 ${r.code}`;
  return make(
    'msb-cli',
    'fail',
    `microsandbox CLI(msb)不可用:${reason}`,
    '可选后端,不影响 docker;如需 Firecracker microVM 后端,安装 microsandbox(curl -fsSL https://install.microsandbox.dev | sh)并确认 KVM 可用(/dev/kvm)',
  );
}

// ---------------------------------------------------------------------------
// 数据面路径跨界检测(v0.2 §10.6,error 级)
// ---------------------------------------------------------------------------

export function makeDataPlaneCheck(paths: DataPlanePathInput[]): CheckFn {
  return async (ctx) => {
    if (paths.length === 0) {
      return make(
        'data-plane',
        'unknown',
        '未配置数据面路径(workdir / 工件仓库 / docker context),跳过跨界检测',
        '在 daemon 配置中设置数据面路径后重新运行 doctor',
      );
    }
    const platformName = ctx.info.platform;
    const details: string[] = [];
    let crossBoundary = false;
    for (const { kind, path } of paths) {
      const c = classifyDataPlanePath(path, { platform: platformName });
      crossBoundary = crossBoundary || c.crossBoundary;
      details.push(`${kind}=${path} → ${c.location}(${c.detail})`);
    }
    if (crossBoundary) {
      return make(
        'data-plane',
        'fail',
        `存在跨界数据面路径:${details.join('; ')}`,
        '把 workdir / 工件仓库 / docker context 全部迁移到 WSL2 原生文件系统(WSL 发行版内 ext4 路径或 wsl$ 访问路径);跨界 drvfs/9p 路径有数量级的 IO 性能悬崖',
      );
    }
    return make(
      'data-plane',
      'ok',
      `数据面路径均在原生文件系统内:${details.join('; ')}`,
    );
  };
}

// ---------------------------------------------------------------------------
// .wslconfig 资源限额(缺失不阻塞)
// ---------------------------------------------------------------------------

export function makeWslconfigCheck(content: string | null): CheckFn {
  return async () => {
    if (content === null) {
      return make(
        'wslconfig',
        'unknown',
        '未找到 .wslconfig,使用 WSL 默认资源限额(约为宿主内存 50% / 全部核)',
        '如需限制 WSL2 资源,在 %UserProfile%\.wslconfig 中设置 [wsl2] memory / processors',
      );
    }
    const parsed = parseWslConfig(content);
    if (parsed.parseError !== null) {
      return make('wslconfig', 'warn', `.wslconfig 解析异常: ${parsed.parseError}`);
    }
    if (parsed.memory === null && parsed.processors === null) {
      return make(
        'wslconfig',
        'unknown',
        '.wslconfig 存在,但 [wsl2] 小节未设置 memory / processors,使用 WSL 默认限额',
      );
    }
    return make(
      'wslconfig',
      'ok',
      `.wslconfig 限额: memory=${parsed.memory ?? '(默认)'} processors=${parsed.processors ?? '(默认)'}`,
    );
  };
}
