/**
 * CLI 参数解析与命令路由的纯函数测试(§3.10)。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CliUsageError, flagBool, flagInt, flagString, parseArgs, routeCommand } from '../../src/cli/args.ts';

describe('cli args: parseArgs', () => {
  it('布尔开关与位置参数', () => {
    const r = parseArgs(['--yes', '--json', 'x']);
    assert.equal(r.flags['yes'], true);
    assert.equal(r.flags['json'], true);
    assert.deepEqual(r.positionals, ['x']);
  });

  it('--flag value 与 --flag=value 两种写法等价', () => {
    const a = parseArgs(['--state-dir', '/tmp/a', '--port=7917'], ['state-dir', 'port']);
    const b = parseArgs(['--state-dir=/tmp/a', '--port', '7917'], ['state-dir', 'port']);
    assert.equal(flagString(a.flags, 'state-dir'), '/tmp/a');
    assert.equal(flagString(a.flags, 'port'), '7917');
    assert.deepEqual(a.flags, b.flags);
  });

  it('未声明为值型的 --x 视为布尔;声明了但值缺失报用法错误', () => {
    const r = parseArgs(['--json'], ['state-dir']);
    assert.equal(r.flags['json'], true);
    assert.throws(() => parseArgs(['--state-dir'], ['state-dir']), CliUsageError);
  });

  it('-- 终止符之后全部算位置参数', () => {
    const r = parseArgs(['--yes', '--', '--not-a-flag', 'x']);
    assert.equal(r.flags['yes'], true);
    assert.deepEqual(r.positionals, ['--not-a-flag', 'x']);
  });

  it('重复选项后者覆盖前者', () => {
    const r = parseArgs(['--port', '1', '--port', '2'], ['port']);
    assert.equal(flagString(r.flags, 'port'), '2');
  });

  it('flagInt:合法端口通过,非法值报用法错误', () => {
    const ok = parseArgs(['--port', '0'], ['port']);
    assert.equal(flagInt(ok.flags, 'port'), 0);
    const bad = parseArgs(['--port', 'abc'], ['port']);
    assert.throws(() => flagInt(bad.flags, 'port'), CliUsageError);
    const bool = parseArgs(['--port']);
    assert.throws(() => flagInt(bool.flags, 'port'), CliUsageError);
    assert.equal(flagInt(parseArgs([]).flags, 'port'), undefined);
  });

  it('flagBool', () => {
    const r = parseArgs(['--write']);
    assert.equal(flagBool(r.flags, 'write'), true);
    assert.equal(flagBool(r.flags, 'nope'), false);
  });
});

describe('cli args: allowedFlags 白名单(issue #28)', () => {
  it('白名单外的 --flag 报用法错误,并列出该命令合法选项', () => {
    assert.throws(
      () => parseArgs(['--registryy', 'x'], ['registry'], ['registry', 'port']),
      (err: unknown) => {
        assert.ok(err instanceof CliUsageError);
        assert.match((err as Error).message, /未知选项 --registryy/);
        assert.match((err as Error).message, /--port, --registry/);
        return true;
      },
    );
  });

  it('--flag=value 形态的未知 flag 同样报错;合法值型 flag 不受影响', () => {
    assert.throws(() => parseArgs(['--registryy=x'], [], ['registry']), CliUsageError);
    const ok = parseArgs(['--registry', 'x'], ['registry'], ['registry']);
    assert.equal(flagString(ok.flags, 'registry'), 'x');
  });

  it('位置参数不被误判为未知 flag', () => {
    const r = parseArgs(['t1', 'status', '--json'], ['state-dir'], ['state-dir', 'json']);
    assert.deepEqual(r.positionals, ['t1', 'status']);
    assert.equal(r.flags['json'], true);
  });

  it('-- 终止符之后的 token 即使形如未知 flag 也不报错(算位置参数)', () => {
    const r = parseArgs(['--', '--registryy', 'x'], [], ['registry']);
    assert.deepEqual(r.positionals, ['--registryy', 'x']);
  });
});

describe('cli args: routeCommand', () => {
  it('首个非选项 token 是命令名,其余透传', () => {
    assert.deepEqual(routeCommand(['doctor', '--json']), { name: 'doctor', args: ['--json'] });
    assert.deepEqual(routeCommand(['prune', '--state-dir', '/x', '--yes']), {
      name: 'prune',
      args: ['--state-dir', '/x', '--yes'],
    });
  });

  it('空 argv 或以选项开头返回 null(交 runCli 处理全局参数)', () => {
    assert.equal(routeCommand([]), null);
    assert.equal(routeCommand(['--help']), null);
    assert.equal(routeCommand(['--version']), null);
    assert.equal(routeCommand(['-h']), null);
  });
});
