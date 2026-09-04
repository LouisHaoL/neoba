/**
 * Redactor 脱敏工具测试(§3.8:args_digest 等字段不含 secret 内容)。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Redactor, redactUnknownValue, secretRefToken } from '../../src/secrets/redact.ts';

describe('Redactor', () => {
  const redactor = new Redactor([
    ['github-token', 'ghp_abcdef123456'],
    ['db-password', 'hunter2-super-secret'],
  ]);

  it('已知值 → secret:<id 前 8 位>[REDACTED],输出稳定', () => {
    assert.equal(redactor.redact('ghp_abcdef123456'), 'secret:github-t[REDACTED]');
    assert.equal(redactor.redact('hunter2-super-secret'), 'secret:db-passw[REDACTED]');
    // 稳定:同值同串
    assert.equal(redactor.redact('ghp_abcdef123456'), redactor.redact('ghp_abcdef123456'));
  });

  it('未注册值 → sha256 前 8 位稳定串,不可逆向回 id', () => {
    const token = redactor.redact('some-random-text');
    assert.match(token, /^secret:[0-9a-f]{8}\[REDACTED\]$/);
    assert.equal(token, redactor.redact('some-random-text'));
    assert.notEqual(token, redactor.redact('other-text'));
  });

  it('空串原样返回,注册空串是 no-op', () => {
    assert.equal(redactor.redact(''), '');
    const r = new Redactor();
    r.register('empty', '');
    assert.equal(r.redact(''), '');
  });

  it('id 短于 8 位时取全 id', () => {
    const r = new Redactor([['k', 'v-value']]); // 'v-value' 不与 'k' 前缀冲突
    assert.equal(r.redact('v-value'), 'secret:k[REDACTED]');
  });

  it('secretRefToken 形态', () => {
    assert.equal(secretRefToken('github-token'), 'secret:github-t[REDACTED]');
  });

  it('redactDeep:嵌套结构中的已知值被替换,其余原样,入参不被改写', () => {
    const input = {
      task: 't1',
      args: { token: 'ghp_abcdef123456', count: 2 },
      list: ['plain', 'hunter2-super-secret', { nested: 'ghp_abcdef123456' }],
    };
    const snapshot = JSON.stringify(input);
    const out = redactor.redactDeep(input) as typeof input;

    assert.equal(out.task, 't1');
    assert.equal(out.args.count, 2);
    assert.equal(out.args.token, 'secret:github-t[REDACTED]');
    assert.deepEqual(out.list, [
      'plain',
      'secret:db-passw[REDACTED]',
      { nested: 'secret:github-t[REDACTED]' },
    ]);
    // 原对象未被改写
    assert.equal(JSON.stringify(input), snapshot);
  });

  it('redactDeep:Date / 类实例等非普通对象原样保留', () => {
    const date = new Date(0);
    class Thing {
      tag = 'x';
    }
    const thing = new Thing();
    const out = redactor.redactDeep({ at: date, thing }) as { at: Date; thing: Thing };
    assert.equal(out.at, date);
    assert.equal(out.thing, thing);
  });

  it('redactDeep:循环引用不爆栈', () => {
    const obj: Record<string, unknown> = { name: 'ok' };
    obj['self'] = obj;
    const out = redactor.redactDeep(obj) as Record<string, unknown>;
    assert.equal(out['name'], 'ok');
    assert.ok(out['self'] !== undefined);
  });

  it('containsSecret:嵌套检测已知值', () => {
    assert.equal(redactor.containsSecret('ghp_abcdef123456'), true);
    assert.equal(
      redactor.containsSecret({ a: [{ b: 'hunter2-super-secret' }] }),
      true,
    );
    assert.equal(redactor.containsSecret('plain text'), false);
    assert.equal(redactor.containsSecret({ a: 1, b: 'x' }), false);
    assert.equal(redactor.containsSecret(null), false);
  });

  it('redactUnknownValue:独立稳定串,空串原样', () => {
    assert.match(redactUnknownValue('zzz'), /^secret:[0-9a-f]{8}\[REDACTED\]$/);
    assert.equal(redactUnknownValue(''), '');
  });
});
