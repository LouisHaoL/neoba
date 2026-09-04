/**
 * Claude Code Adapter 测试(§3.6 事件归一化 + 唯一事实源):
 * fixture 行驱动典型 stream-json 样本(init/assistant/stream_event/result/坏行),
 * 覆盖:权威清单、清单外工具标志、模型自述不产生状态事件、usage/cost 归一、
 * error 映射、parse_error 不炸流、artifact_ready 提示事件。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClaudeCodeAdapter, argsDigest } from '../../src/harness/index.ts';

const NOW = new Date('2026-09-05T08:00:00Z');

/** 测试视图:统一事件按索引访问字段(断言用),避免逐成员收窄。 */
type TestEvent = { readonly event: string } & Record<string, unknown>;

function makeAdapter(opts: ConstructorParameters<typeof ClaudeCodeAdapter>[0] = {}) {
  const received: TestEvent[] = [];
  const adapter = new ClaudeCodeAdapter({ now: () => NOW, agent: 'task-42/e2e-tester-01', ...opts });
  return {
    adapter,
    received,
    feed(lines: string[]): TestEvent[] {
      const events = lines.flatMap((line) => adapter.translate(line) as unknown as TestEvent[]);
      received.push(...events);
      return events;
    },
  };
}

// ---------------------------------------------------------------- fixtures(典型 stream-json 样本)

const L_INIT =
  '{"type":"system","subtype":"init","session_id":"sess-8f3a","tools":["Read","Write","Edit","Bash"],"mcp_servers":[{"name":"playwright","status":"connected"}],"permissionMode":"default","model":"glm-4.7-air","cwd":"/home/worker/work"}';

const L_PARTIAL_DELTA =
  '{"type":"stream_event","session_id":"sess-8f3a","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我先查看目录。"}}}';

/** 模型自述"已完成/已修改":唯一事实源原则下只允许是观测文本。 */
const L_SELF_CLAIM =
  '{"type":"assistant","session_id":"sess-8f3a","message":{"role":"assistant","model":"glm-4.7-air","content":[{"type":"text","text":"我已完成修改,文件已保存。"}]}}';

const L_TOOL_READ =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/home/worker/work/src/a.ts"}}]}}';

const L_TOOL_MCP_LISTED =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"mcp__playwright__screenshot","input":{"b":2,"a":1}}]}}';

const L_TOOL_MCP_GHOST =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_3","name":"mcp__ghost__haunt","input":{}}]}}';

const L_TOOL_UNLISTED_BUILTIN =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_4","name":"WebSearch","input":{"query":"x"}}]}}';

const L_TOOL_RESULT =
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}';

const L_RESULT_COST =
  '{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":120,"output_tokens":45,"cache_read_input_tokens":10},"total_cost_usd":0.013,"num_turns":3,"duration_ms":4200,"permission_denials":[]}';

/** 订阅制 / 自定义网关:无 total_cost_usd。 */
const L_RESULT_NO_COST =
  '{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":10,"output_tokens":5}}';

const L_RESULT_ERROR =
  '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API timeout"}';

const L_ARTIFACT_WRITE =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_5","name":"Write","input":{"file_path":"/home/worker/work/artifacts/report.md","content":"# 报告"}}]}}';

const L_WRITE_OUTSIDE_ARTIFACTS =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_6","name":"Write","input":{"file_path":"/home/worker/work/src/a.ts","content":"x"}}]}}';

// ---------------------------------------------------------------- 权威清单(唯一事实源)

