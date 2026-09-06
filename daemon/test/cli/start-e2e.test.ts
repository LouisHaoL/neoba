/**
 * #6 进程级 e2e 冒烟(真实 CLI 子进程,不经 deps 注入):
 * - `node src/cli/main.ts start --presets/--registry/--models` 拉起 daemon 后,
 *   workflow.run 引用外部 preset 真跑通(缺省 memory 供给,基座走 ExecRuntime
 *   参考实现的 memory 路径);
 * - 装载失败(--presets 指不存在目录)→ 子进程退出码非 0,stderr 类型化报错。
 * 不带 flag 的零漂移路径由 cli.test.ts / start-artifacts.test.ts 装配层覆盖。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import { minimalPresetDoc } from '../../src/capability/index.ts';

const MAIN_TS = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop();
    if (child === undefined || child.exitCode !== null) continue;
    child.kill();
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `neoba-start-e2e-${prefix}-`));
  roots.push(dir);
  return dir;
}

const REGISTRY_DOC = {
  protocol: '1.0',
  spec_version: '1.0',
  capabilities: [
    {
      id: 'fs:workdir',
      kind: 'fs_path',
      description: '任务工作目录',
      risk_level: 'low',
      grantable_scopes: ['ro', 'rw'],
      path_template: '${task.workdir}',
    },
  ],
};

const WORKFLOW = {
  api: 'workflow/1.0',
  intent_ref: 'i-1',
  nodes: [{ id: 'n1', preset: 'ae-rpa' }],
  outputs: [],
  feedback: [],
  evidence: [],
};

interface Started {
  baseUrl: string;
  token: string;
  stdout: string;
}

/** 拉起 CLI 子进程 start,等 stdout 报"已启动",回 baseUrl + token。 */
async function startCli(flags: readonly string[]): Promise<Started> {
  const stateDir = await tmp('state');
  const child = spawn(process.execPath, [MAIN_TS, 'start', '--state-dir', stateDir, '--port', '0', ...flags], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  const stdout = await collect(child.stdout, (text) => /已启动: (http:\/\/127\.0\.0\.1:\d+)/.exec(text) !== null, 20000);
  const baseUrl = /已启动: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
  assert.ok(baseUrl !== undefined, `stdout 应含 daemon 地址:\n${stdout}`);
  const token = (await readFile(join(stateDir, 'token'), 'utf8')).replace(/\r?\n$/, '');
  return { baseUrl, token, stdout };
}

/** 收 stdout 至谓词命中(或超时);返回已收到的全部文本。 */
async function collect(
  stream: NodeJS.ReadableStream,
  done: (text: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  let text = '';
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => resolve(text), timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      text += chunk;
      if (done(text)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
    stream.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function rpc(baseUrl: string, token: string, method: string, params: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function waitFor(what: string, predicate: () => Promise<string | null>): Promise<string> {
  const deadline = Date.now() + 20000;
  for (;;) {
    const hit = await predicate();
    if (hit !== null) return hit;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe('cli start e2e 冒烟(#6 进程级)', () => {
  it('CLI 子进程带 --presets/--registry/--models → workflow.run 引用外部 preset 跑通', async () => {
    const root = await tmp('fixtures');
    const presetsDir = join(root, 'presets');
    await mkdir(presetsDir, { recursive: true });
    await writeFile(
      join(presetsDir, 'ae-rpa.json'),
      JSON.stringify(minimalPresetDoc({ name: 'ae-rpa' })),
      'utf8',
    );
    const registryFile = join(root, 'capabilities.json');
    await writeFile(registryFile, JSON.stringify(REGISTRY_DOC), 'utf8');
    const modelsFile = join(root, 'modelscore.json');
    await writeFile(modelsFile, JSON.stringify({ api: 'modelscore/1.0', models: [] }), 'utf8');

    const { baseUrl, token } = await startCli([
      '--presets', presetsDir,
      '--registry', registryFile,
      '--models', modelsFile,
    ]);

    const body = await rpc(baseUrl, token, 'workflow.run', { workflow: WORKFLOW });
    const taskId = (body['result'] as Record<string, unknown>)['task_id'] as string;
    assert.ok(taskId?.startsWith('task-'), `workflow.run 应受理: ${JSON.stringify(body)}`);

    const final = await waitFor('任务到终态', async () => {
      const status = await rpc(baseUrl, token, 'task.status', { task_id: taskId });
      const task = ((status['result'] as Record<string, unknown>)?.['task'] ?? {}) as Record<string, unknown>;
      return task['status'] === 'completed' || task['status'] === 'failed' ? String(task['status']) : null;
    });
    assert.equal(final, 'completed', '外部 preset 工作流应跑通(而非校验失败)');
  });

  it('装载失败(--presets 目录不存在)→ 子进程退出码非 0,stderr 类型化报错', async () => {
    const stateDir = await tmp('bad');
    const missing = join(stateDir, 'no-such-presets');
    const child = spawn(process.execPath, [MAIN_TS, 'start', '--state-dir', stateDir, '--port', '0', '--presets', missing], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);

    const [code, stderr] = await new Promise<[number | null, string]>((resolve, reject) => {
      let err = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (c: string) => { err += c; });
      child.on('error', reject);
      child.on('exit', (c: number | null) => resolve([c, err]));
    });
    assert.notEqual(code, 0, '装载失败必须退出非 0');
    assert.ok(stderr.includes('start 装载失败(presets)'), `stderr 应类型化报错:\n${stderr}`);
  });
});
