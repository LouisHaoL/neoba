/**
 * capability 注册表测试(§3.1,结构按 capability-registry.schema.json):
 * 合法加载、校验失败集(id 重复 / scope 非法 / fs_path 缺 path_template /
 * kind 非法 / risk_level 非法 / 缺必填字段)、文件加载、内置默认注册表。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  RegistryInvalid,
  defaultRegistry,
  loadCapabilityRegistry,
  loadCapabilityRegistryFile,
} from '../../src/capability/index.ts';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

function validDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
      {
        id: 'mcp:github',
        kind: 'mcp_server',
        description: 'GitHub 仓库/issue/PR 读写',
        tools: ['create_pr', 'list_issues'],
        risk_level: 'medium',
        grantable_scopes: ['read', 'write', 'admin'],
      },
    ],
    ...overrides,
  };
}

function issuesOf(doc: unknown): string[] {
  try {
    loadCapabilityRegistry(doc);
  } catch (err) {
    assert.ok(err instanceof RegistryInvalid, `应抛 RegistryInvalid,实际 ${String(err)}`);
    return [...err.issues];
  }
  assert.fail('应抛 RegistryInvalid');
}

describe('能力注册表加载', () => {
  it('合法文档加载:字段保持、按 id 查询命中', () => {
    const reg = loadCapabilityRegistry(validDoc());
    assert.equal(reg.protocol, '1.0');
    assert.equal(reg.capabilities.length, 2);
    const fs = reg.get('fs:workdir');
    assert.ok(fs);
    assert.equal(fs.kind, 'fs_path');
    assert.deepEqual(fs.grantable_scopes, ['ro', 'rw']);
    assert.equal(fs.path_template, '${task.workdir}');
    assert.equal(reg.get('nope'), undefined);
  });

  it('risk_level 可省略(schema 可选),tools 可省略', () => {
    const reg = loadCapabilityRegistry(
      validDoc({
        capabilities: [
          { id: 'skill:playwright-basics', kind: 'skill', description: 'x', grantable_scopes: ['read'] },
        ],
      }),
    );
    const entry = reg.get('skill:playwright-basics');
    assert.ok(entry);
    assert.equal(entry.risk_level, undefined);
    assert.equal(entry.tools, undefined);
  });
});

describe('能力注册表校验失败集', () => {
  it('id 重复 → 报重复问题', () => {
    const doc = validDoc();
    (doc['capabilities'] as unknown[]).push({
      id: 'fs:workdir',
      kind: 'fs_path',
      description: 'dup',
      grantable_scopes: ['ro'],
      path_template: '/x',
    });
    const issues = issuesOf(doc);
    assert.ok(issues.some((i) => i.includes('重复的能力 id')));
  });

  it('fs_path 缺 path_template → 报 schema if/then 违规', () => {
    const issues = issuesOf(
      validDoc({
        capabilities: [
          { id: 'fs:tmp', kind: 'fs_path', description: 'x', grantable_scopes: ['rw'] },
        ],
      }),
    );
    assert.ok(issues.some((i) => i.includes('path_template') && i.includes('fs_path')));
  });

  it('grantable_scopes 非法取值 / 空数组 / 重复 → 各报一条', () => {
    const bad = issuesOf(
      validDoc({
        capabilities: [
          { id: 'mcp:x', kind: 'mcp_server', description: 'x', grantable_scopes: ['root'] },
        ],
      }),
    );
    assert.ok(bad.some((i) => i.includes('grantable_scopes')));

    const empty = issuesOf(
      validDoc({
        capabilities: [
          { id: 'mcp:x', kind: 'mcp_server', description: 'x', grantable_scopes: [] },
        ],
      }),
    );
    assert.ok(empty.some((i) => i.includes('grantable_scopes')));

    const dup = issuesOf(
      validDoc({
        capabilities: [
          {
            id: 'mcp:x',
            kind: 'mcp_server',
            description: 'x',
            grantable_scopes: ['read', 'read'],
          },
        ],
      }),
    );
    assert.ok(dup.some((i) => i.includes('无重复')));
  });

  it('kind 非法 / risk_level 非法 / id 格式非法 / description 缺失', () => {
    const mk = (entry: Record<string, unknown>) =>
      issuesOf(validDoc({ capabilities: [entry] }));

    assert.ok(mk({ id: 'mcp:x', kind: 'shell', description: 'x', grantable_scopes: ['read'] })
      .some((i) => i.includes('kind')));
    assert.ok(
      mk({ id: 'mcp:x', kind: 'mcp_server', description: 'x', risk_level: 'extreme', grantable_scopes: ['read'] })
        .some((i) => i.includes('risk_level')),
    );
    assert.ok(mk({ id: 'mcp_x', kind: 'mcp_server', description: 'x', grantable_scopes: ['read'] })
      .some((i) => i.includes('id')));
    assert.ok(mk({ id: 'mcp:x', kind: 'mcp_server', grantable_scopes: ['read'] })
      .some((i) => i.includes('description')));
  });

  it('一次报出全部问题(issues 多条)', () => {
    const issues = issuesOf(validDoc({ protocol: '9.9', spec_version: 'abc', capabilities: 'no' }));
    assert.ok(issues.length >= 3);
  });

  it('根不是对象 → 单条问题', () => {
    assert.equal(issuesOf([1, 2]).length, 1);
  });
});

describe('注册表文件加载与默认注册表', () => {
  it('从临时 JSON 文件加载成功', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neoba-cap-'));
    roots.push(dir);
    const path = join(dir, 'registry.json');
    await writeFile(path, JSON.stringify(validDoc()), 'utf8');
    const reg = await loadCapabilityRegistryFile(path);
    assert.equal(reg.capabilities.length, 2);
  });

  it('文件不存在 / 非法 JSON → RegistryInvalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neoba-cap-'));
    roots.push(dir);
    await assert.rejects(
      loadCapabilityRegistryFile(join(dir, 'missing.json')),
      RegistryInvalid,
    );
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{nope', 'utf8');
    await assert.rejects(loadCapabilityRegistryFile(bad), RegistryInvalid);
  });

  it('内置默认注册表:fs:workdir + mcp 示例,自身通过校验', () => {
    const reg = defaultRegistry();
    assert.ok(reg.get('fs:workdir'));
    assert.equal(reg.get('fs:workdir')?.path_template, '${task.workdir}');
    const mcps = reg.capabilities.filter((c) => c.kind === 'mcp_server');
    assert.ok(mcps.length >= 2);
    for (const entry of reg.capabilities) {
      assert.match(entry.id, /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/);
      assert.ok(entry.grantable_scopes.length > 0);
    }
  });
});