describe('tool_inventory:基座 init 事件是工具清单权威来源(§3.6 v0.2)', () => {
  it('init 行 → tool_inventory 事件,tools/mcp_servers/permission_mode 全量提取', () => {
    const { adapter, feed } = makeAdapter();
    const events = feed([L_INIT]);
    assert.equal(events.length, 1);
    const inv = events[0];
    assert.equal(inv?.event, 'tool_inventory');
    assert.deepEqual(inv?.['tools'], ['Read', 'Write', 'Edit', 'Bash']);
    assert.deepEqual(inv?.['mcp_servers'], ['playwright']);
    assert.equal(inv?.['permission_mode'], 'default');
    assert.equal(inv?.['model'], 'glm-4.7-air');
    assert.equal(inv?.['session_id'], 'sess-8f3a');
    assert.equal(inv?.['ts'], '2026-09-05T08:00:00.000Z');
    assert.equal(inv?.['agent'], 'task-42/e2e-tester-01');
    // 权威清单状态可查
    assert.deepEqual(adapter.getInventory()?.tools, ['Read', 'Write', 'Edit', 'Bash']);
  });

  it('兼容字符串形式的 mcp_servers;非 init 的 system 行不产生事件', () => {
    const { adapter, feed } = makeAdapter();
    feed(['{"type":"system","subtype":"init","mcp_servers":["alpha","beta"]}']);
    assert.deepEqual(adapter.getInventory()?.mcpServers, ['alpha', 'beta']);
    assert.deepEqual(feed(['{"type":"system","subtype":"compact_boundary"}']), []);
  });

  it('清单未建立(未见过 init)时不判清单外(无从对照)', () => {
    const { feed } = makeAdapter();
    const events = feed([L_TOOL_UNLISTED_BUILTIN]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'tool_call');
  });
});

describe('unlisted_tool:清单外工具打标志事件,原 tool_call 不丢弃', () => {
  it('内建清单外工具 → tool_call + unlisted_tool 两条', () => {
    const { feed } = makeAdapter();
    feed([L_INIT]);
    const events = feed([L_TOOL_UNLISTED_BUILTIN]);
    assert.deepEqual(events.map((e) => e.event), ['tool_call', 'unlisted_tool']);
    assert.equal(events[1]?.['tool'], 'WebSearch');
    assert.match(events[1]?.['detail'] as string, /WebSearch/);
  });

  it('MCP 工具按 server 前缀对照:清单内 server 不打标,幻觉 server 打标(spike #1 E4)', () => {
    const { feed } = makeAdapter();
    feed([L_INIT]);
    const listed = feed([L_TOOL_MCP_LISTED]);
    assert.deepEqual(listed.map((e) => e.event), ['tool_call']);
    const ghost = feed([L_TOOL_MCP_GHOST]);
    assert.deepEqual(ghost.map((e) => e.event), ['tool_call', 'unlisted_tool']);
    assert.match(ghost[1]?.['detail'] as string, /ghost/);
  });
});

describe('唯一事实源:模型自述不产生状态事件(spike #1 F3)', () => {
  it('自述文本只产生 message_delta;tool_result 回现行消化不外发', () => {
    const { feed } = makeAdapter();
    feed([L_INIT]);
    const claim = feed([L_SELF_CLAIM]);
    assert.equal(claim.length, 1);
    assert.equal(claim[0]?.event, 'message_delta');
    assert.equal(claim[0]?.['text'], '我已完成修改,文件已保存。');
    assert.deepEqual(feed([L_TOOL_RESULT]), []);
  });

  it('文本增量(stream_event)→ message_delta', () => {
    const { feed } = makeAdapter();
    const events = feed([L_PARTIAL_DELTA]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'message_delta');
    assert.equal(events[0]?.['text'], '我先查看目录。');
  });
});

