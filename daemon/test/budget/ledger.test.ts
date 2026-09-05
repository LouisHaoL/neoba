/**
 * 预算 ledger 测试(§3.5f):soft 80% 缺省、warning/exceeded 一次触发、
 * hard action=paused、续预算回落重新武装、非法入参。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetLedger, DEFAULT_SOFT_RATIO } from '../../src/budget/index.ts';
import type { BudgetEmitInput } from '../../src/budget/index.ts';

function ledger(limitTokens: number, softRatio?: number) {
  const events: BudgetEmitInput[] = [];
  const led = new BudgetLedger(
    softRatio === undefined ? { limitTokens } : { limitTokens, softRatio },
    {
      emit: (ev) => {
        events.push(ev);
      },
    },
  );
  return { led, events };
}

describe('budget/BudgetLedger', () => {
  it('缺省 soft 比例 80%', () => {
    const { led } = ledger(1000);
    assert.equal(DEFAULT_SOFT_RATIO, 0.8);
    assert.equal(led.softTokens, 800);
  });

  it('越 soft 线发一次 warning,继续消耗不重发', async () => {
    const { led, events } = ledger(1000);
    const v1 = await led.record(700, 50); // 750 ≥ 800? 否
    assert.deepEqual(v1.crossed, []);
    assert.equal(led.level, 'ok');
    const v2 = await led.record(40, 20); // 810 ≥ 800
    assert.deepEqual(v2.crossed, ['soft']);
    assert.equal(v2.level, 'soft');
    await led.record(10, 10);
    assert.equal(events.filter((e) => e.type === 'budget.warning').length, 1);
    const warn = events[0];
    assert.equal(warn?.payload.level, 'soft');
    assert.equal(warn?.payload.limitTokens, 800);
  });

  it('越 hard 线发 exceeded 带 action=paused', async () => {
    const { led, events } = ledger(1000);
    const v = await led.record(1200, 0);
    // 同笔先越 soft 再越 hard:两档都触发。
    assert.deepEqual(v.crossed, ['soft', 'hard']);
    assert.equal(v.action, 'paused');
    assert.equal(events.length, 2);
    const exceeded = events[1];
    assert.equal(exceeded?.type, 'budget.exceeded');
    assert.equal(exceeded?.payload.level, 'hard');
    assert.equal(exceeded?.payload.action, 'paused');
  });

  it('hard 状态持续,不重复发 exceeded', async () => {
    const { led, events } = ledger(100);
    await led.record(150, 0);
    const v = await led.record(50, 0);
    assert.deepEqual(v.crossed, []);
    assert.equal(v.level, 'hard');
    assert.equal(events.filter((e) => e.type === 'budget.exceeded').length, 1);
  });

  it('续预算:回落 ok 重新武装 soft,再次越线再发 warning', async () => {
    const { led, events } = ledger(1000);
    await led.record(900, 0); // soft
    const r = led.raise(2000);
    assert.equal(r.reArmed, true);
    assert.equal(led.level, 'ok');
    await led.record(1700 - 900, 0); // 累计 1700 ≥ 1600 新 soft
    assert.equal(led.level, 'soft');
    assert.equal(events.filter((e) => e.type === 'budget.warning').length, 2);
  });

  it('续预算落到 soft~hard 之间:hard 重新武装,soft 不重发', async () => {
    const { led, events } = ledger(1000);
    await led.record(950, 0); // soft + hard? 950 < 1000 → 仅 soft
    led.raise(1100); // soft=880,observed 950 ∈ [880, 1100)
    assert.equal(led.level, 'soft');
    const v = await led.record(200, 0); // 1150 ≥ 1100
    assert.deepEqual(v.crossed, ['hard']);
    assert.equal(events.filter((e) => e.type === 'budget.warning').length, 1);
    assert.equal(events.filter((e) => e.type === 'budget.exceeded').length, 1);
  });

  it('raise 低于已耗或非法值抛 TypeError', async () => {
    const { led } = ledger(100);
    await led.record(60, 0);
    assert.throws(() => led.raise(50), TypeError);
    assert.throws(() => led.raise(1.5), TypeError);
  });

  it('非法配置/usage 抛 TypeError', () => {
    assert.throws(() => new BudgetLedger({ limitTokens: -1 }, { emit: () => {} }), TypeError);
    assert.throws(
      () => new BudgetLedger({ limitTokens: 100, softRatio: 1.5 }, { emit: () => {} }),
      TypeError,
    );
    const { led } = ledger(100);
    assert.rejects(led.record(-1, 0), TypeError);
  });
});
