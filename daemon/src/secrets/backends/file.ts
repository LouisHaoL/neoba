/**
 * FileSecretBackend:加密文件后端(§3.8 / §11,零第三方依赖约束下的取舍)。
 *
 * 落盘布局:
 *   {root}/{tenant}/{id}.bin          密文信封(单行文本,自带模式魔数)
 *   {root}/{tenant}/{id}.meta.json    元数据(id、description、createdAt、updatedAt)
 *   {root}/.key                       AES 模式的 256 位主密钥(仅非 Windows)
 *
 * 元数据与密文分离存放:明文只在 .bin 里,且永不以明文落盘;
 * list 只读 .meta.json,类型与实现上都不触碰密文。
 *
 * 加密取舍(两种模式,构造时定,信封魔数自描述):
 *   - dpapi(Windows 默认):经 powershell 子进程调 DPAPI Protect/Unprotect,
 *     CurrentUser 作用域;密钥由 Windows 按用户管理,不落盘,是首选。
 *   - aes-gcm(非 Windows 默认):AES-256-GCM,主密钥在 {root}/.key
 *     (首次自动生成,POSIX 上 chmod 0600)。密钥与密文同机是已知弱点,
 *     换来的是零依赖 + 跨进程可用;生产 Linux 应换 OS keyring 适配器(§11)。
 *
 * 原子写:.tmp + fsync + rename(Windows 上 rename 以
 * MOVEFILE_REPLACE_EXISTING 语义覆盖,指针替换原子)。
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dpapiProtect, dpapiUnprotect } from './dpapi.ts';
import { SecretBackendError, SecretCorrupt, SecretNotFound } from '../errors.ts';
import type {
  SecretBackend,
  SecretMetadata,
  SecretSetOptions,
  SecretValue,
} from '../types.ts';
import { assertSecretId, assertTenant } from '../validate.ts';

const ENVELOPE_MAGIC = 'neoba-secret/v1';

export type FileBackendMode = 'dpapi' | 'aes-gcm';

const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export interface FileSecretBackendOptions {
  /** 存储根目录。默认 ~/.neoba/secrets。 */
  readonly root?: string;
  /** 加密模式。默认按平台:win32 → dpapi,其余 → aes-gcm。 */
  readonly mode?: FileBackendMode;
  /** DPAPI 模式:powershell 可执行文件(测试注入用)。 */
  readonly powershellPath?: string;
  /** DPAPI 模式:子进程超时毫秒。 */
  readonly timeoutMs?: number;
}

/** 元数据文件内容(磁盘格式,v1)。 */
interface StoredMeta {
  v: 1;
  id: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export class FileSecretBackend implements SecretBackend {
  readonly kind = 'file' as const;

  readonly root: string;
  readonly mode: FileBackendMode;

  private readonly powershellPath: string | undefined;
  private readonly timeoutMs: number | undefined;
  private aesKey: Buffer | null = null;

  constructor(options?: FileSecretBackendOptions) {
    this.root =
      options?.root ?? join(homedir(), '.neoba', 'secrets');
    this.mode =
      options?.mode ?? (process.platform === 'win32' ? 'dpapi' : 'aes-gcm');
    this.powershellPath = options?.powershellPath;
    this.timeoutMs = options?.timeoutMs;
  }

  // ------------------------------------------------------------ 路径

  private tenantDir(tenant: string): string {
    return join(this.root, tenant);
  }

  private binPath(tenant: string, id: string): string {
    return join(this.tenantDir(tenant), `${id}.bin`);
  }

  private metaPath(tenant: string, id: string): string {
    return join(this.tenantDir(tenant), `${id}.meta.json`);
  }

  private keyPath(): string {
    return join(this.root, '.key');
  }

  // ------------------------------------------------------------ 原子写

  private async atomicWrite(
    path: string,
    data: string | Uint8Array,
  ): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  }

  // ------------------------------------------------------------ AES 主密钥

  private async loadAesKey(): Promise<Buffer> {
    if (this.aesKey !== null) return this.aesKey;
    const keyPath = this.keyPath();
    let raw: Buffer;
    try {
      raw = await readFile(keyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SecretBackendError(
          `读取密钥文件 ${keyPath} 失败: ${(err as Error).message}`,
        );
      }
      // 首次:生成并落盘,权限收紧(POSIX 0600;Windows 无 POSIX 位,尽力而为)。
      const key = randomBytes(AES_KEY_BYTES);
      await this.atomicWrite(keyPath, key);
      try {
        await chmod(keyPath, 0o600);
      } catch {
        // Windows 上 chmod 只能翻 read-only 位,失败不影响正确性。
      }
      this.aesKey = key;
      return key;
    }
    if (raw.length !== AES_KEY_BYTES) {
      throw new SecretCorrupt(
        null,
        null,
        `密钥文件 ${keyPath} 长度 ${raw.length},应为 ${AES_KEY_BYTES}`,
      );
    }
    this.aesKey = raw;
    return raw;
  }

  // ------------------------------------------------------------ 信封编解码

