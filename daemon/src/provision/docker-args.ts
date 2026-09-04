/**
 * SandboxSpec → docker CLI 参数的纯函数映射。
 * 产出交给 CliRunner 执行;测试直接断言参数数组,不依赖真实 docker。
 */
import { NotSupportedError } from "./errors.ts";
import { mergeLabels } from "./labels.ts";
import type { ExecOptions, LogsOptions, SandboxSpec } from "./types.ts";

/** 由句柄 id 派生容器名(全后端一致,id 前 12 位与 docker 短 id 惯例对齐)。 */
export function containerName(id: string): string {
  return `neoba-${id.slice(0, 12)}`;
}

/** docker create 全量参数(资源限额 / 网络 / 挂载 ro:rw / env / labels / 非 root 用户)。 */
export function buildCreateArgs(spec: SandboxSpec, id: string, createdAt: string): string[] {
  const args: string[] = ["create", "--name", containerName(id)];

  for (const [k, v] of Object.entries(mergeLabels(spec, "docker", id, createdAt))) {
    args.push("--label", `${k}=${v}`);
  }

  const resources = spec.resources ?? {};
  if (resources.memoryBytes !== undefined) args.push("--memory", String(resources.memoryBytes));
  if (resources.cpus !== undefined) args.push("--cpus", String(resources.cpus));
  if (resources.pidsLimit !== undefined) args.push("--pids-limit", String(resources.pidsLimit));

  // 网络缺省 none:最严默认;allowlist 为预留能力,映射层即拒绝
  const network = spec.network ?? { mode: "none" as const };
  if (network.mode === "allowlist") {
    throw new NotSupportedError(
      "network.mode=allowlist 为预留能力(§5 v0.2 grant 级出网授权),本期 docker 后端不支持",
    );
  }
  args.push("--network", network.mode);

  // 基座前置 userns(§5 v0.2):docker 默认 seccomp 拦 clone(CLONE_NEWUSER),需放行
  if (spec.baseRequirements?.userns === true) {
    args.push("--security-opt", "seccomp=unconfined");
  }

  if (spec.user !== undefined) args.push("--user", spec.user);
  if (spec.workdir !== undefined) args.push("--workdir", spec.workdir);

  for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
  for (const m of spec.mounts ?? []) args.push("-v", `${m.source}:${m.target}:${m.mode}`);

  args.push(spec.image, ...(spec.command ?? []));
  return args;
}

export function buildStartArgs(id: string): string[] {
  return ["start", id];
}

export function buildExecArgs(id: string, cmd: string[], opts?: ExecOptions): string[] {
  const args: string[] = ["exec"];
  if (opts?.user !== undefined) args.push("--user", opts.user);
  if (opts?.workdir !== undefined) args.push("--workdir", opts.workdir);
  for (const [k, v] of Object.entries(opts?.env ?? {})) args.push("--env", `${k}=${v}`);
  args.push(id, ...cmd);
  return args;
}

export function buildLogsArgs(id: string, opts?: LogsOptions): string[] {
  return opts?.tail !== undefined
    ? ["logs", "--tail", String(opts.tail), id]
    : ["logs", id];
}

export function buildRemoveArgs(id: string): string[] {
  return ["rm", "-f", id];
}
