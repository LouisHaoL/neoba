/**
 * SecretStore 的对外类型(§3.8 v0.2:凭据是一等协议概念)。
 */

/** 凭据值。注入目标是 sidecar 环境变量,故值轴取字符串。 */
export type SecretValue = string;

/** secret id:以 protocol/schemas/common.schema.json 的 secret_id 为准
 * (^[a-z][a-z0-9_.-]*$;校验逻辑见 validate.ts)。 */
export type SecretId = string;

/** 四层 principal 的顶层(§10.4)。secret 按 tenant 分桶,永不跨桶。 */
export type Tenant = string;

/** secret 的元数据。**类型上就不含 value 字段** —— list/getMeta 类接口
 * 在签名上不可能把凭据明文带出(§3.5g 导出包铁律)。 */
export interface SecretMetadata {
  readonly id: SecretId;
  /** 用途描述(grant manifest 作者填,随 set 写入)。 */
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 带属主 tenant 的 secret 引用(grant manifest / 预设只引用 id + tenant,
 * 任何协议结构体中禁止出现凭据明文,§3.8)。 */
export interface SecretRef {
  readonly tenant: Tenant;
  readonly id: SecretId;
}

export interface SecretSetOptions {
  /** 用途描述,写入元数据并透出到导出清单。 */
  readonly description?: string;
}

/** 一次注入的产物:id → 值解析结果,附 ref 供审计
 * (值只在 resolveInjection 的返回里出现一次,供 sidecar 环境变量使用)。 */
export interface SecretInjection {
  /** 环境变量命名建议:即 secret id(容器侧可再加前缀)。 */
  readonly name: SecretId;
  readonly value: SecretValue;
  readonly ref: SecretRef;
}

/** 导出清单条目(§3.5g 铁律:任何档位不含凭据)。类型上只有
 * id / 用途描述 / 时间戳,**没有任何能装凭据明文的字段** ——
 * "导出凭据明文"在 SecretStore 的类型面上不可表达。 */
export interface SecretManifestEntry {
  readonly id: SecretId;
  /** "此处需要什么类型的凭据"的占位说明。 */
  readonly purpose: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 存储后端抽象(§3.8:OS keyring 起步;§11 参考实现)。
 * 后端只认 (tenant, id) 二元组,值在 get 时出接口;set/list 均不回传值。 */
export interface SecretBackend {
  /** 后端类别标识(观测 / doctor / 工厂判定用)。 */
  readonly kind: 'memory' | 'file' | 'keyring';

  /** 写入或更新。返回更新后的元数据。 */
  set(
    tenant: string,
    secretId: string,
    value: SecretValue,
    options?: SecretSetOptions,
  ): Promise<SecretMetadata>;

  /** 读取凭据值(唯一让值出后端的口)。不存在 → SecretNotFound。 */
  get(tenant: string, secretId: string): Promise<SecretValue>;

  /** 删除。返回是否真的删了东西。 */
  delete(tenant: string, secretId: string): Promise<boolean>;

  /** 列出某 tenant 桶内全部 secret —— 只有元数据,永不返回值。 */
  list(tenant: string): Promise<readonly SecretMetadata[]>;
}
