/**
 * M4 观测线:api-doc 描述符表与 OPERATIONS 方法表的一致性(双向,防漂移),
 * 以及 openapiDocument() 的结构合法性。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPERATIONS } from '../../src/daemon/operations.ts';
import { API_OPERATIONS, OPENAPI_VERSION, openapiDocument } from '../../src/daemon/api-doc.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('api-doc ↔ OPERATIONS 一致性(M4 防漂移)', () => {
  it('双向一一对应:每个 OPERATIONS 方法都有描述符,反之亦然', () => {
    const documented = API_OPERATIONS.map((op) => op.method).sort();
    const registered = [...OPERATIONS].sort();
    assert.deepEqual(documented, registered);
  });

  it('无重复描述符', () => {
    const methods = API_OPERATIONS.map((op) => op.method);
    assert.equal(new Set(methods).size, methods.length);
  });

  it('每个描述符结构完整:summary 非空、params 字段唯一且类型合法、result 非空', () => {
    const legalTypes = new Set(['string', 'integer', 'number', 'boolean', 'object', 'array']);
    for (const op of API_OPERATIONS) {
      assert.ok(op.summary.length > 0, `${op.method}: summary 缺失`);
      assert.ok(op.result.length > 0, `${op.method}: result 描述缺失`);
      const names = op.params.map((p) => p.name);
      assert.equal(new Set(names).size, names.length, `${op.method}: params 字段重名`);
      for (const param of op.params) {
        assert.ok(param.description.length > 0, `${op.method}.${param.name}: 描述缺失`);
        assert.ok(legalTypes.has(param.type), `${op.method}.${param.name}: 非法类型 ${param.type}`);
      }
    }
  });
});

describe('openapiDocument()(OpenAPI 3.1)', () => {
  const doc: Record<string, unknown> = openapiDocument();

  it('文档骨架:openapi 3.1.x、info、servers、单端点 POST /', () => {
    assert.equal(doc['openapi'], '3.1.0');
    const info = doc['info'] as Record<string, unknown>;
    assert.equal(info['version'], OPENAPI_VERSION);
    const paths = doc['paths'] as Record<string, unknown>;
    assert.deepEqual(Object.keys(paths), ['/']);
    const post = (paths['/'] as Record<string, unknown>)['post'] as Record<string, unknown>;
    assert.ok(isRecord(post));
  });

  it('Bearer securityScheme 挂在 POST / 上', () => {
    const paths = doc['paths'] as Record<string, unknown>;
    const post = (paths['/'] as Record<string, unknown>)['post'] as Record<string, unknown>;
    assert.deepEqual(post['security'], [{ bearerAuth: [] }]);
    const components = doc['components'] as Record<string, unknown>;
    const schemes = components['securitySchemes'] as Record<string, unknown>;
    assert.deepEqual(schemes['bearerAuth'], {
      type: 'http',
      scheme: 'bearer',
      description: 'bootstrap token = admin;session.init 签发的会话 token 绑定 (tenant, session)',
    });
  });

  it('每个 OPERATIONS 方法都有一个 (method const, params) 变体与 params schema', () => {
    const post = ((doc['paths'] as Record<string, unknown>)['/'] as Record<string, unknown>)['post'] as Record<string, unknown>;
    const requestBody = post['requestBody'] as Record<string, unknown>;
    const content = requestBody['content'] as Record<string, unknown>;
    const json = content['application/json'] as Record<string, unknown>;
    const schema = json['schema'] as Record<string, unknown>;
    const variants = schema['oneOf'] as Record<string, unknown>[];
    assert.equal(variants.length, OPERATIONS.length);
    const methods = variants.map((v) => (v['properties'] as Record<string, unknown>)['method']);
    for (const method of OPERATIONS) {
      assert.ok(
        methods.some((m) => isRecord(m) && m['const'] === method),
        `缺 ${method} 的 oneOf 变体`,
      );
      const components = doc['components'] as Record<string, unknown>;
      const schemas = components['schemas'] as Record<string, unknown>;
      assert.ok(schemas[`params.${method}`] !== undefined, `缺 params.${method} schema`);
    }
  });

  it('params schema 字段与描述符一致(抽查 events.list)', () => {
    const components = doc['components'] as Record<string, unknown>;
    const schemas = components['schemas'] as Record<string, unknown>;
    const eventsList = schemas['params.events.list'] as Record<string, unknown>;
    const properties = eventsList['properties'] as Record<string, unknown>;
    assert.deepEqual(Object.keys(properties).sort(), ['limit', 'session', 'task', 'tenant', 'type']);
    const doc0 = API_OPERATIONS.find((op) => op.method === 'events.list');
    assert.ok(doc0 !== undefined);
    for (const param of doc0.params) {
      assert.equal((properties[param.name] as Record<string, unknown>)['type'], param.type);
    }
  });

  it('产出可 JSON 序列化', () => {
    const text = JSON.stringify(openapiDocument('test'));
    assert.ok(text.includes('"openapi":"3.1.0"'));
    assert.ok(!text.includes('"version":"0.3.0"'), '版本参数应被覆盖');
  });
});