describe('tool_call 归一', () => {
  it('入参摘要为 canonical JSON 的 sha256,tool_use_id 透传', () => {
    const { feed } = makeAdapter();
    feed([L_INIT]);
    const events = feed([L_TOOL_READ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'tool_call');
    assert.equal(events[0]?.['tool'], 'Read');
    assert.equal(events[0]?.['args_digest'], argsDigest({ file_path: '/home/worker/work/src/a.ts' }));
    assert.equal(events[0]?.['tool_use_id'], 'toolu_1');
  });

  it('入参摘要对键序不敏感(同参同摘要)', () => {
    const { feed } = makeAdapter();
    feed([L_INIT]);
    const events = feed([L_TOOL_MCP_LISTED]);
    assert.equal(events[0]?.['args_digest'], argsDigest({ a: 1, b: 2 }));
  });
});

describe('usage / error 归一(§3.6)', () => {
  it('result:tokens 与 cost 映射;缓存命中与 permission_denials 进 extra', () => {
    const { feed } = makeAdapter();
    const events = feed([L_RESULT_COST]);
    assert.equal(events.length, 1);
    const usage = events[0];
    assert.equal(usage?.event, 'usage');
    assert.equal(usage?.['tokens_in'], 120);
    assert.equal(usage?.['tokens_out'], 45);
    assert.equal(usage?.['cost_estimate'], 0.013);
    assert.deepEqual(usage?.['extra'], { cache_read_input_tokens: 10 });
  });

  it('订阅制无计费信息:cost_estimate 显式 null(省略≠null,键存在)', () => {
    const { feed } = makeAdapter();
    const events = feed([L_RESULT_NO_COST]);
    const usage = events[0];
    assert.equal(usage?.event, 'usage');
    assert.ok('cost_estimate' in (usage as object));
    assert.equal(usage?.['cost_estimate'], null);
    assert.equal(usage?.['extra'], undefined);
  });

  it('result 报错(is_error / error_* subtype)→ error 事件 kind=result_error', () => {
    const { feed } = makeAdapter();
    const events = feed([L_RESULT_ERROR]);
    assert.deepEqual(events.map((e) => e.event), ['usage', 'error']);
    assert.equal(events[1]?.['kind'], 'result_error');
    assert.match(events[1]?.['detail'] as string, /API timeout/);
  });
});

describe('artifact_ready 提示事件(tool_use 事实驱动)', () => {
  it('写入工件目录 → artifact_ready,sha256 显式 null(权威哈希由文件系统回填)', () => {
    const { feed } = makeAdapter({ artifactsRoot: '/home/worker/work/artifacts' });
    feed([L_INIT]);
    const events = feed([L_ARTIFACT_WRITE]);
    assert.deepEqual(events.map((e) => e.event), ['tool_call', 'artifact_ready']);
    assert.equal(events[1]?.['name'], 'report.md');
    assert.equal(events[1]?.['sha256'], null);
    assert.equal(events[1]?.['path'], '/home/worker/work/artifacts/report.md');
  });

  it('写工件目录之外不产生 artifact_ready', () => {
    const { feed } = makeAdapter({ artifactsRoot: '/home/worker/work/artifacts' });
    feed([L_INIT]);
    assert.deepEqual(feed([L_WRITE_OUTSIDE_ARTIFACTS]).map((e) => e.event), ['tool_call']);
  });

  it('未配置 artifactsRoot 时不产生 artifact_ready', () => {
    const { feed } = makeAdapter();
    feed([L_INIT]);
    assert.deepEqual(feed([L_ARTIFACT_WRITE]).map((e) => e.event), ['tool_call']);
  });
});

describe('健壮性:坏行不炸流', () => {
  it('非 JSON 行 → parse_error(带原文摘要,不回显原文),后续行照常翻译', () => {
    const { feed } = makeAdapter();
    const bad = feed(['这不是 JSON {{{']);
    assert.equal(bad.length, 1);
    assert.equal(bad[0]?.event, 'parse_error');
    assert.equal(typeof bad[0]?.['raw_digest'], 'string');
    assert.equal((bad[0]?.['raw_digest'] as string).length, 64);
    assert.doesNotMatch(bad[0]?.['detail'] as string, /这不是 JSON/);
    // 不炸流:init 照常解析
    assert.deepEqual(feed([L_INIT]).map((e) => e.event), ['tool_inventory']);
  });

  it('JSON 非对象行 → parse_error;空行与未知 type 忽略(前向兼容)', () => {
    const { feed } = makeAdapter();
    assert.equal(feed(['[1,2,3]']).length, 1);
    assert.deepEqual(feed(['   ']), []);
    assert.deepEqual(feed(['{"type":"something_new_in_a_future_version"}']), []);
  });

  it('整段典型流(init→delta→自述→tool_use→tool_result→result)端到端', () => {
    const { feed } = makeAdapter({ artifactsRoot: '/home/worker/work/artifacts' });
    const events = feed([
      L_INIT,
      L_PARTIAL_DELTA,
      L_SELF_CLAIM,
      L_TOOL_READ,
      L_TOOL_RESULT,
      L_RESULT_COST,
    ]);
    assert.deepEqual(
      events.map((e) => e.event),
      ['tool_inventory', 'message_delta', 'message_delta', 'tool_call', 'usage'],
    );
  });
});
