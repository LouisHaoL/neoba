/**
 * 恢复对账骨架(§6 状态与恢复:事件溯源,daemon 重启可恢复):
 *
 *   恢复 = 重放事件 + 对账:
 *   - 重放构建内存态(调用方把 EventLog.replay() 流喂进来);
 *   - 对 in-flight 资源逐个对账:容器查 /status 实态 —— 查询逻辑经注入的
 *     reconciler 实现,本模块不持有 Provisioner(引擎不存在没关系,接口先立住);
 *   - TTL 定时器从落盘时间戳重推导(不是恢复内存里的定时器):绝对 ttl 直接
 *     生效,相对 duration 以事件 ts 为基准;已过期的标记给 reconciler 处置;
 *   - 重放态与实态不一致时以实态为准,记 correction 事件(§6),落同一份日志;
 *   - 收尾追加 daemon.recovered 事件。
 *
 * 兼容约定(§3.0 + §6 v0.2):流里出现的未知事件类型被跳过(计数进报告并
 * 可选通知),不炸 —— 升级 daemon 必须能重放旧日志。
 */
import { EventLog } from './log.ts';
import { EVENT_TYPES } from './types.ts';
import type { ReplayOptions } from './log.ts';
import type { CorrectionPayload, Event, TtlCarrier } from './types.ts';

// ---------------------------------------------------------------- TTL 重推导

const DURATION_RE = /^(\d+)([smhd])$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * 从事件推导 TTL 到期时刻:
 * - payload.ttl(绝对 ISO 8601)→ 直接生效;
 * - payload.duration(^\d+[smhd]$)→ 以事件落盘时间戳(ts)为基准重推导,
 *   而不是恢复时刻 —— 这是 §6 "TTL 定时器从落盘时间戳重推导" 的语义;
 * - 两者都没有 → null(无 TTL)。
 */
