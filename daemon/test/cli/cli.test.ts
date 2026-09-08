/**
 * CLI 集成测试(§3.10):--help/--version、未知命令退出码、doctor --json
 * 在假探针下的输出结构与退出码(#30:有 fail 级检查项退出 1,--json 附 ok)、
 * doctor --write 落配置、status 对缺失/损坏/在/不在状态的优雅处理、
 * prune dry-run 不删 + --yes 真删(真实 CAS 仓库)+ 未初始化目录拒跑。
 * 不做真实 startDaemon 长驻测试;探活与仓库经 deps 注入。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runCli } from '../../src/cli/main.ts';
import { defaultDeps } from '../../src/cli/deps.ts';
import type { CliDeps, CliIo } from '../../src/cli/types.ts';
import { ArtifactRepository } from '../../src/artifacts/index.ts';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

interface TestIo extends CliIo {
  outLines: string[];
  errLines: string[];
}

function makeIo(): TestIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    out: (t) => outLines.push(t),
    err: (t) => errLines.push(t),
    outLines,
    errLines,
  };
}

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `neoba-cli-${prefix}-`));
  roots.push(dir);
  return dir;
}

const fakeProbe = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
  code: -1,
  stdout: '',
  stderr: 'command not found',
});

/**
 * 全绿探针(#30):按命令行路由回成功结果(linux / win32 两套命令都铺,
 * 跨平台可跑)。不能无脑回 code 0 —— wsl-status 等检查要解析 stdout 内容。
 */
const GREEN_ROUTES: Record<string, { code: number; stdout: string; stderr: string }> = {
  'uname -r': { code: 0, stdout: '6.8.0-40-generic\n', stderr: '' },
  'docker --version': { code: 0, stdout: 'Docker version 27.3.1, build a...\n', stderr: '' },
  'docker info': { code: 0, stdout: 'Server Version: 27.3.1\n', stderr: '' },
  'docker compose version': { code: 0, stdout: 'Docker Compose version v2.29.7\n', stderr: '' },
  'unshare --user true': { code: 0, stdout: '', stderr: '' },
  'docker info --format {{json .SecurityOptions}}': {
    code: 0, stdout: '["name=seccomp,profile=unconfined"]\n', stderr: '',
  },
  'secret-tool lookup service neoba': { code: 0, stdout: 'secret-value\n', stderr: '' },
  'msb --version': { code: 0, stdout: 'msb 0.1.8\n', stderr: '' },
  'wsl.exe --status': { code: 0, stdout: '默认版本: 2\n', stderr: '' },
  'wsl.exe unshare --user true': { code: 0, stdout: '', stderr: '' },
  'wsl.exe docker --version': { code: 0, stdout: 'Docker version 27.3.1\n', stderr: '' },
  'wsl.exe docker info': { code: 0, stdout: 'Server Version: 27.3.1\n', stderr: '' },
  'powershell.exe -NoProfile -Command (Get-CimInstance Win32_ComputerSystem).HypervisorPresent': {
    code: 0, stdout: 'True\n', stderr: '',
  },
};

const greenProbe: CliDeps['execProbe'] = async (cmd, args) =>
  GREEN_ROUTES[[cmd, ...args].join(' ')] ?? { code: 0, stdout: '', stderr: '' };

async function makeDeps(overrides: Partial<CliDeps> = {}): Promise<CliDeps> {
  return await defaultDeps({ execProbe: fakeProbe, version: '9.9.9-test', ...overrides });
}

const deadFetch: CliDeps['fetch'] = (async () => {
  throw new Error('connect ECONNREFUSED');
}) as unknown as CliDeps['fetch'];

const liveFetch: CliDeps['fetch'] = (async () => ({ ok: true, status: 405 })) as unknown as CliDeps['fetch'];

async function listFiles(dir: string): Promise<string[]> {
  const dirents = await readdir(dir, { withFileTypes: true, recursive: true });
  return dirents.filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name));
}

