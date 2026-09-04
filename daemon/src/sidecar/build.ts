/**
 * sidecar 配置生成器(§2 sidecar"按 grant manifest 生成容器挂载/网络/凭据配置"
 * / §4 Adapter 统一职责 3、4 / §3.8 Secrets)。
 *
 * buildSandboxConfig(grantManifest, preset, options) -> SidecarPlan:纯函数,
 * 产物可 JSON 序列化;执行(写文件 / 拉容器)不在此,留给 Provisioner 接线。
 *
 * 原则:
 * - grant manifest 是挂载的唯一事实来源(§3.3):fs 按授权路径与 ro/rw 挂载、
 *   mcp_server 只挂 manifest 里点名的(清单外一个不出现,物理性)、网络策略
 *   按网络类 grant,缺省 none 最严;
 * - fs 窄化(§3.3"授权可窄于申请"):constraint.fs_scope_narrowed_to 把挂载
 *   收窄到子路径,且按 ro 处理(窄化授予不给整目录写权);
 * - spawn 硬规则(§4.4):启动命令生成后过 assertNoBypassFlags,settings.json
 *   过 assertNoBypassSettings,必炸不静默;
 * - secret(§3.8):产物只含 secret id -> 环境变量名映射 + ro 标记,值经
 *   Provisioner 注入的 resolver 在拉容器时取,配置产物永不出现明文。
 */
import type { GrantManifest, Preset } from '../capability/types.ts';
import type { NetworkPolicy, SandboxMount, SandboxSpec } from '../provision/types.ts';
import { assertNoBypassFlags, assertNoBypassSettings } from './bypass.ts';
import { McpServerNotInCatalog, SecretPlaintextLeak, SidecarConfigInvalid } from './errors.ts';
import {
  CONTAINER_CONFIG_DIR,
  CONTAINER_WORKDIR,
  DEFAULT_WORKER_IMAGE,
  defaultSecretEnvName,
} from './types.ts';
import type {
  BuildSandboxConfigOptions,
  McpCatalog,
  McpServerSpec,
  PlanFile,
  SafePermissionMode,
  SecretInjectionEntry,
  SidecarPlan,
} from './types.ts';

const SAFE_PERMISSION_MODES: readonly SafePermissionMode[] = ['default', 'acceptEdits', 'plan'];