export function ttlDeadline(event: Event): string | null {
  const payload = event.payload as unknown as Partial<TtlCarrier>;
  if (payload.ttl != null) {
    const ms = Date.parse(payload.ttl);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (payload.duration != null) {
    const m = DURATION_RE.exec(payload.duration);
    const unit = m?.[2];
    if (m === null || unit === undefined) return null;
    const base = Date.parse(event.ts);
    if (Number.isNaN(base)) return null;
    const seconds = Number(m[1]) * (UNIT_SECONDS[unit] ?? 0);
    return new Date(base + seconds * 1000).toISOString();
  }
  return null;
}

// ---------------------------------------------------------------- in-flight 集合

/** in-flight 资源:重放后仍"活着"的容器 / 授权。 */
export interface InFlightResource {
  readonly kind: 'sandbox' | 'grant';
  /** 稳定标识:'sandbox:<id>' / 'grant:<scope>:<cap>'。 */
  readonly key: string;
  /** 该资源最近一条 in-flight 事件(其 principal/ts 即对账的命名空间与时间基准)。 */
  readonly event: Event;
  /** TTL 重推导的到期时刻;无 TTL 为 null。 */
  readonly deadline: string | null;
  /** 是否已过期(相对 now)。 */
  readonly ttlExpired: boolean;
}

/**
 * 重放事件流,收集 in-flight 资源:
 * - sandbox.created 起,至 sandbox.destroyed 止(重复 created/started 取最新);
 * - grant.granted 起,至同归属域同 cap 的 grant.revoked 止;
 * - 每个存活资源用其最近一条事件重新推导 TTL;
 * - 未知事件类型自然被忽略(不炸)。
 */
export async function collectInFlight(
  events: AsyncIterable<Event> | Iterable<Event>,
  now: string,
): Promise<InFlightResource[]> {
  const live = new Map<string, InFlightResource>();
  const nowMs = Date.parse(now);

  const upsert = (kind: InFlightResource['kind'], key: string, event: Event): void => {
    const deadline = ttlDeadline(event);
    const deadlineMs = deadline === null ? null : Date.parse(deadline);
    live.set(key, {
      kind,
      key,
      event,
      deadline,
      ttlExpired: deadlineMs !== null && !Number.isNaN(deadlineMs) && deadlineMs <= nowMs,
    });
  };

  for await (const ev of events) {
    if (ev.type === 'sandbox.created' || ev.type === 'sandbox.started') {
      const sandboxId = (ev.payload as { sandboxId?: unknown }).sandboxId;
      if (typeof sandboxId === 'string') upsert('sandbox', `sandbox:${sandboxId}`, ev);
    } else if (ev.type === 'sandbox.destroyed') {
      const sandboxId = (ev.payload as { sandboxId?: unknown }).sandboxId;
      if (typeof sandboxId === 'string') live.delete(`sandbox:${sandboxId}`);
    } else if (ev.type === 'grant.granted') {
      const cap = (ev.payload as { cap?: unknown }).cap;
      if (typeof cap === 'string') upsert('grant', `grant:${scopeKey(ev)}:${cap}`, ev);
    } else if (ev.type === 'grant.revoked') {
      const cap = (ev.payload as { cap?: unknown }).cap;
      if (typeof cap === 'string') live.delete(`grant:${scopeKey(ev)}:${cap}`);
    }
  }
  return [...live.values()];
}

/** 已过期的 in-flight 资源(TTL 从落盘时间戳重推导)。 */
export async function findExpired(
  events: AsyncIterable<Event> | Iterable<Event>,
  now: string,
): Promise<InFlightResource[]> {
  return (await collectInFlight(events, now)).filter((r) => r.ttlExpired);
}

/** grant 事件的归属域:优先 agent,其次 task,再次 session,最后 tenant。 */
function scopeKey(ev: Event): string {
  const p = ev.principal;
  return p.agent ?? p.task ?? p.session ?? p.tenant;
}

// ---------------------------------------------------------------- 对账流程

/** 对账结论载荷:重放态与实态不一致时,以实态为准记入 correction 事件。 */
export interface CorrectionSpec {
  readonly reason: string;
  readonly expected?: unknown;
  readonly observed?: unknown;
  readonly detail?: string;
}

export interface ReconcileContext {
  readonly resource: InFlightResource;
  /** 对账时刻(ISO 8601)。 */
  readonly now: string;
  /** 记一条 correction 事件(落同一份日志,principal 继承自 in-flight 事件)。 */
  emitCorrection(spec: CorrectionSpec): Promise<Event<'correction'>>;
}

export interface ReconcilerResult {
  /** consistent = 重放态与实态一致;corrected = 以实态为准,应记 correction。 */
  readonly verdict: 'consistent' | 'corrected';
  readonly detail?: string;
}

/** 注入的对账器:容器实态查询(§6 "逐个 in-flight 容器查 /status")在这里实现。 */
export type Reconciler = (ctx: ReconcileContext) => Promise<ReconcilerResult> | ReconcilerResult;

export interface RecoverReport {
  /** 消费的合法事件数(不含本次恢复追加的 correction / daemon.recovered)。 */
  readonly replayed: number;
  /** 跳过的未知事件类型数(升级 daemon 必须能重放旧日志)。 */
  readonly skipped: number;
  /** 对账时仍 in-flight 的资源数。 */
  readonly inFlight: number;
  /** 其中 TTL 已过期(从落盘时间戳重推导)的资源数。 */
  readonly expired: number;
  /** 本次记下的 correction 事件数。 */
  readonly corrected: number;
}

export interface RecoverOptions {
  /** 恢复时刻;缺省当前时间。 */
  readonly now?: string;
  /** 未知事件类型被跳过时的通知口。 */
  readonly onSkipped?: (info: { readonly type: string }) => void;
}

/**
 * 恢复流程:重放 → 收集 in-flight → 逐个对账(串行,确定性顺序)→
 * correction 落盘 → 追加 daemon.recovered。correction 必须进同一份审计日志
 * (§3.3 / §6:审计日志 = 事件日志,同一份),所以 log 与 events 通常来自
 * 同一个 EventLog。reconciler 报 corrected 却未 emit 时,补记一条兜底
 * correction,审计不留空洞。
 */
export async function recover(
  events: AsyncIterable<Event> | Iterable<Event>,
  reconciler: Reconciler,
  log: EventLog,
  options: RecoverOptions = {},
): Promise<RecoverReport> {
  const now = options.now ?? new Date().toISOString();

  let replayed = 0;
  let skipped = 0;
  const seen: Event[] = [];
  for await (const ev of events) {
    if (!(EVENT_TYPES as readonly string[]).includes(ev.type)) {
      skipped += 1;
      options.onSkipped?.({ type: String(ev.type) });
      continue;
    }
    replayed += 1;
    seen.push(ev);
  }

  const inFlight = await collectInFlight(seen, now);
  const expired = inFlight.filter((r) => r.ttlExpired).length;
  let corrected = 0;

  for (const resource of inFlight) {
    const before = corrected;
    const ctx: ReconcileContext = {
      resource,
      now,
      emitCorrection: (spec) => {
        corrected += 1;
        const payload: CorrectionPayload = {
          refSeq: resource.event.seq,
          target: resource.key,
          reason: spec.reason,
          ...(spec.expected !== undefined ? { expected: spec.expected } : {}),
          ...(spec.observed !== undefined ? { observed: spec.observed } : {}),
          ...(spec.detail !== undefined ? { detail: spec.detail } : {}),
        };
        return log.append({
          type: 'correction',
          principal: resource.event.principal,
          payload,
          ts: now,
        });
      },
    };
    const result = await reconciler(ctx);
    if (result.verdict === 'corrected' && corrected === before) {
      await ctx.emitCorrection({ reason: result.detail ?? 'reconciled' });
    }
  }

  await log.append({
    type: 'daemon.recovered',
    principal: { tenant: 'default', session: null, task: null, agent: null },
    payload: { replayed, inFlight: inFlight.length, corrected, expired },
    ts: now,
  });

  return {
    replayed,
    skipped,
    inFlight: inFlight.length,
    expired,
    corrected,
  };
}

/**
 * recover 的便捷入口:直接吃 EventLog,内部用 replay({ onSkipped }) 喂流,
 * 未知事件类型在重放层被摘除时的通知并入报告的 skipped 计数。
 * (直接调 recover 时,若传入的流已在重放层过滤未知类型,skipped 恒 0 ——
 * 那些跳过已经由流的 onSkipped 通知过。)
 */
export async function recoverFromLog(
  log: EventLog,
  reconciler: Reconciler,
  options: RecoverOptions = {},
): Promise<RecoverReport> {
  let skippedInReplay = 0;
  const replayOpts: ReplayOptions = {
    onSkipped: (r) => {
      skippedInReplay += 1;
      options.onSkipped?.({ type: r.type ?? '(unreadable)' });
    },
  };
  const report = await recover(log.replay(replayOpts), reconciler, log, options);
  return { ...report, skipped: report.skipped + skippedInReplay };
}
