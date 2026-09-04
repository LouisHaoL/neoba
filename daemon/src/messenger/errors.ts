/**
 * messenger 模块的对外类型化错误。所有对外错误都必须是这些类的实例,
 * 不允许抛裸字符串或裸 Error(与 session / events 模块同一约定)。
 */
export class MessengerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 消息不符合 messaging.schema.json 语义(缺字段 / 字段类型或取值不符)。 */
export class InvalidMsg extends MessengerError {
  /** 违规字段名(点路径,如 "to" / "feedback.kind" / "traversal")。 */
  readonly field: string;
  readonly detail: string;

  constructor(field: string, detail: string) {
    super('MSG_INVALID', `消息非法: ${field}: ${detail}`);
    this.field = field;
    this.detail = detail;
  }
}

/** agent id 不符合 <task>/<实例名> 格式(common.schema.json $defs/agent_id)。 */
export class InvalidAgentId extends MessengerError {
  readonly agentId: string;

  constructor(agentId: string, detail: string) {
    super('AGENT_ID_INVALID', `agent id 非法: ${agentId}: ${detail}`);
    this.agentId = agentId;
  }
}

/** 能力未协商开启(§3.4:广播是可选能力,握手 broadcast=false 时 daemon 拒绝)。 */
export class NotSupportedError extends MessengerError {
  readonly capability: string;

  constructor(capability: string, detail: string) {
    super('CAPABILITY_UNSUPPORTED', `能力未启用: ${capability}: ${detail}`);
    this.capability = capability;
  }
}
