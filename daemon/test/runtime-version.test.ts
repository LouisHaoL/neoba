/**
 * Node 运行时版本防御测试(issue #18):
 * Node 22.18(23.6 的 backport)起才默认直跑 .ts;22.6–22.17 需
 * `--experimental-strip-types`。纯函数注入假 version/execArgv 矩阵。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  needsTypeStripFlag,
  parseNodeVersion,
  typeStripGuard,
} from '../src/runtime-version.ts';

describe('runtime-version: parseNodeVersion', () => {
  it('解析 v 前缀与裸版本号', () => {
    assert.deepEqual(parseNodeVersion('v22.6.0'), { major: 22, minor: 6, patch: 0 });
    assert.deepEqual(parseNodeVersion('22.18.0'), { major: 22, minor: 18, patch: 0 });
  });

  it('无法识别的形态返回 null', () => {
    assert.equal(parseNodeVersion('not-a-version'), null);
    assert.equal(parseNodeVersion(''), null);
  });
});

describe('runtime-version: needsTypeStripFlag', () => {
  const cases: ReadonlyArray<[string, boolean]> = [
    ['v22.6.0', true], // engines 旧下沿:需 flag
    ['v22.17.1', true], // 22.17:仍需 flag
    ['v22.18.0', false], // 默认直跑 .ts 起点
    ['v22.18.1', false],
    ['v22.21.0', false],
    ['v23.5.0', true], // 23.x 线 23.6 起才默认支持
    ['v23.6.0', false],
    ['v24.0.0', false],
    ['v25.9.0', false], // 新版本现状不受影响
  ];

  for (const [version, expected] of cases) {
    it(`${version} → ${expected ? '需' : '不需'} --experimental-strip-types`, () => {
      assert.equal(needsTypeStripFlag(version), expected);
    });
  }

  it('无法识别的版本不报 flag 需求(交由 engines 与用户判断)', () => {
    assert.equal(needsTypeStripFlag('garbage'), false);
  });
});

describe('runtime-version: typeStripGuard', () => {
  it('低版本且未带 flag → 返回含指引的报错文案', () => {
    const msg = typeStripGuard('v22.6.0', []);
    assert.notEqual(msg, null);
    assert.match(msg as string, /22\.6\.0/);
    assert.match(msg as string, /--experimental-strip-types/);
  });

  it('22.17 未带 flag → 仍报错', () => {
    assert.notEqual(typeStripGuard('v22.17.1', []), null);
  });

  it('22.18+ / 25.x 未带 flag → 放行(现状不变)', () => {
    assert.equal(typeStripGuard('v22.18.0', []), null);
    assert.equal(typeStripGuard('v25.9.0', []), null);
  });

  it('低版本但已显式携带 type-strip flag → 放行', () => {
    assert.equal(
      typeStripGuard('v22.6.0', ['--experimental-strip-types']),
      null,
    );
    assert.equal(
      typeStripGuard('v22.17.1', ['--experimental-transform-types', 'x.ts']),
      null,
    );
  });

  it('无法识别的版本形态不阻塞', () => {
    assert.equal(typeStripGuard('weird', []), null);
  });
});
