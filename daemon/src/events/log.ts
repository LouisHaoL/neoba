/**
 * JSONL 追加写事件日志(§6:daemon 所有状态变更追加写入事件日志,内存态 = 重放;
 * §3.3 审计日志 = 事件日志,同一份)。
 *
 * 落盘格式:一行一个事件 JSON,带 `v`(日志格式版本,本期 "1.0")、
 * `seq`(文件内单调递增,从 1 起)、`ts`(ISO 8601)、`principal`(四层)、
 * `type`、`payload`。
 *
 * 崩溃安全(半行不误读):
 *   - 写入策略 = 常驻追加句柄(O_APPEND)+ 每次 append 后 fsync;
 *   - 崩溃最坏留下末尾半行(无换行符的残缺 JSON);打开/重放时:
 *     末行非法 JSON 视为崩溃截断 → 重放丢弃,repair=true(默认)时修剪
 *     (truncate 回最后一个完整行);末行合法 JSON 但缺换行符 → 视为完整,
 *     原样接受并补封换行符;
 *   - 非末行的非法 JSON / 空行 / seq 非单调 = 中途损坏(不是崩溃形态),
 *     抛 EventCorrupt,不静默跳过。
 *
 * 重放前向兼容(§3.0 "接收方必须忽略未知字段"同样适用于持久化日志):
 *   - 未知字段:不校验、不剥离,透传保留(升级 daemon 必须能重放旧日志);
 *   - 未知事件类型:跳过不炸,经 replay 的 onSkipped 回调上报
 *     (recover 的报告含 skipped 计数);
 *   - 日志格式破坏性变更(major,如行结构/v 语义变化)时,daemon 必须附带
 *     迁移工具转换旧日志 —— 本期 "1.0" 内不做迁移,此条为给未来实现的约定。
 *
 * 并发:同一分片文件的 append 走 promise 链严格串行(seq 消费与落盘原子);
 * 不同分片互不阻塞。replay / readByPrincipal 亦经同一队列,读到的是
 * 与追加串行化的一致快照。
 *
 * 分片:可选 shard 策略(principal → 相对路径),默认单文件 events.jsonl;
 * seq 按分片文件独立计数。
 */
import { mkdir, open, readdir, readFile, truncate } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EventCorrupt, EventLogClosed, InvalidEvent, InvalidPrincipal } from './errors.ts';
import {
  EVENT_TYPES,
  type Event,
  type EventInput,
  type EventPayloads,
  type EventType,
  type Principal,
  type PrincipalFilter,
} from './types.ts';

/** 当前日志格式版本(随每条事件落盘;破坏性变更 = major,须附迁移工具)。 */
export const EVENT_LOG_VERSION = '1.0';

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_FILE = 'events.jsonl';

/**
 * 分片策略:把 principal 映射到一个相对 root 的日志文件路径(以 .jsonl 结尾),
 * 返回 null 表示落入默认单文件。默认策略恒为单文件。
 */
export type ShardStrategy = (principal: Principal) => string | null;

/** 内置分片策略:按 tenant/session/task 分文件(空层以 "_" 占位)。 */
export function shardByTask(): ShardStrategy {
  return (p) => {
    const tenant = p.tenant;
    const session = p.session ?? '_';
    const task = p.task ?? '_';
    return `${tenant}/${session}/${task}.jsonl`;
  };
}

function matchesFilter(ev: Event, filter: PrincipalFilter): boolean {
  if (filter.tenant !== undefined && ev.principal.tenant !== filter.tenant) return false;
  if (filter.session !== undefined && ev.principal.session !== filter.session) return false;
  if (filter.task !== undefined && ev.principal.task !== filter.task) return false;
  if (filter.agent !== undefined && ev.principal.agent !== filter.agent) return false;
  if (filter.types !== undefined && !filter.types.includes(ev.type)) return false;
  return true;
}

