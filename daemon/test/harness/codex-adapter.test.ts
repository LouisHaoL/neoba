/**
 * 多基座 Adapter 测试(§4 P3):
 * - CodexAdapter:`codex exec --json` 事件流 fixture 驱动 —— thread.started
 *   载体清单、item.completed 分派(agent_message / command_execution /
 *   mcp_tool_call / reasoning)、中间态消化、turn.completed usage 归一、
 *   turn.failed、未知 item → parse_error 不炸流;
 * - OpenCodeAdapter:纯文本行 → message_delta,inventory 恒 null;
 * - createAdapter 工厂:已知基座构造 / 'any' 落位 / 未知抛 AdapterUnknown;
 * - baseCommand 命令表:三基座 argv 形状。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AdapterUnknown,
  ClaudeCodeAdapter,
  CodexAdapter,
  OpenCodeAdapter,
  baseCommand,
  createAdapter,
  argsDigest,
  DEFAULT_BASE,
  resolveBase,
} from '../../src/harness/index.ts';

const NOW = new Date('2026-09-05T08:00:00Z');

type TestEvent = { readonly event: string } & Record<string, unknown>;

function makeCodex() {
  const adapter = new CodexAdapter({ now: () => NOW, agent: 'task-7/coder-01' });
  const feed = (lines: string[]): TestEvent[] =>
    lines.flatMap((line) => adapter.translate(line) as unknown as TestEvent[]);
  return { adapter, feed };
}

// ---------------------------------------------------------------- fixtures(codex exec --json 事件流)

const L_THREAD = '{"type":"thread.started","thread_id":"0199abcd-ef01"}';
const L_TURN_STARTED = '{"type":"turn.started"}';
const L_ITEM_STARTED_REASONING =
  '{"type":"item.started","item":{"id":"item_0","type":"reasoning","text":"思考中"}}';
const L_ITEM_UPDATED_CMD =
  '{"type":"item.updated","item":{"id":"item_1","type":"command_execution","command":"ls","status":"in_progress"}}';
const L_ITEM_DONE_REASONING =
  '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"先看目录"}}';
const L_ITEM_DONE_MESSAGE =
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"答案是 2。"}}';
const L_ITEM_DONE_COMMAND =
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls -la","aggregated_output":"total 0","exit_code":0,"status":"completed"}}';
const L_ITEM_DONE_MCP =
  '{"type":"item.completed","item":{"id":"item_3","type":"mcp_tool_call","tool":"browser_snapshot","arguments":{"url":"https://example.com"}}}';
const L_ITEM_DONE_GHOST =
  '{"type":"item.completed","item":{"id":"item_4","type":"file_change","changes":[]}}';
const L_TURN_COMPLETED =
  '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":64,"output_tokens":30}}';
const L_TURN_FAILED = '{"type":"turn.failed","error":{"message":"model overloaded"}}';

describe('harness/CodexAdapter', () => {
  it('thread.started → tool_inventory 载体(sessionId=thread_id,不伪造清单)', () => {
    const { adapter, feed } = makeCodex();
    assert.equal(adapter.getInventory(), null);
    const events = feed([L_THREAD]);
    assert.equal(events.length, 1);
    const inv = events[0]!;
    assert.equal(inv['event'], 'tool_inventory');
    assert.deepEqual(inv['tools'], []);
    assert.deepEqual(inv['mcp_servers'], []);
    assert.equal(inv['permission_mode'], null);
    assert.equal(inv['model'], null);
    assert.equal(inv['session_id'], '0199abcd-ef01');
    assert.equal(adapter.getInventory()?.sessionId, '0199abcd-ef01');
  });

  it('item.started/updated 中间态与 reasoning 消化,不外发事件', () => {
    const { feed } = makeCodex();
    assert.deepEqual(feed([L_TURN_STARTED, L_ITEM_STARTED_REASONING, L_ITEM_UPDATED_CMD]), []);
    assert.deepEqual(feed([L_ITEM_DONE_REASONING]), []);
  });

  it('agent_message → message_delta;command_execution/mcp_tool_call → tool_call(摘要入账)', () => {
    const { feed } = makeCodex();
    feed([L_THREAD]);
    const [msg] = feed([L_ITEM_DONE_MESSAGE]);
    assert.equal(msg?.['event'], 'message_delta');
    assert.equal(msg?.['text'], '答案是 2。');
    assert.equal(msg?.['agent'], 'task-7/coder-01');

    const [cmd] = feed([L_ITEM_DONE_COMMAND]);
    assert.equal(cmd?.['event'], 'tool_call');
    assert.equal(cmd?.['tool'], 'command_execution');
    assert.equal(cmd?.['args_digest'], argsDigest({ command: 'ls -la' }));
    assert.equal(cmd?.['tool_use_id'], 'item_1');

    const [mcp] = feed([L_ITEM_DONE_MCP]);
    assert.equal(mcp?.['event'], 'tool_call');
    assert.equal(mcp?.['tool'], 'browser_snapshot');
    assert.equal(mcp?.['args_digest'], argsDigest({ url: 'https://example.com' }));
    assert.equal(mcp?.['tool_use_id'], 'item_3');
  });

  it('未知 item 类型 → parse_error 不炸流;后续行照常翻译', () => {
    const { feed } = makeCodex();
    const events = feed([L_ITEM_DONE_GHOST, L_ITEM_DONE_MESSAGE]);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.['event'], 'parse_error');
    assert.match(String(events[0]?.['detail']), /file_change/);
    assert.match(String(events[0]?.['raw_digest']), /^[0-9a-f]{64}$/);
    assert.equal(events[1]?.['event'], 'message_delta');
  });

  it('turn.completed → usage(cost 显式 null,cached 进 extra);turn.failed → error', () => {
    const { feed } = makeCodex();
    const [usage] = feed([L_TURN_COMPLETED]);
    assert.equal(usage?.['event'], 'usage');
    assert.equal(usage?.['tokens_in'], 120);
    assert.equal(usage?.['tokens_out'], 30);
    assert.equal(usage?.['cost_estimate'], null);
    assert.deepEqual(usage?.['extra'], { cached_input_tokens: 64 });

    const [err] = feed([L_TURN_FAILED]);
    assert.equal(err?.['event'], 'error');
    assert.equal(err?.['kind'], 'turn_failed');
    assert.equal(err?.['detail'], 'model overloaded');
  });

  it('坏行 parse_error(带原文摘要);未知顶层 type 忽略;空行静默', () => {
    const { feed } = makeCodex();
    const events = feed(['not-json{', '{"type":"shutdown_complete"}', '   ', L_THREAD]);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.['event'], 'parse_error');
    assert.match(String(events[0]?.['detail']), /不是合法 JSON/);
    assert.equal(events[1]?.['event'], 'tool_inventory');
  });
});

describe('harness/OpenCodeAdapter', () => {
  it('纯文本行 → message_delta;空行静默;inventory 恒 null', () => {
    const adapter = new OpenCodeAdapter({ now: () => NOW, agent: 'task-8/oc-01' });
    const events = adapter.translate('  已完成实现。  ') as unknown as TestEvent[];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.['event'], 'message_delta');
    assert.equal(events[0]?.['text'], '已完成实现。');
    assert.equal(events[0]?.['agent'], 'task-8/oc-01');
    assert.deepEqual(adapter.translate(''), []);
    assert.equal(adapter.getInventory(), null);
  });
});

describe('harness/createAdapter 工厂 + baseCommand 命令表', () => {
  it('已知基座构造,base 字段落位(claude-code adapter 复用)', () => {
    assert.equal(createAdapter('claude-code').base, 'claude-code');
    assert.ok(createAdapter('claude-code') instanceof ClaudeCodeAdapter);
    assert.equal(createAdapter('codex').base, 'codex');
    assert.ok(createAdapter('codex') instanceof CodexAdapter);
    assert.equal(createAdapter('opencode').base, 'opencode');
    assert.ok(createAdapter('opencode') instanceof OpenCodeAdapter);
  });

  it("'any' 落位 defaultBase(缺省 claude-code);resolveBase 同步", () => {
    assert.equal(createAdapter('any').base, 'claude-code');
    assert.equal(createAdapter('any', { defaultBase: 'codex' }).base, 'codex');
    assert.equal(resolveBase('any', 'opencode'), 'opencode');
    assert.equal(resolveBase('codex'), 'codex');
    assert.equal(DEFAULT_BASE, 'claude-code');
  });

  it('未知基座抛 AdapterUnknown(不静默降级)', () => {
    assert.throws(() => createAdapter('mystery' as never), (err: unknown) => {
      assert.ok(err instanceof AdapterUnknown);
      assert.equal(err.base, 'mystery');
      assert.match(err.message, /未知基座/);
      return true;
    });
  });

  it('baseCommand:三基座 argv 形状(无 bypass 标志)', () => {
    assert.deepEqual(baseCommand('claude-code', { instruction: 'hi' }), [
      'claude', '-p', 'hi', '--output-format', 'stream-json',
    ]);
    assert.deepEqual(baseCommand('codex', { instruction: 'hi' }), [
      'codex', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', 'hi',
    ]);
    assert.deepEqual(baseCommand('opencode', { instruction: 'hi' }), ['opencode', 'run', 'hi']);
    // 命令表自身不引入 bypass 标志(§4.4:生成后仍有校验兜底)。
    for (const base of ['claude-code', 'codex', 'opencode'] as const) {
      for (const arg of baseCommand(base, { instruction: 'x' })) {
        assert.doesNotMatch(arg.toLowerCase(), /dangerously|yolo/);
      }
    }
  });
});
