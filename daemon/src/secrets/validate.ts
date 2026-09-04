/**
 * secret id / tenant 校验。
 *
 * secret id:以 protocol/schemas/common.schema.json 的 secret_id 定义为准
 * (pattern ^[a-z][a-z0-9_.-]*$;schema 未设 maxLength,存储层加 128 上限
 * 防文件名越界)。tenant:schema 的 tenant_id 只约束 minLength 1,但
 * tenant 要作为落盘目录段(§3.8 按 tenant 分桶),按工件仓库段规则
 * 收紧为安全文件段。
 */
import { InvalidSecretId, InvalidTenant } from './errors.ts';

export const SECRET_ID_RE = /^[a-z][a-z0-9_.-]*$/;
export const SECRET_ID_MAX_LENGTH = 128;

export const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSecretId(id: string): void {
  if (
    typeof id !== 'string' ||
    id.length < 1 ||
    id.length > SECRET_ID_MAX_LENGTH ||
    !SECRET_ID_RE.test(id)
  ) {
    throw new InvalidSecretId(id);
  }
}

export function assertTenant(tenant: string): void {
  if (typeof tenant !== 'string' || !TENANT_RE.test(tenant)) {
    throw new InvalidTenant(tenant);
  }
}