  private async encrypt(value: SecretValue): Promise<string> {
    const plain = Buffer.from(value, 'utf8');
    if (this.mode === 'dpapi') {
      const blob = await dpapiProtect(new Uint8Array(plain), {
        powershellPath: this.powershellPath,
        timeoutMs: this.timeoutMs,
      });
      return this.seal('dpapi', blob);
    }
    const key = await this.loadAesKey();
    const iv = randomBytes(AES_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return this.seal(
      'aes-gcm',
      Buffer.concat([iv, body, tag]),
    );
  }

  private seal(mode: FileBackendMode, blob: Uint8Array): string {
    return `${ENVELOPE_MAGIC}|${mode}|${Buffer.from(blob).toString('base64')}`;
  }

  private async decrypt(
    envelope: string,
    tenant: string,
    id: string,
  ): Promise<SecretValue> {
    const parts = envelope.split('|');
    if (parts.length !== 3 || parts[0] !== ENVELOPE_MAGIC) {
      throw new SecretCorrupt(tenant, id, '密文信封魔数不合法');
    }
    const mode = parts[1];
    const blobBase64 = parts[2]!;
    if (mode !== 'dpapi' && mode !== 'aes-gcm') {
      throw new SecretCorrupt(tenant, id, `未知加密模式 ${JSON.stringify(mode)}`);
    }
    const blob = (() => {
      try {
        return Buffer.from(blobBase64, 'base64');
      } catch {
        throw new SecretCorrupt(tenant, id, '密文不是合法 base64');
      }
    })();
    try {
      if (mode === 'dpapi') {
        const plain = await dpapiUnprotect(new Uint8Array(blob), {
          powershellPath: this.powershellPath,
          timeoutMs: this.timeoutMs,
          context: { tenant, id },
        });
        return Buffer.from(plain).toString('utf8');
      }
      const key = await this.loadAesKey();
      if (blob.length < AES_IV_BYTES + GCM_TAG_BYTES) {
        throw new SecretCorrupt(tenant, id, 'AES 信封长度不足');
      }
      const iv = blob.subarray(0, AES_IV_BYTES);
      const tag = blob.subarray(blob.length - GCM_TAG_BYTES);
      const body = blob.subarray(AES_IV_BYTES, blob.length - GCM_TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(body), decipher.final()]);
      return plain.toString('utf8');
    } catch (err) {
      if (err instanceof SecretCorrupt) throw err;
      if (err instanceof SecretBackendError) throw err;
      // GCM 认证失败 / DPAPI 解密失败都会走到这里 —— 统一类型化为损坏。
      throw new SecretCorrupt(
        tenant,
        id,
        `解密失败(${mode}): ${(err as Error).message}`,
      );
    }
  }

  // ------------------------------------------------------------ 元数据

  private async readMeta(
    tenant: string,
    id: string,
  ): Promise<StoredMeta | null> {
    let raw: string;
    try {
      raw = await readFile(this.metaPath(tenant, id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new SecretCorrupt(
        tenant,
        id,
        `元数据不可读: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SecretCorrupt(
        tenant,
        id,
        `元数据不是合法 JSON: ${(err as Error).message}`,
      );
    }
    const meta = parsed as Partial<StoredMeta> | null;
    if (
      typeof meta !== 'object' ||
      meta === null ||
      meta.v !== 1 ||
      typeof meta.id !== 'string' ||
      typeof meta.createdAt !== 'string' ||
      typeof meta.updatedAt !== 'string'
    ) {
      throw new SecretCorrupt(tenant, id, '元数据字段缺失或类型不符');
    }
    const description = meta.description;
    return {
      v: 1,
      id: meta.id,
      description:
        typeof description === 'string' ? description : null,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
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
    await mkdir(this.tenantDir(tenant), { recursive: true });
    const existing = await this.readMeta(tenant, secretId);
    const now = new Date().toISOString();
    const meta: StoredMeta = {
      v: 1,
      id: secretId,
      description: options?.description ?? existing?.description ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    // 先写密文后写元数据:元数据是提交标记,读侧以密文为准。
    await this.atomicWrite(
      this.binPath(tenant, secretId),
      await this.encrypt(value),
    );
    await this.atomicWrite(
      this.metaPath(tenant, secretId),
      JSON.stringify(meta, null, 2) + '\n',
    );
    return {
      id: meta.id,
      description: meta.description,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
  }

  async get(tenant: string, secretId: string): Promise<SecretValue> {
    assertTenant(tenant);
    assertSecretId(secretId);
    let envelope: string;
    try {
      envelope = await readFile(this.binPath(tenant, secretId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SecretNotFound(tenant, secretId);
      }
      throw new SecretCorrupt(
        tenant,
        secretId,
        `密文不可读: ${(err as Error).message}`,
      );
    }
    return this.decrypt(envelope, tenant, secretId);
  }

  async delete(tenant: string, secretId: string): Promise<boolean> {
    assertTenant(tenant);
    assertSecretId(secretId);
    let existed = false;
    for (const path of [this.binPath(tenant, secretId), this.metaPath(tenant, secretId)]) {
      try {
        await rm(path);
        existed = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new SecretBackendError(
            `删除 ${path} 失败: ${(err as Error).message}`,
          );
        }
      }
    }
    return existed;
  }

  async list(tenant: string): Promise<readonly SecretMetadata[]> {
    assertTenant(tenant);
    let names: string[];
    try {
      names = await readdir(this.tenantDir(tenant));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new SecretBackendError(
        `扫描 tenant 目录失败: ${(err as Error).message}`,
      );
    }
    const out: SecretMetadata[] = [];
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const id = name.slice(0, -'.meta.json'.length);
      const meta = await this.readMeta(tenant, id);
      if (meta === null) continue;
      out.push({
        id: meta.id,
        description: meta.description,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
