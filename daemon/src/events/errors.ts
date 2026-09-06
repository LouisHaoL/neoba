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

/**
 * repair 截断的跨进程冲突(issue #21):truncate 前重读文件发现内容已偏离
 * 快照(有其它进程 —— 通常是运行中的 daemon —— 在读取之后追加了新事件)。
 * 此刻按快照修剪会把别人的完整事件截掉,拒绝 repair 并上抛,宁可让本次
 * 重放失败也不静默丢事件。
 */
export class EventRepairConflict extends EventLogError {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(
      'EVENT_LOG_REPAIR_CONFLICT',
      `事件日志 ${path} 在读取后被并发修改,拒绝 repair 截断: ${detail}` +
        '(按过快照修剪会丢掉新追加的完整事件;请等写入方退出后重试)',
    );
    this.path = path;
  }
}

/**
 * repair=false 打开时文件尾部存在崩溃残行(issue #21 附带):残行不带换行符,
 * 此时追加会与新事件拼成一行,两行永久损坏。repair=false 的语义是不改写文件
 * 字节,因此不封换行,改为拒绝 append(保守选择);需要追加请用 repair=true
 * 打开一次修剪残行。
 */
export class EventBrokenTail extends EventLogError {
  readonly path: string;

  constructor(path: string) {
    super(
      'EVENT_LOG_BROKEN_TAIL',
      `事件日志 ${path} 末尾存在崩溃残行且以 repair=false 打开(不修剪不封行);` +
        '此刻追加会与新事件拼行造成永久损坏,已拒绝。请用 repair=true 重新打开修剪后再追加',
    );
    this.path = path;
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
