/**
 * 工件仓库测试(§3.7 v0.2 CAS 语义,从严):
 * 1. 基本发布/读取/resolve(文件型 + 目录型)
 * 2. 写屏障:写入中途并发读者只能看到上一版(manifest 指针未变)
 * 3. 同路径并发发布串行、版本递增;跨路径/内容去重
 * 4. 篡改 CAS 对象后 verify 失败(HashMismatch);对象缺失 → CasObjectNotFound
 * 5. CAS 目录重建/对账:重启恢复、reconcile 审计、prune 手动 GC
 * 6. staging 孤儿清理
 * 7. 跨 tenant/task 隔离
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  ArtifactRepository,
  CasObjectNotFound,
  HashMismatch,
  InvalidArtifactPath,
  ManifestCorrupt,
  MANIFEST_API_VERSION,
  NotPublished,
  type ArtifactNamespace,
} from '../../src/artifacts/index.ts';

const roots: string[] = [];

async function makeRepo(): Promise<{ root: string; repo: ArtifactRepository }> {
  const root = await mkdtemp(join(tmpdir(), 'neoba-cas-'));
  roots.push(root);
  const repo = await ArtifactRepository.open(root);
  return { root, repo };
}

const nsA: ArtifactNamespace = { tenant: 'acme', task: 'task-1' };
const nsB: ArtifactNamespace = { tenant: 'acme', task: 'task-2' };

function sha256Of(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function objectCount(root: string): Promise<number> {
  const walk = async (dir: string): Promise<string[]> => {
    const dirents = await readdir(dir, { withFileTypes: true, recursive: true });
    return dirents.filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name));
  };
  return (await walk(join(root, 'objects'))).length;
}

async function stagingCount(root: string): Promise<number> {
  try {
    return (await readdir(join(root, '.staging'))).length;
  } catch {
    return 0;
  }
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

describe('CAS 工件仓库:基本发布/读取', () => {
  it('发布文件型工件返回递增版本与 sha256,读取内容一致', async () => {
    const { repo } = await makeRepo();

    const r1 = await repo.publish(nsA, 'worker', 'report.md', 'hello');
    assert.equal(r1.version, 1);
    assert.equal(r1.rootSha256, sha256Of('hello'));
    assert.equal(r1.size, 5);

    const r2 = await repo.publish(nsA, 'worker', 'report.md', 'hello world');
    assert.equal(r2.version, 2);
    assert.equal(r2.rootSha256, sha256Of('hello world'));

    const ref = await repo.resolve(nsA, 'worker', 'report.md');
    assert.ok(ref);
    // 结构版本轴(api)与发布计数轴(version)并存且互相独立:
    // api 管文档结构演进,version 管同路径第几次发布。
    assert.equal(ref.api, 'artifact-manifest/1.0');
    assert.equal(ref.api, MANIFEST_API_VERSION);
    assert.equal(ref.version, 2);
    assert.equal(ref.kind, 'file');
    assert.equal(ref.rootSha256, sha256Of('hello world'));
    assert.equal(ref.retention, null); // GC 预留字段位

    assert.equal(
      Buffer.from(await repo.read(nsA, 'worker', 'report.md')).toString(),
      'hello world',
    );
  });

  it('目录型工件:manifest 文件清单 + 每文件各自 hash,按条目读取', async () => {
    const { repo } = await makeRepo();
    const files = [
      { path: 'src/main.ts', content: 'export {};' },
      { path: 'docs/readme.md', content: '# readme' },
    ] as const;

    const result = await repo.publish(nsA, 'builder', 'bundle', files);
    assert.equal(result.version, 1);

    const ref = await repo.resolve(nsA, 'builder', 'bundle');
    assert.ok(ref);
    assert.equal(ref.kind, 'tree');
    assert.equal(ref.entries.length, 2);
    assert.deepEqual(
      ref.entries.map((e) => [e.path, e.sha256]).sort(),
      [
        ['docs/readme.md', sha256Of('# readme')],
        ['src/main.ts', sha256Of('export {};')],
      ],
    );
    assert.equal(ref.size, 'export {};'.length + '# readme'.length);

    assert.equal(
      Buffer.from(await repo.readEntry(nsA, 'builder', 'bundle', 'src/main.ts')).toString(),
      'export {};',
    );
    await assert.rejects(
      repo.read(nsA, 'builder', 'bundle'),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'ARTIFACT_IS_TREE',
    );
    await assert.rejects(
      repo.readEntry(nsA, 'builder', 'bundle', 'missing.txt'),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'ARTIFACT_NOT_FOUND',
    );
  });

  it('Uint8Array 与流式载荷都能发布,哈希一致', async () => {
    const { repo } = await makeRepo();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const rb = await repo.publish(nsA, 'n', 'blob.bin', bytes);
    assert.equal(rb.rootSha256, sha256Of(bytes));

    async function* stream(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4, 5]);
    }
    const rs = await repo.publish(nsA, 'n', 'stream.bin', stream());
    assert.equal(rs.rootSha256, rb.rootSha256);
    assert.deepEqual(
      Buffer.from(await repo.read(nsA, 'n', 'stream.bin')),
      Buffer.from(bytes),
    );
  });

  it('错误类型化:未发布/非法路径,拒绝后不产生任何发布', async () => {
    const { root, repo } = await makeRepo();

    assert.equal(await repo.resolve(nsA, 'ghost', 'x'), null); // resolve 不抛错
    await assert.rejects(repo.read(nsA, 'ghost', 'x'), NotPublished);

    await assert.rejects(
      repo.publish({ tenant: '../evil', task: 't' }, 'n', 'x', 'y'),
      InvalidArtifactPath,
    );
    await assert.rejects(repo.publish(nsA, 'a/b', 'x', 'y'), InvalidArtifactPath);
    await assert.rejects(
      repo.publish(nsA, 'n', 'ok', [{ path: '../escape', content: 'y' }]),
      InvalidArtifactPath,
    );
    // 非法 namespace 连读接口也直接拒绝(与 publish 一致的从严校验)。
    await assert.rejects(
      repo.resolve({ tenant: '../evil', task: 't' }, 'n', 'x'),
      InvalidArtifactPath,
    );
    // 拒绝后确实什么都没发布:
    await assert.rejects(repo.resolve(nsA, 'a/b', 'x'), InvalidArtifactPath);

    // api 轴从严:未知结构版本的 manifest 指针直接拒读(保证演进纪律)。
    await repo.publish(nsA, 'n', 'm', 'body');
    await writeFile(
      join(root, 'manifests', nsA.tenant, nsA.task, 'n', 'legacy'),
      JSON.stringify({ api: 'artifact-manifest/0.9', version: 1, kind: 'file', rootSha256: sha256Of('body'), size: 4, publishedAt: new Date().toISOString(), retention: null, entries: [{ path: 'm', sha256: sha256Of('body'), size: 4 }] }),
    );
    await assert.rejects(repo.resolve(nsA, 'n', 'legacy'), ManifestCorrupt);
    assert.equal((await repo.resolve(nsA, 'n', 'm'))?.api, MANIFEST_API_VERSION);
  });
});

describe('CAS 工件仓库:写屏障', () => {
  it('写入中途并发读者只能看到上一版(manifest 指针未变),完成后才可见', async () => {
    const { root, repo } = await makeRepo();
    const oldBody = 'old-snapshot';
    await repo.publish(nsA, 'worker', 'result.txt', oldBody);
    const oldRef = await repo.resolve(nsA, 'worker', 'result.txt');
    assert.ok(oldRef);

    // 构造一次"卡在半路"的发布:吐出前半段后停下,等测试放行。
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    async function* slowContent(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode('new-');
      entered = true;
      await released; // 屏障未通过:内容尚未 ingest 完,manifest 未更新
      yield new TextEncoder().encode('body');
    }

    const pending = repo.publish(nsA, 'worker', 'result.txt', slowContent());

    while (!entered) await new Promise((r) => setTimeout(r, 1));
    await new Promise((r) => setTimeout(r, 10));

    // 屏障之前:manifest 指针仍指上一版;读者拿到的只能是旧快照(共享读无锁)。
    const midRef = await repo.resolve(nsA, 'worker', 'result.txt');
    assert.ok(midRef);
    assert.equal(midRef.version, oldRef.version);
    assert.equal(midRef.rootSha256, oldRef.rootSha256);
    assert.equal(
      Buffer.from(await repo.read(nsA, 'worker', 'result.txt')).toString(),
      oldBody,
    );
    // 半写状态留在 .staging/,一个对象都还没暴露出去。
    assert.ok((await stagingCount(root)) >= 1);

    // 多读者并发读同一不可变版本,结果一致。
    const readers = await Promise.all(
      Array.from({ length: 5 }, () => repo.read(nsA, 'worker', 'result.txt')),
    );
    for (const content of readers) {
      assert.equal(Buffer.from(content).toString(), oldBody);
    }

    // 放行 → ingest 完成 → manifest 原子替换 → 屏障通过 → 新版本可见。
    release();
    const published = await pending;
    assert.equal(published.version, 2);
    assert.equal(published.rootSha256, sha256Of('new-body'));
    assert.equal(await stagingCount(root), 0); // staging 已清理

    const newRef = await repo.resolve(nsA, 'worker', 'result.txt');
    assert.ok(newRef);
    assert.equal(newRef.version, 2);
    assert.equal(
      Buffer.from(await repo.read(nsA, 'worker', 'result.txt')).toString(),
      'new-body',
    );
  });
});

describe('CAS 工件仓库:并发串行与去重', () => {
  it('同路径并发发布严格串行,版本 1..N 递增且 manifest 单调推进', async () => {
    const { root, repo } = await makeRepo();
    const bodies = Array.from({ length: 6 }, (_, i) => `body-${i}`);

    const results = await Promise.all(
      bodies.map((body) => repo.publish(nsA, 'n', 'doc', body)),
    );

    const sorted = results.map((r) => r.version).sort((a, b) => a - b);
    assert.deepEqual(sorted, [1, 2, 3, 4, 5, 6]);

    const ref = await repo.resolve(nsA, 'n', 'doc');
    assert.ok(ref);
    assert.equal(ref.version, 6);
    assert.equal(
      Buffer.from(await repo.read(nsA, 'n', 'doc')).toString(),
      'body-5',
    );
    // 六个不同内容 = 六个 CAS 对象,全部在盘上。
    assert.equal(await objectCount(root), 6);
  });

  it('相同内容两路径共享同一 object(跨任务去重)', async () => {
    const { root, repo } = await makeRepo();
    const body = 'identical-bytes';
    await repo.publish(nsA, 'n1', 'a.txt', body);
    await repo.publish(nsA, 'n2', 'b.txt', body);
    await repo.publish(nsB, 'n1', 'a.txt', body); // 跨 task 也去重

    assert.equal(await objectCount(root), 1);
    for (const [ns, node] of [
      [nsA, 'n1'],
      [nsA, 'n2'],
      [nsB, 'n1'],
    ] as const) {
      assert.equal(
        Buffer.from(await repo.read(ns, node, node === 'n1' ? 'a.txt' : 'b.txt')).toString(),
        body,
      );
    }
  });

  it('不同路径并发发布互不阻塞', async () => {
    const { repo } = await makeRepo();
    const results = await Promise.all([
      repo.publish(nsA, 'n', 'a', 'A'),
      repo.publish(nsA, 'n', 'b', 'B'),
      repo.publish(nsB, 'n', 'a', 'C'),
    ]);
    assert.deepEqual(
      results.map((r) => r.version),
      [1, 1, 1],
    );
  });
});

describe('CAS 工件仓库:verify', () => {
  it('发布后 verify 通过;篡改 CAS 对象后 verify 抛 HashMismatch', async () => {
    const { root, repo } = await makeRepo();
    await repo.publish(nsA, 'n', 'doc', 'trusted-body');
    const ok = await repo.verify(nsA, 'n', 'doc');
    assert.equal(ok.rootSha256, sha256Of('trusted-body'));
    assert.equal(ok.entries, 1);

    // 直接改 CAS 对象字节,绕过仓库 API(模拟容器外篡改/损坏)。
    const sha = sha256Of('trusted-body');
    await appendFile(
      join(root, 'objects', sha.slice(0, 2), sha.slice(2, 4), sha),
      'TAMPERED',
    );
    await assert.rejects(
      repo.verify(nsA, 'n', 'doc'),
      (error: unknown) =>
        error instanceof HashMismatch &&
        error.expected === sha &&
        error.actual === sha256Of('trusted-bodyTAMPERED'),
    );
    // read 也做完整性守护?—— CAS 只保证指针正确性,读接口校验交给 verify。
    assert.ok(await repo.resolve(nsA, 'n', 'doc'));
  });

  it('manifest 引用的对象被外部删除 → CasObjectNotFound', async () => {
    const { root, repo } = await makeRepo();
    await repo.publish(nsA, 'n', 'doc', 'body');
    const sha = sha256Of('body');
    await rm(join(root, 'objects', sha.slice(0, 2), sha.slice(2, 4), sha));
    await assert.rejects(repo.read(nsA, 'n', 'doc'), CasObjectNotFound);
    await assert.rejects(repo.verify(nsA, 'n', 'doc'), CasObjectNotFound);
  });
});

describe('CAS 工件仓库:目录重建/对账(替代 journal 回放)', () => {
  it('重启后状态从磁盘恢复(manifest 指针即状态),版本继续推进', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neoba-cas-'));
    roots.push(root);
    const first = await ArtifactRepository.open(root);
    await first.publish(nsA, 'n', 'doc', 'gen-1');
    await first.publish(nsA, 'n', 'doc', 'gen-2');
    await first.publish(nsB, 'other', 'doc', 'x');
    const before = await first.resolve(nsA, 'n', 'doc');
    assert.ok(before);
    await first.close();

    // 模拟重启:全新实例,CAS 天然恢复。
    const reopened = await ArtifactRepository.open(root);
    const ref = await reopened.resolve(nsA, 'n', 'doc');
    assert.ok(ref);
    assert.equal(ref.version, 2);
    assert.equal(ref.rootSha256, before.rootSha256);
    assert.equal(
      Buffer.from(await reopened.read(nsA, 'n', 'doc')).toString(),
      'gen-2',
    );
    await assert.doesNotReject(reopened.verify(nsB, 'other', 'doc'));

    // 旧对象未被复用/覆盖:gen-1 仍在 CAS(append-only 语义)。
    const gen1 = sha256Of('gen-1');
    const raw = await readFile(
      join(root, 'objects', gen1.slice(0, 2), gen1.slice(2, 4), gen1),
    );
    assert.equal(raw.toString(), 'gen-1');

    // 继续发布:版本接着推进。
    const next = await reopened.publish(nsA, 'n', 'doc', 'gen-3');
    assert.equal(next.version, 3);
  });

  it('reconcile 对账:检出孤儿对象,prune 清理且不影响在用对象', async () => {
    const { root, repo } = await makeRepo();
    await repo.publish(nsA, 'n', 'doc', 'live');
    await repo.publish(nsA, 'n', 'old', 'orphan-target');

    // 伪造一个无 manifest 引用的孤儿对象。
    const orphanBody = randomUUID();
    const orphanSha = sha256Of(orphanBody);
    await mkdir(join(root, 'objects', orphanSha.slice(0, 2), orphanSha.slice(2, 4)), {
      recursive: true,
    });
    await writeFile(
      join(root, 'objects', orphanSha.slice(0, 2), orphanSha.slice(2, 4), orphanSha),
      orphanBody,
    );

    let report = await repo.reconcile();
    assert.equal(report.manifests, 2);
    assert.equal(report.objects, 3);
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.corrupted, []);
    assert.deepEqual(report.unreferenced, [orphanSha]);

    // 手动 GC(P1):清孤儿,在用对象不受影响。
    const pruned = await repo.prune();
    assert.deepEqual(pruned, [orphanSha]);
    await assert.doesNotReject(repo.verify(nsA, 'n', 'doc'));
    await assert.doesNotReject(repo.verify(nsA, 'n', 'old'));

    report = await repo.reconcile();
    assert.deepEqual(report.unreferenced, []);
    assert.equal(report.objects, 2);
  });

  it('reconcile 对账:检出被篡改对象与缺失对象', async () => {
    const { root, repo } = await makeRepo();
    await repo.publish(nsA, 'n', 'doc', 'watched');
    const sha = sha256Of('watched');
    await appendFile(
      join(root, 'objects', sha.slice(0, 2), sha.slice(2, 4), sha),
      'X',
    );
    const report = await repo.reconcile();
    assert.deepEqual(report.corrupted, [sha]);
  });
});

describe('CAS 工件仓库:staging 孤儿清理', () => {
  it('open() 清理崩溃留下的孤儿 staging;活跃 staging 不被误删', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neoba-cas-'));
    roots.push(root);
    const repo = await ArtifactRepository.open(root, { cleanStaging: false });
    await repo.publish(nsA, 'n', 'doc', 'x');

    // 伪造 worker 崩溃留下的半写 staging。
    const orphanDir = join(root, '.staging', 'crashed-worker');
    await mkdir(join(orphanDir, 'sub'), { recursive: true });
    await writeFile(join(orphanDir, 'sub', 'half.bin'), 'half-written');
    assert.equal(await stagingCount(root), 1);

    // 重启:孤儿被清,且从未进入 CAS。
    const reopened = await ArtifactRepository.open(root);
    assert.equal(await stagingCount(root), 0);
    assert.equal(await objectCount(root), 1);
    assert.ok(await reopened.resolve(nsA, 'n', 'doc'));

    // 手动触发同样可用。
    await mkdir(join(root, '.staging', 'manual'), { recursive: true });
    const removed = await reopened.cleanStaging();
    assert.deepEqual(removed, ['manual']);
  });
});

describe('CAS 工件仓库:跨 tenant/task 隔离', () => {
  it('同名工件在不同 tenant/task 命名空间下互不影响', async () => {
    const { root, repo } = await makeRepo();
    const ra = await repo.publish(nsA, 'agent', 'out.txt', 'from-task-1');
    const rb = await repo.publish(nsB, 'agent', 'out.txt', 'from-task-2');
    assert.notEqual(ra.rootSha256, rb.rootSha256);

    assert.equal(
      Buffer.from(await repo.read(nsA, 'agent', 'out.txt')).toString(),
      'from-task-1',
    );
    assert.equal(
      Buffer.from(await repo.read(nsB, 'agent', 'out.txt')).toString(),
      'from-task-2',
    );

    // 篡改 task-1 的对象不影响 task-2 的可验证性(内容不同 → 对象不同)。
    const shaA = ra.rootSha256;
    await appendFile(
      join(root, 'objects', shaA.slice(0, 2), shaA.slice(2, 4), shaA),
      'X',
    );
    await assert.rejects(repo.verify(nsA, 'agent', 'out.txt'), HashMismatch);
    await assert.doesNotReject(repo.verify(nsB, 'agent', 'out.txt'));
    const refB = await repo.resolve(nsB, 'agent', 'out.txt');
    assert.ok(refB);
    assert.equal(refB.rootSha256, rb.rootSha256);
    assert.equal(refB.version, 1);
  });

  it('task 间默认物理无共享:未发布的路径对其他 task 不可见', async () => {
    const { repo } = await makeRepo();
    await repo.publish(nsA, 'agent', 'secret.txt', 'task-1 only');
    assert.equal(await repo.resolve(nsB, 'agent', 'secret.txt'), null);
    await assert.rejects(repo.read(nsB, 'agent', 'secret.txt'), NotPublished);
  });
});
