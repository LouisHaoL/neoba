/**
 * daemon 服务壳(§6):服务为核,工具为壳,MCP 为桥。
 *
 * startDaemon:
 *   1. 读/建状态目录(默认 ~/.neoba/,可注入);
 *   2. 生成鉴权 token 落盘(0o600,Windows 尽力而为 + warning);
 *   3. 初始化 EventLog(daemon.started)→ 重放恢复 TaskStore(任务态 = 事件重放)
 *      → ArtifactRepository → CapabilityRegistry → SessionRegistry →
 *      GrantExecutor(注入 EventLog 为审计 sink);
 *   4. 起 localhost JSON-RPC HTTP 绑定(127.0.0.1,Bearer token 强制校验)。
 *
 * 全局状态写入的原子性说明:任务/授权/工件元数据的状态变更统一走事件日志追加,
 * EventLog.append 本身是原子的(O_APPEND 单写者 + 分片内 promise 链串行 +
 * fsync 后才可见),内存态只是重放缓存,因此无需额外全局锁。
 *
 * stopDaemon:停止接受请求(HTTP close)→ 状态标记文件落 stoppedAt →
 * flush 关闭工件仓库与事件日志(每次 append 已 fsync,close 是兜底 flush)。
 * 注:events 模块的事件类型闭集没有 daemon.stopped,停止标记落在
 * `<stateDir>/daemon-state.json`(原子写),不滥用既有事件类型污染审计流。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server } from 'node:http';
import { ArtifactRepository, collectArtifactGc, isTerminalStatus } from '../artifacts/index.ts';
import type { GcCollectResult } from '../artifacts/index.ts';
import {
  GrantExecutor,
  defaultRegistry,
  minimalPresetDoc,
  parsePreset,
} from '../capability/index.ts';
import type { GrantConstraint, LoadedRegistry, Preset, Scope } from '../capability/index.ts';
import { EventLog } from '../events/index.ts';
import type { Event } from '../events/index.ts';
import { recoverFromLog } from '../events/recover.ts';
import type { RecoverReport } from '../events/recover.ts';
import { SessionRegistry, defaultProfile } from '../session/index.ts';
import type { DaemonProfile } from '../session/index.ts';
import { MemoryProvider } from '../provision/index.ts';
import type { SandboxPool } from '../provision/warm-pool.ts';
import type { SandboxProvider } from '../provision/types.ts';
import { NodeExecutor, WorkflowEngine, makeExecRuntime } from '../engine/index.ts';
import type { NodeRuntime } from '../engine/index.ts';
import type { SecretInjector } from '../engine/node-executor.ts';
import { ApprovalBoard, presetPolicyLayer } from '../approval/index.ts';
import type { PolicyLayer } from '../approval/index.ts';
import { BudgetLedger } from '../budget/index.ts';
import { loadModelRegistry } from '../modelscore/index.ts';
import type { LoadedModelRegistry } from '../modelscore/index.ts';
import type { SecretStore } from '../secrets/index.ts';
import { Operations, DEFAULT_TENANT, makeGrantSink } from './operations.ts';
import type { ApplyContext } from './operations.ts';
import { ModelRegistryStore, makeApprovalEmit, makeEngineEmit, sandboxReconciler } from './wiring.ts';
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_PORT, startHttpBinding, stopHttpBinding } from './http.ts';
import { DaemonPortInUse, DaemonError, RpcError } from './errors.ts';
import { generateToken, TOKEN_FILE_NAME, writeTokenFile } from './token.ts';
import { TokenRegistry } from './identity.ts';
import { replayTasks, TaskStore } from './tasks.ts';

export const DAEMON_VERSION = '0.1.0';
const STATE_FILE_NAME = 'daemon-state.json';

export interface DaemonOptions {
  /** 状态目录;缺省 ~/.neoba/。 */
  readonly stateDir?: string;
  /** 监听端口;缺省 7917,0 = 随机空闲端口(测试用)。冲突时报 PORT_IN_USE。 */
  readonly port?: number;
  readonly daemonVersion?: string;
  readonly profile?: DaemonProfile;
  readonly registry?: LoadedRegistry;
  /** 预设集(task.create 按 name 引用);缺省内置 minimal。 */
  readonly presets?: Readonly<Record<string, Preset>>;
  /** 注入 token(测试);缺省每次启动随机生成。 */
  readonly token?: string;
  readonly maxBodyBytes?: number;
  readonly now?: () => Date;
  // ---- P2 执行面(缺省 = MemoryProvider + ExecRuntime 参考实现) ----
  /** 沙箱供给后端(§5);缺省 MemoryProvider(进程内,重启即失)。 */
  readonly provider?: SandboxProvider;
  /**
   * 预热池(M7,§9 P4;可选):给出时 NodeExecutor 的沙箱取用/归还走池
   * (命中回热 / 冷拉;健康回池 / 否则销毁),与 ResourceGate 共用信号量的
   * 装配见 cli/deps.ts。缺省不建池,现行为零漂移。
   */
  readonly pool?: SandboxPool;
  /** 节点基座镜像(缺省 neoba/sandbox:latest;memory 后端忽略)。 */
  readonly image?: string;
  /** 节点内跑基座的 runtime;缺省 makeExecRuntime(provider)。 */
  readonly runtime?: NodeRuntime;
  /** SecretStore(workflow 节点声明 secret_ids 时注入容器 env;§3.8)。 */
  readonly secrets?: SecretStore;
  /** Model Score Registry;缺省读 <stateDir>/modelscore.json,没有则空表。 */
  readonly models?: LoadedModelRegistry;
  /** escalation 授予 TTL 回收扫描间隔(ms);0 = 关闭。缺省 30s。 */
  readonly reclaimIntervalMs?: number;
  /** 工件自动 GC 扫描间隔(ms);0 = 关闭。缺省 10min(见 artifacts/gc.ts)。 */
  readonly gcIntervalMs?: number;
  /** SSE(/events/stream)心跳间隔 ms;0 = 关闭。缺省 15s(M4,测试可调短)。 */
  readonly sseHeartbeatMs?: number;
  /**
   * 审批策略 session 层(§3.3 分层:builtin < global < preset < session)。
   * 按申请 agent 所属任务的前两层回调;缺省不注入(现语义 = 只到 preset 层)。
   */
  readonly sessionPolicyLayers?: (tenant: string, session: string) => readonly PolicyLayer[];
}

