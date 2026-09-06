/**
 * WorkflowEngine(§3.5 WorkflowSpec 执行引擎,§9 P2 顺序、P3 并行):
 *
 * - 依赖序推进(输入依赖的拓扑序,同层按文档序,确定性);P3 起
 *   `parallel: true` 的同批就绪节点可并发派发(§3.5 并行语义,上限 =
 *   intent.constraints.max_parallel,经 WorkflowRunParams.maxParallel 传入);
 *   `parallel: false`(缺省)节点独占派发:在飞批次排空后才单独跑 ——
 *   全串行 workflow(无 parallel 字段)的事件序与 P2 逐字节一致;
 * - 并行失败语义(P3 钉死):
 *   - 批内失败 → 在飞节点照常跑到自然完成(确定性排空),再按拓扑序处置;
 *   - budget_paused → 在飞排空后 paused 收尾(不撕裂批次,可重放);
 *   - feedback 回打 → 先排空在飞,再重置 target 及全部下游(在飞结果可能
 *     基于将失效工件,排空是唯一无歧义语义);
 *   - cancel → gate.abort 经 signal 协作终止在飞节点,排空后按 cancelled 收尾;
 * - retry:crash(含 output_missing 契约缺口)按 retry.on 重试;timeout 仅当
 *   preset.idempotent 且 on 含 timeout(§3.5e:超时重试必须幂等,PlanCheck
 *   前置校验,引擎侧防御性再查);重试 = 重派发(attempts 计数在引擎侧);
 * - 有界反馈(§3.5b):feedback 边 {from, to, max_traversals} —— from 节点
 *   失败且重试耗尽时回打 to;traversal 计数超限 = feedback_limit,升级主控;
 * - 预算熔断联动(§3.5f):budget_paused → 任务挂起(paused),续预算后
 *   resume 续跑;
 * - 证据双重校验(§3.5d):evidence.must_exist 核对 CAS 指针存在,
 *   sha256_recorded 再跑 verify 重算哈希(篡改/损坏 = 未完成交付);
 * - 暂停/恢复(cancel/pause/resume)经 EngineGate:派发边界阻塞 + 执行中
 *   节点协作终止(§9 P2 人机入口的状态机执行面)。
 *
 * 引擎不持持久状态:进度都在事件日志(node.* / artifact.published),
 * 挂起态的 RunState 是进程内续跑上下文,daemon 重启后按 §6 由上层重放决策。
 */
import type { Preset } from '../capability/types.ts';
import { ArtifactRepository } from '../artifacts/repository.ts';
import type { ArtifactNamespace } from '../artifacts/repository.ts';
import type { BudgetLedger } from '../budget/index.ts';
import type { WorkflowDoc, WorkflowNodeSpec, IntentDoc } from '../plancheck/types.ts';
import { EngineGate, GateAborted } from './gate.ts';
import { NodeExecutor } from './node-executor.ts';
import type { EngineEmit, NodeExecutionResult, WorkflowOutputRef, WorkflowRunResult } from './types.ts';
import { PresetUnknown, RunDuplicate, RunNotPaused, RunUnknown, WorkflowCycle } from './errors.ts';

export interface WorkflowEngineDeps {
  readonly executor: NodeExecutor;
  readonly artifacts: ArtifactRepository;
  /** 预设集(workflow 节点引用名 → preset)。 */
  readonly presets: Readonly<Record<string, Preset>>;
  /** 事件出口(可选;用于派发边界被取消时补落 node.failed,重放可重建终态)。 */
  readonly emit?: EngineEmit;
}

export interface WorkflowRunParams {
  readonly tenant: string;
  readonly session: string | null;
  readonly taskId: string;
  readonly workflow: WorkflowDoc;
  readonly intent?: IntentDoc;
  /** 任务预算台账(§3.5f;不给 = 无预算约束,与 P1 行为一致)。 */
  readonly budget?: BudgetLedger | null;
  readonly secretIds?: readonly string[];
  /** 编排并行度上限(§3.5:intent.constraints.max_parallel;<1 视为 1)。 */
  readonly maxParallel?: number;
}

