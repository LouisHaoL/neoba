/**
 * messenger 模块(§3.4 消息通道)。
 *
 * 按 ID 点对点(主控↔子双向)、广播(可选能力,握手协商)、结构化纠偏
 * (kind + ref + traversal)。消息结构以 protocol/schemas/messaging.schema.json
 * 为准;持久化经注入 sink 完成(实现归 src/events),本模块零第三方依赖。
 */
export { Messenger, ORCHESTRATOR_ID, type MessengerOptions } from './messenger.ts';
export { InvalidAgentId, InvalidMsg, MessengerError, NotSupportedError } from './errors.ts';
export {
  AGENT_ID_RE,
  ARTIFACT_REF_RE,
  RFC3339_UTC_RE,
  SPEC_VERSION_RE,
  assertRfc3339Utc,
  isRfc3339Utc,
  nowRfc3339,
  validateMsg,
} from './validate.ts';
export {
  DEAD_LETTER_REASONS,
  FEEDBACK_KINDS,
  MSG_TYPES,
  PRIORITIES,
  PROTOCOL_VERSION,
} from './types.ts';
export type {
  DeadLetter,
  DeadLetterReason,
  DeliveryFailure,
  EventSink,
  FeedbackKind,
  HistoryFilter,
  MsgBroadcastInput,
  MsgDirectInput,
  MsgFeedbackInput,
  MsgHandler,
  MsgInput,
  MsgMeta,
  MsgSubscriber,
  MsgType,
  MessengerSinkEvent,
  Principal,
  Priority,
  StoredMessage,
} from './types.ts';
