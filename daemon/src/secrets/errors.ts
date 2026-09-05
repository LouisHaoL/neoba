/**
 * SecretStore 的对外类型化错误。所有对外错误都必须是这些类的实例,
 * 不允许抛裸字符串或裸 Error(与工件仓库错误风格一致)。
 */
export class SecretError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** secret id 不符合 common.schema.json 的 secret_id 定义(^[a-z][a-z0-9_.-]*$)。 */
export class InvalidSecretId extends SecretError {
  readonly id: string;

  constructor(id: string) {
    super(
      'SECRET_INVALID_ID',
      `非法 secret id: ${JSON.stringify(id)} ` +
        `(必须匹配 ^[a-z][a-z0-9_.-]*$,长度 1-128)`,
    );
    this.id = id;
  }
}

/** tenant 不合法(无法作为安全文件段,或为空)。 */
export class InvalidTenant extends SecretError {
  readonly tenant: string;

  constructor(tenant: string) {
    super(
      'SECRET_INVALID_TENANT',
      `非法 tenant: ${JSON.stringify(tenant)} ` +
        `(必须匹配 ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$)`,
    );
    this.tenant = tenant;
  }
}

/** 请求的 secret 在该 tenant 桶内不存在。 */
export class SecretNotFound extends SecretError {
  readonly tenant: string;
  readonly id: string;

  constructor(tenant: string, id: string) {
    super('SECRET_NOT_FOUND', `secret ${tenant}/${id} 不存在`);
    this.tenant = tenant;
    this.id = id;
  }
}

/** 跨 tenant 访问被拒绝(§3.8:绝不把 A 任务的凭据注入 B 任务)。
 * 在触碰后端**之前**抛出 —— 不给"探测其他 tenant 是否存在某 secret"留任何通道。 */
export class CrossTenantAccess extends SecretError {
  readonly tenant: string;
  readonly refTenant: string;
  readonly id: string;

  constructor(tenant: string, refTenant: string, id: string) {
    super(
      'SECRET_CROSS_TENANT',
      `跨 tenant 凭据访问被拒绝: 调用方 tenant ${JSON.stringify(tenant)} ` +
        `试图读取 tenant ${JSON.stringify(refTenant)} 的 secret ${JSON.stringify(id)}`,
    );
    this.tenant = tenant;
    this.refTenant = refTenant;
    this.id = id;
  }
}

/** 落盘的密文 / 元数据 / 密钥文件损坏(无法解析或解密认证失败)。 */
export class SecretCorrupt extends SecretError {
  readonly tenant: string | null;
  readonly id: string | null;
  readonly detail: string;

  constructor(tenant: string | null, id: string | null, detail: string) {
    const where =
      tenant === null ? '' : ` ${tenant}${id === null ? '' : `/${id}`}`;
    super('SECRET_CORRUPT', `secret 存储损坏${where}: ${detail}`);
    this.tenant = tenant;
    this.id = id;
    this.detail = detail;
  }
}

/** 后端基础设施故障(子进程启动失败 / 非零退出 / 文件系统错误等)。 */
export class SecretBackendError extends SecretError {
  readonly detail: string;

  constructor(detail: string, code = 'SECRET_BACKEND_ERROR') {
    super(code, `secret 后端故障: ${detail}`);
    this.detail = detail;
  }
}

/** 后端子进程(如 DPAPI 的 powershell)超时未返回。 */
export class SecretBackendTimeout extends SecretBackendError {
  readonly timeoutMs: number;

  constructor(detail: string, timeoutMs: number) {
    super(detail, 'SECRET_BACKEND_TIMEOUT');
    this.name = 'SecretBackendTimeout';
    this.timeoutMs = timeoutMs;
  }
}

/** 后端在当前环境不可用(依赖的 OS 工具缺失 / 子进程起不来)。
 * 归类为后端故障的子类(错误传播路径通用),但单独类型化:这是
 * "环境没有这个后端",调用方(如工厂、doctor)应显式处理或失败,
 * **不允许静默降级**到弱后端(§3.8)。 */
export class SecretBackendUnavailable extends SecretBackendError {
  constructor(detail: string) {
    super(detail, 'SECRET_BACKEND_UNAVAILABLE');
    this.name = 'SecretBackendUnavailable';
  }
}

/** 配置声明了未知 secret 后端 kind(工厂 / 生产接线用,不静默降级)。 */
export class UnknownSecretBackendKind extends SecretError {
  readonly kind: string;

  constructor(kind: string, known: readonly string[]) {
    super(
      'SECRET_BACKEND_UNKNOWN_KIND',
      `未知 secret 后端 kind: ${JSON.stringify(kind)}(可选: ${known.join(', ')})`,
    );
    this.kind = kind;
  }
}
