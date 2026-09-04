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
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server } from 'node:http';
import { ArtifactRepository } from '../artifacts/index.ts';
import {
  GrantExecutor,
  defaultRegistry,
  minimalPresetDoc,
  parsePreset,
} from '../capability/index.ts';
import type { LoadedRegistry, Preset } from '../capability/index.ts';
import { EventLog } from '../events/index.ts';
import type { Event } from '../events/index.ts';
import { SessionRegistry, defaultProfile } from '../session/index.ts';
import type { DaemonProfile } from '../session/index.ts';
import { Operations, DEFAULT_TENANT, makeGrantSink } from './operations.ts';
import type { ApplyContext } from './operations.ts';
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_PORT, startHttpBinding, stopHttpBinding } from './http.ts';
import { DaemonPortInUse, DaemonError, RpcError } from './errors.ts';
import { generateToken, TOKEN_FILE_NAME, writeTokenFile } from './token.ts';
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

  // 1. 鉴权 token(§6:每次启动生成,绑定层必携)。
  const token = opts.token ?? generateToken();
  const tokenFile = await writeTokenFile(stateDir, token);

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
  const operations = new Operations(
    {
      profile,
      registry,
      sessions,
      grants,
      tasks,
      events,
      artifacts,
      presets,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    },
    apply,
  );

  // 4. daemon 生命周期事件:started(必记)+ recovered(有历史可重放时)。
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
  if (replayed.length > 0) {
    const inFlight = tasks.list().filter((t) => t.status === 'created').length;
    await events.append({
      type: 'daemon.recovered',
      principal: startedPrincipal,
      payload: { replayed: replayed.length, inFlight, corrected: 0, expired: 0 },
    });
  }

  // 5. localhost HTTP 绑定。
  const port = opts.port ?? DEFAULT_PORT;
  let server: Server;
  try {
    server = await startHttpBinding({
      port,
      token,
      handler: (method, params) => operations.call(method, params),
      isKnownMethod: Operations.has,
      ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
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
    async stop(): Promise<void> {
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