/** 单个在飞节点的结算结果;error = executor 抛错(原样上抛,保持 crash 语义)。 */
interface SettledEntry {
  readonly spec: WorkflowNodeSpec;
  readonly result?: NodeExecutionResult;
  readonly error?: unknown;
}

/** 已排除 completed/cancelled/budget_paused 的失败结算(待排空后处置)。 */
type FailedEntry = {
  readonly spec: WorkflowNodeSpec;
  readonly result: Extract<NodeExecutionResult, { readonly status: 'failed' }>;
};

/** 节点结算唤醒信号(条件变量:waitNotify 挂等待者,signalNotify 全部唤醒)。 */
interface Notify {
  waiters: (() => void)[];
}

function newNotify(): Notify {
  return { waiters: [] };
}

interface RunState {
  readonly params: WorkflowRunParams;
  readonly order: readonly WorkflowNodeSpec[];
  /** nodeId → 拓扑序位置(并行批内失败按拓扑序处置的确定性依据)。 */
  readonly topoIndex: Map<string, number>;
  readonly completed: Set<string>;
  readonly outputs: Map<string, readonly { readonly name: string; readonly sha256: string }[]>;
  readonly attempts: Map<string, number>;
  readonly traversals: Map<string, number>;
  readonly gate: EngineGate;
  /** 在飞节点(nodeId → 执行 promise;结算时填 settled 并唤醒 notify)。 */
  readonly inFlight: Map<string, Promise<void>>;
  /** 已结算待处理的节点结果(按拓扑序消费)。 */
  settled: SettledEntry[];
  /** 已结算、待排空后处置的失败(§3.5 并行失败语义)。 */
  failures: FailedEntry[];
  /** 排队唤醒信号(waitNotify 一次性消费)。 */
  notify: Notify;
  readonly maxParallel: number;
  /** run() 的结果通道:loop 退出(终态或 budget 挂起)时 resolve。 */
  readonly done: {
    readonly promise: Promise<WorkflowRunResult>;
    resolve: (result: WorkflowRunResult) => void;
    reject: (err: unknown) => void;
  };
  /** 'paused' = 收口循环已因 budget 挂起退出(resume 重入);执行中外部暂停不改它。 */
  status: 'running' | 'paused';
  /**
   * budget 排空窗口(loop 正在 #drain,gate 已 pause 但挂起尚未落定):
   * 此窗口内到达的 resume 记为待办,由 #settle 的 while 在落定瞬间续跑
   * (否则 resume 落在已 settle 的旧 promise 上被静默吞掉,任务永远停在
   * paused —— 丢唤醒)。
   */
  budgetPausing: boolean;
  /**
   * 排空窗口 / 熔断窗口内收到的 resume;#settle 的 while 消费后自动重入
   * loop。只在 #settle 返回处消费 —— 杜绝悬空标志(置了没人消费)。
   */
  pendingResume: boolean;
  /**
   * 当前在飞的收口循环(#drive 或 resume 重入启动)。窗口内到达的 resume
   * 等待它拿新终态,而不是已 settle 的 run() 旧 promise。
   */
  settling: Promise<WorkflowRunResult> | null;
  /** 最近一次挂起(paused)的定位节点;budget_paused 形态取消收尾时用作 failedNode(#17)。 */
  pausedNode?: string;
}

export class WorkflowEngine {
  readonly #deps: WorkflowEngineDeps;
  readonly #runs = new Map<string, RunState>();

  constructor(deps: WorkflowEngineDeps) {
    this.#deps = deps;
  }

