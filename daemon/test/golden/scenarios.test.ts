/**
 * golden 一致性测试集入口(§9 P0):枚举 protocol/scenarios/*.json 逐场景
 * 执行(runScenarioFile:ajv 校验 → 起 daemon → 步骤序列 → 事件断言)。
 * 场景文件是协议冻结物;本测试 = 参考实现对"接入合同"的自证。
 */
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROTOCOL_ROOT, loadScenario, runScenarioFile } from './driver.ts';

const dir = join(PROTOCOL_ROOT, 'scenarios');
// 模块顶层枚举(describe 回调须同步;ESM 顶层 await 即可)。
const files = (await readdir(dir))
  .filter((f) => f.endsWith('.json') && f !== 'scenario.schema.json')
  .sort();

describe('golden 场景(§9 P0 一致性测试集)', () => {
  it('场景目录非空(至少收录 P0 五景)', () => {
    assert.ok(files.length >= 5, `仅发现 ${files.length} 个场景:${files.join(', ')}`);
  });

  for (const file of files) {
    it(file, async () => {
      // 先 loadScenario:schema 校验错误单独报,不混入执行断言。
      await loadScenario(join(dir, file));
      await runScenarioFile(join(dir, file));
    });
  }
});
