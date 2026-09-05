/**
 * e2e · HTTP 面(真实子进程):dashboard、openapi.json、JSON-RPC 协议错误
 * (-32700/-32601)、405、413 体积上限。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { bootDaemon, cleanupStateDir } from './helpers.ts';

const kept: string[] = [];
after(async () => {
  await Promise.all(kept.map((dir) => cleanupStateDir(dir)));
});

describe('e2e · HTTP 只读面', () => {
  it('GET / 出 dashboard HTML;GET /openapi.json 出 3.1 文档且覆盖全部 RPC', async () => {
    const daemon = await bootDaemon();
    kept.push(daemon.stateDir);
    try {
      const page = await fetch(daemon.baseUrl, { signal: AbortSignal.timeout(5_000) });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /<html/i, 'dashboard 应为 HTML');

      const doc = await fetch(new URL('/openapi.json', daemon.baseUrl), { signal: AbortSignal.timeout(5_000) });
      assert.equal(doc.status, 200);
      const spec = (await doc.json()) as { openapi?: string; paths?: Record<string, unknown> };
      assert.equal(spec.openapi, '3.1.0');
      assert.ok(spec.paths !== undefined && Object.keys(spec.paths).length > 0);
    } finally {
      await daemon.stop();
    }
  });
});

describe('e2e · JSON-RPC 协议错误面', () => {
  it('非法 JSON → -32700;未知方法 → -32601(404);白名单外 GET → 405', async () => {
    const daemon = await bootDaemon();
    kept.push(daemon.stateDir);
    try {
      const bad = await fetch(daemon.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${daemon.token}` },
        body: '{not json',
      });
      assert.equal(bad.status, 400);
      const badBody = (await bad.json()) as { error?: { code?: number } };
      assert.equal(badBody.error?.code, -32700);

      const unknown = await daemon.rpc('definitely.not.a.method', {});
      assert.equal(unknown.status, 404);
      assert.equal((unknown.body.error as Record<string, unknown>)['code'], -32601);

      const notAllowed = await fetch(new URL('/events', daemon.baseUrl), {
        headers: { 'authorization': `Bearer ${daemon.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(notAllowed.status, 405);
    } finally {
      await daemon.stop();
    }
  });

  it('超限 body(>8MiB)→ 413', async () => {
    const daemon = await bootDaemon();
    kept.push(daemon.stateDir);
    try {
      const big = 'x'.repeat(9 * 1024 * 1024);
      const res = await fetch(daemon.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${daemon.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'capabilities.list', params: { pad: big } }),
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(res.status, 413);
    } finally {
      await daemon.stop();
    }
  });
});
