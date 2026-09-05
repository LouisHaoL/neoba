/**
 * MicrosandboxProvider:SandboxProvider 的 Firecracker microVM 后端(M7,§9 P4)。
 * 经 microsandbox CLI(`msb`)子进程操作,零第三方依赖;CliRunner 可注入假实现
 * 供全矩阵桩测试(真桥冒烟见仓库 manual checklist,不进 CI)。
 *
 * 与 DockerProvider 的关键差异:
 * - microVM 硬件隔离:userns 天然满足(基座前置不探测、不拒绝,§5 v0.2);
 * - create = idle 拉起(`msb create`),基座命令一律经 exec 下发,spec.command
 *   不适用(显式 NotSupported,不静默忽略);
 * - snapshot/restore 真实可用(池化的准入能力,§9 P4 预热池):snapshot 前
 *   必须 stop(msb 规格),restore = `msb run --from-snapshot` 秒级回热;
 * - CLI 不可用(spawn 失败)/ msbd 服务端不可达 → PrerequisiteNotMetError,
 *   显式拒绝不静默降级;其余非零退出 → CommandFailedError;
 * - 未知 CLI 输出(如 restore 输出与锚定名不符)→ CliOutputParseError,
 *   类型化解析错误,不炸事件流(思路同 harness adapter 的 parse_error)。
 */
