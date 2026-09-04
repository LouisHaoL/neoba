/**
 * sidecar 配置生成器测试(§3.3 授予落地 / §4.4 spawn 硬规则 / §3.8 Secrets):
 * 典型 manifest → SidecarPlan 快照、清单外 MCP 不出现、bypass 标志必炸、
 * secret 明文不落产物、fs 窄化 → ro 挂载、网络缺省 none。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { minimalPresetDoc, parsePreset } from '../../src/capability/index.ts';
import type { Grant, GrantManifest } from '../../src/capability/index.ts';
import {
  BypassFlagDetected,
  CONTAINER_CONFIG_DIR,
  CONTAINER_WORKDIR,
  DEFAULT_WORKER_IMAGE,
  McpServerNotInCatalog,
  SecretPlaintextLeak,
  SidecarConfigInvalid,
  assertNoBypassFlags,
  assertNoBypassSettings,
  assertNoSecretPlaintext,
  buildSandboxConfig,
  defaultSecretEnvName,
  materializeSecretEnv,
} from '../../src/sidecar/index.ts';
import type { McpCatalog, SidecarPlan } from '../../src/sidecar/index.ts';

const WORKDIR = '/srv/neoba/tasks/task-42';
const PRESET = parsePreset(minimalPresetDoc());

function grant(cap: string, scope: Grant['scope'], extra: Partial<Grant> = {}): Grant {
  return { cap, scope, source: 'baseline', ttl: null, ...extra };
}

function manifest(grants: Grant[]): GrantManifest {
  return { protocol: '1.0', spec_version: '1.0', agent_id: 'task-42/e2e-tester-01', grants, audit: [] };
}

const CATALOG: McpCatalog = {
  'mcp:playwright': { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  'mcp:github': {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envSecrets: { GITHUB_TOKEN: 'sec-github-token' },
  },
};

function build(grants: Grant[], overrides: Partial<Parameters<typeof buildSandboxConfig>[2]> = {}) {
  return buildSandboxConfig(manifest(grants), PRESET, { workdir: WORKDIR, mcpCatalog: CATALOG, ...overrides });
}

describe('典型 manifest → SidecarPlan 快照(§3.3 授予落地)', () => {
  it('fs:workdir rw + mcp:playwright write → 完整计划(快照断言)', () => {
    const plan = build([
      grant('fs:workdir', 'rw'),
      grant('mcp:playwright', 'write'),
    ]);
    const settingsPath = `${CONTAINER_CONFIG_DIR}/settings.json`;
    const mcpPath = `${CONTAINER_CONFIG_DIR}/mcp.json`;
    const expected: SidecarPlan = {
      planVersion: '1.0',
      agentId: 'task-42/e2e-tester-01',
      harness: 'claude-code',
      sandbox: {
        image: DEFAULT_WORKER_IMAGE,
        baseRequirements: { harness: 'claude-code' },
        env: { CI: '1' },
        network: { mode: 'none' },
        mounts: [
          { kind: 'workdir', source: WORKDIR, target: CONTAINER_WORKDIR, mode: 'rw' },
          { kind: 'config', source: settingsPath, target: settingsPath, mode: 'ro' },
          { kind: 'config', source: mcpPath, target: mcpPath, mode: 'ro' },
        ],
        user: 'worker',
        workdir: CONTAINER_WORKDIR,
      },
      files: [
        {
          path: settingsPath,
          content: '{"permissions":{"defaultMode":"default"}}',
          format: 'json',
          mount: 'ro',
        },
        {
          path: mcpPath,
          content: '{"mcpServers":{"playwright":{"command":"npx","args":["-y","@playwright/mcp@latest"]}}}',
          format: 'json',
          mount: 'ro',
        },
      ],
      secrets: [],
      harnessSpawn: {
        argv: [
          'claude',
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--settings',
          settingsPath,
          '--mcp-config',
          mcpPath,
        ],
      },
    };
    assert.deepEqual(plan, expected);
    // 计划可整体 JSON 序列化(纯数据,留给 Provisioner)
    assert.deepEqual(JSON.parse(JSON.stringify(plan)) as unknown, plan);
  });

  it('scope 语义映射:fs read → ro;多条指向同一根的 fs 授权去重且 rw 优先', () => {
    const ro = build([grant('fs:workdir', 'ro')]);
    assert.equal((ro.sandbox.mounts ?? []).find((m) => m.kind === 'workdir')?.mode, 'ro');
    const rw = build([grant('fs:workdir', 'ro'), grant('fs:extra', 'rw')]);
    const fsMounts = (rw.sandbox.mounts ?? []).filter((m) => m.kind === 'workdir');
    assert.deepEqual(
      fsMounts.map((m) => [m.source, m.mode]),
      [[WORKDIR, 'rw']],
    );
  });
});

describe('MCP 物理性(§3.3):清单外 server 一个不出现', () => {
  it('catalog 里存在但未授予的 server 不进 mcp.json', () => {
    const plan = build([grant('fs:workdir', 'rw'), grant('mcp:playwright', 'write')]);
    const mcpFile = plan.files.find((f) => f.path.endsWith('mcp.json'));
    assert.ok(mcpFile !== undefined);
    assert.ok(mcpFile.content.includes('playwright'));
    assert.ok(!mcpFile.content.includes('github'));
    const parsed = JSON.parse(mcpFile.content) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(parsed.mcpServers), ['playwright']);
  });

  it('授予了 catalog 中没有的 mcp_server → fail-closed 报错,不静默不挂载', () => {
    assert.throws(
      () => build([grant('mcp:not-in-catalog', 'read')]),
      (err: unknown) => err instanceof McpServerNotInCatalog && err.cap === 'mcp:not-in-catalog',
    );
  });
});

describe('spawn 硬规则(§4.4):bypass 类标志必炸', () => {
  it('assertNoBypassFlags:危险标志 / --permission-mode bypassPermissions 两种写法全拦', () => {
    assert.throws(() => assertNoBypassFlags(['claude', '-p', '--dangerously-skip-permissions']), BypassFlagDetected);
    assert.throws(() => assertNoBypassFlags(['claude', '--permission-mode', 'bypassPermissions']), BypassFlagDetected);
    assert.throws(() => assertNoBypassFlags(['claude', '--permission-mode=bypassPermissions']), BypassFlagDetected);
    assert.throws(() => assertNoBypassFlags(['claude', '--yolo']), BypassFlagDetected);
    // 嵌套逃逸载荷(spike #1 E6:经 Bash 参数传给内层 claude)同样命中
    assert.throws(
      () => assertNoBypassFlags(['claude', '-p', 'run: claude --dangerously-skip-permissions']),
      BypassFlagDetected,
    );
    // 干净 argv 不误伤
    assert.doesNotThrow(() => assertNoBypassFlags(['claude', '-p', '--permission-mode', 'default']));
  });

  it('assertNoBypassSettings:settings.json 写入 bypassPermissions 必炸', () => {
    assert.doesNotThrow(() => assertNoBypassSettings('{"permissions":{"defaultMode":"acceptEdits"}}'));
    assert.throws(
      () => assertNoBypassSettings('{"permissions":{"defaultMode":"bypassPermissions"}}'),
      BypassFlagDetected,
    );
    assert.throws(() => assertNoBypassSettings('not json'), SidecarConfigInvalid);
  });

  it('生成器拒绝越界 permissionMode;正常产物的 spawn/settings 通过生成后校验', () => {
    assert.throws(
      () => build([grant('fs:workdir', 'rw')], { permissionMode: 'bypassPermissions' as never }),
      SidecarConfigInvalid,
    );
    const plan = build([grant('fs:workdir', 'rw')], { permissionMode: 'acceptEdits' });
    assert.doesNotThrow(() => assertNoBypassFlags(plan.harnessSpawn.argv));
    assert.doesNotThrow(() => assertNoBypassSettings(plan.files[0]?.content ?? ''));
    assert.ok(plan.files[0]?.content.includes('"defaultMode":"acceptEdits"'));
  });
});

describe('secret 注入段(§3.8):明文永不落产物', () => {
  it('只含 secret id → 环境变量名映射 + ro 标记;mcp.json 不含 env/明文', () => {
    const plan = build([grant('fs:workdir', 'rw'), grant('mcp:github', 'write')]);
    assert.deepEqual(plan.secrets, [
      { secretId: 'sec-github-token', envVarName: 'NEOBA_SECRET_SEC_GITHUB_TOKEN', ro: true },
    ]);
    const mcpFile = plan.files.find((f) => f.path.endsWith('mcp.json'));
    assert.ok(mcpFile !== undefined);
    assert.ok(!mcpFile.content.includes('GITHUB_TOKEN'));
    assert.ok(!mcpFile.content.includes('sec-github-token'));
  });

  it('值经注入 resolver 取:materializeSecretEnv 产出 env 映射,产物零明文(断言测试)', () => {
    const plan = build([grant('mcp:github', 'write')]);
    const SECRET_VALUE = 'sk-live-super-secret-123';
    const env = materializeSecretEnv(plan, (id) => (id === 'sec-github-token' ? SECRET_VALUE : ''));
    assert.deepEqual(env, { NEOBA_SECRET_SEC_GITHUB_TOKEN: SECRET_VALUE });
    // 产物整体(含序列化形态)不含明文
    assert.ok(!JSON.stringify(plan).includes(SECRET_VALUE));
    assert.doesNotThrow(() => assertNoSecretPlaintext(plan, [SECRET_VALUE]));
  });

  it('被篡改进明文的产物被 assertNoSecretPlaintext 拦下', () => {
    const leaked = { ...build([grant('mcp:github', 'write')]) } as SidecarPlan;
    (leaked.sandbox.env as Record<string, string>)['LEAKED'] = 'sk-live-super-secret-123';
    assert.throws(() => assertNoSecretPlaintext(leaked, ['sk-live-super-secret-123']), SecretPlaintextLeak);
  });

  it('secretEnvName resolver 可覆盖缺省映射;缺省映射为确定性纯函数', () => {
    const plan = build([grant('mcp:github', 'write')], { secretEnvName: () => 'GH_TOKEN' });
    assert.deepEqual(plan.secrets, [{ secretId: 'sec-github-token', envVarName: 'GH_TOKEN', ro: true }]);
    assert.equal(defaultSecretEnvName('sec-github-token'), 'NEOBA_SECRET_SEC_GITHUB_TOKEN');
    assert.equal(defaultSecretEnvName('tenant-a/prod.key'), 'NEOBA_SECRET_TENANT_A_PROD_KEY');
  });
});

describe('fs 授权窄化(§3.3):constraint.fs_scope_narrowed_to → ro 挂载', () => {
  it('窄化到子路径:模板解析正确、mode 强制 ro、根目录不整体暴露', () => {
    const plan = build([
      grant('fs:workdir', 'rw', { constraint: { fs_scope_narrowed_to: '${task.workdir}/screenshots' } }),
    ]);
    const fsMounts = (plan.sandbox.mounts ?? []).filter((m) => m.kind === 'workdir');
    assert.deepEqual(fsMounts, [
      { kind: 'workdir', source: `${WORKDIR}/screenshots`, target: `${CONTAINER_WORKDIR}/screenshots`, mode: 'ro' },
    ]);
  });

  it('裸相对路径同样按窄化处理;逃逸出 workdir 的窄化路径拒绝', () => {
    const rel = build([grant('fs:workdir', 'rw', { constraint: { fs_scope_narrowed_to: 'out/report' } })]);
    assert.equal(
      (rel.sandbox.mounts ?? []).find((m) => m.kind === 'workdir')?.source,
      `${WORKDIR}/out/report`,
    );
    assert.throws(
      () => build([grant('fs:workdir', 'rw', { constraint: { fs_scope_narrowed_to: '../outside' } })]),
      SidecarConfigInvalid,
    );
    assert.throws(
      () => build([grant('fs:workdir', 'rw', { constraint: { fs_scope_narrowed_to: '${task.unknown}' } })]),
      SidecarConfigInvalid,
    );
  });
});

describe('网络策略(§5):缺省 none 最严,net grant 才放宽', () => {
  it('无网络类 grant → {mode:"none"}', () => {
    const plan = build([grant('fs:workdir', 'rw')]);
    assert.deepEqual(plan.sandbox.network, { mode: 'none' });
  });

  it('net grant 无 allow 约束 → bridge;带 allow → allowlist', () => {
    const bridge = build([grant('fs:workdir', 'rw'), grant('net:egress', 'write')]);
    assert.deepEqual(bridge.sandbox.network, { mode: 'bridge' });
    const allow = build([
      grant('fs:workdir', 'rw'),
      grant('net:api', 'write', { constraint: { allow: ['api.github.com:443'] } }),
    ]);
    assert.deepEqual(allow.sandbox.network, { mode: 'allowlist', allow: ['api.github.com:443'] });
  });
});