export function buildSandboxConfig(
  grantManifest: GrantManifest,
  _preset: Preset,
  options: BuildSandboxConfigOptions,
): SidecarPlan {
  const workdir = options.workdir;
  if (workdir === '' ) {
    throw new SidecarConfigInvalid(['options.workdir: 必须是非空路径']);
  }
  const containerWorkdir = options.containerWorkdir ?? CONTAINER_WORKDIR;
  const permissionMode = options.permissionMode ?? 'default';
  if (!SAFE_PERMISSION_MODES.includes(permissionMode)) {
    throw new SidecarConfigInvalid([
      `permissionMode "${permissionMode}" 越界(bypassPermissions 禁用,§4.4)`,
    ]);
  }

  const issues: string[] = [];
  const mounts: SandboxMount[] = [];
  const servers = new Map<string, { name: string; spec: McpServerSpec }>();
  const secretIds = new Set<string>();
  let network: NetworkPolicy = { mode: 'none' };

  // 第一遍:网络(缺省 none 最严,任何 net: grant 才放宽)。
  for (const grant of grantManifest.grants) {
    if (namespaceOf(grant.cap) !== 'net') continue;
    const allow = readAllow(grant.constraint);
    network = allow === null ? { mode: 'bridge' } : { mode: 'allowlist', allow: [...allow] };
  }

  // 第二遍:fs 挂载(按宿主 source 去重,rw 优先)与 MCP server 选择。
  const fsMounts = new Map<string, { source: string; target: string; mode: 'ro' | 'rw' }>();
  for (const grant of grantManifest.grants) {
    const ns = namespaceOf(grant.cap);
    if (ns === 'fs') {
      const narrowed = readNarrowedTo(grant.constraint);
      if (narrowed !== null) {
        // 窄化授予:收窄到子路径,且 ro(§3.3 窄于申请)。
        const source = resolveHostPath(narrowed, workdir, issues, grant.cap);
        if (source !== null) {
          fsMounts.set(source, {
            source,
            target: containerTargetOf(source, workdir, containerWorkdir),
            mode: 'ro',
          });
        }
        continue;
      }
      const mode = fsModeOf(grant.scope);
      if (mode === null) {
        issues.push(`${grant.cap}: scope "${grant.scope}" 无法映射为挂载模式`);
        continue;
      }
      const existing = fsMounts.get(workdir);
      if (existing === undefined || (existing.mode === 'ro' && mode === 'rw')) {
        fsMounts.set(workdir, { source: workdir, target: containerWorkdir, mode });
      }
    } else if (ns === 'mcp') {
      const spec = options.mcpCatalog[grant.cap];
      if (spec === undefined) {
        // fail-closed:静默跳过 = 授予与物理挂载不一致,§3.3 不允许。
        throw new McpServerNotInCatalog(grant.cap);
      }
      servers.set(grant.cap, { name: serverNameOf(grant.cap), spec });
      for (const secretId of Object.values(spec.envSecrets ?? {})) {
        secretIds.add(secretId);
      }
    }
    // skill / model 等 namespace:P1 无容器落地物,忽略。
  }

  for (const mount of [...fsMounts.values()].sort((a, b) => (a.source < b.source ? -1 : 1))) {
    mounts.push({ kind: 'workdir', source: mount.source, target: mount.target, mode: mount.mode });
  }

  // 基座配置文件(内容生成 → ro 挂载,§3.8/spike #1 E4/E5:模型会自改配置)。
  const settingsPath = `${CONTAINER_CONFIG_DIR}/settings.json`;
  const settingsContent = JSON.stringify({ permissions: { defaultMode: permissionMode } });
  assertNoBypassSettings(settingsContent);
  const files: PlanFile[] = [
    { path: settingsPath, content: settingsContent, format: 'json', mount: 'ro' },
  ];
  mounts.push({ kind: 'config', source: settingsPath, target: settingsPath, mode: 'ro' });

  // MCP 挂载段:claude-code mcpServers JSON;env 不写进配置(server 继承
  // 容器环境变量,secret 值只经 Provisioner 注入的环境进入容器)。
  let mcpPath: string | null = null;
  if (servers.size > 0) {
    mcpPath = `${CONTAINER_CONFIG_DIR}/mcp.json`;
    const mcpServers: Record<string, unknown> = {};
    for (const { name, spec } of [...servers.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      mcpServers[name] = {
        command: spec.command,
        ...(spec.args !== undefined ? { args: [...spec.args] } : {}),
      };
    }
    files.push({
      path: mcpPath,
      content: JSON.stringify({ mcpServers }),
      format: 'json',
      mount: 'ro',
    });
    mounts.push({ kind: 'config', source: mcpPath, target: mcpPath, mode: 'ro' });
  }

  if (issues.length > 0) throw new SidecarConfigInvalid(issues);

  // secret 注入段:只含 id -> 环境变量名映射 + ro 标记(§3.8)。
  const toEnvName = options.secretEnvName ?? defaultSecretEnvName;
  const secrets: SecretInjectionEntry[] = [...secretIds]
    .sort()
    .map((secretId) => ({ secretId, envVarName: toEnvName(secretId), ro: true as const }));

  // 基座启动命令(§4.4 硬规则:生成后校验,绝不出现 bypass 类标志;
  // permissionMode 走 settings.json,不上命令行)。
  const argv = [
    'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--settings',
    settingsPath,
    ...(mcpPath !== null ? ['--mcp-config', mcpPath] : []),
  ];
  assertNoBypassFlags(argv);

  const sandbox: SandboxSpec = {
    image: options.image ?? DEFAULT_WORKER_IMAGE,
    baseRequirements: { harness: 'claude-code' },
    env: { CI: '1' },
    ...(options.resources !== undefined ? { resources: options.resources } : {}),
    network,
    mounts,
    user: 'worker',
    workdir: containerWorkdir,
  };

  return {
    planVersion: '1.0',
    agentId: grantManifest.agent_id,
    harness: 'claude-code',
    sandbox,
    files,
    secrets,
    harnessSpawn: { argv },
  };
}

// ---------------------------------------------------------------- secret 注入(Provisioner 接线用)

/**
 * 拉容器时的 secret 环境变量取值:经注入的 value resolver 逐条解析
 * (SecretStore),返回 env 映射供 SandboxProvider.create 注入。
 * 返回值只进入容器环境,调用方不得把它写进任何落盘产物(§3.8 铁律;
 * assertNoSecretPlaintext 是发布前的最后闸门)。
 */
export function materializeSecretEnv(
  plan: SidecarPlan,
  resolveValue: (secretId: string) => string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of plan.secrets) {
    env[entry.envVarName] = resolveValue(entry.secretId);
  }
  return env;
}

