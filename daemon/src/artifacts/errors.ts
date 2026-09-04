/**
 * 工件仓库的对外类型化错误。所有对外错误都必须是这些类的实例,
 * 不允许抛裸字符串或裸 Error。
 */
export class ArtifactError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 请求的工件条目不存在(路径发布过,但没有这个 entry path / 版本)。 */
export class ArtifactNotFound extends ArtifactError {
  readonly tenant: string;
  readonly task: string;
  readonly node: string;
  readonly name: string;
  readonly entryPath: string | null;

  constructor(
    tenant: string,
    task: string,
    node: string,
    name: string,
    entryPath: string | null = null,
  ) {
    super(
      'ARTIFACT_NOT_FOUND',
      `artifact ${tenant}/${task}/${node}/${name}` +
        (entryPath === null ? '' : ` 条目 "${entryPath}"`) +
        ' 不存在',
    );
    this.tenant = tenant;
    this.task = task;
    this.node = node;
    this.name = name;
    this.entryPath = entryPath;
  }
}

/** 该路径从未发布过(manifest 指针不存在),读不到"上一版快照"。 */
export class NotPublished extends ArtifactError {
  readonly tenant: string;
  readonly task: string;
  readonly node: string;
  readonly name: string;

  constructor(tenant: string, task: string, node: string, name: string) {
    super(
      'ARTIFACT_NOT_PUBLISHED',
      `artifact ${tenant}/${task}/${node}/${name} 从未发布过`,
    );
    this.tenant = tenant;
    this.task = task;
    this.node = node;
    this.name = name;
  }
}

/** CAS 对象字节与其哈希不符 —— 工件被篡改或损坏。 */
export class HashMismatch extends ArtifactError {
  readonly sha256: string;
  readonly expected: string;
  readonly actual: string;

  constructor(sha256: string, expected: string, actual: string) {
    super(
      'ARTIFACT_HASH_MISMATCH',
      `CAS 对象 ${sha256} 哈希不匹配: 期望 ${expected}, 实际 ${actual}`,
    );
    this.sha256 = sha256;
    this.expected = expected;
    this.actual = actual;
  }
}

/** manifest 引用的 CAS 对象文件缺失(被外部删除/存储损坏)。 */
export class CasObjectNotFound extends ArtifactError {
  readonly sha256: string;

  constructor(sha256: string) {
    super('CAS_OBJECT_NOT_FOUND', `CAS 对象 ${sha256} 缺失`);
    this.sha256 = sha256;
  }
}

/** namespace / node / name / entry path 含非法字符或路径穿越,拒绝落盘。 */
export class InvalidArtifactPath extends ArtifactError {
  readonly kind: 'tenant' | 'task' | 'node' | 'name' | 'entryPath';
  readonly value: string;

  constructor(
    kind: 'tenant' | 'task' | 'node' | 'name' | 'entryPath',
    value: string,
  ) {
    super(
      'ARTIFACT_INVALID_PATH',
      `非法工件 ${kind}: ${JSON.stringify(value)} ` +
        `(段仅允许 [A-Za-z0-9._-],不以 . 开头)`,
    );
    this.kind = kind;
    this.value = value;
  }
}

/** manifest 指针文件损坏(不是合法 JSON 或字段缺失)。 */
export class ManifestCorrupt extends ArtifactError {
  readonly path: string;

  constructor(path: string, detail: string) {
    super('ARTIFACT_MANIFEST_CORRUPT', `manifest 指针损坏 ${path}: ${detail}`);
    this.path = path;
  }
}