export interface DaemonHandle {
  readonly stateDir: string;
  readonly token: string;
  readonly tokenFile: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly daemonVersion: string;
  /** 启动期告警(token 权限尽力而为等)。 */
  readonly warnings: readonly string[];
  readonly events: EventLog;
  readonly artifacts: ArtifactRepository;
  readonly tasks: TaskStore;
  readonly sessions: SessionRegistry;
  readonly grants: GrantExecutor;
  readonly operations: Operations;
  /** per-session token 注册表(M3 双 token 模型;测试/运维可查 size)。 */
  readonly tokens: TokenRegistry;
  /** 恢复对账报告(§6;重放数/in-flight/correction 数)。 */
  readonly recovered: RecoverReport;
  readonly provider: SandboxProvider;
  readonly engine: WorkflowEngine;
  readonly board: ApprovalBoard;
  readonly budgets: Map<string, BudgetLedger>;
  readonly models: ModelRegistryStore;
  /** 工件自动 GC 扫描间隔(ms);0 = 关闭(与 opts.gcIntervalMs 同源)。 */
  readonly gcIntervalMs: number;
  /** 手动触发一轮工件自动 GC(与守护定时器同一实现;plan 摘要落 artifact.gc 事件)。 */
  runGc(): Promise<GcCollectResult>;
  stop(): Promise<void>;
}

/** P1 内置预设:最小基线(fs:workdir rw)。 */
export function defaultPresets(): Record<string, Preset> {
  return {
    minimal: parsePreset(
      minimalPresetDoc({ baseline_grants: [{ cap: 'fs:workdir', scope: 'rw' }] }),
    ),
  };
}

