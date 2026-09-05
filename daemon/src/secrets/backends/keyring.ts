/**
 * Linux keyring 桥(libsecret `secret-tool`,仅 Linux)。
 *
 * 零第三方依赖约束下经 secret-tool 子进程读写 OS keyring(GNOME Keyring /
 * KWallet 经 libsecret D-Bus 服务)。凭据按属性寻址:
 *   service=neoba  tenant=<t>  id=<i>
 * 值经 stdin 进出,不落命令行(进程列表/审计不可见)。
 *
 * secret-tool 无枚举能力,而 SecretBackend 契约要求 list(只出元数据,
 * §3.5g)—— 因此在本机保留一份**只含元数据**的索引文件
 * (<indexRoot>/<tenant>.index.json);值的唯一真源仍是 keyring。
 *
 * binary / timeoutMs / runner 全部可注入(仿 dpapi.ts):测试用假 runner
 * 覆盖全矩阵,不依赖真 keyring。不可用(secret-tool 缺失 / spawn 失败)抛
 * SecretBackendUnavailable —— **不静默降级**到弱后端(§3.8)。
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SecretBackendError,
  SecretBackendTimeout,
  SecretBackendUnavailable,
  SecretNotFound,
} from '../errors.ts';
import type {
  SecretBackend,
  SecretMetadata,
  SecretSetOptions,
  SecretValue,
} from '../types.ts';
import { assertSecretId, assertTenant } from '../validate.ts';

export const DEFAULT_SECRET_TOOL = 'secret-tool';
export const DEFAULT_KEYRING_TIMEOUT_MS = 10_000;
/** 属性 service 的固定取值:neoba 的凭据桶与其他应用的 keyring 条目隔离。 */
export const KEYRING_SERVICE = 'neoba';

/** 一次 secret-tool 执行的标准化结果(仿 doctor 的 ExecResult)。 */
export interface SecretToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * secret-tool 执行器。binary/args/input/timeoutMs 全由后端给定;
 * 注入假实现即可在任意平台跑全矩阵测试。
 */
export type SecretToolRunner = (
  binary: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
) => Promise<SecretToolResult>;

/** 默认执行器:spawn 子进程,stdin 送值,超时杀进程,错误类型化传播。 */
export function defaultSecretToolRunner(
  binary: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
): Promise<SecretToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    // 守护进程场景:不因这枚定时器拖住进程退出。
    timer.unref();

    const fail = (err: SecretBackendError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err: Error) => {
      // ENOENT = secret-tool 缺失:这是"环境没有该后端",单独类型化,
      // 调用方据此显式失败,绝不静默降级(§3.8)。
      fail(
        err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new SecretBackendUnavailable(`未找到 ${binary}(请安装 libsecret 工具)`)
          : new SecretBackendUnavailable(`${binary} 子进程启动失败: ${err.message}`),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (timedOut) {
        fail(
          new SecretBackendTimeout(
            `${binary} 子进程超时(>${timeoutMs}ms)被终止`,
            timeoutMs,
          ),
        );
        return;
      }
      settled = true;
      resolve({ code: code ?? -1, stdout, stderr });
    });

    // 子进程提前退出时写 stdin 会 EPIPE,吞掉以免砸出未捕获异常。
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
  });
}

export interface KeyringSecretBackendOptions {
  /** secret-tool 可执行文件(默认 'secret-tool',测试可注入假路径)。 */
  readonly binary?: string;
  /** 子进程超时毫秒(默认 10s)。 */
  readonly timeoutMs?: number;
  /** 执行器(测试注入假 runner;缺省真实 spawn)。 */
  readonly runner?: SecretToolRunner;
  /** 元数据索引目录(默认 ~/.neoba/secrets;与 file 后端共用根,不冲突)。 */
  readonly indexRoot?: string;
}

/** 索引文件条目:只有元数据,**没有能装凭据明文的字段**(§3.5g)。 */
interface KeyringIndexEntry {
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 索引文件磁盘格式(v1)。 */
interface KeyringIndexFile {
  v: 1;
  entries: Record<string, KeyringIndexEntry>;
}

export class KeyringSecretBackend implements SecretBackend {
  readonly kind = 'keyring' as const;

  readonly binary: string;
  readonly timeoutMs: number;
  readonly indexRoot: string;

  private readonly runner: SecretToolRunner;

  constructor(options?: KeyringSecretBackendOptions) {
    this.binary = options?.binary ?? DEFAULT_SECRET_TOOL;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_KEYRING_TIMEOUT_MS;
    this.runner = options?.runner ?? defaultSecretToolRunner;
    this.indexRoot = options?.indexRoot ?? join(homedir(), '.neoba', 'secrets');
  }

  // ------------------------------------------------------------ keyring 访问

  /** 属性定位串:service=neoba tenant=<t> id=<i>(secret-tool 的 argv 序列)。 */
  private attrArgs(tenant: string, secretId: string): string[] {
    return ['service', KEYRING_SERVICE, 'tenant', tenant, 'id', secretId];
  }

  private async run(
    op: 'store' | 'lookup' | 'clear',
    tenant: string,
    secretId: string,
    input: string,
  ): Promise<SecretToolResult> {
    const args =
      op === 'store'
        ? [`--label=${KEYRING_SERVICE}:${tenant}/${secretId}`, ...this.attrArgs(tenant, secretId)]
        : this.attrArgs(tenant, secretId);
    return this.runner(this.binary, [op, ...args], input, this.timeoutMs);
  }

