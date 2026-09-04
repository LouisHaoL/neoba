/**
 * MemorySecretBackend:进程内假实现,测试与无盘环境用。
 * 结构:Map<tenant, Map<secretId, {value, meta}>> —— 天然按 tenant 分桶。
 */
import { SecretNotFound } from '../errors.ts';
import type {
  SecretBackend,
  SecretMetadata,
  SecretSetOptions,
  SecretValue,
} from '../types.ts';

interface MemoryEntry {
  value: SecretValue;
  meta: SecretMetadata;
}

export class MemorySecretBackend implements SecretBackend {
  readonly kind = 'memory' as const;

  private readonly buckets = new Map<string, Map<string, MemoryEntry>>();

  private bucketOf(tenant: string): Map<string, MemoryEntry> {
    let bucket = this.buckets.get(tenant);
    if (bucket === undefined) {
      bucket = new Map();
      this.buckets.set(tenant, bucket);
    }
    return bucket;
  }

  async set(
    tenant: string,
    secretId: string,
    value: SecretValue,
    options?: SecretSetOptions,
  ): Promise<SecretMetadata> {
    const bucket = this.bucketOf(tenant);
    const existing = bucket.get(secretId);
    const now = new Date().toISOString();
    const meta: SecretMetadata = {
      id: secretId,
      description: options?.description ?? existing?.meta.description ?? null,
      createdAt: existing?.meta.createdAt ?? now,
      updatedAt: now,
    };
    bucket.set(secretId, { value, meta });
    return meta;
  }

  async get(tenant: string, secretId: string): Promise<SecretValue> {
    const entry = this.buckets.get(tenant)?.get(secretId);
    if (entry === undefined) throw new SecretNotFound(tenant, secretId);
    return entry.value;
  }

  async delete(tenant: string, secretId: string): Promise<boolean> {
    const bucket = this.buckets.get(tenant);
    if (bucket === undefined) return false;
    return bucket.delete(secretId);
  }

  async list(tenant: string): Promise<readonly SecretMetadata[]> {
    const bucket = this.buckets.get(tenant);
    if (bucket === undefined) return [];
    return [...bucket.values()].map((entry) => entry.meta).sort(byId);
  }
}

function byId(a: SecretMetadata, b: SecretMetadata): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
