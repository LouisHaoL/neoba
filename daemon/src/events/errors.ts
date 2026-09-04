/**
 * 事件日志的对外类型化错误。所有对外错误都必须是这些类的实例,
 * 不允许抛裸字符串或裸 Error。
 */
export class EventLogError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * 事件日志文件损坏:非末行的非法 JSON、空行、seq 非单调 ——
 * 崩溃只会截断尾部,中途损坏说明日志被外力篡改/破坏,拒绝静默跳过。
 */
export class EventCorrupt extends EventLogError {
  readonly path: string;
  readonly line: number;

  constructor(path: string, line: number, detail: string) {
    super(
      'EVENT_LOG_CORRUPT',
      `事件日志损坏 ${path} 第 ${line} 行: ${detail}` +
        '(只有文件末尾的半行被视为崩溃截断;中途损坏不自动跳过)',
    );
    this.path = path;
    this.line = line;
  }
}

/** principal 缺 tenant,或分片路径含非法段/路径穿越。 */
export class InvalidPrincipal extends EventLogError {
  readonly detail: string;

  constructor(detail: string) {
    super('EVENT_LOG_INVALID_PRINCIPAL', `非法 principal: ${detail}`);
    this.detail = detail;
  }
}

/** append 的 type 不在事件类型闭集内,或 payload 不是普通对象。 */
export class InvalidEvent extends EventLogError {
  readonly detail: string;

  constructor(detail: string) {
    super('EVENT_LOG_INVALID_EVENT', `非法事件: ${detail}`);
    this.detail = detail;
  }
}

/** 日志已 close 后再使用。 */
export class EventLogClosed extends EventLogError {
  constructor() {
    super('EVENT_LOG_CLOSED', '事件日志已关闭');
  }
}