function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  return writeFile(tmp, text, 'utf8').then(() => rename(tmp, path));
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const version = opts.daemonVersion ?? DAEMON_VERSION;
  const stateDir = opts.stateDir ?? join(homedir(), '.neoba');
  await mkdir(stateDir, { recursive: true });

  // 1. 鉴权 token(§6:每次启动生成,绑定层必携)+ 会话 token 注册表
  //    (M3 双 token 模型:hash 表从 tokens.json 恢复,会话须重新握手激活)。
  const token = opts.token ?? generateToken();
  const tokenFile = await writeTokenFile(stateDir, token);
  const tokens = await TokenRegistry.open(stateDir);

  // 2. 事件日志 + 重放恢复。
  const events = await EventLog.open(join(stateDir, 'events'));
  const replayed: Event[] = [];
  for await (const ev of events.replay()) replayed.push(ev);
  const tasks = replayTasks(replayed);

  // 3. 工件仓库 / 注册表 / 会话表 / 基线授予执行器(EventLog 即审计 sink)。
  const artifacts = await ArtifactRepository.open(join(stateDir, 'artifacts'));
  const registry = opts.registry ?? defaultRegistry();
  const sessions = new SessionRegistry();
  const apply = new AsyncLocalStorage<ApplyContext>();
  const grants = new GrantExecutor(registry, { sink: makeGrantSink(apply, events) });
  const profile = opts.profile ?? defaultProfile(version);
  const presets = opts.presets ?? defaultPresets();

  // ---- P2 执行面:供给后端 / runtime / 引擎 / 审批台账 / 预算表 / 模型评分 ----
  const provider = opts.provider ?? new MemoryProvider();
  const runtime = opts.runtime ?? makeExecRuntime(provider);
  const secretInjector: SecretInjector | undefined = opts.secrets === undefined
    ? undefined
    : {
        resolve: (tenant, secretId) =>
          opts.secrets?.get(tenant, secretId).then((value) => ({ name: secretId, value })) ??
          Promise.reject(new Error('SecretStore 消失')),
      };
  const engineEmit = makeEngineEmit(events, tasks);
  const executor = new NodeExecutor({
    provider,
    runtime,
    artifacts,
    grants,
    emit: engineEmit,
    // 引擎路径的基线授予审计(issue #1):进 task.create 同一 ALS 上下文,
    // grant sink 据此落 grant.granted(principal 带 task/agent 两层,与
    // task.create 同一事件形状);manifest 快照同步 TaskStore,grants.of
    // 即时可见,重启重放与实态一致(§6 唯一事实源)。
    withGrantAudit: async (ctx, applyBaseline) => {
      const applied = await apply.run(ctx, applyBaseline);
      tasks.setManifest(applied.manifest);
      return applied;
    },
    ...(opts.pool !== undefined ? { pool: opts.pool } : {}),
    ...(opts.image !== undefined ? { image: opts.image } : {}),
    ...(secretInjector !== undefined ? { secrets: secretInjector } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const engine = new WorkflowEngine({ executor, artifacts, presets, emit: engineEmit });
  const budgets = new Map<string, BudgetLedger>();
  const board = new ApprovalBoard({
    registry,
    grants,
    emit: makeApprovalEmit(events, tasks),
    // 策略层快照:按申请 agent 的任务记录取其预设层 + session 覆盖层
    // (builtin 兜底层 board 自补;§3.3 分层语义,session 层缺省不注入)。
    layers: (agentId) => {
      const idx = agentId.indexOf('/');
      const record = idx > 0 ? tasks.get(agentId.slice(0, idx)) : undefined;
      const preset = record !== undefined ? presets[record.preset] : undefined;
      const sessionLayers =
        record !== undefined && record.session !== null && opts.sessionPolicyLayers !== undefined
          ? opts.sessionPolicyLayers(record.tenant, record.session)
          : [];
      return [
        ...(record !== undefined && preset !== undefined
          ? [presetPolicyLayer(record.preset, preset)]
          : []),
        ...sessionLayers,
      ];
    },
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  // 启动重放(issue #14):从重放事件重建审批台账,重启后 pending 单仍可
  // decide(否则 TaskStore 把任务标回 waiting_approval 却永远无人能定案)。
  // 残缺事件被保守跳过,不阻断启动。
  board.restoreFromEvents(replayed);
  const modelsPath = join(stateDir, 'modelscore.json');
  let initialModels: LoadedModelRegistry;
  if (opts.models !== undefined) {
    initialModels = opts.models;
  } else {
    try {
      initialModels = loadModelRegistry(JSON.parse(await readFile(modelsPath, 'utf8')));
    } catch {
      initialModels = loadModelRegistry({ api: 'modelscore/1.0', models: [] });
    }
  }
  const models = new ModelRegistryStore(initialModels);

  const operations = new Operations(
    {
      profile,
      registry,
      sessions,
      tokens,
      grants,
      tasks,
      events,
      artifacts,
      presets,
      engine,
      board,
      budgets,
      models,
      modelsPath,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    },
    apply,
  );

  // 4. daemon 生命周期事件:started(必记)+ 恢复对账(§6:in-flight 资源
  //    逐个查 provider 实态,correction 落同一份日志,daemon.recovered 收尾)。
  //    首次启动(无可重放历史)不记 recovered,保持事件流干净。
  const startedPrincipal = {
    tenant: DEFAULT_TENANT,
    session: null,
    task: null,
    agent: null,
  };
  await events.append({
    type: 'daemon.started',
    principal: startedPrincipal,
    payload: { pid: process.pid, version },
  });
  let recovered: RecoverReport = { replayed: 0, skipped: 0, inFlight: 0, expired: 0, corrected: 0 };
  if (replayed.length > 0) {
    recovered = await recoverFromLog(
      events,
      sandboxReconciler(provider),
      ...(opts.now !== undefined ? [{ now: opts.now().toISOString() }] : []),
    );
  }

  // escalation 授予跨重启恢复(重放的 grant.granted → GrantExecutor 内存),
  // TTL 回收守护因此能看到重启前批出的授予;重复/失效条目不阻断启动。
  for (const ev of replayed) {
    if (ev.type !== 'grant.granted' || ev.principal.agent === null) continue;
    const payload = ev.payload as unknown as Record<string, unknown>;
    const source = typeof payload['source'] === 'string' ? payload['source'] : '';
    if (!source.startsWith('escalation:')) continue;
    await grants
      .grant(ev.principal.agent, {
        cap: String(payload['cap'] ?? ''),
        scope: String(payload['scope'] ?? 'read') as Scope,
        source,
        ttl: typeof payload['ttl'] === 'string' ? payload['ttl'] : null,
        ...(payload['constraint'] !== undefined
          ? { constraint: payload['constraint'] as GrantConstraint }
          : {}),
        ...(typeof payload['decisionSource'] === 'string'
          ? { decisionSource: payload['decisionSource'] as string }
          : {}),
      })
      .catch(() => {});
  }

  // 5. localhost HTTP 绑定。
  const port = opts.port ?? DEFAULT_PORT;
  let server: Server;
  try {
    server = await startHttpBinding({
      port,
      token,
      tokens,
      events,
      handler: (method, params, identity) => operations.call(method, params, identity),
      isKnownMethod: Operations.has,
      ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
      ...(opts.sseHeartbeatMs !== undefined ? { sseHeartbeatMs: opts.sseHeartbeatMs } : {}),
    });
  } catch (err) {
    await artifacts.close().catch(() => {});
    await events.close().catch(() => {});
    if (
      (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ||
      (err instanceof RpcError && (err.data as Record<string, unknown> | undefined)?.['code'] === 'PORT_IN_USE')
    ) {
      throw new DaemonPortInUse(port);
    }
    throw err;
  }
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  const statePath = join(stateDir, STATE_FILE_NAME);
  const warnings = tokenFile.warnings;
  // escalation TTL 回收守护(§3.3):周期扫描到期授予并补记 grant.revoked。
  const reclaimIntervalMs = opts.reclaimIntervalMs ?? 30_000;
  const reclaimTimer = reclaimIntervalMs > 0
    ? setInterval(() => {
        void board.reclaimExpired().catch(() => {});
      }, reclaimIntervalMs)
    : null;
  reclaimTimer?.unref?.();
  // 工件自动 GC 守护(M5,artifacts/gc.ts):周期 plan/collect,plan 摘要落
  // artifact.gc 事件;终态判定取重放/实态共用的 TaskStore(未知任务保守按非终态)。
  const gcIntervalMs = opts.gcIntervalMs ?? 600_000;
  const runGc = (): Promise<GcCollectResult> =>
    collectArtifactGc(artifacts, {
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      isTerminal: (taskId) => {
        const record = tasks.get(taskId);
        return record !== undefined && isTerminalStatus(record.status);
      },
      emit: (input) => events.append(input),
      principal: startedPrincipal,
    });
  const gcTimer = gcIntervalMs > 0
    ? setInterval(() => {
        void runGc().catch(() => {});
      }, gcIntervalMs)
    : null;
  gcTimer?.unref?.();
  await atomicWrite(
    statePath,
    JSON.stringify(
      {
        pid: process.pid,
        version,
        port: boundPort,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
      },
      null,
      2,
    ) + '\n',
  );

  const handle: DaemonHandle = {
    stateDir,
    token,
    tokenFile: tokenFile.path,
    port: boundPort,
    baseUrl: `http://127.0.0.1:${boundPort}`,
    daemonVersion: version,
    warnings,
    events,
    artifacts,
    tasks,
    sessions,
    grants,
    operations,
    tokens,
    recovered,
    provider,
    engine,
    board,
    budgets,
    models,
    gcIntervalMs,
    runGc,
    async stop(): Promise<void> {
      if (reclaimTimer !== null) clearInterval(reclaimTimer);
      if (gcTimer !== null) clearInterval(gcTimer);
      await stopHttpBinding(server);
      await atomicWrite(
        statePath,
        JSON.stringify(
          {
            pid: process.pid,
            version,
            port: boundPort,
            startedAt: new Date().toISOString(),
            stoppedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
      );
      await artifacts.close();
      await events.close();
    },
  };
  return handle;
}

/** 优雅关闭(stopDaemon = handle.stop())。 */
export async function stopDaemon(handle: DaemonHandle): Promise<void> {
  await handle.stop();
}

export { DaemonError, TOKEN_FILE_NAME };
