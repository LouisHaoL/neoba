/**
 * SecretStore(§3.8):凭据存取的门面。
 *
 * 职责与不变量:
 *  - 按 tenant 分桶:所有方法都显式带 tenant,后端按桶隔离;
 *  - 值只在 get / resolveInjection 时出接口;list / exportManifest
 *    只出元数据(§3.5g 导出包铁律:类型上不可表达"导出凭据明文");
 *  - 跨 tenant 访问在存储层直接类型化拒绝(CrossTenantAccess),
 *    且在触碰后端**之前**抛出 —— 连"他桶是否存在某 id"都不允许探测
 *    (§3.8:绝不把 A 任务的凭据注入 B 任务);
 *  - id 校验对齐 protocol/schemas/common.schema.json 的 secret_id。
 */
import { CrossTenantAccess } from './errors.ts';
import { Redactor, redactUnknownValue } from './redact.ts';
import { assertSecretId, assertTenant } from './validate.ts';
import type {
  SecretBackend,
  SecretId,
  SecretInjection,
  SecretManifestEntry,
  SecretMetadata,
  SecretRef,
  SecretSetOptions,
  SecretValue,
  Tenant,
} from './types.ts';

export interface SecretStoreOptions {
  /** 可选:事件流/审计用的脱敏器;set 写入的值会自动注册进去。 */
  readonly redactor?: Redactor;
}

export class SecretStore {
  private readonly backend: SecretBackend;
  private readonly redactorOrNull: Redactor | null;

  constructor(backend: SecretBackend, options?: SecretStoreOptions) {
    this.backend = backend;
    this.redactorOrNull = options?.redactor ?? null;
  }

  /** 脱敏器(未注入则为 null)。 */
  get redactor(): Redactor | null {
    return this.redactorOrNull;
  }

  /** 供审计/事件流:某值的稳定脱敏串。未注入脱敏器时退化为
   * sha256 前 8 位的稳定串(不可逆向,但无法回指 id —— 建议注入)。 */
  redact(value: string): string {
    if (this.redactorOrNull !== null) return this.redactorOrNull.redact(value);
    return redactUnknownValue(value);
  }

  /** 写入或更新;同时把值注册进脱敏器(若启用)。 */
  async set(
    tenant: Tenant,
    secretId: SecretId,
    value: SecretValue,
    options?: SecretSetOptions,
  ): Promise<SecretMetadata> {
    assertTenant(tenant);
    assertSecretId(secretId);
    if (this.redactorOrNull !== null) {
      this.redactorOrNull.register(secretId, value);
    }
    return this.backend.set(tenant, secretId, value, options);
  }

  /** 读取凭据值(唯一让值出 store 的口)。 */
  async get(tenant: Tenant, secretId: SecretId): Promise<SecretValue> {
    assertTenant(tenant);
    assertSecretId(secretId);
    return this.backend.get(tenant, secretId);
  }

  /** 按 ref 读取:ref.tenant 必须等于调用方 tenant,否则 CrossTenantAccess
   * (先于任何后端访问抛出,不泄露他桶存在性)。 */
  async getFromRef(callerTenant: Tenant, ref: SecretRef): Promise<SecretValue> {
    assertTenant(callerTenant);
    assertSecretId(ref.id);
    if (ref.tenant !== callerTenant) {
      throw new CrossTenantAccess(callerTenant, ref.tenant, ref.id);
    }
    return this.backend.get(callerTenant, ref.id);
  }

  async delete(tenant: Tenant, secretId: SecretId): Promise<boolean> {
    assertTenant(tenant);
    assertSecretId(secretId);
    return this.backend.delete(tenant, secretId);
  }

  /** 列出某 tenant 桶内全部 secret —— 只有元数据,永不返回值。 */
  async list(tenant: Tenant): Promise<readonly SecretMetadata[]> {
    assertTenant(tenant);
    return this.backend.list(tenant);
  }

  /** id→值解析(供 sidecar 环境变量注入的取数侧)。接受纯 id(视为本
   * tenant)或 SecretRef;ref 指向他 tenant 一律 CrossTenantAccess。
   * 返回附 ref 供审计;顺序与入参一致。 */
  async resolveInjection(
    tenant: Tenant,
    secretIds: readonly (SecretId | SecretRef)[],
  ): Promise<readonly SecretInjection[]> {
    assertTenant(tenant);
    const out: SecretInjection[] = [];
    for (const entry of secretIds) {
      const ref: SecretRef =
        typeof entry === 'string'
          ? { tenant, id: entry }
          : entry;
      const value = await this.getFromRef(tenant, ref);
      out.push({ name: ref.id, value, ref });
    }
    return out;
  }

  /** 导出清单(§3.5g):只有 id / 用途描述 / 时间戳,
   * 类型上不存在能装凭据明文的字段 —— "导出凭据明文"不可表达。 */
  async exportManifest(
    tenant: Tenant,
  ): Promise<readonly SecretManifestEntry[]> {
    const metas = await this.list(tenant);
    return metas.map((meta) => ({
      id: meta.id,
      purpose: meta.description,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    }));
  }
}