  /** 正在运行/挂起的执行(查询视图)。 */
  activeTaskIds(): readonly string[] {
    return [...this.#runs.keys()];
  }

  /** 启动一次工作流执行;同 taskId 已有未终态执行时拒绝(RunDuplicate)。 */
  async run(params: WorkflowRunParams): Promise<WorkflowRunResult> {
    if (this.#runs.has(params.taskId)) throw new RunDuplicate(params.taskId);
    let resolve!: (result: WorkflowRunResult) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<WorkflowRunResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const order = topoSort(params.workflow.nodes);
    const state: RunState = {
      params,
      order,
      topoIndex: new Map(order.map((n, i) => [n.id, i])),
      completed: new Set(),
      outputs: new Map(),
      attempts: new Map(),
      traversals: new Map(),
      gate: new EngineGate(),
      inFlight: new Map(),
      settled: [],
      failures: [],
      notify: newNotify(),
      maxParallel: params.maxParallel !== undefined && params.maxParallel >= 1 ? params.maxParallel : Infinity,
      done: { promise, resolve, reject },
      status: 'running',
      budgetPausing: false,
      pendingResume: false,
      settling: null,
    };
    this.#runs.set(params.taskId, state);
    void this.#drive(state);
    return promise;
  }

  /** 暂停:当前节点跑完后停在下一个派发边界(执行中的节点不强杀)。 */
  pause(taskId: string): boolean {
    return this.#runs.get(taskId)?.gate.pause() ?? false;
  }

  /**
   * 取消:立即协作终止执行中节点并按 cancelled 收尾(终态)。
   * 两种形态(issue #17):
   * - 运行中 / 外部暂停:abort 经 gate 信号被 #loop 消费(GateAborted),
   *   走正常取消收尾;
   * - budget_paused 已挂起(#loop 已退出,任务 paused 但 run 仍在 #runs):
   *   abort 已无人消费 —— 直接走与 GateAborted 相同的收尾(补落
   *   node.failed(cancelled)、终态 cancelled、从 #runs 摘除),否则任务
   *   永远 paused,activeTaskIds() 留僵尸。
   */
  cancel(taskId: string): boolean {
    const state = this.#runs.get(taskId);
    if (state === undefined) return false;
    if (state.status === 'paused') {
      state.gate.abort();
      // 先出表再异步收尾:resume / 重复 cancel 立即看到终态(RunUnknown/false),
      // 收尾只是补事件与产出终态结果(run() 的 promise 早已以 paused 落定)。
      this.#runs.delete(taskId);
      void this.#finishCancelled(state).catch(() => {
        // 收尾失败(如事件落盘异常)不回滚:出表即终态,避免僵尸复活。
      });
      return true;
    }
    return state.gate.abort();
  }

  /**
   * 恢复执行。三种挂起形态:
   * - budget_paused 已落定(loop 已退出):重入收口循环续跑;
   * - 执行中外部 pause(loop 阻塞在派发边界):原地唤醒,结果经当前在飞
   *   的收口循环送达;
   * - budget 熔断窗口(executor 已在台账记下 hard、gate.pause 尚未落定):
   *   记待办,由收口循环在挂起落定瞬间自动续跑 —— 与「已挂起」同语义。
   * 健康运行中(无任何 pause 信号)resume 显式抛 RunNotPaused,不武装
   * 自动续跑(否则真熔断时 #settle 的 while 会自动续跑,操作者的
   * budget_paused 决策点 —— 续预算或终止 —— 被静默跳过)。
   */
  async resume(taskId: string): Promise<WorkflowRunResult> {
    const state = this.#runs.get(taskId);
    if (state === undefined) throw new RunUnknown(taskId);
    if (state.status === 'paused') {
      // budget_paused 挂起:重入收口循环。与 #drive 复用同一 while 消费
      // pendingResume —— 重入期间再次熔断、期间到达的新 resume 都在同一
      // 处收口,不再产生悬空标志或过期 promise(窗口 b)。
      state.status = 'running';
      state.gate.resume();
      return this.#reenter(state);
    }
    if (state.gate.paused) {
      if (state.budgetPausing) {
        // budget 排空窗口:挂起尚未落定,记待办,由收口循环在落定瞬间续跑。
        state.pendingResume = true;
      } else {
        // 外部 pause(loop 阻塞在派发边界):原地唤醒。
        state.gate.resume();
      }
      return this.#currentSettling(state);
    }
    const budget = state.params.budget;
    if (budget !== undefined && budget !== null && budget.level === 'hard') {
      // 熔断窗口:executor 记账已判 hard(节点结算 budget_paused 在途,
      // gate.pause 尚未落定,台账 level 是精确信号)。此间到达的 resume
      // 记待办,挂起落定瞬间由收口循环自动续跑;抛 RunNotPaused 会把这次
      // resume 静默吞掉,任务永远停在 paused。
      state.pendingResume = true;
      return this.#currentSettling(state);
    }
    // 健康运行中(无任何 pause 信号):resume 是调用方误用,显式报错;
    // 不置 pendingResume —— 否则后续真熔断时收口循环会自动续跑,操作者的
    // budget_paused 决策点(续预算或终止)被静默跳过,任务继续烧预算。
    throw new RunNotPaused(taskId, state.gate.state);
  }

