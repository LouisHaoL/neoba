/**
 * SandboxSpec 硬规则校验(§4.4 / §5 v0.2),两个 provider 共用:
 * - secret/config 挂载一律 ro,运行时强制(防 JS 侧 as 断言绕过类型);
 * - 网络 allowlist 为预留能力,本期显式 NotSupportedError。
 */
import { InvalidSpecError, NotSupportedError } from "./errors.ts";
import type { SandboxSpec } from "./types.ts";

export function validateSpec(spec: SandboxSpec): void {
  if (spec.network?.mode === "allowlist") {
    throw new NotSupportedError(
      "network.mode=allowlist 为预留能力(§5 v0.2 grant 级出网授权),本期沙箱后端不支持",
    );
  }
  for (const mount of spec.mounts ?? []) {
    // 类型上 secret/config 的 mode 已是字面量 "ro";此处运行时复核,防 JS 侧 as 绕过
    if (mount.kind === "workdir") continue;
    if ((mount.mode as string) !== "ro") {
      throw new InvalidSpecError(
        `挂载 ${mount.source} → ${mount.target} 为 ${mount.kind} 类挂载,一律 ro(spawn 硬规则 §4.4),不可 rw`,
      );
    }
  }
}
