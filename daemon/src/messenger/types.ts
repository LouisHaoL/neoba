/**
 * messenger 模块的对外类型(§3.4 消息通道)。
 *
 * 消息结构以 protocol/schemas/messaging.schema.json 为准:信封类 —— 首层
 * protocol + spec_version,顶层判别 type ∈ {msg.direct, msg.broadcast, msg.feedback}。
 * schema 之外的字段按 §3.0 规则 1(接收方忽略未知字段)处理:daemon 会在投递前
 * 盖上 id / ts / priority / seq / from 等超集元数据,因此 validateMsg 不拒绝未知键。
 *
 * 与 src/events 的关系:持久化经注入的 sink 接口回调完成,本模块不 import
 * events,也不自己写盘;principal 四层结构在此自定义最小版本(字段语义与
 * events.Principal 一致:tenant → session → task → agent,§2/§10.4)。
 */

/** 协议版本,冻结为 "1.0"(common.schema.json $defs/protocol)。 */
export const PROTOCOL_VERSION = '1.0';

/** 优先级枚举(schema msgDirect.priority;daemon 作为超集允许三型都带,缺省 normal)。 */
export const PRIORITIES = ['low', 'normal', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** 反馈类型闭集(§3.4:correction 纠偏 / question 提问 / ack 确认)。 */
export const FEEDBACK_KINDS = ['correction', 'question', 'ack'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** 消息三型判别(顶层 oneOf)。 */
export const MSG_TYPES = ['msg.direct', 'msg.broadcast', 'msg.feedback'] as const;
export type MsgType = (typeof MSG_TYPES)[number];

/** 四层 principal(最小自定义结构;字段语义对齐 events.Principal,不互相 import)。 */
export interface Principal {
  readonly tenant: string;
  readonly session: string | null;
  readonly task: string | null;
  readonly agent: string | null;
}

/** 点对点消息(主控↔子双向),schema $defs/msgDirect。 */
export interface MsgDirectInput {
  readonly protocol: string;
  readonly spec_version: string;
  readonly type: 'msg.direct';
  /** 收件人 agent id,格式 <task>/<实例名>。 */
  readonly to: string;
  /** 消息体,结构开放(对象)。 */
  readonly body: Record<string, unknown>;
  readonly priority?: Priority;
}

/** 广播消息(可选能力:握手协商 broadcastEnabled),schema $defs/msgBroadcast。 */
export interface MsgBroadcastInput {
  readonly protocol: string;
  readonly spec_version: string;
  readonly type: 'msg.broadcast';
  /** 广播主题,如 deps-changed。 */
  readonly topic: string;
  readonly body: Record<string, unknown>;
  readonly priority?: Priority;
}

/** 结构化纠偏指令,schema $defs/msgFeedback。注意 body 是字符串(与另两型不同)。 */
export interface MsgFeedbackInput {
  readonly protocol: string;
  readonly spec_version: string;
  readonly type: 'msg.feedback';
  readonly to: string;
  readonly kind: FeedbackKind;
  /** 反馈指向的工件,格式 artifact:<工件名>。 */
  readonly ref: string;
  /** 反馈正文,非空字符串。 */
  readonly body: string;
  /** 有界反馈计数,非负整数;对应编排 feedback.max_traversals(§3.5b)。 */
  readonly traversal: number;
  readonly priority?: Priority;
}

/** 三型联合:send() 的入参 / validateMsg 的返回。 */
export type MsgInput = MsgDirectInput | MsgBroadcastInput | MsgFeedbackInput;

/** daemon 盖章的投递元数据(schema 之外的 daemon 超集)。 */
export interface MsgMeta {
  /** uuid(crypto.randomUUID)。 */
  readonly id: string;
  /** RFC3339 UTC 时间戳,以 Z 结尾。 */
  readonly ts: string;
  /** 优先级,缺省 normal。 */
  readonly priority: Priority;
  /** 单调递增序号:并发 send 的顺序基准。 */
  readonly seq: number;
  /** 发送方标识;send() 未指定时缺省 "orchestrator"(主控是默认反馈源)。 */
  readonly from: string;
}

/** 盖章后的消息(投递给 handler、进 history、回调 sink 的形态)。 */
export type StoredMessage = (MsgDirectInput & MsgMeta) | (MsgBroadcastInput & MsgMeta) | (MsgFeedbackInput & MsgMeta);

/** 订阅/投递回调:同步返回或 Promise 均可,异常不会炸 Messenger。 */
export type MsgHandler = (msg: StoredMessage) => void | Promise<void>;

/** 审计/事件日志挂点:onMessage(cb) 的回调形态。 */
export type MsgSubscriber = (msg: StoredMessage) => void;

/** 持久化 sink 接口 —— 实现由 src/events 提供,本模块只定义接口、不 import。 */
export type EventSink = (event: MessengerSinkEvent) => void | Promise<void>;

/** 回调给 sink 的事件:每条通过校验的消息一条(sent 语义,含 dead letter)。 */
export interface MessengerSinkEvent {
  readonly type: 'msg.sent';
  readonly message: StoredMessage;
  /** 构造时注入的 principal(可选透传,便于持久层落四层命名空间)。 */
  readonly principal?: Principal;
}

/** dead letter 原因闭集(收件人未注册时入队)。 */
export const DEAD_LETTER_REASONS = ['recipient_not_registered'] as const;
export type DeadLetterReason = (typeof DEAD_LETTER_REASONS)[number];

/** dead letter 记录:取回后可由调用方决定重发或升级。 */
export interface DeadLetter {
  readonly message: StoredMessage;
  readonly reason: DeadLetterReason;
  readonly at: string;
}

/** 投递失败记录(handler / 订阅者 / sink 抛错或 Promise 拒绝时的落账)。 */
export interface DeliveryFailure {
  readonly messageId: string;
  readonly seq: number;
  /** handler 失败时为收件人 agent id;订阅者/sink 失败为 null。 */
  readonly target: string | null;
  readonly stage: 'handler' | 'subscriber' | 'sink';
  readonly error: string;
  readonly at: string;
}

/** history(filter) 的过滤条件:出现的字段精确相等。 */
export interface HistoryFilter {
  readonly id?: string;
  readonly type?: MsgType;
  readonly from?: string;
  readonly to?: string;
  readonly topic?: string;
  readonly kind?: FeedbackKind;
  readonly ref?: string;
}
