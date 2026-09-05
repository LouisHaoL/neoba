/**
 * NodeExecutor(§3.5 单节点执行;§9 P1 执行链闭环、P2 接入引擎):
 *
 *   node.started → 供给沙箱 → secret 注入 → 基线授予 → 跑 NodeRuntime →
 *   usage 记账(budget)→ 工件发布(CAS 写屏障,sha256 权威哈希)→
 *   node.completed / node.failed → 销毁沙箱
 *
 * 语义要点:
 * - 工件以 runtime 上报的产物为准(真实侧 = sidecar 读文件系统事实,
 *   §3.6/§3.7 唯一事实源);引擎只负责发布,哈希由 CAS 计算并落事件;
 * - 超时(timeoutSec)与外部取消(signal)都经 AbortSignal 通知 runtime
 *   协作终止,节点按 timeout / cancelled 收尾;沙箱在任何路径上都保证销毁;
 * - 预算 hard 触发(budget.record → action=paused)立即终止节点,
 *   reason=budget_paused,升级主控的续预算/终止决策归调用方(§3.5f);
 * - 基线授予按 agent(= task/node)一次;重复(反馈回打后重跑同一节点)
 *   视为已就绪,幂等跳过 —— grant manifest 持久于事件日志(§6 重放重建)。
 */
import { createHash } from 'node:crypto';
import { BaselineAlreadyApplied } from '../capability/index.ts';
import type { GrantExecutor } from '../capability/index.ts';
import type { Preset } from '../capability/types.ts';
import { ArtifactRepository } from '../artifacts/repository.ts';
import type { ArtifactNamespace } from '../artifacts/repository.ts';
import type { BudgetLedger } from '../budget/index.ts';
import type { Principal } from '../events/types.ts';
import type { SandboxPool } from '../provision/warm-pool.ts';
import type { NetworkPolicy, SandboxHandle, SandboxProvider } from '../provision/types.ts';
import { GateAborted } from './gate.ts';
import type {
  EngineEmit,
  NodeExecutionResult,
  NodeRunContext,
  NodeRuntime,
  PublishedOutput,
  RuntimeResult,
} from './types.ts';

/** secret 注入口(§3.8:值只在 resolve 时出接口,manifest/export 永不含明文)。 */
export interface SecretInjector {
  resolve(tenant: string, secretId: string): Promise<{ readonly name: string; readonly value: string }>;
}

export interface NodeExecutorDeps {
  readonly provider: SandboxProvider;
  /**
   * 预热池(M7,§9 P4;可选):给出时沙箱的取用/归还走池
   * (命中回热 / 冷拉;健康回池 / 否则销毁),provider 保留给
   * runtime 与对账路径。池与 ResourceGate 的协作语义见 provision/warm-pool.ts。
   */
  readonly pool?: SandboxPool;
  readonly runtime: NodeRuntime;
  readonly artifacts: ArtifactRepository;
  readonly grants: GrantExecutor;
  /** 事件出口(daemon 接 EventLog.append;测试接数组)。 */
  readonly emit: EngineEmit;
  readonly now?: () => Date;
  /** 基座镜像(缺省 neoba 参考镜像;memory 后端忽略)。 */
  readonly image?: string;
  /** 网络策略(缺省 none,最严,§5)。 */
  readonly network?: NetworkPolicy;
  readonly secrets?: SecretInjector;
  /** secret 注入的环境变量前缀(缺省 NEBOBA_SECRET_)。 */
  readonly secretEnvPrefix?: string;
}

export interface ExecuteNodeParams {
  readonly tenant: string;
  readonly session: string | null;
  readonly taskId: string;
  readonly nodeId: string;
  readonly preset: Preset;
  readonly instruction: string;
  readonly attempt: number;
  readonly inputArtifacts: readonly {
    readonly from: string;
    readonly name: string;
    readonly sha256: string;
  }[];
  /** 节点级超时,秒(缺省不限)。 */
  readonly timeoutSec?: number;
  readonly secretIds?: readonly string[];
  readonly budget?: BudgetLedger | null;
  /** 外部取消信号(引擎 gate.signal)。 */
  readonly signal?: AbortSignal;
}

/** 内部超时标志错误(race 用,不外抛)。 */
class TimeoutSignal extends Error {}

export class NodeExecutor {
  readonly #deps: NodeExecutorDeps;

  constructor(deps: NodeExecutorDeps) {
    this.#deps = deps;
  }