describe('cli:全局', () => {
  it('--help 列出全部命令与摘要,退出码 0', async () => {
    const io = makeIo();
    const code = await runCli(['--help'], io, await makeDeps());
    assert.equal(code, 0);
    const text = io.outLines.join('\n');
    for (const name of ['start', 'status', 'doctor', 'prune', 'mcp']) {
      assert.ok(text.includes(name), `help 应包含 ${name}`);
    }
    assert.ok(text.includes('拉起 neoba daemon'));
    assert.ok(text.includes('--version'));
  });

  it('空 argv 等价 --help', async () => {
    const io = makeIo();
    const code = await runCli([], io, await makeDeps());
    assert.equal(code, 0);
    assert.ok(io.outLines.join('\n').includes('用法'));
  });

  it('--version 输出注入的版本号', async () => {
    const io = makeIo();
    const code = await runCli(['--version'], io, await makeDeps());
    assert.equal(code, 0);
    assert.equal(io.outLines[0], 'neoba 9.9.9-test');
  });

  it('未知命令报错并列出可用命令,退出码非 0', async () => {
    const io = makeIo();
    const code = await runCli(['frobnicate'], io, await makeDeps());
    assert.equal(code, 2);
    assert.notEqual(code, 0);
    assert.ok(io.errLines.join('\n').includes('未知命令 "frobnicate"'));
    assert.ok(io.errLines.join('\n').includes('start, status, doctor, prune, mcp'));
  });

  it('未知全局选项报错,退出码 2', async () => {
    const io = makeIo();
    const code = await runCli(['--wat'], io, await makeDeps());
    assert.equal(code, 2);
    assert.ok(io.errLines.join('\n').includes('未知全局选项 --wat'));
  });
});

describe('cli:doctor', () => {
  it('--json 在全绿探针下退出 0,ok:true 且报告结构完整', async () => {
    const io = makeIo();
    const code = await runCli(['doctor', '--json'], io, await makeDeps({ execProbe: greenProbe }));
    assert.equal(code, 0);
    assert.equal(io.outLines.length, 1);
    const report = JSON.parse(io.outLines[0] ?? '{}') as Record<string, unknown>;
    assert.equal(report['schemaVersion'], 1);
    assert.equal(typeof report['generatedAt'], 'string');
    assert.ok(Array.isArray(report['checks']));
    assert.ok((report['checks'] as unknown[]).length > 0);
    assert.equal(typeof report['recommendedBackend'], 'string');
    assert.equal(typeof report['codexReady'], 'boolean');
    assert.equal(typeof report['dataPlaneCrossBoundary'], 'boolean');
    const platform = report['platform'] as Record<string, unknown>;
    assert.equal(typeof platform['platform'], 'string');
    // #30:无 fail 级检查项 → 顶层 ok 为 true(退出码 0 的同一口径)。
    assert.equal(report['ok'], true);
  });

  it('存在 fail 级检查项:退出码 1,--json ok:false(#30)', async () => {
    const io = makeIo();
    const code = await runCli(['doctor', '--json'], io, await makeDeps());
    assert.equal(code, 1);
    const report = JSON.parse(io.outLines[0] ?? '{}') as Record<string, unknown>;
    const checks = report['checks'] as { severity: string }[];
    assert.ok(checks.some((c) => c.severity === 'fail'), '假探针下应有 fail 级检查项');
    assert.equal(report['ok'], false);
    // 人读渲染路径同一退出码口径。
    const io2 = makeIo();
    assert.equal(await runCli(['doctor'], io2, await makeDeps()), 1);
  });

  it('仅 warn/unknown 不算失败:退出码仍 0(#30 语义边界)', async () => {
    // 全绿探针下 keyring/msb(按平台)与 data-plane 落 unknown,不阻塞退出码。
    const io = makeIo();
    const code = await runCli(['doctor', '--json'], io, await makeDeps({ execProbe: greenProbe }));
    const report = JSON.parse(io.outLines[0] ?? '{}') as { checks: { severity: string }[] };
    assert.ok(
      report.checks.some((c) => c.severity === 'unknown' || c.severity === 'warn'),
      '场景里应有非 ok 非 fail 的检查项',
    );
    assert.equal(code, 0);
  });

  it('默认人读渲染(renderReport)', async () => {
    const io = makeIo();
    const code = await runCli(['doctor'], io, await makeDeps({ execProbe: greenProbe }));
    assert.equal(code, 0);
    const text = io.outLines.join('\n');
    assert.ok(text.includes('neoba doctor 环境检测报告'));
    assert.ok(text.includes('推荐后端'));
    assert.ok(text.includes('检查项'));
  });

  it('--write 落配置(路径经 deps 注入)', async () => {
    const dir = await makeTmp('doctor');
    const configPath = join(dir, 'config.json');
    const io = makeIo();
    const code = await runCli(
      ['doctor', '--write', '--json'],
      io,
      await makeDeps({ execProbe: greenProbe, defaultConfigPath: () => configPath }),
    );
    assert.equal(code, 0);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    const doctorSection = config['doctor'] as Record<string, unknown> | undefined;
    assert.ok(doctorSection !== undefined);
    assert.equal(typeof doctorSection['recommendedBackend'], 'string');
  });
});

