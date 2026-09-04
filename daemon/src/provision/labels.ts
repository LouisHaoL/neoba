/**
 * neoba.* 管理标签:所有 provider 统一打标,便于按标签批量清理
 * (如 `docker ps -a --filter label=neoba.managed=true -q | xargs docker rm -f`)。
 */
import type { SandboxSpec } from "./types.ts";

export const NEOBA_MANAGED_LABEL = "neoba.managed";
export const NEOBA_PROVIDER_LABEL = "neoba.provider";
export const NEOBA_CREATED_AT_LABEL = "neoba.created-at";

/** 合并管理标签与业务标签(spec.labels 原样透传;声明了基座则加 neoba.harness)。 */
export function mergeLabels(
  spec: SandboxSpec,
  backend: string,
  id: string,
  createdAt: string,
): Record<string, string> {
  return {
    [NEOBA_MANAGED_LABEL]: "true",
    [NEOBA_PROVIDER_LABEL]: backend,
    [NEOBA_CREATED_AT_LABEL]: createdAt,
    "neoba.id": id,
    ...(spec.baseRequirements?.harness !== undefined
      ? { "neoba.harness": spec.baseRequirements.harness }
      : {}),
    ...(spec.labels ?? {}),
  };
}

/** labels 子集匹配:needle 中每个键值对都必须出现在 haystack。 */
export function labelsMatch(
  haystack: Record<string, string>,
  needle: Record<string, string> | undefined,
): boolean {
  if (needle === undefined) return true;
  return Object.entries(needle).every(([k, v]) => haystack[k] === v);
}
