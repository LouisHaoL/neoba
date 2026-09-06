/**
 * env / conf 临时文件机制(issue #11):secret 明文不再经 docker/msb 的
 * `-e K=V` 上命令行(宿主进程列表 / 审计日志可见),改走文件 ——
 * - docker:`create --env-file <tmpfile>`(逐行 K=V);
 * - msb:`create --conf <tmpfile>`(sparse 根配置的 YAML env 映射;
 *   msb CLI 无 --env-file 等价物,--conf 是其文件化注入 env 的既有机制)。
 *
 * 文件建于 os.tmpdir(),POSIX 上 0600 权限(Windows 的 %TEMP% 本就按用户
 * ACL 隔离,mode 位忽略),由 provider 在 CLI 调用结束后立即删除(用后即删,
 * create 失败路径同样清理)。与 secrets/backends/dpapi.ts 的既有做法对齐:
 * 凭据明文不上命令行。
 *
 * 约束:env-file 逐行解析,键不含 `=`/换行/`#` 前缀;值含换行无法安全
 * 表达,一律显式拒绝(InvalidSpecError,多行值请先 base64 编码)。
 */
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidSpecError } from "./errors.ts";

/** POSIX 权限位:仅属主可读写(Windows 忽略,依赖 %TEMP% 的用户 ACL)。 */
const ENV_FILE_MODE = 0o600;

/** env 键值可否安全进逐行/配置文件:键无 `=`、无换行、非 `#` 前缀;值无换行。 */
function assertEnvCarryable(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    if (k.length === 0 || /[\r\n=]/.test(k) || k.startsWith("#")) {
      throw new InvalidSpecError(
        `env 键不合法(经 env-file 传递需逐行/映射安全): ${JSON.stringify(k.slice(0, 64))}`,
      );
    }
    if (/[\r\n]/.test(v)) {
      throw new InvalidSpecError(
        `env 值含换行,无法经 env-file/conf 传递(多行值请先 base64 编码): ` +
          `键 ${JSON.stringify(k.slice(0, 64))}`,
      );
    }
  }
}

/** docker --env-file 内容:逐行 `K=V`;`#` 注释与空行由 docker 自行忽略。 */
export function formatDockerEnvFile(env: Record<string, string>): string {
  assertEnvCarryable(env);
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
}

/**
 * msb --conf(sparse 根配置)内容:YAML env 映射。键值经 JSON.stringify
 * 成双引号标量 —— YAML 1.2 双引号标量是 JSON 字符串的超集,反斜杠、引号、
 * 控制字符都被安全转义。注意:msb 侧会对配置值做 `${NAME}` 宿主 env 插值,
 * 值本身含 `${` 时按 msb 语义处理(通常显式报错),属其配置格式固有行为。
 */
export function formatMsbConfYaml(env: Record<string, string>): string {
  assertEnvCarryable(env);
  const lines = Object.entries(env)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}\n`)
    .join("");
  return `env:\n${lines}`;
}

/**
 * 写临时文件:tmpdir 下随机 UUID 命名(`wx` 独占创建防碰撞/防符号链接抢占),
 * POSIX 0600。返回绝对路径,供 argv 引用(--env-file / --conf)。
 */
export async function writeEnvFile(content: string, extension: string): Promise<string> {
  const path = join(tmpdir(), `neoba-env-${randomUUID()}${extension}`);
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: ENV_FILE_MODE });
  return path;
}

/**
 * 用后即删:provider 在 CLI 调用结束(finally)后调用。force 吞掉 ENOENT;
 * 其余失败同样吞掉(尽力而为)—— Windows 上杀软/索引器短暂占用句柄属常见
 * 瞬态,清理失败不应掩盖业务结果或让已成功的 create 变失败。
 */
export async function removeEnvFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {});
}