  async execute(params: ExecuteNodeParams): Promise<NodeExecutionResult> {
    const { tenant, session, taskId, nodeId, preset, attempt } = params;
    const agentId = `${taskId}/${nodeId}`;
    const principal: Principal = { tenant, session, task: taskId, agent: agentId };
    const emit = this.#deps.emit;

    await emit({
      type: 'node.started',
      principal,
      payload: { nodeId, attempt },
    });

    // 基线授予:manifest 按事件日志重建(§6),重复 apply = 已就绪,幂等跳过。
    try {
      await this.#deps.grants.applyBaseline(agentId, preset);
    } catch (err) {
      if (!(err instanceof BaselineAlreadyApplied)) throw err;
    }

    // secret 注入:值只在此处出接口并进容器 env(§3.8)。
    const env: Record<string, string> = {};
    const prefix = this.#deps.secretEnvPrefix ?? 'NEBOBA_SECRET_';
    for (const [index, secretId] of (params.secretIds ?? []).entries()) {
      if (this.#deps.secrets === undefined) {
        throw new Error(`节点 ${nodeId} 声明了 secret ${secretId} 但未配置 SecretStore`);
      }
      const injected = await this.#deps.secrets.resolve(tenant, secretId);
      env[`${prefix}${sanitizedEnvName(injected.name, index)}`] = injected.value;
    }

    // 沙箱取用:M7 起 pool 可选 —— 有池走池(命中回热 / 池空冷拉;池在
    // ResourceGate 之内,gate 语义由池承担),无池保持直连 provider(零漂移)。
    const acquired = this.#deps.pool !== undefined
      ? await this.#deps.pool.acquire({
          image: this.#deps.image ?? 'neoba/sandbox:latest',
          workdir: '/workspace',
          mounts: [
            { kind: 'workdir', source: `neoba-${taskId}-${nodeId}`, target: '/workspace', mode: 'rw' },
          ],
          env,
          ...(this.#deps.network !== undefined ? { network: this.#deps.network } : {}),
          labels: {
            'neoba.task': taskId,
            'neoba.node': nodeId,
            'neoba.attempt': String(attempt),
          },
        })
      : {
          handle: await this.#deps.provider.create({
            image: this.#deps.image ?? 'neoba/sandbox:latest',
            workdir: '/workspace',
            mounts: [
              { kind: 'workdir', source: `neoba-${taskId}-${nodeId}`, target: '/workspace', mode: 'rw' },
            ],
            env,
            ...(this.#deps.network !== undefined ? { network: this.#deps.network } : {}),
            labels: {
              'neoba.task': taskId,
              'neoba.node': nodeId,
              'neoba.attempt': String(attempt),
            },
          }),
          fromPool: false,
        };
    const handle = acquired.handle;
    if (!acquired.fromPool) {
      // 冷拉才落 sandbox.created;池命中 = 实例早已存在,审计由池的
      // sandbox.acquired(复用事件,pool/hit 字段纯增量)承担,不虚报创建。
      await emit({
        type: 'sandbox.created',
        principal,
        payload: { sandboxId: handle.id, backend: this.#deps.provider.backend },
      });
    }

    // 取消链:外部 signal + 超时 → 统一 controller;runtime 经 ctx.signal 协作终止。
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (params.signal?.aborted) controller.abort();
    params.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let outcome: NodeExecutionResult | null = null;
    // #settle 内部对失败路径自行落 node.failed;race 捕获路径(timeout/
    // cancelled/crash)由 execute 统一补落,避免任务状态机丢事件。
    let terminalEventEmitted = false;

    try {
      const runPromise = this.#deps.runtime.run(this.#runContext(params, agentId, handle, controller.signal));
      const abortPromise = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(new GateAborted());
          return;
        }
        controller.signal.addEventListener('abort', () => reject(new GateAborted()), { once: true });
      });
      const timeoutSec = params.timeoutSec;
      const timeoutPromise = timeoutSec === undefined
        ? null
        : new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new TimeoutSignal());
            }, timeoutSec * 1000);
          });

      let result: RuntimeResult | undefined;
      try {
        const racers: Promise<RuntimeResult | never>[] = [runPromise, abortPromise];
        if (timeoutPromise !== null) racers.push(timeoutPromise);
        result = await Promise.race(racers);
      } catch (err) {
        if (timedOut) {
          outcome = {
            status: 'failed',
            reason: 'timeout',
            detail: `节点超时(${params.timeoutSec}s)`,
          };
        } else if (controller.signal.aborted || err instanceof GateAborted) {
          // 外部取消:无论 runtime 自身拒绝还是 abortPromise 先到,都按 cancelled。
          outcome = { status: 'failed', reason: 'cancelled', detail: '执行被取消' };
        } else {
          outcome = {
            status: 'failed',
            reason: 'crash',
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      }

      if (result !== undefined) {
        outcome = await this.#settle(params, principal, result);
        terminalEventEmitted = true;
      }
    } catch (err) {
      outcome = {
        status: 'failed',
        reason: 'crash',
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (timer !== null) clearTimeout(timer);
      params.signal?.removeEventListener('abort', onExternalAbort);
    }
    if (outcome === null) {
      outcome = { status: 'failed', reason: 'crash', detail: '未知执行错误' };
    }
    if (outcome.status === 'failed' && !terminalEventEmitted) {
      await emit({
        type: 'node.failed',
        principal,
        payload: {
          nodeId,
          attempt,
          reason: outcome.reason,
          ...(outcome.detail !== null ? { detail: outcome.detail } : {}),
        },
      });
    }

    // 终局:completed → completed;timeout/cancelled → manual;其余 → failed。
    const destroyReason = outcome.status === 'completed'
      ? 'completed'
      : outcome.reason === 'timeout' || outcome.reason === 'cancelled'
        ? 'manual'
        : 'failed';
    if (this.#deps.pool !== undefined) {
      // 有池:健康(completed)回池固化,不健康销毁;pooled 时不落
      // sandbox.destroyed(实例仍在池内服役,审计由池的 sandbox.released 承担)。
      const verdict = await this.#deps.pool.release(handle, {
        healthy: outcome.status === 'completed',
      });
      if (verdict !== 'pooled') {
        await emit({
          type: 'sandbox.destroyed',
          principal,
          payload: { sandboxId: handle.id, reason: destroyReason },
        });
      }
    } else {
      await this.#deps.provider.destroy(handle);
      await emit({
        type: 'sandbox.destroyed',
        principal,
        payload: { sandboxId: handle.id, reason: destroyReason },
      });
    }
    return outcome;
  }

  /** 成功路径收尾:usage 记账 → 产物发布 → node.completed。失败即短路。 */
  async #settle(
    params: ExecuteNodeParams,
    principal: Principal,
    result: RuntimeResult,
  ): Promise<NodeExecutionResult> {
    const { nodeId, attempt } = params;
    const budget = params.budget;

    // §3.6 usage 事实 → 预算台账(§3.5f);hard 触发立即熔断pause。
    for (const event of result.events) {
      if (event.event !== 'usage' || budget === undefined || budget === null) continue;
      const verdict = await budget.record(event.tokens_in, event.tokens_out);
      if (verdict.action === 'paused') {
        await this.#deps.emit({
          type: 'node.failed',
          principal,
          payload: {
            nodeId,
            attempt,
            reason: 'budget_paused',
            detail: `预算 hard 触发(observed ${verdict.observedTokens} ≥ limit ${budget.limitTokens}),节点暂停待主控处置`,
          },
        });
        return { status: 'failed', reason: 'budget_paused', detail: 'budget hard limit' };
      }
    }

    if (result.exitCode !== 0) {
      await this.#deps.emit({
        type: 'node.failed',
        principal,
        payload: { nodeId, attempt, reason: 'crash', detail: `exit ${result.exitCode}` },
      });
      return { status: 'failed', reason: 'crash', detail: `exit ${result.exitCode}` };
    }

    // 产物发布(§3.7 写屏障):以 preset.io_contracts.outputs 为契约逐端口核对,
    // 缺口 = 失败(output_missing);哈希由 CAS 计算,工件事件为权威记录。
    const outputs: PublishedOutput[] = [];
    for (const port of params.preset.io_contracts.outputs) {
      const artifact = result.artifacts.find((a) => a.name === port.name);
      if (artifact === undefined) {
        await this.#deps.emit({
          type: 'node.failed',
          principal,
          payload: {
            nodeId,
            attempt,
            reason: 'output_missing',
            detail: `契约产物缺失: ${port.name}`,
          },
        });
        return { status: 'failed', reason: 'output_missing', detail: `产物 ${port.name} 缺失` };
      }
      const ns: ArtifactNamespace = { tenant: params.tenant, task: params.taskId };
      const published = await this.#deps.artifacts.publish(ns, nodeId, port.name, artifact.payload);
      outputs.push({ name: port.name, sha256: published.rootSha256 });
      await this.#deps.emit({
        type: 'artifact.published',
        principal,
        payload: {
          node: nodeId,
          name: port.name,
          sha256: published.rootSha256,
          size: published.size,
          kind: 'file',
        },
      });
    }

    await this.#deps.emit({
      type: 'node.completed',
      principal,
      payload: { nodeId, attempt, outputs },
    });
    return { status: 'completed', outputs };
  }

  #runContext(
    params: ExecuteNodeParams,
    agentId: string,
    handle: SandboxHandle,
    signal: AbortSignal,
  ): NodeRunContext {
    return {
      agentId,
      nodeId: params.nodeId,
      attempt: params.attempt,
      preset: params.preset,
      instruction: params.instruction,
      inputArtifacts: params.inputArtifacts,
      handle,
      signal,
    };
  }
}

/** 环境变量名净化:secret id 可能含 scheme 分隔符,替换为下划线。 */
function sanitizedEnvName(secretId: string, index: number): string {
  const name = secretId.replace(/[^A-Za-z0-9_]/g, '_');
  return name.length > 0 ? name : String(index);
}

/** 指令摘要(sandbox.execed 的 argsDigest,不回传全量参数)。 */
export function argsDigest(instruction: string): string {
  return createHash('sha256').update(instruction, 'utf8').digest('hex').slice(0, 16);
}
