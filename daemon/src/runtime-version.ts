/**
 * Node 运行时版本防御(issue #18)。
 *
 * Node 从 22.18(23.6 的 backport)起才默认直接执行 .ts 文件;
 * 22.6.0–22.17.x 需要显式 `--experimental-strip-types`,否则以
 * ERR_UNKNOWN_FILE_EXTENSION 失败。本项目 bin 直接指向
 * src/cli/main.ts(TypeScript 源码),因此在 CLI 入口处先做版本检测:
 * 低于 22.18 且未携带 type-strip flag 时给出明确报错并退出,
 * 而不是让 Node 抛出难以理解的文件扩展名错误。
 *
 * 折中说明:daemon/src/bindings/spawn.ts 的 spawnBridge 同样裸 spawn
 * node 执行 .ts,但该文件属于 bindings 目录(与并行改动隔离),
 * 本轮不动;低版本下 spawnBridge 的 `--experimental-strip-types`
 * flag 兜底留作后续跟进(TODO 见下)。
 *
 * 22.18+(含 23.6+/24.x/25.x)不加 flag 照常工作,现状不受影响;
 * 已显式携带 flag 启动的场景也不受影响。
 */

/** 默认支持直跑 .ts 的最低 22.x 版本(23.6 的 backport 起点)。 */
export const MIN_DEFAULT_TS_VERSION = { major: 22, minor: 18, patch: 0 };

/** 23.x 线默认支持直跑 .ts 的起点(23.6)。 */
const MIN_DEFAULT_TS_VERSION_23 = { major: 23, minor: 6, patch: 0 };

/** 识别为 type-strip 生效的 node CLI flags。 */
const TYPE_STRIP_FLAGS = [
  '--experimental-strip-types',
  '--experimental-transform-types',
];

/** 解析 "v22.6.0" 形态的版本号;无法解析时返回 null。 */
export function parseNodeVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
} | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (m === null) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * 纯版本判断:该 Node 版本直跑 .ts 是否需要显式 `--experimental-strip-types`。
 * 注入字符串以便测试矩阵(22.6/22.17 需 flag;22.18/25.9 不需要)。
 */
export function needsTypeStripFlag(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (parsed === null) return false;
  const { major, minor } = parsed;
  if (major < 22) return true; // 低于 22 的区间不在 engines 承诺内,一律视为需要 flag
  if (major === 22) return minor < MIN_DEFAULT_TS_VERSION.minor;
  if (major === 23) return minor < MIN_DEFAULT_TS_VERSION_23.minor;
  return false; // 24.x/25.x 及以后默认支持
}

/**
 * 入口守卫:返回 null 表示可以继续启动;
 * 否则返回面向用户的中文报错文案(含修复指引)。
 * `version`/`execArgv` 注入,便于单测。
 */
export function typeStripGuard(
  version: string,
  execArgv: readonly string[],
): string | null {
  // 已显式开启 type-strip 的场景(如 node --experimental-strip-types main.ts)放行。
  if (execArgv.some((arg) => TYPE_STRIP_FLAGS.includes(arg))) return null;
  const parsed = parseNodeVersion(version);
  // 无法识别的版本形态不做阻塞,交由 engines 字段与用户自行判断。
  if (parsed === null) return null;
  if (!needsTypeStripFlag(version)) return null;
  return [
    `neoba: 当前 Node ${parsed.major}.${parsed.minor}.${parsed.patch} 不会默认执行 .ts 文件。`,
    `Node 需 >= ${MIN_DEFAULT_TS_VERSION.major}.${MIN_DEFAULT_TS_VERSION.minor}(默认支持直跑 TypeScript)。`,
    '修复方式任选其一:',
    '  1. 升级 Node 至 22.18 LTS 及以上;',
    '  2. 以 `node --experimental-strip-types <neoba 入口>` 方式启动。',
  ].join('\n');
}

// TODO(issue #18 后续跟进): daemon/src/bindings/spawn.ts 的 spawnBridge 在
// needsTypeStripFlag(process.version) 为真时应向 spawn argv 追加
// `--experimental-strip-types`(对 22.18+ 加 flag 无害,可统一加);
// 该文件本轮为避免与并行改动冲突而未动。
