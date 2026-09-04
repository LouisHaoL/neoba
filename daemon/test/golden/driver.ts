/**
 * golden 场景执行器(§9 P0 一致性测试集的参考实现侧)。
 *
 * 场景文件(protocol/scenarios/*.json,结构按 scenario.schema.json)是纯数据:
 *   1. ajv 按 scenario.schema.json 校验场景文档(协议 $id 引用经注册全部
 *      protocol schema 解析,同 protocol/examples/validate.mjs 的做法);
 *   2. setup.capabilities / setup.presets 装载为 daemon 注册表与预设集
 *      (loadCapabilityRegistry / parsePreset 复审一遍,坏场景在装载即炸);
 *   3. steps 按序执行:rpc(真实 HTTP 绑定,Bearer token 按 auth 变体) /
 *      restart(同状态目录重启,token 随重启更换)/ hardline.check(协议层
 *      硬底线纯函数);
 *   4. 断言走 test/golden/matchers.ts:结果部分匹配 + capture/${VAR} 变量 +
 *      事件序列(subsequence / exact,失败产出可读 diff)。
 *
 * 场景失败抛 Error(带场景名 / 步骤名 / diff),由 scenarios.test.ts 逐场景
 * it() 承接。临时状态目录用完即删。
 */
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../../src/daemon/index.ts';
import type { DaemonHandle } from '../../src/daemon/index.ts';
import {
  defaultRegistry,
  hardlineAllowsAuto,
  hardlineVerdict,
  loadCapabilityRegistry,
  parsePreset,
} from '../../src/capability/index.ts';
import type { LoadedRegistry, Preset, Scope } from '../../src/capability/index.ts';
import { DEFAULT_TENANT } from '../../src/daemon/operations.ts';
import type { PrincipalFilter } from '../../src/events/index.ts';
import { collectSubsetMismatches, clip, matchEventSequence, substitute } from './matchers.ts';

/** protocol/ 目录(daemon/test/golden → 仓库根)。 */
export const PROTOCOL_ROOT = join(import.meta.dirname, '../../../protocol');

// ---------------------------------------------------------------- 场景文档

/** 场景步骤/断言的结构(宽松形,权威结构以 scenario.schema.json 为准)。 */
export interface ScenarioDoc {
  readonly scenario: string;
  readonly description: string;
  readonly setup?: {
    readonly capabilities?: unknown;
    readonly presets?: readonly unknown[];
  };
  readonly steps: readonly ScenarioStep[];
  readonly events?: {
    readonly match?: 'subsequence' | 'exact';
    readonly scope?: Record<string, unknown>;
    readonly expect: readonly Record<string, unknown>[];
  };
}

type ScenarioStep = {
  readonly name?: string;
  readonly call: string;
  readonly params?: Record<string, unknown>;
  readonly auth?: 'daemon' | 'none' | 'wrong';
  readonly capture?: Record<string, string>;
  readonly expect?: {
    readonly http?: number;
    readonly error_code?: number;
    readonly result?: unknown;
    readonly error?: unknown;
  };
} | {
  readonly op: 'restart';
  readonly name?: string;
} | {
  readonly op: 'hardline.check';
  readonly name?: string;
  readonly cap: string;
  readonly scope: string;
  readonly expect: {
    readonly registered?: boolean;
    readonly risk_level?: string;
    readonly verdict: string;
    readonly auto_allowed: boolean;
  };
};

let scenarioValidate: import('ajv').ValidateFunction<unknown> | null = null;

/** 注册全部 protocol schema 后取 scenario.schema.json 的校验器(进程内缓存)。 */
async function getScenarioValidator(): Promise<import('ajv').ValidateFunction<unknown>> {
  if (scenarioValidate !== null) return scenarioValidate;
  const require = createRequire(join(import.meta.dirname, '../../package.json'));
  const AjvMod = require('ajv/dist/2020') as { default: new (opts: object) => import('ajv').default };
  const instance = new AjvMod.default({ strict: false, validateFormats: false, allErrors: true });
  const schemaDir = join(PROTOCOL_ROOT, 'schemas');
  for (const name of (await readdir(schemaDir)).sort()) {
    if (!name.endsWith('.schema.json')) continue;
    instance.addSchema(
      JSON.parse(await readFile(join(schemaDir, name), 'utf8')) as object,
    );
  }
  const scenarioSchema = JSON.parse(
    await readFile(join(PROTOCOL_ROOT, 'scenarios', 'scenario.schema.json'), 'utf8'),
  ) as object;
  scenarioValidate = instance.compile(scenarioSchema);
  return scenarioValidate;
}

