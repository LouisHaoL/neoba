import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import assert from 'node:assert/strict';

import { defaultConfigPath, writeConfig } from '../../src/doctor/config.ts';
import type { DoctorReport } from '../../src/doctor/types.ts';
import { linuxInfo } from './helpers.ts';

function fakeReport(): DoctorReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-04T08:00:00.000Z',
    platform: linuxInfo(),
    checks: [],
    recommendedBackend: 'docker',
    backendReason: 'host 侧 docker CLI 与 daemon 均可用',
    codexReady: true,
    codexReadyReason: null,
    opencodeReady: true,
    opencodeReadyReason: null,
    keyringReady: true,
    keyringReadyReason: null,
    microsandboxReady: false,
    microsandboxReadyReason: null,
    dataPlane: [],
    dataPlaneCrossBoundary: false,
    wslconfig: { found: false, memory: null, processors: null, parseError: null },
  };
}

test('defaultConfigPath 指向 ~/.neoba/config.json', () => {
  assert.equal(
    defaultConfigPath('/home/u'),
    join('/home/u', '.neoba', 'config.json'),
  );
});

test('配置不存在:写入推荐后端与 doctor 小节', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neoba-doctor-'));
  try {
    const cfgPath = join(dir, 'config.json');
    const next = await writeConfig(fakeReport(), cfgPath);
    assert.equal(next.sandbox?.provider, 'docker');
    assert.equal(next.doctor?.recommendedBackend, 'docker');
    assert.equal(next.doctor?.codexReady, true);
    const onDisk = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.equal(onDisk.sandbox.provider, 'docker');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('配置合并保留既有字段:用户已设置 provider 时不覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neoba-doctor-'));
  try {
    const cfgPath = join(dir, 'config.json');
    await writeFile(
      cfgPath,
      JSON.stringify({
        sandbox: { provider: 'my-custom-backend', image: 'neoba-worker:latest' },
        listen: { port: 7788 },
        doctor: { lastRunAt: '2000-01-01T00:00:00.000Z', customNote: 'keep me' },
      }),
      'utf8',
    );
    const next = await writeConfig(fakeReport(), cfgPath);
    // 用户字段不覆盖
    assert.equal(next.sandbox?.provider, 'my-custom-backend');
    assert.equal(next.sandbox?.image, 'neoba-worker:latest');
    assert.equal(next['listen'] && (next['listen'] as { port: number }).port, 7788);
    // doctor 小节刷新但保留医生节内用户自定义键
    assert.equal(next.doctor?.lastRunAt, '2026-09-04T08:00:00.000Z');
    assert.equal(next.doctor?.customNote, 'keep me');
    assert.equal(next.doctor?.dataPlaneCrossBoundary, false);
    const onDisk = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.equal(onDisk.sandbox.provider, 'my-custom-backend');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('配置为损坏 JSON:不抛异常,以空配置合并写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neoba-doctor-'));
  try {
    const cfgPath = join(dir, 'config.json');
    await writeFile(cfgPath, '{not json', 'utf8');
    const next = await writeConfig(fakeReport(), cfgPath);
    assert.equal(next.sandbox?.provider, 'docker');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('用户未设置 provider 但有其他 sandbox 字段:补全 provider 并保留其余', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neoba-doctor-'));
  try {
    const cfgPath = join(dir, 'config.json');
    await writeFile(
      cfgPath,
      JSON.stringify({ sandbox: { image: 'img:1' } }),
      'utf8',
    );
    const next = await writeConfig(fakeReport(), cfgPath);
    assert.equal(next.sandbox?.provider, 'docker');
    assert.equal(next.sandbox?.image, 'img:1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
