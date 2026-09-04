/**
 * 预设解析测试(§3.2,结构按 preset.schema.json,含 v0.2 的 idempotent):
 * 合法解析、idempotent 缺省/显式、校验失败、文件加载。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { PresetInvalid, minimalPresetDoc, parsePreset, parsePresetFile } from '../../src/capability/index.ts';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

describe('预设解析(§3.2)', () => {
  it('完整预设(文档 §3.2 示例的 JSON 形态)解析出全部字段', () => {
    const preset = parsePreset(
      minimalPresetDoc({
        model: { tier: 'standard', fallback: ['standard', 'fast'] },
        skills: ['playwright-basics'],
        baseline_grants: [
          { cap: 'fs:workdir', scope: 'rw' },
          { cap: 'mcp:playwright', scope: 'write' },
        ],
        io_contracts: {
          inputs: [{ name: 'test_plan', type: 'file:markdown' }],
          outputs: [
            { name: 'test_report', type: 'file:markdown' },
            { name: 'artifacts', type: 'dir' },
          ],
        },
        idempotent: true,
      }),
    );
    assert.equal(preset.api, 'preset/1.0');
    assert.equal('protocol' in preset, false);
    assert.equal('spec_version' in preset, false);
    assert.equal(preset.name, 'e2e-tester');
    assert.equal(preset.base, 'any');
    assert.deepEqual(preset.model, { tier: 'standard', fallback: ['standard', 'fast'] });
    assert.deepEqual(preset.skills, ['playwright-basics']);
    assert.equal(preset.baseline_grants.length, 2);
    assert.deepEqual(preset.baseline_grants[0], { cap: 'fs:workdir', scope: 'rw' });
    assert.deepEqual(preset.io_contracts.outputs[1], { name: 'artifacts', type: 'dir' });
    assert.deepEqual(preset.escalation_policy, {
      auto_approve: [],
      require_approval: ['*'],
    });
  });

  it('idempotent 缺省 = false(schema default),显式 true 保留', () => {
    assert.equal(parsePreset(minimalPresetDoc()).idempotent, false);
    assert.equal(parsePreset(minimalPresetDoc({ idempotent: true })).idempotent, true);
    // idempotent: false 显式写也是 false 而非缺省
    assert.equal(parsePreset(minimalPresetDoc({ idempotent: false })).idempotent, false);
  });

  it('escalation 清单接受 cap_id_or_wildcard(精确 id / "*" / "ns:*"),拒绝其它', () => {
    const ok = parsePreset(
      minimalPresetDoc({
        escalation_policy: {
          auto_approve: ['mcp:playwright', 'mcp:*', '*'],
          require_approval: ['fs:workdir'],
        },
      }),
    );
    assert.deepEqual(ok.escalation_policy.auto_approve, ['mcp:playwright', 'mcp:*', '*']);
    assert.throws(
      () =>
        parsePreset(
          minimalPresetDoc({
            escalation_policy: { auto_approve: ['mcp*'], require_approval: [] },
          }),
        ),
      (err: unknown) =>
        err instanceof PresetInvalid && err.issues.some((i) => i.includes('auto_approve')),
    );
  });

  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ['api 非法', { api: 'preset/2.0' }, 'api'],
    ['禁止携带 protocol(文档类根类型)', { protocol: '1.0' }, 'protocol'],
    ['禁止携带 spec_version(文档类根类型)', { spec_version: '1.0' }, 'spec_version'],
    ['name 大写开头', { name: 'E2E' }, 'name'],
    ['base 非法', { base: 'gpt' }, 'base'],
    ['baseline_grants 缺失', { baseline_grants: undefined }, 'baseline_grants'],
    ['baseline_grants.scope 非法', { baseline_grants: [{ cap: 'fs:x', scope: 'rx' }] }, 'scope'],
    ['baseline_grants.cap 格式非法', { baseline_grants: [{ cap: 'fsx', scope: 'rw' }] }, 'cap'],
    ['io_contracts 缺失', { io_contracts: undefined }, 'io_contracts'],
    ['io_contracts.port 缺 type', { io_contracts: { inputs: [{ name: 'a' }], outputs: [] } }, 'type'],
    ['escalation_policy 缺失', { escalation_policy: undefined }, 'escalation_policy'],
    ['escalation 缺 require_approval', { escalation_policy: { auto_approve: [] } }, 'require_approval'],
    ['model.tier 非法', { model: { tier: 'giant' } }, 'tier'],
    ['idempotent 非布尔', { idempotent: 'yes' }, 'idempotent'],
    ['skills 含空串', { skills: [''] }, 'skills'],
  ];
  for (const [name, override, field] of invalid) {
    it(`非法: ${name}`, () => {
      assert.throws(
        () => parsePreset(minimalPresetDoc(override)),
        (err: unknown) =>
          err instanceof PresetInvalid &&
          err.issues.some((i) => i.includes(field)),
      );
    });
  }

  it('一次报出全部问题', () => {
    try {
      parsePreset(minimalPresetDoc({ api: 'x', base: 'y', name: 'Z' }));
      assert.fail('应抛 PresetInvalid');
    } catch (err) {
      assert.ok(err instanceof PresetInvalid);
      assert.ok(err.issues.length >= 3);
    }
  });

  it('根不是对象 → PresetInvalid', () => {
    assert.throws(() => parsePreset('nope'), PresetInvalid);
  });

  it('从临时 JSON 文件加载;非法 JSON → PresetInvalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neoba-preset-'));
    roots.push(dir);
    const good = join(dir, 'e2e-tester.json');
    await writeFile(good, JSON.stringify(minimalPresetDoc()), 'utf8');
    const preset = await parsePresetFile(good);
    assert.equal(preset.name, 'e2e-tester');

    const bad = join(dir, 'bad.json');
    await writeFile(bad, '[[[', 'utf8');
    await assert.rejects(parsePresetFile(bad), PresetInvalid);
  });
});
