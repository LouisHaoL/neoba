/**
 * SandboxSpec → microsandbox CLI(`msb`)参数的纯函数映射(M7,§9 P4)。
 * 产出交给 CliRunner 执行;测试直接断言参数数组,不依赖真实 microsandbox。
 *
 * argv 形状按 microsandbox CLI 规格(msb ≥ 0.x):
 *   create --name N [-c CPUS] [--memory 512M] [--net-default deny] [-e K=V]
 *          [-v SRC:DST[:OPT]] [-w DIR] [--label K=V] <IMAGE>
 *   exec  [-q] [-e K=V] [-w DIR] [-u USER] <NAME> -- <CMD...>(退出码透传)
 *   logs  [--tail N] <NAME>
 *   stop  <NAME>(snapshot 前置:沙箱必须已停止)
 *   remove --force <NAME>
 *   snapshot create <SNAP> --from <NAME> [--label K=V]
 *   run --from-snapshot <SNAP> --name <NAME> --detach
 */
import { mergeLabels } from "./labels.ts";
import { containerName } from "./docker-args.ts";
import type { ExecOptions, LogsOptions, SandboxSpec } from "./types.ts";

/** msb 沙箱名与 docker 容器名同惯例:neoba-<id 前 12 位>。 */
export function sandboxName(id: string): string {
  return containerName(id);
}

/** snapshot 引用名(池条目),同 id 派生惯例。 */
export function snapshotName(id: string): string {
  return `neoba-snap-${id.slice(0, 12)}`;
}

/** 字节数 → msb --memory 形态(如 536870912 → "512M");<1MiB 按 1M 兜底。 */
export function formatMemoryMiB(bytes: number): string {
  const mib = Math.max(1, Math.round(bytes / (1024 * 1024)));
  return `${mib}M`;
}

/** msb create 全量参数(idle 拉起;基座命令一律经 exec 下发)。 */
export function buildCreateArgs(spec: SandboxSpec, id: string, createdAt: string): string[] {
  const args: string[] = ["create", "--name", sandboxName(id)];

  for (const [k, v] of Object.entries(mergeLabels(spec, "microsandbox", id, createdAt))) {
    args.push("--label", `${k}=${v}`);
  }

  const resources = spec.resources ?? {};
  if (resources.cpus !== undefined) args.push("-c", String(resources.cpus));
  if (resources.memoryBytes !== undefined) {
    args.push("--memory", formatMemoryMiB(resources.memoryBytes));
  }
  // pids_limit 为 docker 语义,microVM 内无对应 CLI 面,忽略(声明性记录)

  // 网络缺省 deny(最严,§5);bridge → allow;allowlist 已被 validateSpec 拒绝
  const network = spec.network ?? { mode: "none" as const };
  args.push("--net-default", network.mode === "none" ? "deny" : "allow");

  if (spec.workdir !== undefined) args.push("-w", spec.workdir);
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
  for (const m of spec.mounts ?? []) {
    // msb volume 语义:SOURCE:DEST[:OPTIONS];缺省 rw,ro 以 options 表达
    args.push("-v", m.mode === "ro" ? `${m.source}:${m.target}:ro` : `${m.source}:${m.target}`);
  }

  args.push(spec.image);
  return args;
}

/** msb exec:--quiet 抑制进度输出;`--` 后为沙箱内命令;退出码透传。 */
export function buildExecArgs(name: string, cmd: string[], opts?: ExecOptions): string[] {
  const args: string[] = ["exec", "-q"];
  if (opts?.user !== undefined) args.push("-u", opts.user);
  if (opts?.workdir !== undefined) args.push("-w", opts.workdir);
  for (const [k, v] of Object.entries(opts?.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(name, "--", ...cmd);
  return args;
}

export function buildLogsArgs(name: string, opts?: LogsOptions): string[] {
  return opts?.tail !== undefined
    ? ["logs", "--tail", String(opts.tail), name]
    : ["logs", name];
}

export function buildStopArgs(name: string): string[] {
  return ["stop", name];
}

export function buildRemoveArgs(name: string): string[] {
  return ["remove", "--force", name];
}

/** snapshot create:沙箱必须已停止;引用名由 neoba 指定,管理标签随行。 */
export function buildSnapshotCreateArgs(ref: string, name: string, createdAt: string): string[] {
  return [
    "snapshot", "create", ref,
    "--from", name,
    "--label", "neoba.managed=true",
    "--label", `neoba.snapshot-at=${createdAt}`,
  ];
}

/** restore:从 snapshot 拉起并后台运行;--name 锚定输出,便于校验(防解析漂移)。 */
export function buildRestoreArgs(ref: string, name: string): string[] {
  return ["run", "--from-snapshot", ref, "--name", name, "--detach"];
}
