import assert from 'node:assert/strict';

import test from 'node:test';

import { classifyDataPlanePath, collectDataPlanePaths } from '../../src/doctor/dataplane.ts';
import { parseWslConfig } from '../../src/doctor/wslconfig.ts';

const win = { platform: 'win32' };
const linux = { platform: 'linux' };

test('数据面分类:Windows 盘符路径跨界', () => {
  for (const p of ['D:\\neoba\\work', 'C:/Users/x', 'd:/tmp']) {
    const c = classifyDataPlanePath(p, win);
    assert.equal(c.location, 'windows-drive', p);
    assert.equal(c.crossBoundary, true, p);
  }
});

test('数据面分类:/mnt/<盘符> 为 drvfs 跨界', () => {
  const c = classifyDataPlanePath('/mnt/d/work', win);
  assert.equal(c.location, 'wsl-mnt-bridge');
  assert.equal(c.crossBoundary, true);
  // /mnt/<多字母目录> 不算盘符桥(如 /mnt/tools)
  const ok = classifyDataPlanePath('/mnt/tools/x', win);
  assert.equal(ok.location, 'wsl-native');
  assert.equal(ok.crossBoundary, false);
});

test('数据面分类:WSL 原生路径不跨界', () => {
  const BS = String.fromCharCode(92);
  const UNC = BS + BS;
  for (const p of [
    UNC + 'wsl$' + BS + 'Ubuntu' + BS + 'home' + BS + 'u',
    UNC + 'wsl.localhost' + BS + 'Debian' + BS + 'srv',
    '/home/u/work',
    '/opt/neoba',
  ]) {
    const c = classifyDataPlanePath(p, win);
    assert.equal(c.location, 'wsl-native', p);
    assert.equal(c.crossBoundary, false, p);
  }
});

test('数据面分类:UNC 共享跨界,相对路径 unknown', () => {
  const BS = String.fromCharCode(92);
  const unc = classifyDataPlanePath(BS + BS + 'nas' + BS + 'share' + BS + 'repo', win);
  assert.equal(unc.crossBoundary, true);
  const rel = classifyDataPlanePath('relative/path', win);
  assert.equal(rel.location, 'unknown');
  assert.equal(rel.crossBoundary, false);
});

test('数据面分类:非 Windows 平台一律原生', () => {
  for (const p of ['/home/u/work', 'D:\\x', '/mnt/c/y']) {
    const c = classifyDataPlanePath(p, linux);
    assert.equal(c.location, 'host-native', p);
    assert.equal(c.crossBoundary, false, p);
  }
  const empty = classifyDataPlanePath('  ', linux);
  assert.equal(empty.location, 'unknown');
});

test('collectDataPlanePaths 只取已知键且忽略空值', () => {
  const paths = collectDataPlanePaths({
    sandbox: { workdir: 'D:\\w', provider: 'docker' },
    artifacts: { repoPath: '/home/u/cas' },
    docker: { contextPath: '' },
    other: { workdir: 'x' },
  });
  assert.deepEqual(paths, [
    { kind: 'workdir', path: 'D:\\w' },
    { kind: 'artifact-repo', path: '/home/u/cas' },
  ]);
});

test('parseWslConfig:取 [wsl2] 小节限额,忽略注释与其他小节', () => {
  const parsed = parseWslConfig(
    [
      '# comment',
      '[wsl2]',
      'memory = 8GB',
      'processors=4',
      'swap=2GB',
      '',
      '[other]',
      'memory=99GB',
    ].join('\r\n'),
  );
  assert.equal(parsed.memory, '8GB');
  assert.equal(parsed.processors, '4');
  assert.equal(parsed.parseError, null);
});

test('parseWslConfig:无相关键时返回 null', () => {
  const parsed = parseWslConfig('[wsl2]\nswap=2GB\n');
  assert.equal(parsed.memory, null);
  assert.equal(parsed.processors, null);
});