describe('cli:status', () => {
  it('状态目录不存在:优雅报错退出码 1,不抛异常', async () => {
    const io = makeIo();
    const code = await runCli(
      ['status', '--state-dir', join(await makeTmp('status'), 'nope')],
      io,
      await makeDeps(),
    );
    assert.equal(code, 1);
    assert.ok(io.errLines.join('\n').includes('未找到 daemon 状态文件'));
  });

  it('状态目录不存在 + --json:输出 running:false 结构', async () => {
    const io = makeIo();
    const code = await runCli(
      ['status', '--json', '--state-dir', join(await makeTmp('status'), 'nope')],
      io,
      await makeDeps(),
    );
    assert.equal(code, 1);
    const parsed = JSON.parse(io.outLines[0] ?? '{}') as Record<string, unknown>;
    assert.equal(parsed['running'], false);
    assert.equal(parsed['alive'], false);
    assert.equal(parsed['stateFile'], false);
  });

  it('daemon 在跑(alive):人读一行摘要,退出码 0', async () => {
    const dir = await makeTmp('status');
    await writeFile(
      join(dir, 'daemon-state.json'),
      JSON.stringify({ pid: 42, version: '0.1.0', port: 7917, startedAt: '2026-01-01T00:00:00Z', stoppedAt: null }),
      'utf8',
    );
    await writeFile(join(dir, 'token'), 'tok\n', 'utf8');
    const io = makeIo();
    const code = await runCli(['status', '--state-dir', dir], io, await makeDeps({ fetch: liveFetch }));
    assert.equal(code, 0);
    const line = io.outLines[0] ?? '';
    assert.ok(line.includes('运行中'));
    assert.ok(line.includes('pid=42'));
    assert.ok(line.includes('port=7917'));
  });

  it('探活失败:退出码 1;--json 给全字段', async () => {
    const dir = await makeTmp('status');
    await writeFile(
      join(dir, 'daemon-state.json'),
      JSON.stringify({ pid: 42, version: '0.1.0', port: 7917, startedAt: '2026-01-01T00:00:00Z', stoppedAt: null }),
      'utf8',
    );
    const io = makeIo();
    const code = await runCli(
      ['status', '--json', '--state-dir', dir],
      io,
      await makeDeps({ fetch: deadFetch }),
    );
    assert.equal(code, 1);
    const parsed = JSON.parse(io.outLines[0] ?? '{}') as Record<string, unknown>;
    assert.equal(parsed['alive'], false);
    assert.equal(parsed['running'], false);
    assert.equal(parsed['pid'], 42);
    assert.equal(parsed['port'], 7917);
    assert.equal(parsed['tokenFile'], false);
  });

  it('状态文件损坏:优雅报错不抛', async () => {
    const dir = await makeTmp('status');
    await writeFile(join(dir, 'daemon-state.json'), '{not json', 'utf8');
    const io = makeIo();
    const code = await runCli(['status', '--state-dir', dir], io, await makeDeps());
    assert.equal(code, 1);
    assert.ok(io.errLines.join('\n').includes('损坏'));
  });
});