import { randomUUID } from "node:crypto";
import {
  CliOutputParseError,
  CommandFailedError,
  InvalidStateError,
  NotSupportedError,
  PrerequisiteNotMetError,
  SandboxError,
} from "./errors.ts";
import {
  buildCreateArgs,
  buildExecArgs,
  buildLogsArgs,
  buildRemoveArgs,
  buildRestoreArgs,
  buildSnapshotCreateArgs,
  buildStopArgs,
  sandboxName,
  snapshotName,
} from "./msb-args.ts";
import { mergeLabels } from "./labels.ts";
import { HandleRegistry } from "./registry.ts";
import { createMicrosandboxCliRunner, type CliResult, type CliRunner } from "./runner.ts";
import { validateSpec } from "./validate.ts";
import type {
  ExecOptions,
  ExecResult,
  LogsOptions,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from "./types.ts";

/** msbd 服务端不可达时 stderr/stdout 的常见形态(msb 走本地 msbd REST)。 */
const UNREACHABLE_PATTERN =
  /connection refused|not running|failed to connect|msbd.*(unreachable|down)|error connecting/i;

/** 沙箱不存在的错误形态(remove/logs/exec 对已删沙箱;幂等 destroy 用)。 */
const NO_SANDBOX_PATTERN = /no such sandbox|sandbox .* not found|not found: sandbox/i;

export interface MicrosandboxProviderOptions {
  runner?: CliRunner;
}

export class MicrosandboxProvider implements SandboxProvider {
  readonly backend = "microsandbox";
  readonly snapshotCapable = true;
  readonly runner: CliRunner;
  readonly #registry = new HandleRegistry();

  constructor(options: MicrosandboxProviderOptions = {}) {
    this.runner = options.runner ?? createMicrosandboxCliRunner();
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    validateSpec(spec);
    // microVM 硬件隔离:userns 天然满足,不探测、不拒绝(§5 v0.2 前置契约
    // 由后端显式满足;与 DockerProvider 的 seccomp 放行路径形成对照)。
    if (spec.command !== undefined) {
      throw new NotSupportedError(
        "microsandbox 后端以 idle 沙箱拉起(msb create),spec.command 不适用;" +
          "基座命令一律经 exec 下发(exec-runtime 语义)",
      );
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const handle: SandboxHandle = {
      id,
      status: "pending",
      createdAt,
      name: sandboxName(id),
      labels: {
        ...mergeLabels(spec, this.backend, id, createdAt),
        // msb create 无 --user 面(用户经 exec -u 下发),spec.user 记入标签,
        // exec 缺省用户由此还原(msb create 规格差异的映射)
        ...(spec.user !== undefined ? { "neoba.user": spec.user } : {}),
      },
    };
    this.#registry.add(handle);

    handle.status = "provisioning";
    await this.#run(buildCreateArgs(spec, id, createdAt));
    handle.status = "running";
    return handle;
  }

  async exec(
    handle: SandboxHandle,
    cmd: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const record = this.#requireRunning(handle);
    // spec.user 为该沙箱的缺省执行用户;opts.user 显式覆盖
    const user = opts?.user ?? this.#userOf(record);
    const merged: ExecOptions = {
      ...opts,
      ...(user !== undefined ? { user } : {}),
    };
    // exec 的非零退出码是命令结果,不是 provider 错误,原样透传
    const result = await this.#run(buildExecArgs(record.name, cmd, merged), { allowNonZero: true });
    return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
  }

  async logs(handle: SandboxHandle, opts?: LogsOptions): Promise<string> {
    const record = this.#requireLive(handle);
    const result = await this.#run(buildLogsArgs(record.name, opts));
    return result.stdout;
  }

  /** 幂等:对已销毁或未知句柄直接返回;沙箱已不存在视为已销毁。 */
  async destroy(handle: SandboxHandle): Promise<void> {
    const record = this.#registry.find(handle.id);
    if (record === undefined || record.status === "removed") {
      handle.status = "removed";
      return;
    }
    try {
      await this.#run(buildRemoveArgs(record.name));
    } catch (err) {
      if (!(err instanceof SandboxError) || !NO_SANDBOX_PATTERN.test(err.message)) {
        throw err;
      }
    }
    record.status = "removed";
    handle.status = "removed";
  }

  async list(labels?: Record<string, string>): Promise<SandboxHandle[]> {
    return this.#registry.list(labels);
  }

  /**
   * snapshot(msb 规格:先 stop 后 snapshot create):返回池化引用名。
   * 句柄转入 stopped(仍注册,destroy 可续);恢复走 restore(ref)。
   */
  async snapshot(handle: SandboxHandle): Promise<string> {
    const record = this.#requireLive(handle);
    if (record.status !== "running" && record.status !== "stopped") {
      throw new InvalidStateError(
        `沙箱 ${handle.id} 状态为 ${record.status},不可 snapshot`,
      );
    }
    const ref = snapshotName(handle.id);
    if (record.status === "running") {
      await this.#run(buildStopArgs(record.name));
      record.status = "stopped";
    }
    await this.#run(buildSnapshotCreateArgs(ref, record.name, new Date().toISOString()));
    return ref;
  }

  /**
   * restore:`msb run --from-snapshot <ref> --detach` 秒级回热。
   * 输出以锚定名校验(--name 由我们指定):不符 → CliOutputParseError,
   * 类型化解析错误,不炸事件流。
   */
  async restore(snapshotRef: string): Promise<SandboxHandle> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const name = sandboxName(id);
    const handle: SandboxHandle = {
      id,
      status: "provisioning",
      createdAt,
      name,
      labels: {
        "neoba.managed": "true",
        "neoba.provider": this.backend,
        "neoba.created-at": createdAt,
        "neoba.id": id,
        "neoba.snapshot": snapshotRef,
      },
    };
    const result = await this.#run(buildRestoreArgs(snapshotRef, name));
    if (!extractOutputText(result).includes(name)) {
      throw new CliOutputParseError(
        `msb run --from-snapshot 输出与锚定名 ${name} 不符,无法确认沙箱回热:` +
          `${JSON.stringify(extractOutputText(result).slice(0, 200))}`,
      );
    }
    this.#registry.add(handle);
    handle.status = "running";
    return handle;
  }

  async acquire(_slot: string): Promise<void> {
    throw new NotSupportedError(
      "资源池排队未实现(§6 v0.2,由 ResourceGate 在包装层确定性执行)",
    );
  }

  async release(_slot: string): Promise<void> {
    throw new NotSupportedError(
      "资源池排队未实现(§6 v0.2,由 ResourceGate 在包装层确定性执行)",
    );
  }

  // ------------------------------------------------------------------ 内部

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

  /** spec.user 存进管理标签(neoba.user),exec 缺省用户由此还原。 */
  #userOf(record: SandboxHandle): string | undefined {
    return record.labels["neoba.user"];
  }

  /**
   * 统一的 runner 封装:
   * - spawn 失败(CLI 未安装等)→ PrerequisiteNotMetError(不静默降级);
   * - msbd 不可达 → PrerequisiteNotMetError;
   * - 其余非零 → CommandFailedError(allowNonZero 时仅透传,供 exec 使用)。
   */
  async #run(args: string[], opts?: { allowNonZero?: boolean }): Promise<CliResult> {
    let result: CliResult;
    try {
      result = await this.runner(args);
    } catch (err) {
      throw new PrerequisiteNotMetError(
        `无法启动 microsandbox CLI(${args.join(" ")}): ${err instanceof Error ? err.message : String(err)}。` +
          "msb 未安装或不可执行,microsandbox 后端拒绝供给,不静默降级",
      );
    }
    if (result.code !== 0) {
      const text = extractOutputText(result);
      if (UNREACHABLE_PATTERN.test(text)) {
        throw new PrerequisiteNotMetError(
          `microsandbox 服务端(msbd)不可达: ${text}。microsandbox 后端拒绝供给,不静默降级`,
        );
      }
      if (opts?.allowNonZero === true) return result;
      throw new CommandFailedError(
        `msb ${args.join(" ")} 失败(exit ${result.code})${text === "" ? "" : `: ${text}`}`,
      );
    }
    return result;
  }
}

/** stdout+stderr 合并(trim);msb 部分子命令把进度写到 stderr。 */
function extractOutputText(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}