/** 读场景文件并按 scenario.schema.json 校验;非法即抛(场景文件是冻结物)。 */
export async function loadScenario(path: string): Promise<ScenarioDoc> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const validate = await getScenarioValidator();
  if (!validate(raw)) {
    throw new Error(
      `场景文档未过 scenario.schema.json:${basename(path)}\n  ` +
        clip(String(validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; '))),
    );
  }
  return raw as ScenarioDoc;
}

// ---------------------------------------------------------------- 执行

/**
 * 执行一个场景文件:起 daemon → 跑全部步骤 → 事件序列断言。
 * 任何断言失败抛 Error(消息含场景名/步骤名/diff);成功正常返回。
 */
export async function runScenarioFile(path: string): Promise<void> {
  const scenario = await loadScenario(path);
  const stateDir = await mkdtemp(join(tmpdir(), 'neoba-golden-'));
  try {
    const registry = scenario.setup?.capabilities !== undefined
      ? loadCapabilityRegistry(scenario.setup.capabilities)
      : defaultRegistry();
    const presets = scenario.setup?.presets !== undefined
      ? Object.fromEntries(
          scenario.setup.presets.map((doc) => {
            const preset = parsePreset(doc);
            return [preset.name, preset] as const;
          }),
        )
      : undefined;

    let handle = await startDaemon({ port: 0, stateDir, registry, ...(presets !== undefined ? { presets } : {}) });
    const captures = new Map<string, unknown>();

    try {
      for (let i = 0; i < scenario.steps.length; i++) {
        const step = scenario.steps[i];
        if (step === undefined) continue;
        const label = stepLabel(step, i);
        if ('op' in step) {
          if (step.op === 'restart') {
            await handle.stop();
            handle = await startDaemon({ port: 0, stateDir, registry, ...(presets !== undefined ? { presets } : {}) });
          } else {
            runHardlineCheck(handle, registry, step, `${scenario.scenario} / ${label}`);
          }
          continue;
        }
        await runRpcStep(handle, step, captures, `${scenario.scenario} / ${label}`);
      }
      await assertEvents(handle, scenario, captures);
    } finally {
      await handle.stop().catch(() => {});
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

function stepLabel(step: ScenarioStep, index: number): string {
  if ('op' in step) return `step[${index}] ${step.name ?? step.op}`;
  return `step[${index}] ${step.name ?? step.call}`;
}

// ---------------------------------------------------------------- rpc 步骤

interface RpcResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function callRpc(
  handle: DaemonHandle,
  method: string,
  params: unknown,
  auth: 'daemon' | 'none' | 'wrong',
): Promise<RpcResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth !== 'none') {
    const token = auth === 'wrong' ? `wrong-${handle.token}` : handle.token;
    headers['authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${handle.baseUrl}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function runRpcStep(
  handle: DaemonHandle,
  step: Extract<ScenarioStep, { call: string }>,
  captures: Map<string, unknown>,
  label: string,
): Promise<void> {
  const method = step.call ?? '';
  const params = substitute(step.params ?? {}, captures) as Record<string, unknown>;
  const res = await callRpc(handle, method, params, step.auth ?? 'daemon');

  // capture 先取值:同一步骤的 expect 可能自引用本步捕获值(如
  // agent_id = "${TASK}/worker-01");断言失败即抛,暂存值不外泄。
  const staged = new Map(captures);
  if (step.capture !== undefined) {
    for (const [name, path] of Object.entries(step.capture)) {
      const value = dig(res.body, path);
      if (value === undefined) {
        throw new Error(`场景断言失败:${label}\n  capture ${name}=${path}: 应答体无此路径`);
      }
      staged.set(name, value);
    }
  }

  const expect = step.expect ?? {};
  const problems: string[] = [];

  // HTTP 状态(缺省 200)。
  const wantHttp = expect.http ?? 200;
  if (res.status !== wantHttp) {
    problems.push(`http: 期望 ${wantHttp},实际 ${res.status}`);
  }
  // JSON-RPC error.code(出现即认为应答是 error 形)。
  if (expect.error_code !== undefined) {
    const error = res.body['error'] as Record<string, unknown> | undefined;
    if (!isRecord(error)) {
      problems.push('error_code: 实际应答无 error 对象');
    } else if (error['code'] !== expect.error_code) {
      problems.push(`error.code: 期望 ${expect.error_code},实际 ${JSON.stringify(error['code'])}`);
    }
  } else if (expect.result !== undefined && isRecord(res.body['error'])) {
    problems.push(`result: 实际应答为 error ${clip(JSON.stringify(res.body['error']))}`);
  }
  // result 部分匹配。
  if (expect.result !== undefined) {
    collectSubsetMismatches(substitute(expect.result, staged), res.body['result'], 'result', problems);
  }
  // error.data 部分匹配。
  if (expect.error !== undefined) {
    const error = res.body['error'] as Record<string, unknown> | undefined;
    const data = isRecord(error) ? error['data'] : undefined;
    collectSubsetMismatches(substitute(expect.error, staged), data, 'error.data', problems);
  }
  if (problems.length > 0) {
    throw new Error(
      `场景断言失败:${label}\n  ` +
        problems.map((p) => clip(p)).join('\n  ') +
        `\n  应答体:${clip(JSON.stringify(res.body))}`,
    );
  }
  // 断言全过:暂存捕获值提交为正式变量。
  for (const [name, value] of staged) {
    if (!captures.has(name)) captures.set(name, value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 点分路径取值(数组下标用数字段,如 result.items.0.task_id)。 */
function dig(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const segment of path.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[segment];
  }
  return cur;
}

// ---------------------------------------------------------------- hardline 步骤

function runHardlineCheck(
  handle: DaemonHandle,
  registry: LoadedRegistry,
  step: Extract<ScenarioStep, { op: 'hardline.check' }>,
  label: string,
): void {
  void handle;
  const entry = registry.get(step.cap);
  const registered = entry !== undefined;
  const verdict = hardlineVerdict(entry?.risk_level, step.scope as Scope);
  const autoAllowed = hardlineAllowsAuto(verdict);
  const problems: string[] = [];
  const expect = step.expect;
  if (expect.registered !== undefined && expect.registered !== registered) {
    problems.push(`registered: 期望 ${expect.registered},实际 ${registered}`);
  }
  if (expect.risk_level !== undefined && expect.risk_level !== entry?.risk_level) {
    problems.push(`risk_level: 期望 ${expect.risk_level},实际 ${String(entry?.risk_level)}`);
  }
  if (expect.verdict !== verdict) {
    problems.push(`verdict: 期望 ${expect.verdict},实际 ${verdict}`);
  }
  if (expect.auto_allowed !== autoAllowed) {
    problems.push(`auto_allowed: 期望 ${expect.auto_allowed},实际 ${autoAllowed}`);
  }
  if (problems.length > 0) {
    throw new Error(`场景断言失败:${label}\n  ` + problems.join('\n  '));
  }
}

// ---------------------------------------------------------------- 事件序列断言

async function assertEvents(
  handle: DaemonHandle,
  scenario: ScenarioDoc,
  captures: ReadonlyMap<string, unknown>,
): Promise<void> {
  const events = scenario.events;
  if (events === undefined) return;
  const scope = substitute(events.scope ?? {}, captures) as Record<string, unknown>;
  const filter: PrincipalFilter = {
    tenant: typeof scope['tenant'] === 'string' ? scope['tenant'] : DEFAULT_TENANT,
  };
  for (const layer of ['session', 'task', 'agent'] as const) {
    if (layer in scope) (filter as Record<string, unknown>)[layer] = scope[layer] as string | null;
  }
  if (Array.isArray(scope['types'])) {
    (filter as Record<string, unknown>)['types'] = scope['types'] as string[];
  }

  const actual = await handle.events.readByPrincipal(filter);
  const expected = substitute(events.expect, captures) as unknown as Parameters<
    typeof matchEventSequence
  >[0];
  // Event 与 EventLike 结构兼容,仅缺 index signature,此处收窄一次。
  const result = matchEventSequence(
    expected,
    actual as unknown as Parameters<typeof matchEventSequence>[1],
    events.match ?? 'subsequence',
  );
  if (!result.ok) {
    throw new Error(`场景断言失败:${scenario.scenario} / 事件序列\n${result.report}`);
  }
}
