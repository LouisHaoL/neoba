/**
 * 工件仓库(§3.7 v0.2):跨容器交付的唯一通道,内容寻址存储(CAS,参考 git/OCI)。
 *
 * 落盘布局:
 *   {root}/objects/aa/bb/<sha256>                    内容块,不可变,跨任务去重
 *   {root}/manifests/{tenant}/{task}/{node}/{name}   manifest 指针(JSON)
 *   {root}/.staging/{uuid}/...                       发布中的临时目录(worker 崩溃半写留在这里)
 *   {root}/.tmp/{uuid}                               manifest / CAS 对象的写临时文件
 *
 * 发布 = 写屏障:
 *   1. 载荷写入 .staging/{uuid}/(边写边算每文件 sha256,写完 fsync);
 *   2. ingest:每个文件按 sha256 落入 objects/aa/bb/<sha256>(已存在即去重跳过;
 *      不存在则写 .tmp 临时文件 → fsync → 原子 rename 到位);
 *   3. manifest 指针原子更新:新 manifest 写 .tmp → fsync → rename 覆盖指针。
 *      rename 返回的那一刻即"发布时刻"。屏障之前 manifest 指针未变,
 *      所有读者(resolve/read/readEntry)拿到的只能是上一版快照;
 *      发布后对象不可变,多读者并发共享读,无锁。
 *   worker 崩溃的半写状态永远留在 .staging/,不进 CAS;
 *   open() 时与手动 cleanStaging() 扫描清理孤儿 staging。
 *
 * 写写串行:同一路径 {tenant}/{task}/{node}/{name} 的并发 publish 经
 * promise 链严格串行,manifest 版本号严格递增;不同路径互不阻塞。
 *
 * 状态与恢复:CAS 天然可恢复 —— manifest 指针即状态,每次读都走磁盘,
 * 重启(open)后无需回放;reconcile() 提供全量对账,prune() 提供手动 GC
 * (删除无 manifest 引用的孤儿对象);M5 自动 GC 见 gc.ts(plan/collect 分离),
 * 本仓库提供其底层支撑(listManifests / listObjects / deleteManifest / removeObjects)。
 *
 * Windows 注:fs.rename 在 Windows 上以 MOVEFILE_REPLACE_EXISTING 语义
 * 覆盖已存在的目标,指针替换是原子的;目录 fsync 不可用,依赖 NTFS 元数据日志。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ArtifactError,
  ArtifactNotFound,
  CasObjectNotFound,
  HashMismatch,
  InvalidArtifactPath,
  ManifestCorrupt,
  NotPublished,
} from './errors.ts';
import {
  parseRetentionPolicy,
  retentionFromDiskValue,
  serializeRetentionPolicy,
} from './retention.ts';
import type {
  ArtifactContent,
  ArtifactEntry,
  ArtifactFile,
  ArtifactNamespace,
  ArtifactPayload,
  ArtifactRef,
  ManifestListing,
  PublishResult,
  ReconcileReport,
  RetentionPolicy,
  VerifyResult,
} from './types.ts';

export type {
  ArtifactContent,
  ArtifactFile,
  ArtifactNamespace,
  ArtifactPayload,
} from './types.ts';
export type { RetentionPolicy } from './types.ts';

// ---------------------------------------------------------------- 校验

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSegment(
  kind: 'tenant' | 'task' | 'node' | 'name',
  value: string,
): void {
  if (!SEGMENT_RE.test(value)) throw new InvalidArtifactPath(kind, value);
}

function assertEntryPath(entryPath: string): void {
  const segments = entryPath.split('/');
  if (segments.length === 0 || entryPath === '') {
    throw new InvalidArtifactPath('entryPath', entryPath);
  }
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) {
      throw new InvalidArtifactPath('entryPath', entryPath);
    }
  }
}

function assertNamespace(ns: ArtifactNamespace): void {
  assertSegment('tenant', ns.tenant);
  assertSegment('task', ns.task);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const SHA_RE = /^[0-9a-f]{64}$/;

/** 当前 manifest 结构版本(§3.7 v0.2:文档类自版本化)。 */
export const MANIFEST_API_VERSION = 'artifact-manifest/1.0';

// ---------------------------------------------------------------- 载荷规格化

