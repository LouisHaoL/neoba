/**
 * #16 回归测试:POST body 读取中途客户端断开(带 Content-Length 但不发满
 * body,随后 destroy socket),readBody 的 for-await 抛出 —— 修复前形成
 * unhandled rejection(Node ≥15 默认直接击穿进程);修复后由 startHttpBinding
 * 的顶层 catch 归一消化。断言:daemon 进程不崩溃,同一连接端口上后续正常
 * 请求仍能响应。
 */
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { after, describe, it } from 'node:test';
import { startHttpBinding, stopHttpBinding } from '../../src/daemon/index.ts';
import type { Server } from 'node:http';

describe('http 顶层异常兜底(#16)', () => {
  it('POST body 中途断开不击穿进程,后续请求仍正常响应', async () => {
    const server: Server = await startHttpBinding({
      port: 0,
      token: 'test-token',
      handler: async (method, params) => ({ echo: method, params }),
    });
    after(async () => {
      await stopHttpBinding(server);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    const { port } = address;

    // 模拟客户端:声明 Content-Length=64 的 POST,只发一小段 body 就中途
    // 强制复位连接(resetAndDestroy 发 RST,触发服务端 req emit 'error';
    // 修复前此处 unhandled rejection → 进程退出)。
    await new Promise<void>((resolve) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(
          'POST / HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Authorization: Bearer test-token\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 64\r\n\r\n' +
          '{"jsonrpc":"2.0"',
        );
        // 确保服务端已读到半截 body 再复位:稍等一拍后发 RST。
        setTimeout(() => {
          const abrupt = sock as typeof sock & { resetAndDestroy?: () => void };
          if (typeof abrupt.resetAndDestroy === 'function') abrupt.resetAndDestroy();
          else sock.destroy();
        }, 20);
      });
      sock.on('close', () => resolve());
      sock.on('error', () => resolve());
    });
    // 给服务端一点时间消化断开事件(若修复缺失,进程在此崩溃)。
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 断开后进程必须仍存活:正常 POST 请求继续可用。
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result?: { echo?: string } };
    assert.equal(body.result?.echo, 'ping');
  });
});
