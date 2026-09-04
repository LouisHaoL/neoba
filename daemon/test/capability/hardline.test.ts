/**
 * 协议硬底线纯函数测试(§3.3 v0.2):三态判定 + fail-closed 口径。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hardlineAllowsAuto, hardlineVerdict } from '../../src/capability/index.ts';

describe('协议硬底线(§3.3 v0.2,纯函数三态)', () => {
  it('high + write/admin → forbidden', () => {
    assert.equal(hardlineVerdict('high', 'write'), 'forbidden');
    assert.equal(hardlineVerdict('high', 'admin'), 'forbidden');
  });

  it('high + read 类 → permitted', () => {
    assert.equal(hardlineVerdict('high', 'read'), 'permitted');
    assert.equal(hardlineVerdict('high', 'ro'), 'permitted');
    assert.equal(hardlineVerdict('high', 'rw'), 'permitted');
  });

  it('low/medium + write/admin → permitted(硬底线只看 high)', () => {
    assert.equal(hardlineVerdict('low', 'write'), 'permitted');
    assert.equal(hardlineVerdict('medium', 'admin'), 'permitted');
  });

  it('risk_level 缺失 → unknown_risk(fail-closed,schema 中 risk_level 可选)', () => {
    assert.equal(hardlineVerdict(undefined, 'write'), 'unknown_risk');
    assert.equal(hardlineVerdict(undefined, 'read'), 'unknown_risk');
  });

  it('自动放行口径:仅 permitted 可放行(unknown_risk 一并拦截)', () => {
    assert.equal(hardlineAllowsAuto('permitted'), true);
    assert.equal(hardlineAllowsAuto('forbidden'), false);
    assert.equal(hardlineAllowsAuto('unknown_risk'), false);
  });
});
