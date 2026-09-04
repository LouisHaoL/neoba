/**
 * daemon 鉴权 token(§6 v0.2):每次启动生成 crypto 随机 token,落盘
 * `<stateDir>/token`,绑定层读取并携带;文件权限 0o600(Windows 尽力而为,
 * 记 warning)。比较走 timingSafeEqual(先 sha256 归一长度,防时序侧信道)。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TOKEN_FILE_NAME = 'token';

/** 生成一次性的 daemon 鉴权 token(32 字节,base64url)。 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface TokenFileResult {
  readonly path: string;
  /** 尽力而为过程中产生的告警(如 Windows 不强制 POSIX 权限)。 */
  readonly warnings: readonly string[];
}

/** 写 token 文件并尝试收紧权限到 0o600;权限收紧失败只告警不失败。 */
export async function writeTokenFile(dir: string, token: string): Promise<TokenFileResult> {
  const path = join(dir, TOKEN_FILE_NAME);
  const warnings: string[] = [];
  await writeFile(path, token + '\n', 'utf8');
  try {
    await chmod(path, 0o600);
    if (process.platform === 'win32') {
      warnings.push(
        `Windows 不强制 POSIX 文件权限: ${path} 的 0o600 为尽力而为(NTFS ACL 未收紧)`,
      );
    }
  } catch (err) {
    warnings.push(`token 文件权限收紧失败(尽力而为,继续启动): ${String(err)}`);
  }
  return { path, warnings };
}

/** 读 token 文件(绑定层启动时);内容去掉结尾换行。 */
export async function readTokenFile(path: string): Promise<string> {
  const raw = await readFile(path, 'utf8');
  return raw.replace(/\r?\n$/, '');
}

/** 常数时间比较两个 token(sha256 归一长度后 timingSafeEqual)。 */
export function tokensMatch(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
