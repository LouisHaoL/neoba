/**
 * Messenger(§3.4 消息通道):register/unregister + send 三型投递 + traversal
 * 计数 + history 内存查询 + onMessage 审计挂点 + dead letter 队列。
 *
 * 语义决议:
 * - **投递异步不阻塞 send**:send 同步完成校验、盖章、记账(history/sink/订阅者)
 *   与路由决策,实际 handler 调度经 queueMicrotask 排空单个 FIFO 队列 —— 并发
 *   send 的投递顺序 = send 调用顺序(seq 单调递增)。handler 同步抛错或 Promise
 *   拒绝都被捕获落账到 failures(),不会炸 Messenger、不影响后续消息。
 * - **收件人未注册 → dead letter 队列**(而非类型化错误):主控↔子是双向通道,
 *   子 agent 注册与首条消息存在时序竞争(如编排引擎启动即下发任务);硬报错会把
 *   发送方的时序耦合给调用方,静默丢弃则丢审批/纠偏流。入 DLQ 保留消息与原因,
 *   调用方经 takeDeadLetters() 取回后自行重发(有界反馈的升级动作同理归调用方)。
 * - **广播是协商能力**:broadcastEnabled 来自 session 握手协商(构造参数注入,
 *   本模块不 import session),关闭时 broadcast 抛 NotSupportedError。
 * - **超限判定只读**:exceedsMaxTraversal 只返回布尔,"升级给主控"的执行引擎
 *   在 P2 由调用方实现(§3.5b/§3.5e)。
 * - 路由为 send 时快照:direct 的 handler 在 send 时解析并持有,广播枚举 send 时
 *   已注册的全部 handler;send 之后 unregister 不追溯已入队消息。
 */
import { randomUUID } from 'node:crypto';
import { InvalidAgentId, NotSupportedError } from './errors.ts';
import { AGENT_ID_RE, nowRfc3339, validateMsg } from './validate.ts';
import type {
  DeadLetter,
  DeliveryFailure,
  EventSink,
  HistoryFilter,
  MsgHandler,
  MsgInput,
  MsgSubscriber,
  Principal,
  Priority,
  StoredMessage,
} from './types.ts';

/** send() 未指定发送方时的缺省身份(主控是默认反馈源,§3.5b feedback.from)。 */
export const ORCHESTRATOR_ID = 'orchestrator';

export interface MessengerOptions {
  /** 广播能力,来自 session 握手协商(broadcast 项);缺省 false(从严)。 */
  readonly broadcastEnabled?: boolean;
  /** 本通道归属的 principal(tenant/session/task/agent),随 sink 事件透传给持久层。 */
  readonly principal?: Principal;
  /** 持久化 sink,实现由 src/events 提供;本模块只回调、不落盘。 */
  readonly sink?: EventSink;
  /** 可注入时钟(RFC3339 盖章用),测试可固定。 */
  readonly now?: () => Date;
}

interface DispatchEntry {
  readonly message: StoredMessage;
  readonly to: string;
  readonly handler: MsgHandler;
}

function matchesFilter(m: StoredMessage, f: HistoryFilter): boolean {
  if (f.id !== undefined && m.id !== f.id) return false;
  if (f.type !== undefined && m.type !== f.type) return false;
  if (f.from !== undefined && m.from !== f.from) return false;
  if (f.to !== undefined && !('to' in m && m.to === f.to)) return false;
  if (f.topic !== undefined && !('topic' in m && m.topic === f.topic)) return false;
  if (f.kind !== undefined && !('kind' in m && m.kind === f.kind)) return false;
  if (f.ref !== undefined && !('ref' in m && m.ref === f.ref)) return false;
  return true;
}

export class Messenger {
  private readonly handlers = new Map<string, MsgHandler>();
  private readonly subscribers = new Set<MsgSubscriber>();
  private readonly historyList: StoredMessage[] = [];
  private readonly deadList: DeadLetter[] = [];
  private readonly failureList: DeliveryFailure[] = [];
  /** per-(from, to, ref) 的 traversal 计数(取历史最大值,容忍乱序)。 */
  private readonly traversals = new Map<string, Map<string, Map<string, number>>>();
  private readonly queue: DispatchEntry[] = [];
  private readonly broadcastEnabled: boolean;
  private readonly principal: Principal | null;
  private readonly sink: EventSink | null;
  private readonly now: () => Date;
  private seqCounter = 0;
  private drainScheduled = false;

  constructor(options: MessengerOptions = {}) {
    this.broadcastEnabled = options.broadcastEnabled ?? false;
    this.principal = options.principal ?? null;
    this.sink = options.sink ?? null;
    this.now = options.now ?? (() => new Date());
  }

  // ------------------------------------------------------------- 注册表