describe('cli:prune', () => {
  async function makeRepoWithOrphan(): Promise<{ stateDir: string; sha: string }> {
    const stateDir = await makeTmp('prune');
    const repo = await ArtifactRepository.open(join(stateDir, 'artifacts'));
    const published = await repo.publish(
      { tenant: 'acme', task: 't1' },
      'node-1',
      'out',
      'hello',
    );
    // 抹掉 manifest 指针 → 对象成为孤儿(模拟未引用的 CAS 对象)
    for (const f of await listFiles(join(stateDir, 'artifacts', 'manifests'))) {
      await rm(f, { force: true });
    }
    await repo.close();
    return { stateDir, sha: published.rootSha256 };
  }

  it('默认 dry-run:列出将删对象但不删', async () => {
    const { stateDir, sha } = await makeRepoWithOrphan();
    const io = makeIo();
    const code = await runCli(['prune', '--state-dir', stateDir], io, await makeDeps());
    assert.equal(code, 0);
    const text = io.outLines.join('\n');
    assert.ok(text.includes('dry-run'));
    assert.ok(text.includes(sha));
    assert.ok(text.includes('未删除任何对象'));
    assert.equal((await listFiles(join(stateDir, 'artifacts', 'objects'))).length, 1);
  });

  it('--yes 真正删除孤儿对象', async () => {
    const { stateDir, sha } = await makeRepoWithOrphan();
    const io = makeIo();
    const code = await runCli(['prune', '--state-dir', stateDir, '--yes'], io, await makeDeps());
    assert.equal(code, 0);
    const text = io.outLines.join('\n');
    assert.ok(text.includes('已删除孤儿对象 1 个'));
    assert.ok(text.includes(sha));
    assert.equal((await listFiles(join(stateDir, 'artifacts', 'objects'))).length, 0);
  });

  it('未初始化的空目录(#30):报错退出 1,不静默建仓', async () => {
    const stateDir = await makeTmp('prune');
    const io = makeIo();
    const code = await runCli(['prune', '--state-dir', stateDir, '--yes'], io, await makeDeps());
    assert.equal(code, 1);
    const errText = io.errLines.join('\n');
    assert.ok(errText.includes('已初始化'), '报错应说明 state-dir 未初始化');
    assert.ok(errText.includes(stateDir), '报错应带上实际路径');
    // 防静默建仓:目录里不留 openRepository 的仓库骨架。
    assert.deepEqual(await readdir(stateDir).catch(() => ['<absent>']), []);
  });

  it('有初始化标记的空仓库 --yes:无事发生,退出码 0', async () => {
    const stateDir = await makeTmp('prune');
    // 任一标记即可:仅放一个状态文件,不建 artifacts 目录也应放行。
    await writeFile(join(stateDir, 'daemon-state.json'), '{}', 'utf8');
    const io = makeIo();
    const code = await runCli(['prune', '--state-dir', stateDir, '--yes'], io, await makeDeps());
    assert.equal(code, 0);
    assert.ok(io.outLines.join('\n').includes('没有孤儿对象'));
  });
});

