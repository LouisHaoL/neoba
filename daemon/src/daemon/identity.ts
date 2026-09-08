/**
 * per-session token 注册表(§6 v0.3 M3 双 token 模型):
 *
 * - bootstrap token(daemon.ts 每次启动生成)语义不变 = admin 身份,
 *   现有 golden / CLI / MCP 桥路径零漂移;
 * - session.init 成功后签发会话 token,绑定 (tenant, session) 二元组,
 *   明文只在签发应答里出现一次,注册表只落 sha256;
 * - 持久化 `<stateDir>/tokens.json`(0600 尽力而为,原子写),重启后
 *   hash 表恢复(会话本身仍须重新 session.init 激活,token 才可用);
 * - verify(presented) 返回 RequestIdentity;吊销后立即 401。
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tokensMatch } from './token.ts';

/** 请求身份:http 绑定解析后传给 operations(三元签名第三参)。 */
export interface RequestIdentity {
  readonly kind: 'admin' | 'session';
  /** session 身份的绑定 tenant;admin 为 null(params 自由解析,现语义)。 */
  readonly tenant: string | null;
  /** session 身份的绑定 session id;admin 为 null。 */
  readonly session: string | null;
}

/** admin 身份常量(operations.call 缺省第三参,现语义完全不变)。 */
export const ADMIN_IDENTITY: RequestIdentity = { kind: 'admin', tenant: null, session: null };

/** tokens.json 单条记录(只存 hash,永不存明文;expiresAt 为 #30 可选过期,缺省不带 = 不过期)。 */
interface StoredToken {
  readonly hash: string;
  readonly tenant: string;
  readonly session: string;
  readonly issuedAt: string;
  /** 过期时刻(ISO);缺省(无此键)= 永不过期(现行为,daemon 接线暂用缺省)。 */
  readonly expiresAt?: string;
}

interface TokensFile {
  readonly api: 'neoba-tokens/1.0';
  readonly tokens: readonly StoredToken[];
}

const TOKENS_FILE_NAME = 'tokens.json';

export class TokenRegistry {
  readonly #path: string;
  readonly #tokens = new Map<string, StoredToken>(); // key = sha256(token) hex

  private constructor(path: string) {
    this.#path = path;
  }

  /** 打开注册表:文件存在则恢复 hash 表(损坏按空表处理,不阻断启动)。 */
  static async open(stateDir: string): Promise<TokenRegistry> {
    const registry = new TokenRegistry(join(stateDir, TOKENS_FILE_NAME));
    let raw: string;
    try {
      raw = await readFile(registry.#path, 'utf8');
    } catch {
      return registry; // 首次启动:空表。
    }
    try {
      const parsed = JSON.parse(raw) as TokensFile;
      if (parsed.api === 'neoba-tokens/1.0' && Array.isArray(parsed.tokens)) {
        for (const entry of parsed.tokens) {
          if (
            typeof entry === 'object' && entry !== null &&
            typeof (entry as StoredToken).hash === 'string' &&
            typeof (entry as StoredToken).tenant === 'string' &&
            typeof (entry as StoredToken).session === 'string'
          ) {
            const record = entry as StoredToken;
            registry.#tokens.set(record.hash, record);
          }
        }
      }
    } catch {
      // 损坏文件按空表处理:已发 token 全部失效(fail-closed),不阻断启动。
    }
    return registry;
  }

  /**
   * 签发会话 token:明文只在返回值出现一次;同 (tenant, session) 旧 token 失效。
   * ttlMs 给定时落 expiresAt(#30):到期后 verify 拒绝(fail-closed),
   * 不给 = 永不过期(现行为,daemon 接线暂用缺省)。
   */
  async issue(
    tenant: string,
    session: string,
    opts: { ttlMs?: number; now?: () => Date } = {},
  ): Promise<string> {
    const now = opts.now ?? (() => new Date());
    const token = randomBytes(32).toString('base64url');
    const hash = sha256Hex(token);
    // 同一会话重握手:替换旧条目(一个会话同时只持一枚有效 token)。
    for (const [key, record] of this.#tokens) {
      if (record.tenant === tenant && record.session === session) this.#tokens.delete(key);
    }
    const issued = now();
    const record: StoredToken = {
      hash,
      tenant,
      session,
      issuedAt: issued.toISOString(),
      ...(opts.ttlMs !== undefined ? { expiresAt: new Date(issued.getTime() + opts.ttlMs).toISOString() } : {}),
    };
    this.#tokens.set(hash, record);
    await this.#persist();
    return token;
  }

  /** 校验呈现的 token:命中且未过期返回 session 身份,否则 null(调用方决定 401)。 */
  verify(presented: string, now: () => Date = () => new Date()): RequestIdentity | null {
    const record = this.#tokens.get(sha256Hex(presented));
    if (record === undefined) return null;
    // 过期即拒(#30):缺 expiresAt = 永不过期;脏值解析失败同样 fail-closed。
    if (record.expiresAt !== undefined) {
      const expires = Date.parse(record.expiresAt);
      if (!Number.isFinite(expires) || expires <= now().getTime()) return null;
    }
    return { kind: 'session', tenant: record.tenant, session: record.session };
  }

  /** 吊销会话的全部 token;返回是否确有删除。 */
  async revoke(tenant: string, session: string): Promise<boolean> {
    let removed = false;
    for (const [key, record] of this.#tokens) {
      if (record.tenant === tenant && record.session === session) {
        this.#tokens.delete(key);
        removed = true;
      }
    }
    if (removed) await this.#persist();
    return removed;
  }

  get size(): number {
    return this.#tokens.size;
  }

  /** 原子写 + 0600 尽力而为(与 token 文件同策略;权限失败不阻断)。 */
  async #persist(): Promise<void> {
    const body: TokensFile = {
      api: 'neoba-tokens/1.0',
      tokens: [...this.#tokens.values()],
    };
    const tmp = `${this.#path}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
    await rename(tmp, this.#path);
    await chmod(this.#path, 0o600).catch(() => {});
  }
}

/** bootstrap token → admin 身份;否则查会话表;都不中 → null(401)。 */
export function resolveIdentity(
  presented: string,
  bootstrapToken: string,
  registry: TokenRegistry | undefined,
): RequestIdentity | null {
  if (tokensMatch(presented, bootstrapToken)) return ADMIN_IDENTITY;
  return registry?.verify(presented) ?? null;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