function assertPrincipal(p: Principal): void {
  if (
    p === null ||
    typeof p !== 'object' ||
    typeof p.tenant !== 'string' ||
    p.tenant.length === 0 ||
    (p.session !== null && typeof p.session !== 'string') ||
    (p.task !== null && typeof p.task !== 'string') ||
    (p.agent !== null && typeof p.agent !== 'string')
  ) {
    throw new InvalidPrincipal('tenant 必须为非空字符串,session/task/agent 须为 string | null');
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface ShardState {
  readonly relPath: string;
  handle: FileHandle | null;
  nextSeq: number;
  loaded: boolean;
  queue: Promise<unknown>;
}

export interface SkippedRecord {
  readonly path: string;
  readonly line: number;
  /** 未知事件类型的 type 值(结构坏到读不出 type 时为 null)。 */
  readonly type: string | null;
}

export interface ReplayOptions {
  /** 未知事件类型跳过时的通知(未知字段不通知 —— 那是正常前向兼容)。 */
  readonly onSkipped?: (record: SkippedRecord) => void;
}

export interface EventLogOptions {
  /** 分片策略;缺省单文件。 */
  readonly shard?: ShardStrategy;
  /** 重放发现崩溃截断的末行时是否修剪(默认 true)。 */
  readonly repair?: boolean;
  /** 时钟注入(测试用),默认 Date.prototype.toISOString。 */
  readonly now?: () => string;
  /** 订阅者回调抛错时的上报口;缺省静默隔离(不影响追加)。 */
  readonly onSubscriberError?: (err: unknown, event: Event) => void;
}

export class EventLog {
  readonly #root: string;
  readonly #shard: ShardStrategy | null;
  readonly #repair: boolean;
  readonly #now: () => string;
  readonly #onSubscriberError: ((err: unknown, event: Event) => void) | null;
  readonly #shards = new Map<string, ShardState>();
  readonly #subscribers = new Set<(event: Event) => void>();
  #closed = false;

  private constructor(root: string, opts: EventLogOptions) {
    this.#root = root;
    this.#shard = opts.shard ?? null;
    this.#repair = opts.repair ?? true;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#onSubscriberError = opts.onSubscriberError ?? null;
  }

  /** 打开(创建)事件日志根目录。目录不存在则创建;不扫描文件(分片懒加载)。 */
  static async open(root: string, opts: EventLogOptions = {}): Promise<EventLog> {
    await mkdir(root, { recursive: true });
    return new EventLog(root, opts);
  }

  // ---------------------------------------------------------------- 追加

  /**
   * 追加一个事件,返回带回填 seq / ts(未提供时)/ v 的完整事件。
   * 同一分片内严格串行;写盘 + fsync 成功后才返回并转发订阅者。
   */
  async append<P extends EventType>(input: EventInput<P>): Promise<Event<P>> {
    this.#assertOpen();
    if (!(EVENT_TYPES as readonly string[]).includes(input.type)) {
      throw new InvalidEvent(
        `未知事件类型 ${JSON.stringify(String(input.type))}` +
          '(append 只接受闭集;日志重放对未知 type 宽容)',
      );
    }
    if (!isPlainObject(input.payload)) {
      throw new InvalidEvent('payload 必须是普通对象');
    }
    assertPrincipal(input.principal);

    const st = await this.#shardFor(input.principal);
    return this.#enqueue(st, async () => {
      await this.#ensureLoaded(st);
      const seq = st.nextSeq;
      const event: Event<P> = Object.freeze({
        v: EVENT_LOG_VERSION,
        seq,
        ts: input.ts ?? this.#now(),
        type: input.type,
        principal: Object.freeze({ ...input.principal }),
        payload: Object.freeze({ ...input.payload }) as EventPayloads[P],
      });
      const fh = await this.#ensureHandle(st);
      await fh.write(Buffer.from(JSON.stringify(event) + '\n', 'utf8'));
      await fh.sync();
      st.nextSeq = seq + 1;
      this.#publish(event);
      return event;
    });
  }

  // ---------------------------------------------------------------- 重放

  /**
   * 按序迭代全部事件(跨分片按路径序,分片内按落盘序)。
   * 截断的末行被丢弃(可修剪);未知事件类型被跳过并经 onSkipped 上报;
   * 未知字段原样透传。中途损坏抛 EventCorrupt。
   */
  async *replay(opts: ReplayOptions = {}): AsyncIterable<Event> {
    this.#assertOpen();
    const rels = await this.#listShardFiles();
    for (const rel of rels) {
      const st = await this.#shardState(rel);
      const events = await this.#enqueue(st, async () => {
        return this.#loadShard(st, opts.onSkipped ?? null);
      });
      yield* events;
    }
  }

  // ---------------------------------------------------------------- 订阅

  /**
   * 订阅后续追加的事件(内存转发,供未来 SSE 聚合 / dashboard)。
   * 只转发本进程 append 的事件,不含重放;回调抛错被隔离,
   * 经 onSubscriberError 上报,不影响追加方。返回退订函数。
   */
  onEvent(cb: (event: Event) => void): () => void {
    this.#subscribers.add(cb);
    return () => {
      this.#subscribers.delete(cb);
    };
  }

  // ---------------------------------------------------------------- 查询

  /** 按 principal 过滤查询(四层任一字段可指定,精确匹配;可叠加类型过滤)。 */
  async readByPrincipal(filter: PrincipalFilter): Promise<Event[]> {
    const out: Event[] = [];
    for await (const ev of this.replay()) {
      if (matchesFilter(ev, filter)) out.push(ev);
    }
    return out;
  }

  // ---------------------------------------------------------------- 关闭

  async close(): Promise<void> {
    this.#closed = true;
    const handles = [...this.#shards.values()].map((st) => st.handle);
    this.#shards.clear();
    this.#subscribers.clear();
    for (const fh of handles) {
      if (fh !== null) await fh.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- 内部

  #assertOpen(): void {
    if (this.#closed) throw new EventLogClosed();
  }

  #fullPath(rel: string): string {
    return join(this.#root, ...rel.split('/'));
  }

  #relPathFor(principal: Principal): string {
    if (this.#shard === null) return DEFAULT_FILE;
    const rel = this.#shard(principal);
    if (rel === null) return DEFAULT_FILE;
    const segments = rel.replaceAll('\\', '/').split('/');
    for (const segment of segments) {
      if (!SEGMENT_RE.test(segment)) {
        throw new InvalidPrincipal(
          `分片路径段 ${JSON.stringify(segment)} 含非法字符(须匹配 ${SEGMENT_RE.source})`,
        );
      }
    }
    const last = segments[segments.length - 1];
    if (last === undefined || !last.endsWith('.jsonl')) {
      throw new InvalidPrincipal('分片路径必须以 .jsonl 结尾');
    }
    return segments.join('/');
  }

  async #shardFor(principal: Principal): Promise<ShardState> {
    return this.#shardState(this.#relPathFor(principal));
  }

  async #shardState(rel: string): Promise<ShardState> {
    let st = this.#shards.get(rel);
    if (st === undefined) {
      st = { relPath: rel, handle: null, nextSeq: 1, loaded: false, queue: Promise.resolve() };
      this.#shards.set(rel, st);
    }
    return st;
  }

  async #ensureLoaded(st: ShardState, onSkipped: ((r: SkippedRecord) => void) | null = null): Promise<void> {
    if (!st.loaded) await this.#loadShard(st, onSkipped);
  }

  async #ensureHandle(st: ShardState): Promise<FileHandle> {
    if (st.handle === null) {
      const full = this.#fullPath(st.relPath);
      await mkdir(dirname(full), { recursive: true });
      st.handle = await open(full, 'a');
    }
    return st.handle;
  }

  /** 同一分片串行化;前序失败不毒化队列(后续操作照常尝试)。 */
  #enqueue<T>(st: ShardState, fn: () => Promise<T>): Promise<T> {
    const run = st.queue.then(fn, fn);
    st.queue = run.catch(() => {});
    return run;
  }

  /**
   * 扫描分片文件:校验/修复截断,回填 st.nextSeq。
   * 返回本文件全部合法事件(含未知 type 的透传事件)。
   */
  async #loadShard(st: ShardState, onSkipped: ((r: SkippedRecord) => void) | null): Promise<Event[]> {
    const full = this.#fullPath(st.relPath);
    let buf: Buffer;
    try {
      buf = await readFile(full);
    } catch {
      st.nextSeq = 1;
      st.loaded = true;
      return [];
    }

    const events: Event[] = [];
    let pos = 0;
    let prevSeq = 0;
    let lineNo = 0;
    let truncatedFrom: number | null = null;
    let sealNewline = false;

    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      lineNo += 1;
      if (nl === -1) {
        // 文件末尾无换行符:完整事件(崩溃只可能吃掉结尾)或半行。
        const tail = buf.subarray(pos);
        const parsed = this.#parseLine(tail, st.relPath, lineNo, prevSeq);
        if (parsed === null) {
          truncatedFrom = pos;
        } else {
          if (parsed.skip !== null) onSkipped?.(parsed.skip);
          else events.push(parsed.event);
          prevSeq = parsed.seq;
          sealNewline = true; // 合法但缺结尾换行:补封,防止后续追加拼行
        }
        pos = buf.length;
        break;
      }
      const line = buf.subarray(pos, nl);
      if (line.length === 0) {
        throw new EventCorrupt(st.relPath, lineNo, '空行');
      }
      const parsed = this.#parseLine(line, st.relPath, lineNo, prevSeq);
      if (parsed === null) {
        // 有换行符结尾的行非法 = 不是崩溃截断形态,是真实损坏。
        throw new EventCorrupt(st.relPath, lineNo, '非法 JSON');
      }
      if (parsed.skip !== null) onSkipped?.(parsed.skip);
      else events.push(parsed.event);
      prevSeq = parsed.seq;
      pos = nl + 1;
    }

    if (truncatedFrom !== null && this.#repair) {
      // Windows 注:O_APPEND 句柄上 ftruncate 会 EPERM,须独立句柄修剪;
      // 此刻队列内无未落盘写入(每次 append 后都 fsync),并发安全。
      await truncate(full, truncatedFrom);
    }
    if (sealNewline) {
      const fh = await this.#ensureHandle(st);
      await fh.write(Buffer.from('\n', 'utf8'));
      await fh.sync();
    }

    st.nextSeq = prevSeq + 1;
    st.loaded = true;
    return events;
  }

  /**
   * 解析一行:合法返回事件(未知 type 时带 skip 记录),非法返回 null。
   * 未知字段不剥离(透传);seq 必须为严格递增的正整数(未知 type 行同样校验,
   * 否则 nextSeq 推导会被破坏)。
   */
  #parseLine(
    line: Buffer,
    rel: string,
    lineNo: number,
    prevSeq: number,
  ): { event: Event; seq: number; skip: SkippedRecord | null } | null {
    let raw: unknown;
    try {
      raw = JSON.parse(line.toString('utf8'));
    } catch {
      return null;
    }
    if (!isPlainObject(raw)) return null;
    const seq = raw['seq'];
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= prevSeq) return null;
    if (typeof raw['ts'] !== 'string' || typeof raw['type'] !== 'string' || !isPlainObject(raw['payload'])) {
      return null;
    }
    const type = raw['type'] as EventType;
    const known = (EVENT_TYPES as readonly string[]).includes(type);
    const event = raw as unknown as Event;
    return {
      event,
      seq,
      skip: known ? null : { path: rel, line: lineNo, type },
    };
  }

  /** 枚举当前落盘的全部分片文件(相对路径,排序;新分片文件也可被发现)。 */
  async #listShardFiles(): Promise<string[]> {
    const rels: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), rel);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          rels.push(rel);
        }
      }
    };
    await walk(this.#root, '');
    rels.sort();
    return rels;
  }

  #publish(event: Event): void {
    for (const cb of this.#subscribers) {
      try {
        cb(event);
      } catch (err) {
        this.#onSubscriberError?.(err, event);
      }
    }
  }
}