describe('cli:未知 flag 与命令级 --help(issue #28)', () => {
  it('start --registryy x:未知 flag 报用法错误退出码 2,不启动 daemon', async () => {
    const io = makeIo();
    const code = await runCli(['start', '--registryy', 'x'], io, await makeDeps({
      startDaemon: async () => {
        throw new Error('不应走到 daemon 启动');
      },
    }));
    assert.equal(code, 2);
    const errText = io.errLines.join('\n');
    assert.ok(errText.includes('未知选项 --registryy'));
    assert.ok(errText.includes('--registry')); // 合法选项清单里能对出正确拼写
    assert.ok(errText.includes('用法: neoba start'));
  });

  it('start --registryy=x(--flag=value 形态)同样报错', async () => {
    const io = makeIo();
    const code = await runCli(['start', '--registryy=x'], io, await makeDeps());
    assert.equal(code, 2);
    assert.ok(io.errLines.join('\n').includes('未知选项 --registryy'));
  });

  it('start --help:退出码 0 打印该命令用法,不启动 daemon', async () => {
    const io = makeIo();
    const code = await runCli(['start', '--help'], io, await makeDeps({
      startDaemon: async () => {
        throw new Error('不应走到 daemon 启动');
      },
    }));
    assert.equal(code, 0);
    const text = io.outLines.join('\n');
    assert.ok(text.includes('用法: neoba start'));
    assert.ok(text.includes('--state-dir'));
    assert.ok(text.includes('neoba --help'));
    assert.deepEqual(io.errLines, []);
  });

  it('status --help / prune --help:打印用法退出码 0,不执行命令', async () => {
    const io = makeIo();
    const code = await runCli(['status', '--help'], io, await makeDeps());
    assert.equal(code, 0);
    assert.ok(io.outLines.join('\n').includes('用法: neoba status'));

    const io2 = makeIo();
    const code2 = await runCli(['prune', '-h'], io2, await makeDeps());
    assert.equal(code2, 0);
    assert.ok(io2.outLines.join('\n').includes('用法: neoba prune'));
  });

  it('合法 flag 调用不受影响:prune --state-dir DIR --plan(值型 + 布尔混合)', async () => {
    const stateDir = await makeTmp('plan');
    // #30 前置校验:合法调用的本意是"flag 解析与执行路径通",先落初始化标记。
    await writeFile(join(stateDir, 'tokens.json'), '{"api":"neoba-tokens/1.0","tokens":[]}', 'utf8');
    const io = makeIo();
    const code = await runCli(['prune', '--state-dir', stateDir, '--plan'], io, await makeDeps());
    assert.equal(code, 0);
    assert.ok(io.outLines.join('\n').includes('自动 GC 计划'));
  });

  it('位置参数不被误判为未知 flag:task <id> status 走到连接阶段才失败', async () => {
    const stateDir = await makeTmp('task');
    const io = makeIo();
    const code = await runCli(['task', 't-1', 'status', '--state-dir', stateDir], io, await makeDeps());
    assert.equal(code, 1);
    // 参数层通过(否则退出码会是 2);失败发生在连 daemon 阶段。
    assert.ok(io.errLines.join('\n').includes('daemon 未运行'));
  });
});

describe('cli:start / mcp 用法守卫', () => {
  it('--daemonize 报 not-supported,退出码 2', async () => {
    const io = makeIo();
    const code = await runCli(['start', '--daemonize'], io, await makeDeps());
    assert.equal(code, 2);
    assert.ok(io.errLines.join('\n').includes('not-supported'));
  });

  it('--foreground 与缺省同义(合法用法,不会在参数层被拒)', async () => {
    // 不真拉 daemon:start 会在 deps.startDaemon 里长驻;这里只验证参数层。
    // 用一个立即返回的假 startDaemon 验证 --foreground 被接受。
    const io = makeIo();
    const code = await runCli(['start', '--foreground'], io, await makeDeps({
      startDaemon: async () => {
        throw new Error('不应走到这里之外的路径');
      },
    }));
    assert.equal(code, 1);
    assert.ok(io.errLines.join('\n').includes('不应走到这里之外的路径'));
  });

  it('非法端口值报用法错误,退出码 2', async () => {
    const io = makeIo();
    const code = await runCli(['start', '--port', 'abc'], io, await makeDeps());
    assert.equal(code, 2);
    assert.ok(io.errLines.join('\n').includes('--port'));
  });

  it('mcp 在 token 缺失时优雅报错,退出码 1', async () => {
    const stateDir = await makeTmp('mcp');
    const io = makeIo();
    const code = await runCli(['mcp', '--state-dir', stateDir], io, await makeDeps());
    assert.equal(code, 1);
    assert.ok(io.errLines.join('\n').includes('token'));
  });
});