  /** lookup:空输出 = 无此条目(secret-tool 对缺失条目安静地零输出)。 */
  private async lookup(
    tenant: string,
    secretId: string,
  ): Promise<string | null> {
    let result: SecretToolResult;
    try {
      result = await this.run('lookup', tenant, secretId, '');
    } catch (err) {
      // runner 抛出的类型化错误(不可用/超时)原样传播;其他统一收编。
      if (err instanceof SecretBackendError) throw err;
      throw new SecretBackendError(
        `secret-tool lookup 失败(${tenant}/${secretId}): ${(err as Error).message}`,
      );
    }
    if (result.code !== 0) {
      throw new SecretBackendError(
        `secret-tool lookup 退出码 ${result.code}: ` +
          `${result.stderr.trim().slice(0, 500) || '(无 stderr)'}`,
      );
    }
    return result.stdout === '' ? null : result.stdout;
  }

  // ------------------------------------------------------------ 元数据索引

  private indexPath(tenant: string): string {
    return join(this.indexRoot, `${tenant}.index.json`);
  }

  private async readIndex(tenant: string): Promise<KeyringIndexFile> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath(tenant), 'utf8');
    } catch {
      // 无索引 = 空桶(值在 keyring 里,索引只服务 list)。
      return { v: 1, entries: {} };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const file = parsed as Partial<KeyringIndexFile> | null;
      if (
        typeof file !== 'object' ||
        file === null ||
        file.v !== 1 ||
        typeof file.entries !== 'object' ||
        file.entries === null
      ) {
        return { v: 1, entries: {} };
      }
      return { v: 1, entries: file.entries };
    } catch {
      // 索引损坏不影响值的存取(keyring 是真源),按空桶处理。
      return { v: 1, entries: {} };
    }
  }

  private async writeIndex(tenant: string, file: KeyringIndexFile): Promise<void> {
    await mkdir(this.indexRoot, { recursive: true });
    const path = this.indexPath(tenant);
    const tmp = `${path}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  }

  private toMeta(secretId: string, entry: KeyringIndexEntry): SecretMetadata {
    return {
      id: secretId,
      description: entry.description,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  // ------------------------------------------------------------ SecretBackend

  async set(
    tenant: string,
    secretId: string,
    value: SecretValue,
    options?: SecretSetOptions,
  ): Promise<SecretMetadata> {
    assertTenant(tenant);
    assertSecretId(secretId);
    if (typeof value !== 'string') {
      throw new TypeError('secret value 必须是 string');
    }
    if (value === '') {
      // lookup 对缺失条目零输出,空值在读取侧无法与"不存在"区分 —— 显式拒绝。
      throw new SecretBackendError(
        `keyring 后端不支持空凭据值(${tenant}/${secretId})`,
      );
    }
    const result = await this.run('store', tenant, secretId, value).catch(
      (err: unknown) => {
        if (err instanceof SecretBackendError) throw err;
        throw new SecretBackendError(
          `secret-tool store 失败(${tenant}/${secretId}): ${(err as Error).message}`,
        );
      },
    );
    if (result.code !== 0) {
      throw new SecretBackendError(
        `secret-tool store 退出码 ${result.code}: ` +
          `${result.stderr.trim().slice(0, 500) || '(无 stderr)'}`,
      );
    }
    const index = await this.readIndex(tenant);
    const now = new Date().toISOString();
    const existing = index.entries[secretId];
    const entry: KeyringIndexEntry = {
      description: options?.description ?? existing?.description ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    index.entries[secretId] = entry;
    await this.writeIndex(tenant, index);
    return this.toMeta(secretId, entry);
  }

  async get(tenant: string, secretId: string): Promise<SecretValue> {
    assertTenant(tenant);
    assertSecretId(secretId);
    const value = await this.lookup(tenant, secretId);
    if (value === null) throw new SecretNotFound(tenant, secretId);
    return value;
  }

  async delete(tenant: string, secretId: string): Promise<boolean> {
    assertTenant(tenant);
    assertSecretId(secretId);
    // clear 对缺失条目也返回 0,先探一次才知道是否真的删了东西。
    const existing = await this.lookup(tenant, secretId);
    if (existing === null) return false;
    const result = await this.run('clear', tenant, secretId, '').catch(
      (err: unknown) => {
        if (err instanceof SecretBackendError) throw err;
        throw new SecretBackendError(
          `secret-tool clear 失败(${tenant}/${secretId}): ${(err as Error).message}`,
        );
      },
    );
    if (result.code !== 0) {
      throw new SecretBackendError(
        `secret-tool clear 退出码 ${result.code}: ` +
          `${result.stderr.trim().slice(0, 500) || '(无 stderr)'}`,
      );
    }
    const index = await this.readIndex(tenant);
    delete index.entries[secretId];
    await this.writeIndex(tenant, index);
    return true;
  }

  async list(tenant: string): Promise<readonly SecretMetadata[]> {
    assertTenant(tenant);
    const index = await this.readIndex(tenant);
    return Object.entries(index.entries)
      .map(([id, entry]) => this.toMeta(id, entry))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