/** 断言产物中不含任何凭据明文(§3.8;测试与 Provisioner 发布前共用)。 */
export function assertNoSecretPlaintext(plan: SidecarPlan, secretValues: readonly string[]): void {
  const serialized = JSON.stringify(plan);
  for (const value of secretValues) {
    if (value !== '' && serialized.includes(value)) {
      throw new SecretPlaintextLeak();
    }
  }
}

// ---------------------------------------------------------------- 纯工具函数

function namespaceOf(cap: string): string {
  const idx = cap.indexOf(':');
  return idx === -1 ? cap : cap.slice(0, idx);
}

function serverNameOf(cap: string): string {
  return cap.slice(cap.indexOf(':') + 1);
}

/** fs scope -> 挂载模式;不可映射(read/write 语义例外已列)返回 null。 */
function fsModeOf(scope: string): 'ro' | 'rw' | null {
  if (scope === 'ro' || scope === 'read') return 'ro';
  if (scope === 'rw' || scope === 'write' || scope === 'admin') return 'rw';
  return null;
}

function readNarrowedTo(constraint: unknown): string | null {
  if (typeof constraint !== 'object' || constraint === null) return null;
  const value = (constraint as Record<string, unknown>)['fs_scope_narrowed_to'];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readAllow(constraint: unknown): readonly string[] | null {
  // 返回 readonly 副本;写入 NetworkPolicy 时由调用方复制为可变数组。
  if (typeof constraint !== 'object' || constraint === null) return null;
  const value = (constraint as Record<string, unknown>)['allow'];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v !== '')) return null;
  return value as string[];
}

/**
 * 授权路径模板解析:'${task.workdir}/sub' 或裸相对路径都相对 workdir;
 * 解析结果必须落在 workdir 内(防授权路径逃逸出挂载根)。
 */
function resolveHostPath(
  template: string,
  workdir: string,
  issues: string[],
  cap: string,
): string | null {
  const replaced = template.replaceAll('${task.workdir}', workdir);
  if (replaced.includes('${')) {
    issues.push(`${cap}: fs_scope_narrowed_to 含未支持的模板变量 "${template}"`);
    return null;
  }
  const root = workdir.replaceAll('\\', '/').replace(/\/+$/, '');
  const raw = replaced.replaceAll('\\', '/').replace(/\/+$/, '');
  const joined = raw.startsWith('/') ? raw : `${root}/${raw}`;
  const full = normalizePosix(joined);
  if (full !== root && !full.startsWith(`${root}/`)) {
    issues.push(`${cap}: 窄化路径 "${template}" 逃逸出 workdir`);
    return null;
  }
  return full;
}

/** POSIX 路径规范化:消解 '.' / '..' 段(防窄化路径逃逸挂载根)。 */
function normalizePosix(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join('/')}`;
}

/** 宿主 source -> 容器 target(workdir 根对齐,子路径原样拼接)。 */
function containerTargetOf(source: string, workdir: string, containerWorkdir: string): string {
  const root = workdir.replaceAll('\\', '/').replace(/\/+$/, '');
  const rel = source.startsWith(`${root}/`) ? source.slice(root.length) : '';
  return `${containerWorkdir.replace(/\/+$/, '')}${rel}`;
}
