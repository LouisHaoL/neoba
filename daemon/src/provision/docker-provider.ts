/**
 * DockerProvider:SandboxProvider 的 Docker 参考后端(§5)。
 * 经 docker CLI 子进程操作(create+start / exec / logs / rm -f),零第三方依赖;
 * CliRunner 可注入假实现供测试。
 */
import { randomUUID } from "node:crypto";
import {
  CommandFailedError,
  InvalidStateError,
  NotSupportedError,
  PrerequisiteNotMetError,
  ProviderUnavailableError,
  SandboxError,
} from "./errors.ts";
import {
  buildCreateArgs,
  buildExecArgs,
  buildLogsArgs,
  buildRemoveArgs,
  buildStartArgs,
  containerName,
} from "./docker-args.ts";
import { mergeLabels } from "./labels.ts";
import { HandleRegistry } from "./registry.ts";
import { createDockerCliRunner, type CliResult, type CliRunner } from "./runner.ts";
import { validateSpec } from "./validate.ts";
import type {
  ExecOptions,
  ExecResult,
  LogsOptions,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from "./types.ts";

/** docker daemon 不可达时 stderr 的常见形态(daemon 未启动 / pipe 失效)。 */
const UNREACHABLE_PATTERN =
  /cannot connect|error during connect|daemon (is )?not running|is the docker daemon|docker.*pipe|no such object.*daemon/i;

/** userns 探针:可注入(生产由 neoba doctor 结论/实测探针提供;测试注入假探针)。 */
export type UsernsProbe = () => Promise<boolean> | boolean;

export interface DockerProviderOptions {
  runner?: CliRunner;
  /** userns 能力探针;缺省视为探测不到 → 需 userns 的基座显式拒绝,不静默降级 */
  usernsProbe?: UsernsProbe;
}

export class DockerProvider implements SandboxProvider {
  readonly backend = "docker";
  readonly runner: CliRunner;
  readonly #usernsProbe?: UsernsProbe;
  readonly #registry = new HandleRegistry();

  constructor(options: DockerProviderOptions = {}) {
    this.runner = options.runner ?? createDockerCliRunner();
    this.#usernsProbe = options.usernsProbe;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    // 前置条件不满足在拉起之前显式拒绝,不产生半注册句柄
    validateSpec(spec);
    if (spec.baseRequirements?.userns === true) {
      const probe = this.#usernsProbe;
      const ok = probe !== undefined ? await probe() : false;
      if (!ok) {
        throw new PrerequisiteNotMetError(
          `基座 ${spec.baseRequirements.harness ?? "(未声明)"} 要求 userns 内核能力(clone(CLONE_NEWUSER),bubblewrap 前置),` +
            `${probe === undefined ? "但本 provider 未配置 userns 探针,无法验证" : "但 userns 探测未通过"},无法满足`,
        );
      }
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const handle: SandboxHandle = {
      id,
      status: "pending",
      createdAt,
      name: containerName(id),
      labels: mergeLabels(spec, this.backend, id, createdAt),
    };
    this.#registry.add(handle);

    handle.status = "provisioning";
    await this.#run(buildCreateArgs(spec, id, createdAt));
    await this.#run(buildStartArgs(id));
    handle.status = "running";
    return handle;
  }

  async exec(
    handle: SandboxHandle,
    cmd: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const record = this.#requireRunning(handle);
    // exec 的非零退出码是命令结果,不是 provider 错误,原样透传
    const result = await this.#run(buildExecArgs(record.id, cmd, opts), { allowNonZero: true });
    return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
  }

  async logs(handle: SandboxHandle, opts?: LogsOptions): Promise<string> {
    const record = this.#requireLive(handle);
    const result = await this.#run(buildLogsArgs(record.id, opts));
    return result.stdout;
  }

  /** 幂等:对已销毁或未知句柄直接返回;容器已不存在(rm 报 No such container)视为已销毁。 */
  async destroy(handle: SandboxHandle): Promise<void> {
    const record = this.#registry.find(handle.id);
    if (record === undefined || record.status === "removed") {
      handle.status = "removed";
      return;
    }
    try {
      await this.#run(buildRemoveArgs(record.id));
    } catch (err) {
      if (!(err instanceof SandboxError) || !/no such container/i.test(err.message)) {
        throw err;
      }
    }
    record.status = "removed";
    handle.status = "removed";
  }

  async list(labels?: Record<string, string>): Promise<SandboxHandle[]> {
    return this.#registry.list(labels);
  }

  async snapshot(_handle: SandboxHandle): Promise<string> {
    throw new NotSupportedError("snapshot 暂不支持(预留 §9 P4 预热池)");
  }

  async restore(_snapshotRef: string): Promise<SandboxHandle> {
    throw new NotSupportedError("restore 暂不支持(预留 §9 P4 预热池)");
  }

  async acquire(_slot: string): Promise<void> {
    throw new NotSupportedError(
      "资源池排队未实现(§6 v0.2,由 Provisioner 在事件日志上确定性执行)",
    );
  }

  async release(_slot: string): Promise<void> {
    throw new NotSupportedError(
      "资源池排队未实现(§6 v0.2,由 Provisioner 在事件日志上确定性执行)",
    );
  }

  #requireLive(handle: SandboxHandle): SandboxHandle {
    const record = this.#registry.find(handle.id);
    if (record === undefined) {
      throw new InvalidStateError(`沙箱 ${handle.id} 不属于本 provider 实例`);
    }
    if (record.status === "removed") {
      throw new InvalidStateError(`沙箱 ${handle.id} 已销毁`);
    }
    return record;
  }

  #requireRunning(handle: SandboxHandle): SandboxHandle {
    const record = this.#requireLive(handle);
    if (record.status !== "running") {
      throw new InvalidStateError(
        `沙箱 ${handle.id} 状态为 ${record.status},仅 running 状态可 exec`,
      );
    }
    return record;
  }

  /**
   * 统一的 runner 封装:spawn 失败/不可达 → ProviderUnavailableError;
   * 其余非零 → CommandFailedError(allowNonZero 时非零仅透传,供 exec 使用)。
   */
  async #run(args: string[], opts?: { allowNonZero?: boolean }): Promise<CliResult> {
    let result: CliResult;
    try {
      result = await this.runner(args);
    } catch (err) {
      throw new ProviderUnavailableError(
        `无法启动 docker CLI(${args.join(" ")}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      if (UNREACHABLE_PATTERN.test(stderr)) {
        throw new ProviderUnavailableError(`Docker daemon 不可达: ${stderr}`);
      }
      if (opts?.allowNonZero === true) return result;
      throw new CommandFailedError(
        `docker ${args.join(" ")} 失败(exit ${result.code})${stderr === "" ? "" : `: ${stderr}`}`,
      );
    }
    return result;
  }
}