/** 把任意内容规格化成异步字节迭代。 */
async function* toChunks(content: ArtifactContent): AsyncIterable<Uint8Array> {
  if (typeof content === 'string') {
    yield Buffer.from(content, 'utf8');
    return;
  }
  if (content instanceof Uint8Array) {
    yield content;
    return;
  }
  // Web ReadableStream / Node Readable / 自定义异步迭代器。
  yield* content as AsyncIterable<Uint8Array>;
}

function isFileList(
  payload: ArtifactPayload,
): payload is readonly ArtifactFile[] {
  return Array.isArray(payload);
}

/** 规格化载荷 → 文件清单(单文件载荷的 entry path 就是工件名)。 */
function normalizePayload(
  payload: ArtifactPayload,
  artifactName: string,
): readonly ArtifactFile[] {
  if (!isFileList(payload)) {
    return [{ path: artifactName, content: payload }];
  }
  if (payload.length === 0) {
    throw new ArtifactError(
      'ARTIFACT_EMPTY_PAYLOAD',
      '目录型工件至少要有一个文件',
    );
  }
  const seen = new Set<string>();
  for (const file of payload) {
    assertEntryPath(file.path);
    if (seen.has(file.path)) {
      throw new ArtifactError(
        'ARTIFACT_DUPLICATE_ENTRY',
        `目录型工件存在重复条目: ${JSON.stringify(file.path)}`,
      );
    }
    seen.add(file.path);
  }
  return payload;
}

// ---------------------------------------------------------------- manifest(磁盘上的指针文件)

interface StoredManifest {
  /** 结构版本轴:manifest 文档自身的格式版本,独立于 version(发布计数)。
   * api 轴管结构演进保证旧工件库永远可读;version 管同路径第几次发布。 */
  api: string;
  version: number;
  kind: 'file' | 'tree';
  rootSha256: string;
  size: number;
  publishedAt: string;
  /** 落盘规范形态:'forever' | 'days:<n>';null = 旧数据未声明(按 forever)。 */
  retention: string | null;
  entries: ArtifactEntry[];
}

