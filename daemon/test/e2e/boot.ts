/**
 * e2e 引导子进程:以真实进程边界拉起 daemon(§6),但沙箱供给仍用
 * MemoryProvider + 可注入 execHandler —— 子进程级 e2e 需要确定性的假基座
 * 行为(stream-json 输出 / 产物 cat / 失败注入),而 CLI 壳不暴露这条注入缝,
 * 所以执行链用例走本引导(`neoba start` 真壳路径由 lifecycle 用例单独覆盖)。
 *
 * env 契约:
 *   NEOBA_E2E_STATE_DIR   必填,状态目录(测试侧 mkdtemp)。
 *   NEOBA_E2E_EXEC        假基座行为:echo(缺省,exit 0 无输出)/
 *                         stream(claude-code stream-json 全套 + 产物 cat)/
 *                         fail(基座命令 exit 1)。
 *   NEOBA_E2E_PRESETS     可选,preset 文档 JSON 数组文件路径。
 *   NEOBA_E2E_EXEC_BASE   stream 档假基座输出的产物内容(缺省 '# fake code\n')。
 *
 * 就绪后向 stdout 打一行 `NEOBA_E2E_READY {json}`(测试侧等这行),随后
 * 常驻;收 SIGTERM/SIGINT 优雅关闭(Windows 下信号不可达,测试用 stdin 的
 * `{"op":"stop"}` 行触发同一条 stop() 路径)。
 */
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { startDaemon } from '../../src/daemon/index.ts';
import { MemoryProvider } from '../../src/provision/index.ts';
import type { MemoryExecHandler } from '../../src/provision/index.ts';
import type { Preset } from '../../src/capability/index.ts';
import { parsePreset } from '../../src/capability/index.ts';
import type { ExecResult } from '../../src/provision/index.ts';

const STATE_DIR = process.env['NEOBA_E2E_STATE_DIR'];
if (STATE_DIR === undefined || STATE_DIR === '') {
  console.error('[neoba-e2e-boot] 缺 NEOBA_E2E_STATE_DIR');
  process.exit(2);
}
const EXEC_PROFILE = process.env['NEOBA_E2E_EXEC'] ?? 'echo';
const FAKE_ARTIFACT = process.env['NEOBA_E2E_EXEC_BASE'] ?? '# fake code from e2e base\n';

// stream 档:claude-code stream-json 典型行(init → assistant 文本 → result),
// 与 test/harness/claude-code-adapter.test.ts 的 fixture 同形。
const STREAM_LINES = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'e2e-fake-sess',
    tools: ['Read', 'Write', 'Edit', 'Bash'],
    mcp_servers: [{ name: 'playwright', status: 'connected' }],
    permissionMode: 'default',
    model: 'e2e-fake-model',
    cwd: '/workspace',
  }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model: 'e2e-fake-model', content: [{ type: 'text', text: 'e2e 假基座干活中。' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0.002,
    num_turns: 1,
    duration_ms: 12,
    permission_denials: [],
  }),
];

function makeExecHandler(): MemoryExecHandler {
  const baseCmd = (cmd: string[]): boolean => {
    const head = cmd[0] ?? '';
    return head === 'claude' || head === 'codex' || head === 'opencode';
  };
  return (_handle, cmd): ExecResult => {
    if (baseCmd(cmd)) {
      if (EXEC_PROFILE === 'fail') return { exitCode: 1, stdout: '', stderr: 'e2e: 基座故意失败' };
      if (EXEC_PROFILE === 'stream' || EXEC_PROFILE === 'slow') {
        if (EXEC_PROFILE === 'slow') {
          // 挂住一小段:给 pause/kill 等竞态用例留确定性窗口。
          const end = Date.now() + 800;
          while (Date.now() < end) { /* 忙等:子进程内可接受 */ }
        }
        return { exitCode: 0, stdout: STREAM_LINES.join('\n'), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    // 产物读回:ExecRuntime 对 io_contracts.outputs 逐端口 cat。
    if ((cmd[0] ?? '') === 'cat') {
      if (EXEC_PROFILE === 'fail') return { exitCode: 1, stdout: '', stderr: 'no artifact' };
      return { exitCode: 0, stdout: FAKE_ARTIFACT, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

async function loadPresets(): Promise<Record<string, Preset> | undefined> {
  const path = process.env['NEOBA_E2E_PRESETS'];
  if (path === undefined || path === '') return undefined;
  const docs = JSON.parse(await readFile(path, 'utf8')) as unknown[];
  return Object.fromEntries(
    docs.map((doc) => {
      const preset = parsePreset(doc);
      return [preset.name, preset] as const;
    }),
  );
}

const heartbeat = Number.parseInt(process.env['NEOBA_E2E_SSE_MS'] ?? '', 10);
const gcMs = Number.parseInt(process.env['NEOBA_E2E_GC_MS'] ?? '', 10);
const reclaimMs = Number.parseInt(process.env['NEOBA_E2E_RECLAIM_MS'] ?? '', 10);

const handle = await startDaemon({
  stateDir: STATE_DIR,
  port: 0,
  provider: new MemoryProvider({ execHandler: makeExecHandler() }),
  ...(await loadPresets().then((p) => (p !== undefined ? { presets: p } : {}))),
  ...(Number.isFinite(heartbeat) ? { sseHeartbeatMs: heartbeat } : {}),
  ...(Number.isFinite(gcMs) ? { gcIntervalMs: gcMs } : {}),
  ...(Number.isFinite(reclaimMs) ? { reclaimIntervalMs: reclaimMs } : {}),
});

// 就绪信号:单行 JSON,测试侧按前缀解析(其余 daemon 输出可能是日志)。
process.stdout.write(
  `NEOBA_E2E_READY ${JSON.stringify({
    baseUrl: handle.baseUrl,
    stateDir: handle.stateDir,
    token: handle.token,
    pid: process.pid,
  })}\n`,
);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await handle.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

// 跨平台进程内停机通道(Windows 信号不可达):stdin 收 `{"op":"stop"}` 行。
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  try {
    const msg = JSON.parse(line) as { op?: string };
    if (msg.op === 'stop') void shutdown();
  } catch {
    // 非 JSON 行忽略(测试侧不会发)。
  }
});