  /** resume 重入收口循环:登记在飞 promise,供窗口内后续 resume 等待新终态。 */
  #reenter(state: RunState): Promise<WorkflowRunResult> {
    const settling = this.#settle(state);
    state.settling = settling;
    return settling;
  }

  /** 当前在飞的收口循环(引擎启动前到达的极端情形退回 run() 的结果通道)。 */
  #currentSettling(state: RunState): Promise<WorkflowRunResult> {
    return state.settling ?? state.done.promise;
  }

  /**
   * 收口循环:跑 #loop 到终态;每次落回 paused 时消费 pendingResume(排空
   * 窗口 / 熔断窗口内到达的 resume 在挂起落定瞬间自动续跑)。status 与
   * #runs 表只在这里维护 —— #drive 与 resume 重入路径共用同一循环,标志
   * 不悬空、窗口内 resume 拿到的 promise 永远是当前在飞的那次。
   */
  async #settle(state: RunState): Promise<WorkflowRunResult> {
    try {
      let result = await this.#loop(state);
      while (result.status === 'paused' && state.pendingResume) {
        state.pendingResume = false;
        state.status = 'running';
        state.gate.resume();
        result = await this.#loop(state);
      }
      if (result.status === 'paused') {
        if (state.gate.aborted) {
          // 取消落在 budget 排空 / 熔断窗口:loop 以 paused 返回,但 gate 已被
          // abort —— 不会再有 resume 消费这次挂起。走与 GateAborted 相同的
          // 收尾,终态 cancelled(issue #17:否则任务永远 paused,#runs 留僵尸)。
          this.#runs.delete(state.params.taskId);
          return await this.#finishCancelled(state);
        }
        state.pausedNode = result.failedNode;
        state.status = 'paused';
      } else {
        this.#runs.delete(state.params.taskId);
      }
      return result;
    } catch (err) {
      this.#runs.delete(state.params.taskId);
      throw err;
    }
  }

  /** loop 驱动:终态(含 budget 挂起)resolve run() 的 promise 并维护状态表。 */
  async #drive(state: RunState): Promise<void> {
    const settling = this.#settle(state);
    state.settling = settling;
    try {
      state.done.resolve(await settling);
    } catch (err) {
      state.done.reject(err);
    }
  }

  async #loop(state: RunState): Promise<WorkflowRunResult> {
    const { params, order } = state;
    try {
      while (true) {
        await state.gate.wait(); // aborted 时抛 GateAborted

        // ---- 消费已结算节点(按拓扑序)----
        for (const entry of this.#takeSettled(state)) {
          if (entry.error !== undefined) throw entry.error;
          if (entry.result === undefined) continue;
          if (entry.result.status === 'completed') {
            state.completed.add(entry.spec.id);
            state.outputs.set(entry.spec.id, entry.result.outputs);
            continue;
          }
          // 取消 / 预算挂起:确定性排空在飞后终态(§3.5 并行失败语义)。
          if (entry.result.reason === 'cancelled') {
            await this.#drain(state);
            return finalize(state, {
              status: 'cancelled',
              failedNode: entry.spec.id,
              failReason: 'cancelled',
              detail: entry.result.detail,
            });
          }
          if (entry.result.reason === 'budget_paused') {
            state.gate.pause();
            state.budgetPausing = true; // 排空窗口:期间到达的 resume 记待办
            const pausedNode = await this.#drain(state);
            state.budgetPausing = false;
            return finalize(state, {
              status: 'paused',
              failedNode: pausedNode ?? entry.spec.id,
              failReason: 'budget_paused',
              detail: entry.result.detail,
            });
          }
          state.failures.push({ spec: entry.spec, result: entry.result });
        }

        // ---- 失败处置:等在飞排空,再按拓扑序逐个处置 ----
        if (state.failures.length > 0) {
          if (state.inFlight.size > 0) {
            await waitNotify(state);
            continue;
          }
          const failures = [...state.failures];
          state.failures = [];
          let feedbackApplied = false;
          for (const failure of failures) {
            if (feedbackApplied) break; // 回打重置下游,其余失败节点将随重跑重新结算
            const preset = this.#deps.presets[failure.spec.preset];
            if (preset === undefined) throw new PresetUnknown(failure.spec.preset);
            if (this.#retry(state, failure.spec, preset, failure.result.reason)) continue;

            const edge = params.workflow.feedback.find(
              (f) =>
                f.from === failure.spec.id &&
                (state.traversals.get(feedbackKey(f)) ?? 0) < f.max_traversals,
            );
            if (edge !== undefined) {
              const key = feedbackKey(edge);
              state.traversals.set(key, (state.traversals.get(key) ?? 0) + 1);
              // 重置 target 及全部下游:回打先排空在飞(见上),重跑进依赖序。
              for (const id of downstreamOf(order, edge.to)) {
                state.completed.delete(id);
                state.outputs.delete(id);
              }
              feedbackApplied = true;
              continue;
            }

            // 无可用重试与反馈(或反馈超限)= 升级主控,终态失败。
            const traversalKey = params.workflow.feedback.find((f) => f.from === failure.spec.id);
            return finalize(state, {
              status: 'failed',
              failedNode: failure.spec.id,
              failReason: failure.result.reason,
              detail: traversalKey !== undefined
                ? `反馈边 ${feedbackKey(traversalKey)} 超限(max_traversals=${traversalKey.max_traversals}); ${failure.result.detail ?? ''}`
                : failure.result.detail,
            });
          }
          continue;
        }

        // ---- 派发:就绪集合(依赖完成 ∧ 未完成 ∧ 不在飞),拓扑序取 ----
        const ready = order.filter(
          (n) =>
            !state.completed.has(n.id) &&
            !state.inFlight.has(n.id) &&
            (n.inputs ?? []).every((i) => state.completed.has(i.from)),
        );
        if (ready.length === 0) {
          if (state.inFlight.size === 0) break; // 全部完成
          await waitNotify(state);
          continue;
        }
        const first = ready[0] as WorkflowNodeSpec;
        const batchAllowed = first.parallel === true && state.maxParallel > 1;
        if (batchAllowed) {
          // parallel 批:按拓扑序取同批就绪的 parallel 节点,至上限;
          // 串行节点不混入(独占派发语义)。
          for (const spec of ready) {
            if (state.inFlight.size >= state.maxParallel) break;
            if (spec.parallel !== true) break;
            this.#dispatch(state, spec);
          }
          // 批全为串行(防御):至少派发首个。
          if (state.inFlight.size === 0) this.#dispatch(state, first);
        } else {
          // 串行节点独占派发:在飞批次排空后才起跑(§3.5 并行语义)。
          if (state.inFlight.size > 0) {
            await waitNotify(state);
            continue;
          }
          this.#dispatch(state, first);
        }
      }
    } catch (err) {
      if (err instanceof GateAborted) {
        return this.#finishCancelled(state);
      }
      throw err;
    }

    // ---- 全节点完成:证据双重校验 + 工作流输出汇总 ----
    const ns: ArtifactNamespace = { tenant: params.tenant, task: params.taskId };
    for (const evidence of params.workflow.evidence) {
      if (!evidence.must_exist) continue;
      const ref = await this.#deps.artifacts.resolve(ns, evidence.node, evidence.artifact);
      if (ref === null) {
        return await this.#finalizeFailed(state, {
          status: 'failed',
          failedNode: evidence.node,
          failReason: 'evidence_missing',
          detail: `证据工件不存在: ${evidence.node}/${evidence.artifact}`,
        });
      }
      if (evidence.sha256_recorded) {
        try {
          await this.#deps.artifacts.verify(ns, evidence.node, evidence.artifact);
        } catch (err) {
          return await this.#finalizeFailed(state, {
            status: 'failed',
            failedNode: evidence.node,
            failReason: 'evidence_corrupt',
            detail: `证据校验失败(${evidence.node}/${evidence.artifact}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      }
    }

    const outputs: Record<string, WorkflowOutputRef[]> = {};
    for (const decl of params.workflow.outputs) {
      const nodeOutputs = state.outputs.get(decl.from) ?? [];
      if (nodeOutputs.length === 0) {
        if (decl.required) {
          return await this.#finalizeFailed(state, {
            status: 'failed',
            failedNode: decl.from,
            failReason: 'output_unresolved',
            detail: `工作流输出未解析: 节点 ${decl.from} 无已发布产物`,
          });
        }
        continue;
      }
      outputs[decl.from] = nodeOutputs.map((o) => ({
        node: decl.from,
        name: o.name,
        sha256: o.sha256,
      }));
    }
    return finalize(state, { status: 'completed', outputs });
  }

  /**
   * 取消收尾(GateAborted 捕获与 budget_paused 形态取消共用,issue #17):
   * 先收割已结算条目 —— 取消瞬间刚结算的节点照常记账;已完成者标记完成,
   * 取消/失败者作为 failedNode 依据。取消本身通常无事件(派发边界被取消的
   * 节点未 started;挂起形态的失败事件映射为 paused),补一条
   * node.failed(cancelled) 让 TaskStore / 重放推进到 cancelled 终态;
   * 最后 finalize cancelled。
   */
  async #finishCancelled(state: RunState): Promise<WorkflowRunResult> {
    const params = state.params;
    let current: WorkflowNodeSpec | undefined;
    // 收割的失败条目若为 budget_paused:其失败事件把 TaskStore 映射为 paused
    // (非终态),不能按"executor 已落过失败事件"跳过 —— 仍须补落
    // node.failed(cancelled) 才能推进到终态(issue #17)。
    let currentBudgetPaused = false;
    for (const entry of this.#takeSettled(state)) {
      if (entry.error !== undefined) {
        current ??= entry.spec;
        continue;
      }
      if (entry.result === undefined) continue;
      if (entry.result.status === 'completed') {
        state.completed.add(entry.spec.id);
        state.outputs.set(entry.spec.id, entry.result.outputs);
        continue;
      }
      if (current === undefined) {
        current = entry.spec;
        currentBudgetPaused = entry.result.reason === 'budget_paused';
      }
    }
    const reapedFailure = current !== undefined;
    if (!reapedFailure) {
      // 无收割失败:优先用挂起定位节点(budget_paused 形态的熔断节点),
      // 否则取拓扑序首个未完成节点(派发边界被取消的节点)。
      current = state.pausedNode !== undefined
        ? state.order.find((n) => n.id === state.pausedNode)
        : undefined;
      current ??= state.order.find((n) => !state.completed.has(n.id));
    }
    if (current !== undefined && this.#deps.emit !== undefined && (!reapedFailure || currentBudgetPaused)) {
      await this.#deps.emit({
        type: 'node.failed',
        principal: {
          tenant: params.tenant,
          session: params.session,
          task: params.taskId,
          agent: `${params.taskId}/${current.id}`,
        },
        payload: {
          nodeId: current.id,
          attempt: state.attempts.get(current.id) ?? 0,
          reason: 'cancelled',
          detail: '执行被取消',
        },
      });
    }
    return finalize(state, {
      status: 'cancelled',
      ...(current !== undefined ? { failedNode: current.id } : {}),
      failReason: 'cancelled',
      detail: '执行被取消',
    });
  }

  /**
   * 终检失败收尾(issue #17):evidence_missing / evidence_corrupt /
   * output_unresolved 三条 finalize-failed 路径原先只经返回值表达 failed ——
   * TaskStore 由 node.completed 驱动,全部节点完成后已把任务置 completed,
   * 重放同样 completed,状态面永远显示 completed。这里补落 node.failed,
   * 让 TaskStore 与重放同构推进到 failed。
   */
  async #finalizeFailed(
    state: RunState,
    result: {
      readonly status: 'failed';
      readonly failedNode: string;
      readonly failReason: string;
      readonly detail: string;
    },
  ): Promise<WorkflowRunResult> {
    if (this.#deps.emit !== undefined) {
      await this.#deps.emit({
        type: 'node.failed',
        principal: {
          tenant: state.params.tenant,
          session: state.params.session,
          task: state.params.taskId,
          agent: `${state.params.taskId}/${result.failedNode}`,
        },
        payload: {
          nodeId: result.failedNode,
          attempt: state.attempts.get(result.failedNode) ?? 0,
          reason: result.failReason,
          detail: result.detail,
        },
      });
    }
    return finalize(state, result);
  }

  /** 重试判定:crash/output_missing 按 on 含 crash;timeout 额外要求幂等。 */
  #retry(
    state: RunState,
    spec: WorkflowNodeSpec,
    preset: Preset,
    reason: string,
  ): boolean {
    const retry = spec.retry;
    if (retry === undefined) return false;
    const trigger = reason === 'timeout' ? 'timeout' : reason === 'crash' || reason === 'output_missing' ? 'crash' : null;
    if (trigger === null || !retry.on.includes(trigger)) return false;
    if (trigger === 'timeout' && !preset.idempotent) return false;
    return (state.attempts.get(spec.id) ?? 0) <= retry.max;
  }

  /**
   * 派发单个节点:计 attempt、收集上游工件、起执行 promise;结算时填入
   * settled 并唤醒 notify。executor 抛错按 SettledEntry.error 原样上抛
   * (与顺序引擎的 crash 语义一致)。
   */
  #dispatch(state: RunState, spec: WorkflowNodeSpec): void {
    const params = state.params;
    const preset = this.#deps.presets[spec.preset];
    if (preset === undefined) throw new PresetUnknown(spec.preset);
    const attempt = (state.attempts.get(spec.id) ?? 0) + 1;
    state.attempts.set(spec.id, attempt);
    const inputArtifacts = collectInputs(spec, state.outputs);
    const executor = this.#deps.executor;
    const run = executor
      .execute({
        tenant: params.tenant,
        session: params.session,
        taskId: params.taskId,
        nodeId: spec.id,
        preset,
        attempt,
        instruction: buildInstruction(spec.id, preset, params.intent, inputArtifacts),
        inputArtifacts,
        timeoutSec: spec.timeout,
        secretIds: params.secretIds,
        budget: params.budget ?? null,
        signal: state.gate.signal,
      })
      .then(
        (result: NodeExecutionResult): SettledEntry => ({ spec, result }),
        (error: unknown): SettledEntry => ({ spec, error }),
      );
    const promise = run.then((entry) => {
      state.settled.push(entry);
      signalNotify(state);
    });
    state.inFlight.set(spec.id, promise);
  }

  /** 取出全部已结算条目(按拓扑序);executor 抛错的条目保持 error 待上抛。 */
  #takeSettled(state: RunState): SettledEntry[] {
    const entries = [...state.settled].sort(
      (a, b) => (state.topoIndex.get(a.spec.id) ?? 0) - (state.topoIndex.get(b.spec.id) ?? 0),
    );
    state.settled = [];
    for (const entry of entries) state.inFlight.delete(entry.spec.id);
    return entries;
  }

  /**
   * 确定性排空:等全部在飞节点自然完成(§3.5 并行失败语义)。排空期完成的
   * 节点正常记账;排空期新出现的 budget_paused 返回其节点(取拓扑序首个),
   * 其余失败入 failures 待统一处置;executor 抛错在排空结束后上抛。
   */
  async #drain(state: RunState): Promise<string | null> {
    let pausedNode: string | null = null;
    let error: unknown;
    while (state.inFlight.size > 0) {
      await waitNotify(state);
      for (const entry of this.#takeSettled(state)) {
        if (entry.error !== undefined) {
          error ??= entry.error;
          continue;
        }
        if (entry.result === undefined) continue;
        if (entry.result.status === 'completed') {
          state.completed.add(entry.spec.id);
          state.outputs.set(entry.spec.id, entry.result.outputs);
          continue;
        }
        if (entry.result.reason === 'budget_paused') {
          pausedNode ??= entry.spec.id;
          continue;
        }
        state.failures.push({ spec: entry.spec, result: entry.result });
      }
    }
    if (error !== undefined) throw error;
    return pausedNode;
  }
}

/** 等下一个节点结算(挂入等待者;signalNotify 逐个唤醒,不丢信号)。 */
function waitNotify(state: RunState): Promise<void> {
  return new Promise<void>((resolve) => {
    state.notify.waiters.push(resolve);
  });
}

function signalNotify(state: RunState): void {
  const waiters = [...state.notify.waiters];
  state.notify.waiters = [];
  for (const resolve of waiters) resolve();
}

function feedbackKey(edge: { readonly from: string; readonly to: string }): string {
  return `${edge.from}->${edge.to}`;
}

function finalize(
  state: RunState,
  result: Omit<WorkflowRunResult, 'feedbackTraversals' | 'outputs'> & {
    readonly outputs?: WorkflowRunResult['outputs'];
  },
): WorkflowRunResult {
  const traversals: Record<string, number> = {};
  for (const [key, count] of state.traversals) traversals[key] = count;
  return { outputs: {}, ...result, feedbackTraversals: traversals };
}

/** 上游工件收集:inputs 声明的各上游节点的全部已发布产物。 */
function collectInputs(
  spec: WorkflowNodeSpec,
  outputs: ReadonlyMap<string, readonly { readonly name: string; readonly sha256: string }[]>,
): readonly { readonly from: string; readonly name: string; readonly sha256: string }[] {
  const out: { from: string; name: string; sha256: string }[] = [];
  for (const input of spec.inputs ?? []) {
    for (const output of outputs.get(input.from) ?? []) {
      out.push({ from: input.from, name: output.name, sha256: output.sha256 });
    }
  }
  return out;
}

/** 指令文本:目标 + 上游工件清单(sha256 为权威引用)。 */
function buildInstruction(
  nodeId: string,
  preset: Preset,
  intent: IntentDoc | undefined,
  inputs: readonly { readonly from: string; readonly name: string; readonly sha256: string }[],
): string {
  const lines = [`# 节点任务:${nodeId}(preset: ${preset.name})`];
  if (intent !== undefined) {
    lines.push(`目标:${intent.goal}`);
  }
  if (inputs.length > 0) {
    lines.push('上游工件(CAS 已发布,sha256 为权威):');
    for (const input of inputs) {
      lines.push(`- ${input.from}/${input.name} sha256=${input.sha256}`);
    }
  }
  return lines.join('\n');
}

/**
 * 输入依赖拓扑序(Kahn;同层按文档序,确定性推进)。
 * feedback 边是运行期纠偏通道,不参与编译期依赖。成环 = WorkflowCycle
 * (PlanCheck 前置时已拦;引擎防御性再查)。
 */
export function topoSort(nodes: readonly WorkflowNodeSpec[]): readonly WorkflowNodeSpec[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    const deps = (node.inputs ?? []).map((i) => i.from);
    indegree.set(node.id, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }
  const order: WorkflowNodeSpec[] = [];
  const ready = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  while (ready.length > 0) {
    const id = ready.shift() as string;
    const node = byId.get(id);
    if (node !== undefined) order.push(node);
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  if (order.length !== nodes.length) {
    const cyclic = nodes.filter((n) => !order.includes(n)).map((n) => n.id);
    throw new WorkflowCycle(cyclic.join(', '));
  }
  return order;
}

/** start 及其在输入依赖图上的全部下游(反馈回打的重置范围)。 */
export function downstreamOf(
  order: readonly WorkflowNodeSpec[],
  startId: string,
): readonly string[] {
  const set = new Set<string>([startId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of order) {
      if (set.has(node.id)) continue;
      if ((node.inputs ?? []).some((i) => set.has(i.from))) {
        set.add(node.id);
        changed = true;
      }
    }
  }
  return order.filter((n) => set.has(n.id)).map((n) => n.id);
}