function isStoredManifest(value: unknown): value is StoredManifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    v['api'] !== MANIFEST_API_VERSION ||
    typeof v['version'] !== 'number' ||
    !Number.isInteger(v['version']) ||
    (v['version'] as number) < 1 ||
    (v['kind'] !== 'file' && v['kind'] !== 'tree') ||
    typeof v['rootSha256'] !== 'string' ||
    !SHA_RE.test(v['rootSha256']) ||
    typeof v['size'] !== 'number' ||
    typeof v['publishedAt'] !== 'string' ||
    (v['retention'] !== null && typeof v['retention'] !== 'string')
  ) {
    return false;
  }
  if (!Array.isArray(v['entries'])) return false;
  for (const entry of v['entries']) {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (
      typeof e['path'] !== 'string' ||
      typeof e['sha256'] !== 'string' ||
      !SHA_RE.test(e['sha256']) ||
      typeof e['size'] !== 'number'
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- 目录遍历

async function walkFiles(dir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dirent of dirents) {
    if (dirent.isFile()) files.push(join(dirent.parentPath, dirent.name));
  }
  return files;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 写临时文件 + fsync + 原子 rename 到位(不覆盖语义由调用方保证)。 */
async function atomicWrite(target: string, bytes: Uint8Array): Promise<void> {
  const tmpPath = `${target}.${randomUUID()}.tmp`;
  await mkdir(dirname(tmpPath), { recursive: true });
  const fh = await open(tmpPath, 'w');
  try {
    await fh.write(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmpPath, target);
}

// ---------------------------------------------------------------- 仓库

export class ArtifactRepository {
  readonly #root: string;
  /** 同一路径 {tenant}/{task}/{node}/{name} 的写写串行化:promise 链尾。 */
  readonly #locks = new Map<string, Promise<void>>();
  /** 正在被 publish 使用的 staging 目录名(孤儿清理时跳过)。 */
  readonly #activeStaging = new Set<string>();
  /** retention 非法/降级的告警钩子(日志位;读路径永不因此抛错)。 */
  readonly #onWarning: (message: string) => void;

  private constructor(
    root: string,
    onWarning: (message: string) => void,
  ) {
    this.#root = root;
    this.#onWarning = onWarning;
  }

  // ---------------------------------------------------------- 打开/关闭

  /** 打开仓库。CAS 天然可恢复(manifest 指针即状态),这里只建目录
   * 并清理上次崩溃留下的孤儿 staging(永不进入 CAS 的半写状态)。
   * onWarning:retention 非法值降级为 forever 时回调(缺省丢弃)。 */
  static async open(
    root: string,
    options: {
      readonly cleanStaging?: boolean;
      readonly onWarning?: (message: string) => void;
    } = {},
  ): Promise<ArtifactRepository> {
    await mkdir(join(root, 'objects'), { recursive: true });
    await mkdir(join(root, 'manifests'), { recursive: true });
    await mkdir(join(root, '.staging'), { recursive: true });
    await mkdir(join(root, '.tmp'), { recursive: true });
    const repository = new ArtifactRepository(
      root,
      options.onWarning ?? (() => {}),
    );
    if (options.cleanStaging ?? true) await repository.cleanStaging();
    return repository;
  }

  /** 无需 I/O 的空操作位(句柄不常驻);保留给调用方的对称生命周期。 */
  async close(): Promise<void> {
    await Promise.resolve();
  }

  // ---------------------------------------------------------- 发布(写屏障)

  /**
   * 发布工件。文件型传内容,目录型传文件清单。
   * options.retention:保留策略(M5 GC 消费;任意外部 JSON,非法值降级
   * forever + onWarning 告警,见 retention.ts)。缺省不落 retention(读回 null)。
   * 同一路径并发 publish 严格串行;返回时新版本已通过写屏障。
   */
  async publish(
    ns: ArtifactNamespace,
    node: string,
    name: string,
    payload: ArtifactPayload,
    options: { readonly retention?: unknown } = {},
  ): Promise<PublishResult> {
    assertNamespace(ns);
    assertSegment('node', node);
    assertSegment('name', name);
    const files = normalizePayload(payload, name);
    const retention = parseRetentionPolicy(options.retention);
    for (const message of retention.warnings) this.#onWarning(message);
    // 未声明 retention(选项缺省)落 null(= 旧数据形态,语义 forever);
    // 显式声明(含 forever)落规范串,策略在盘上自描述。
    const declared = options.retention !== undefined;
    const key = `${ns.tenant}/${ns.task}/${node}/${name}`;
    return this.#runExclusive(key, () =>
      this.#publishLocked(ns, node, name, files, declared, retention.policy, retention.warnings),
    );
  }

  async #publishLocked(
    ns: ArtifactNamespace,
    node: string,
    name: string,
    files: readonly ArtifactFile[],
    retentionDeclared: boolean,
    retention: RetentionPolicy,
    retentionWarnings: readonly string[],
  ): Promise<PublishResult> {
    const stagingName = randomUUID();
    const stagingDir = join(this.#root, '.staging', stagingName);
    this.#activeStaging.add(stagingName);
    try {
      // 屏障之前的当前指针:版本号在其基础上递增(只增不改)。
      const current = await this.#readManifest(ns, node, name);
      const version = (current?.version ?? 0) + 1;

      // 1. 写 staging:边写边算每文件 sha256,全部落盘 fsync。
      await mkdir(stagingDir, { recursive: true });
      const entries: ArtifactEntry[] = [];
      for (const file of files) {
        const stagingPath = join(stagingDir, file.path);
        await mkdir(dirname(stagingPath), { recursive: true });
        const fh = await open(stagingPath, 'w');
        const hash = createHash('sha256');
        let size = 0;
        try {
          for await (const chunk of toChunks(file.content)) {
            hash.update(chunk);
            size += chunk.byteLength;
            await fh.write(chunk);
          }
          await fh.sync();
        } finally {
          await fh.close();
        }
        entries.push({ path: file.path, sha256: hash.digest('hex'), size });
      }
      const sorted = [...entries].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      const kind = files.length === 1 && files[0]?.path === name
        ? 'file'
        : 'tree';
      const rootHash = createHash('sha256');
      for (const entry of sorted) {
        rootHash.update(`${entry.path}\0${entry.sha256}\n`);
      }
      const rootSha256 =
        kind === 'file' ? (sorted[0]?.sha256 ?? '') : rootHash.digest('hex');
      const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);

      // 2. ingest 进 CAS:已存在即去重跳过;不存在则原子落位。对象不可变。
      for (const entry of entries) {
        const objectPath = this.#objectPath(entry.sha256);
        if (await pathExists(objectPath)) continue;
        const bytes = await readFile(join(stagingDir, entry.path));
        await atomicWrite(objectPath, bytes);
      }

      // 3. manifest 指针原子更新 —— rename 返回即发布,写屏障通过。
      const manifest: StoredManifest = {
        api: MANIFEST_API_VERSION,
        version,
        kind,
        rootSha256,
        size: totalSize,
        publishedAt: new Date().toISOString(),
        retention: retentionDeclared ? serializeRetentionPolicy(retention) : null,
        entries: sorted,
      };
      const pointerPath = this.#manifestPath(ns, node, name);
      await atomicWrite(pointerPath, Buffer.from(JSON.stringify(manifest)));

      return {
        version,
        rootSha256,
        size: totalSize,
        ...(retentionWarnings.length > 0
          ? { retentionWarnings }
          : {}),
      };
    } finally {
      // 成功或失败都清掉 staging:成功时内容已进 CAS,失败时半写不外泄。
      this.#activeStaging.delete(stagingName);
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ---------------------------------------------------------- 读取(共享读,无锁)

  /** 当前 manifest 指针(版本 + sha256 + 条目);从未发布过返回 null。 */
  async resolve(
    ns: ArtifactNamespace,
    node: string,
    name: string,
  ): Promise<ArtifactRef | null> {
    assertNamespace(ns);
    assertSegment('node', node);
    assertSegment('name', name);
    const manifest = await this.#readManifest(ns, node, name);
    return manifest === null ? null : this.#toRef(ns, node, name, manifest);
  }

  /** 读文件型工件的全部字节(version 缺省 = 当前指针版本)。 */
  async read(
    ns: ArtifactNamespace,
    node: string,
    name: string,
  ): Promise<Uint8Array> {
    const ref = await this.#refFor(ns, node, name);
    if (ref.kind !== 'file') {
      throw new ArtifactError(
        'ARTIFACT_IS_TREE',
        `${ns.tenant}/${ns.task}/${node}/${name} 是目录型工件,` +
          '请用 readEntry() 按条目读取',
      );
    }
    const entry = ref.entries[0];
    if (entry === undefined) throw new ArtifactNotFound(ns.tenant, ns.task, node, name);
    return this.#readObject(entry.sha256);
  }

  /** 读目录型工件的指定条目(文件型工件传其工件名亦可)。 */
  async readEntry(
    ns: ArtifactNamespace,
    node: string,
    name: string,
    entryPath: string,
  ): Promise<Uint8Array> {
    assertEntryPath(entryPath);
    const ref = await this.#refFor(ns, node, name);
    const entry = ref.entries.find((candidate) => candidate.path === entryPath);
    if (entry === undefined) {
      throw new ArtifactNotFound(ns.tenant, ns.task, node, name, entryPath);
    }
    return this.#readObject(entry.sha256);
  }

  // ---------------------------------------------------------- 校验 / 对账 / GC

  /**
   * 重算 manifest 引用的每个 CAS 对象的 sha256 并比对。
   * 哈希不匹配 = 工件被篡改/损坏 = 未完成交付(§3.7)。
   */
  async verify(
    ns: ArtifactNamespace,
    node: string,
    name: string,
  ): Promise<VerifyResult> {
    const ref = await this.#refFor(ns, node, name);
    for (const entry of ref.entries) {
      await this.#checkObject(entry.sha256);
    }
    return {
      version: ref.version,
      rootSha256: ref.rootSha256,
      entries: ref.entries.length,
      size: ref.size,
    };
  }

  /**
   * CAS 全量对账:扫全部 manifest 与对象,报告缺失/损坏/孤儿对象。
   * 状态落盘可恢复的对账入口(manifest 指针即状态,磁盘即事实)。
   */
  async reconcile(): Promise<ReconcileReport> {
    const referenced = new Set<string>();
    const missing = new Set<string>();
    const corrupted = new Set<string>();
    let manifestCount = 0;

    for (const pointer of await walkFiles(join(this.#root, 'manifests'))) {
      let manifest: StoredManifest;
      try {
        manifest = this.#parseManifest(
          await readFile(pointer, 'utf8'),
          pointer,
        );
      } catch {
        corrupted.add(pointer);
        continue;
      }
      manifestCount += 1;
      for (const entry of manifest.entries) {
        referenced.add(entry.sha256);
        const objectPath = this.#objectPath(entry.sha256);
        if (!(await pathExists(objectPath))) {
          missing.add(entry.sha256);
          continue;
        }
        const actual = sha256Hex(await readFile(objectPath));
        if (actual !== entry.sha256) corrupted.add(entry.sha256);
      }
    }

    const unreferenced: string[] = [];
    let objectCount = 0;
    for (const objectPath of await walkFiles(join(this.#root, 'objects'))) {
      const sha = objectPath.split(/[\\/]/).pop() ?? '';
      if (!SHA_RE.test(sha)) continue; // 半写的 CAS 临时文件,忽略
      objectCount += 1;
      const actual = sha256Hex(await readFile(objectPath));
      if (actual !== sha) {
        corrupted.add(sha);
        continue;
      }
      if (!referenced.has(sha)) unreferenced.push(sha);
    }

    return {
      manifests: manifestCount,
      objects: objectCount,
      missing: [...missing].sort(),
      corrupted: [...corrupted].sort(),
      unreferenced: unreferenced.sort(),
    };
  }

  /** 手动 GC(P1):删除无任何 manifest 引用的孤儿对象,返回被清理的 sha。 */
  async prune(): Promise<string[]> {
    const report = await this.reconcile();
    for (const sha of report.unreferenced) {
      await rm(this.#objectPath(sha), { force: true });
    }
    return report.unreferenced;
  }

  /** 孤儿 staging 扫描清理(daemon 启动时自动 + 手动触发)。 */
  async cleanStaging(): Promise<string[]> {
    const stagingRoot = join(this.#root, '.staging');
    await mkdir(stagingRoot, { recursive: true });
    const removed: string[] = [];
    for (const dirent of await readdir(stagingRoot, { withFileTypes: true })) {
      if (!this.#activeStaging.has(dirent.name)) {
        await rm(join(stagingRoot, dirent.name), {
          recursive: true,
          force: true,
        });
        removed.push(dirent.name);
      }
    }
    return removed;
  }

  // ---------------------------------------------------------- 自动 GC 支撑(M5)

  /**
   * 扫全部 manifest 指针(GC 的 in-use 判定输入)。损坏指针跳过不抛
   * (读路径容错;对账审计走 reconcile());retention 脏值降级 forever + 告警。
   */
  async listManifests(): Promise<ManifestListing[]> {
    const listings: ManifestListing[] = [];
    for (const pointer of await walkFiles(join(this.#root, 'manifests'))) {
      let manifest: StoredManifest;
      try {
        manifest = this.#parseManifest(
          await readFile(pointer, 'utf8'),
          pointer,
        );
      } catch {
        continue; // 损坏指针:GC 本轮无视,不阻塞其余扫描。
      }
      const relative = pointer
        .slice(join(this.#root, 'manifests').length + 1)
        .split(/[\\/]/);
      const [tenant, task, node, name] = relative;
      if (
        tenant === undefined ||
        task === undefined ||
        node === undefined ||
        name === undefined ||
        relative.length !== 4
      ) {
        continue; // 目录布局外的杂散文件,不当指针。
      }
      const id = `${tenant}/${task}/${node}/${name}`;
      listings.push({
        id,
        tenant,
        task,
        node,
        name,
        version: manifest.version,
        publishedAt: manifest.publishedAt,
        retention: this.#retentionOf(manifest.retention, id),
        objects: manifest.entries.map((entry) => entry.sha256),
      });
    }
    return listings;
  }

  /** 扫全部 CAS 对象 sha(轻量,不校验内容;完整审计走 reconcile())。 */
  async listObjects(): Promise<string[]> {
    const shas: string[] = [];
    for (const objectPath of await walkFiles(join(this.#root, 'objects'))) {
      const sha = objectPath.split(/[\\/]/).pop() ?? '';
      if (SHA_RE.test(sha)) shas.push(sha); // 半写临时文件忽略
    }
    return shas;
  }

  /** 删除 manifest 指针文件(自动 GC 专用;对象不动,留给下轮孤儿清扫)。 */
  async deleteManifest(id: string): Promise<boolean> {
    const segments = id.split('/');
    if (segments.length !== 4) {
      throw new InvalidArtifactPath('tenant', id);
    }
    const [tenant, task, node, name] = segments;
    if (
      tenant === undefined ||
      task === undefined ||
      node === undefined ||
      name === undefined
    ) {
      throw new InvalidArtifactPath('tenant', id);
    }
    for (const [kind, value] of [
      ['tenant', tenant],
      ['task', task],
      ['node', node],
      ['name', name],
    ] as const) {
      if (!SEGMENT_RE.test(value)) throw new InvalidArtifactPath(kind, value);
    }
    const pointerPath = join(this.#root, 'manifests', tenant, task, node, name);
    try {
      await rm(pointerPath);
      return true;
    } catch {
      return false; // 不存在/已删:幂等。
    }
  }

  /** 删除指定 CAS 对象(自动 GC 的孤儿清扫步;返回实际删掉的 sha)。 */
  async removeObjects(shas: readonly string[]): Promise<string[]> {
    const removed: string[] = [];
    for (const sha of shas) {
      if (!SHA_RE.test(sha)) continue;
      try {
        await rm(this.#objectPath(sha));
        removed.push(sha);
      } catch {
        // 不存在(并发已清):幂等跳过。
      }
    }
    return removed;
  }

  // ---------------------------------------------------------- 内部

  async #refFor(
    ns: ArtifactNamespace,
    node: string,
    name: string,
  ): Promise<ArtifactRef> {
    assertNamespace(ns);
    assertSegment('node', node);
    assertSegment('name', name);
    const manifest = await this.#readManifest(ns, node, name);
    if (manifest === null) throw new NotPublished(ns.tenant, ns.task, node, name);
    return this.#toRef(ns, node, name, manifest);
  }

  #toRef(
    ns: ArtifactNamespace,
    node: string,
    name: string,
    manifest: StoredManifest,
  ): ArtifactRef {
    return {
      tenant: ns.tenant,
      task: ns.task,
      node,
      name,
      api: manifest.api,
      version: manifest.version,
      kind: manifest.kind,
      rootSha256: manifest.rootSha256,
      size: manifest.size,
      entries: manifest.entries,
      publishedAt: manifest.publishedAt,
      // 落盘值不认识(手改盘/脏数据)按 forever 处理 + 告警,读路径不炸。
      retention: this.#retentionOf(
        manifest.retention,
        `${ns.tenant}/${ns.task}/${node}/${name}`,
      ),
    };
  }

  /** 落盘 retention 字段 → 对外策略(null = 未声明 = forever;脏值降级 + 告警)。 */
  #retentionOf(
    diskValue: string | null,
    pointerId: string,
  ): RetentionPolicy | null {
    const parsed = retentionFromDiskValue(diskValue);
    for (const message of parsed.warnings) {
      this.#onWarning(`${message} (manifest ${pointerId})`);
    }
    return parsed.policy.mode === 'forever' && diskValue === null
      ? null
      : parsed.policy;
  }

  /** 读当前 manifest 指针;不存在返回 null,损坏抛 ManifestCorrupt。 */
  async #readManifest(
    ns: ArtifactNamespace,
    node: string,
    name: string,
  ): Promise<StoredManifest | null> {
    const pointerPath = this.#manifestPath(ns, node, name);
    let raw: string;
    try {
      raw = await readFile(pointerPath, 'utf8');
    } catch {
      return null;
    }
    return this.#parseManifest(raw, pointerPath);
  }

  #parseManifest(raw: string, pointerPath: string): StoredManifest {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new ManifestCorrupt(pointerPath, 'JSON 解析失败');
    }
    if (!isStoredManifest(parsed)) {
      throw new ManifestCorrupt(pointerPath, '字段缺失或类型非法');
    }
    return parsed;
  }

  async #readObject(sha256: string): Promise<Uint8Array> {
    const objectPath = this.#objectPath(sha256);
    let raw: Buffer;
    try {
      raw = await readFile(objectPath);
    } catch {
      throw new CasObjectNotFound(sha256);
    }
    return new Uint8Array(raw);
  }

  async #checkObject(sha256: string): Promise<void> {
    const objectPath = this.#objectPath(sha256);
    let raw: Buffer;
    try {
      raw = await readFile(objectPath);
    } catch {
      throw new CasObjectNotFound(sha256);
    }
    const actual = sha256Hex(raw);
    if (actual !== sha256) {
      throw new HashMismatch(sha256, sha256, actual);
    }
  }

  #manifestPath(ns: ArtifactNamespace, node: string, name: string): string {
    return join(this.#root, 'manifests', ns.tenant, ns.task, node, name);
  }

  #objectPath(sha256: string): string {
    return join(this.#root, 'objects', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  /** 同一路径写写串行:挂在 promise 链尾,前一次发布完成后才轮到下一次。 */
  #runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(key, tail);
    void tail.then(() => {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    });
    return run;
  }
}