  /** 登记接收端。重复 register 覆盖旧 handler(重连场景幂等)。 */
  register(agentId: string, handler: MsgHandler): void {
    if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
      throw new InvalidAgentId(String(agentId), '必须匹配 <task>/<实例名> 格式');
    }
    if (typeof handler !== 'function') {
      throw new InvalidAgentId(agentId, 'handler 必须是函数');
    }
    this.handlers.set(agentId, handler);
  }

  /** 注销。未知的 agentId 是 no-op,返回是否真的移除了一个。 */
  unregister(agentId: string): boolean {
    return this.handlers.delete(agentId);
  }

  registeredAgents(): readonly string[] {
    return [...this.handlers.keys()];
  }

  // ------------------------------------------------------------- 发送

  /**
   * 校验 + 盖章(id/ts/priority/seq/from)+ 记账 + 路由。同步返回盖章后的消息;
   * handler 的实际执行异步进行,不阻塞本调用。校验失败 / 广播能力关闭时抛
   * 类型化错误,且不留任何状态残留。
   */
  send(raw: unknown, from: string = ORCHESTRATOR_ID): StoredMessage {
    const msg = validateMsg(raw);
    if (msg.type === 'msg.broadcast' && !this.broadcastEnabled) {
      throw new NotSupportedError(
        'broadcast',
        'session 握手未协商 broadcast 能力(broadcastEnabled=false)',
      );
    }

    const stamped = this.stamp(msg, from);
    this.historyList.push(stamped);
    this.notifySubscribers(stamped);
    this.emitSink(stamped);

    if (msg.type === 'msg.feedback') {
      this.recordTraversal(stamped.from, msg.to, msg.ref, msg.traversal);
    }
    if (msg.type === 'msg.broadcast') {
      for (const [agentId, handler] of this.handlers) {
        this.enqueue(stamped, agentId, handler);
      }
    } else {
      const handler = this.handlers.get(msg.to);
      if (handler === undefined) {
        this.deadList.push({ message: stamped, reason: 'recipient_not_registered', at: stamped.ts });
      } else {
        this.enqueue(stamped, msg.to, handler);
      }
    }
    this.scheduleDrain();
    return stamped;
  }

  private stamp(
    msg: MsgInput,
    from: string,
  ): StoredMessage {
    const id = randomUUID();
    const ts = nowRfc3339(this.now);
    const seq = ++this.seqCounter;
    const priority: Priority = ('priority' in msg && msg.priority) || 'normal';
    switch (msg.type) {
      case 'msg.direct':
        return { ...msg, priority, id, ts, seq, from };
      case 'msg.broadcast':
        return { ...msg, priority, id, ts, seq, from };
      case 'msg.feedback':
        return { ...msg, priority, id, ts, seq, from };
    }
  }

  private enqueue(message: StoredMessage, to: string, handler: MsgHandler): void {
    this.queue.push({ message, to, handler });
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    this.drainScheduled = false;
    const pending = this.queue.splice(0, this.queue.length);
    for (const entry of pending) {
      try {
        const result = entry.handler(entry.message);
        if (result instanceof Promise) {
          result.catch((e: unknown) => this.recordFailure(entry.message, entry.to, 'handler', e));
        }
      } catch (e) {
        this.recordFailure(entry.message, entry.to, 'handler', e);
      }
    }
  }

  private recordFailure(message: StoredMessage, target: string | null, stage: DeliveryFailure['stage'], e: unknown): void {
    this.failureList.push({
      messageId: message.id,
      seq: message.seq,
      target,
      stage,
      error: e instanceof Error ? e.message : String(e),
      at: nowRfc3339(this.now),
    });
  }

  private notifySubscribers(message: StoredMessage): void {
    for (const sub of [...this.subscribers]) {
      try {
        sub(message);
      } catch (e) {
        this.recordFailure(message, null, 'subscriber', e);
      }
    }
  }

  private emitSink(message: StoredMessage): void {
    const sink = this.sink;
    if (sink === null) return;
    try {
      const result = sink({
        type: 'msg.sent',
        message,
        ...(this.principal !== null ? { principal: this.principal } : {}),
      });
      if (result instanceof Promise) {
        result.catch((e: unknown) => this.recordFailure(message, null, 'sink', e));
      }
    } catch (e) {
      this.recordFailure(message, null, 'sink', e);
    }
  }

  // ------------------------------------------------------------- 有界反馈

  private recordTraversal(from: string, to: string, ref: string, traversal: number): void {
    let byTo = this.traversals.get(from);
    if (byTo === undefined) {
      byTo = new Map();
      this.traversals.set(from, byTo);
    }
    let byRef = byTo.get(to);
    if (byRef === undefined) {
      byRef = new Map();
      byTo.set(to, byRef);
    }
    const prev = byRef.get(ref);
    byRef.set(ref, prev === undefined ? traversal : Math.max(prev, traversal));
  }

  /** 查询 per-(from,to,ref) 的 traversal 计数;无记录返回 null。 */
  traversalOf(from: string, to: string, ref: string): number | null {
    return this.traversals.get(from)?.get(to)?.get(ref) ?? null;
  }

  /**
   * 超限判定:count > max 即超限(编排 feedback.max_traversals 语义)。
   * 只返回布尔 —— "升级给主控"的执行动作由调用方做(引擎在 P2,§3.5e)。
   */
  exceedsMaxTraversal(from: string, to: string, ref: string, max: number): boolean {
    const count = this.traversalOf(from, to, ref);
    return count !== null && count > max;
  }

  // ------------------------------------------------------------- 查询/挂点

  /** 审计/事件日志挂点;返回解订函数。订阅者抛错被捕获落账,不影响投递。 */
  onMessage(cb: MsgSubscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /** 内存历史查询(全量时按 seq 升序);持久化靠 sink,不在此实现。 */
  history(filter: HistoryFilter = {}): readonly StoredMessage[] {
    return this.historyList.filter((m) => matchesFilter(m, filter));
  }

  /** 查看 dead letter(不消费,seq 升序)。 */
  deadLetters(): readonly DeadLetter[] {
    return [...this.deadList];
  }

  /** 取回并清空 dead letter;调用方可对消息重发或升级。 */
  takeDeadLetters(): readonly DeadLetter[] {
    return this.deadList.splice(0, this.deadList.length);
  }

  /** 投递失败记录(handler / 订阅者 / sink 抛错或 Promise 拒绝)。 */
  failures(): readonly DeliveryFailure[] {
    return [...this.failureList];
  }
}
