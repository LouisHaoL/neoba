/**
 * SecretStore 语义测试(§3.8,基于 MemorySecretBackend):
 * set/get/delete/list、tenant 分桶与隔离、跨 tenant 类型化拒绝、
 * resolveInjection、exportManifest(§3.5g 导出不可表达明文)、校验。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CrossTenantAccess,
  InvalidSecretId,
  InvalidTenant,
  MemorySecretBackend,
  Redactor,
  SecretError,
  SecretNotFound,
  SecretStore,
} from '../../src/secrets/index.ts';

const makeStore = (redactor?: Redactor): SecretStore =>
  new SecretStore(new MemorySecretBackend(), { redactor });

describe('SecretStore 基本语义', () => {
  it('set/get 往返;set 返回元数据,不含 value', async () => {
    const store = makeStore();
    const meta = await store.set('default', 'api-key', 'v-123', {
      description: '上游 API 的 key',
    });
    assert.equal(meta.id, 'api-key');
    assert.equal(meta.description, '上游 API 的 key');
    assert.ok(!('value' in meta));
    assert.ok(meta.createdAt.length > 0);

    assert.equal(await store.get('default', 'api-key'), 'v-123');
  });

  it('重复 set 更新值与 updatedAt,保留 createdAt 与原 description', async () => {
    const store = makeStore();
    const first = await store.set('default', 'api-key', 'v1', { description: 'd' });
    const second = await store.set('default', 'api-key', 'v2');
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.description, 'd'); // 未传 description 时保留
    assert.equal(await store.get('default', 'api-key'), 'v2');
  });

  it('get 不存在的 secret → SecretNotFound(类型化)', async () => {
    const store = makeStore();
    await assert.rejects(
      store.get('default', 'nope'),
      (err: unknown) =>
        err instanceof SecretNotFound &&
        err.code === 'SECRET_NOT_FOUND' &&
        err instanceof SecretError,
    );
  });

  it('delete:true / 再 delete:false / 删后 get 报 NotFound', async () => {
    const store = makeStore();
    await store.set('default', 'tmp', 'v');
    assert.equal(await store.delete('default', 'tmp'), true);
    assert.equal(await store.delete('default', 'tmp'), false);
    await assert.rejects(store.get('default', 'tmp'), SecretNotFound);
  });

  it('list 只返回 id 与元数据,永不返回 value', async () => {
    const store = makeStore();
    await store.set('default', 'b-key', 'secret-value-b');
    await store.set('default', 'a-key', 'secret-value-a');
    const list = await store.list('default');
    assert.deepEqual(
      list.map((m) => m.id),
      ['a-key', 'b-key'],
    );
    for (const meta of list) {
      assert.ok(!('value' in meta), 'list 条目不允许出现 value 字段');
      assert.equal(typeof meta.createdAt, 'string');
    }
    // 凭据明文不允许从 list 通道泄漏
    assert.equal(
      JSON.stringify(list).includes('secret-value-'),
      false,
    );
  });

  it('空 tenant 桶 list 返回空数组', async () => {
    const store = makeStore();
    assert.deepEqual(await store.list('nobody'), []);
  });
});

describe('tenant 分桶与隔离(§3.8)', () => {
  it('同 id 不同 tenant 互不可见、互不串值', async () => {
    const store = makeStore();
    await store.set('tenant-a', 'shared-id', 'value-a');
    await store.set('tenant-b', 'shared-id', 'value-b');

    assert.equal(await store.get('tenant-a', 'shared-id'), 'value-a');
    assert.equal(await store.get('tenant-b', 'shared-id'), 'value-b');

    await store.delete('tenant-a', 'shared-id');
    assert.equal(await store.get('tenant-b', 'shared-id'), 'value-b');
  });

  it('跨 tenant get(直接桶寻址):他桶没有的 id 报 NotFound,不泄漏', async () => {
    const store = makeStore();
    await store.set('tenant-a', 'only-a', 'value-a');
    await assert.rejects(store.get('tenant-b', 'only-a'), SecretNotFound);
  });

  it('getFromRef 跨 tenant → CrossTenantAccess(先于后端访问抛出)', async () => {
    const store = makeStore();
    await store.set('tenant-a', 'only-a', 'value-a');
    await assert.rejects(
      store.getFromRef('tenant-b', { tenant: 'tenant-a', id: 'only-a' }),
      (err: unknown) =>
        err instanceof CrossTenantAccess &&
        err.code === 'SECRET_CROSS_TENANT' &&
        err.refTenant === 'tenant-a' &&
        err.tenant === 'tenant-b',
    );
    // 本 tenant ref 正常
    assert.equal(
      await store.getFromRef('tenant-a', { tenant: 'tenant-a', id: 'only-a' }),
      'value-a',
    );
  });

  it('CrossTenantAccess 不泄露他桶存在性:他桶不存在同 id 也同样报错', async () => {
    const store = makeStore();
    await assert.rejects(
      store.getFromRef('tenant-b', { tenant: 'tenant-a', id: 'ghost' }),
      CrossTenantAccess,
    );
  });
});

describe('resolveInjection(注入语义)', () => {
  it('纯 id:按序解析为 {name, value, ref}', async () => {
    const store = makeStore();
    await store.set('default', 'gh-token', 'v1');
    await store.set('default', 'db-url', 'v2');
    const injections = await store.resolveInjection('default', [
      'gh-token',
      'db-url',
    ]);
    assert.deepEqual(
      injections.map((i) => [i.name, i.value]),
      [
        ['gh-token', 'v1'],
        ['db-url', 'v2'],
      ],
    );
    assert.deepEqual(injections[1]!.ref, { tenant: 'default', id: 'db-url' });
  });

  it('ref 与纯 id 混用;本 tenant ref 合法', async () => {
    const store = makeStore();
    await store.set('default', 'a', 'va');
    const injections = await store.resolveInjection('default', [
      { tenant: 'default', id: 'a' },
      'a',
    ]);
    assert.equal(injections.length, 2);
    assert.equal(injections[0]!.value, 'va');
    assert.equal(injections[1]!.value, 'va');
  });

  it('ref 指向他 tenant → CrossTenantAccess,绝不解析(§3.8 硬规则)', async () => {
    const store = makeStore();
    await store.set('tenant-a', 'cred', 'value-a');
    await assert.rejects(
      store.resolveInjection('tenant-b', [{ tenant: 'tenant-a', id: 'cred' }]),
      CrossTenantAccess,
    );
    // 混在合法 id 中也一样:整体拒绝
    await store.set('tenant-b', 'own', 'v-own');
    await assert.rejects(
      store.resolveInjection('tenant-b', ['own', { tenant: 'tenant-a', id: 'cred' }]),
      CrossTenantAccess,
    );
  });

  it('空列表 → 空注入', async () => {
    const store = makeStore();
    assert.deepEqual(await store.resolveInjection('default', []), []);
  });
});

describe('exportManifest(§3.5g 导出包铁律)', () => {
  it('只含 id / purpose / 时间戳,类型与值面上都装不下明文', async () => {
    const store = makeStore();
    await store.set('default', 'deploy-key', 'SUPER-SECRET-PLAINTEXT', {
      description: '部署用 SSH key',
    });
    const manifest = await store.exportManifest('default');
    assert.equal(manifest.length, 1);
    const entry = manifest[0]!;
    assert.equal(entry.id, 'deploy-key');
    assert.equal(entry.purpose, '部署用 SSH key');
    const json = JSON.stringify(entry);
    assert.equal(json.includes('SUPER-SECRET-PLAINTEXT'), false);
    for (const key of Object.keys(entry)) {
      assert.ok(
        ['id', 'purpose', 'createdAt', 'updatedAt'].includes(key),
        `导出清单出现意外字段 ${key}`,
      );
    }
  });
});

describe('id / tenant 校验(对齐 common.schema.json)', () => {
  it('secret id 不符 ^[a-z][a-z0-9_.-]*$ → InvalidSecretId', async () => {
    const store = makeStore();
    for (const bad of [
      'Api-Key',
      '9leading-digit',
      'with/slash',
      'with space',
      '',
      '中',
      'a'.repeat(129),
    ]) {
      await assert.rejects(
        store.set('default', bad, 'v'),
        (err: unknown) =>
          err instanceof InvalidSecretId && err.code === 'SECRET_INVALID_ID',
        `id ${JSON.stringify(bad)} 应被拒绝`,
      );
    }
    // 合法形态放行
    await store.set('default', 'a', 'v');
    await store.set('default', 'api_key-1.0', 'v');
  });

  it('tenant 非法 → InvalidTenant', async () => {
    const store = makeStore();
    for (const bad of ['', 'with/slash', '..', '.hidden', 'a/b']) {
      await assert.rejects(store.set(bad, 'k', 'v'), InvalidTenant);
      await assert.rejects(store.get(bad, 'k'), InvalidTenant);
      await assert.rejects(store.list(bad), InvalidTenant);
    }
    await store.set('Tenant-A', 'k', 'v'); // 大写字母开头的合法段
  });
});

describe('Redactor 联动', () => {
  it('set 的值自动注册进脱敏器;store.redact 出 id 指认串', async () => {
    const redactor = new Redactor();
    const store = makeStore(redactor);
    await store.set('default', 'gh-token', 'ghp_real-value-1');
    assert.equal(
      redactor.redact('ghp_real-value-1'),
      'secret:gh-token[REDACTED]',
    );
    assert.equal(store.redact('ghp_real-value-1'), 'secret:gh-token[REDACTED]');
  });

  it('未注入脱敏器时 store.redact 退化为稳定匿名串', async () => {
    const store = makeStore();
    const token = store.redact('whatever-value');
    assert.match(token, /^secret:[0-9a-f]{8}\[REDACTED\]$/);
    assert.equal(token, store.redact('whatever-value'));
  });
});
