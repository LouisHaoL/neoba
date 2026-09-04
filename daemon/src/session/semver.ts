/**
 * semver 比较工具 + 协议版本兼容规则(§3.0 v0.2,纯函数)。
 *
 * 规则(作用于 protocol 与 api 两条版本轴各自):
 * 1. 接收方必须忽略未知字段;仅新增字段/新增可选能力 = minor;
 * 2. 删除字段、变更字段语义、收紧默认行为 = major;daemon 与绑定层
 *    支持相邻两个 major → major 相同或 |major 差| = 1 可接入,
 *    |major 差| >= 2 拒绝握手(VersionIncompatible);
 * 3. minor 有差异 → 接入放行,但应答带 warning。
 *
 * 另含 §3.0 v0.2 补充决议的文档类 kind→版本映射协商:
 * 文档类不匹配按 kind 报告(kind + 期望版本 + 支持列表),非协议级不匹配。
 */
import type { DocumentKind, DocumentKindVersions, DocumentKindsMapping } from './types.ts';

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const SEMVER_RE = /^(\d+)\.(\d+)(?:\.(\d+))?$/;

/** 解析 "1.0" / "1.0.0" 形式的版本号;非法返回 null。 */
export function parseSemver(value: string): SemVer | null {
  const m = SEMVER_RE.exec(value);
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
  };
}

/** 三态比较:-1 / 0 / 1。 */
export function compareSemver(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export type CompatLevel =
  | 'exact' // 有完全相同的版本
  | 'minor-drift' // major 相同、minor 不同
  | 'major-adjacent' // |major 差| = 1(相邻 major 接入)
  | 'incompatible'; // |major 差| >= 2 → 拒绝

export interface CompatResult {
  readonly compatible: boolean;
  readonly level: CompatLevel;
  /** minor 漂移 / 跨 major 接入时给出的 warning 文案;exact 为 null。 */
  readonly warning: string | null;
  /** 命中的 daemon 支持版本(incompatible 时为 null)。 */
  readonly matched: string | null;
}

/**
 * 客户端协议版本 vs daemon 支持版本列表的兼容判定(纯函数)。
 * 取"最接近"的命中:exact > 同 major(minor-drift) > 相邻 major。
 */
export function checkProtocolCompat(
  clientVersion: string,
  supportedVersions: readonly string[],
): CompatResult {
  const client = parseSemver(clientVersion);
  if (client === null) {
    return { compatible: false, level: 'incompatible', warning: null, matched: null };
  }

  let best: { level: CompatLevel; version: string } | null = null;
  for (const version of supportedVersions) {
    const daemon = parseSemver(version);
    if (daemon === null) continue;
    let level: CompatLevel;
    if (daemon.major === client.major) {
      level = daemon.minor === client.minor && daemon.patch === client.patch
        ? 'exact'
        : 'minor-drift';
    } else if (Math.abs(daemon.major - client.major) === 1) {
      level = 'major-adjacent';
    } else {
      continue;
    }
    if (best === null || rank(level) < rank(best.level)) {
      best = { level, version };
    }
  }

  if (best === null) {
    return { compatible: false, level: 'incompatible', warning: null, matched: null };
  }
  if (best.level === 'exact') {
    return { compatible: true, level: 'exact', warning: null, matched: best.version };
  }
  const warning = best.level === 'minor-drift'
    ? `协议版本 minor 漂移: 接入方 ${clientVersion}, daemon 支持 ${best.version}, 按 minor 兼容处理`
    : `跨 major 兼容接入: 接入方 ${clientVersion}, daemon 支持 ${best.version} (支持相邻两个 major)`;
  return { compatible: true, level: best.level, warning, matched: best.version };
}

const RANK: Record<CompatLevel, number> = {
  exact: 0,
  'minor-drift': 1,
  'major-adjacent': 2,
  incompatible: 3,
};

function rank(level: CompatLevel): number {
  return RANK[level];
}

// ----------------- 文档类 kind→版本映射协商(§3.0 v0.2 补充决议) -----------------

/** 文档类版本轴只到 major.minor(preset/intent/workflow/artifact-manifest 各自一条)。 */
export const DOC_VERSION_RE = /^\d+\.\d+$/;

export interface DocumentKindCompatResult {
  /** 双方支持列表有交集 = 可用该 kind 的某个版本互操作。 */
  readonly compatible: boolean;
  /** 命中的版本(交集取最高版);无交集为 null。 */
  readonly matched: string | null;
  /** daemon 映射里没有该 kind 时为 false(kind 级失败,非版本级)。 */
  readonly kindSupported: boolean;
}

/**
 * 版本级判定(纯函数,供 PlanCheck 与绑定层复用):双方各持支持版本列表,
 * 有交集即可用,取交集最高版。不匹配时的错误语义 = 按 kind 报告
 * (kind + 期望版本 + 支持列表),不是协议级不匹配——调用方据此抛
 * DocumentKindMismatch,而不是 VersionIncompatible。
 */
export function checkDocumentKind(
  kind: string,
  requestedVersions: readonly string[],
  supportedVersions: readonly string[],
): DocumentKindCompatResult {
  let matched: string | null = null;
  for (const version of requestedVersions) {
    if (!DOC_VERSION_RE.test(version)) continue;
    if (!supportedVersions.includes(version)) continue;
    if (matched === null || version > matched) matched = version;
  }
  return { compatible: matched !== null, matched, kindSupported: true };
}

/**
 * kind 级 + 版本级综合判定:映射里没有该 kind → kindSupported=false;
 * 有该 kind 但版本无交集 → compatible=false。
 */
export function checkDocumentKindSupported(
  kind: string,
  requestedVersions: readonly string[],
  supportedMapping: DocumentKindsMapping,
): DocumentKindCompatResult {
  const supportedVersions: DocumentKindVersions | undefined = supportedMapping[kind as DocumentKind];
  if (supportedVersions === undefined) {
    return { compatible: false, matched: null, kindSupported: false };
  }
  return checkDocumentKind(kind, requestedVersions, supportedVersions);
}

/** daemon 内置的文档类支持版本映射常量(§3.0 v0.2;可经 DaemonProfile.documentKinds
 *  覆盖,但四个必需 kind 不可缺)。 */
export const DEFAULT_DOCUMENT_KINDS: DocumentKindsMapping = Object.freeze({
  workflow: Object.freeze(['1.0']),
  preset: Object.freeze(['1.0']),
  intent: Object.freeze(['1.0']),
  'artifact-manifest': Object.freeze(['1.0']),
});

/** schema document_kinds 的四个必需 kind。 */
export const REQUIRED_DOCUMENT_KINDS: readonly DocumentKind[] = [
  'preset',
  'intent',
  'workflow',
  'artifact-manifest',
];
