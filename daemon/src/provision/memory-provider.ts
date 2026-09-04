/**
 * MemoryProvider:进程内假实现,行为语义与 DockerProvider 一致
 * (同一套状态机/幂等/错误约定),对象全在内存里。
 * 用途:单测、无 Docker 环境下的编排引擎开发。
 */
import { randomUUID } from "node:crypto";
import { InvalidStateError, NotSupportedError, PrerequisiteNotMetError } from "./errors.ts";
import { mergeLabels } from "./labels.ts";
import { HandleRegistry } from "./registry.ts";
import { validateSpec } from "./validate.ts";
import type {
  ExecOptions,
  ExecResult,
  LogsOptions,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from "./types.ts";

export interface MemoryExecCall {
  handleId: string;
  cmd: string[];
  opts?: ExecOptions;
}

/** 自定义 exec 行为(模拟容器内命令结果);缺省一切命令 exit 0、无输出。 */
export type MemoryExecHandler = (
  handle: SandboxHandle,
  cmd: string[],
  opts?: ExecOptions,
) => ExecResult;

export interface MemoryProviderOptions {
  execHandler?: MemoryExecHandler;
  now?: () => Date;
  /** 模拟的宿主能力(§5 v0.2 前置条件拒绝路径);缺省一律不满足 */
  capabilities?: {
    userns?: boolean;
  };
}

export class MemoryProvider implements SandboxProvider {
  readonly backend = "memory";
  readonly #registry = new HandleRegistry();
  readonly #logLines = new Map<string, string[]>();
  readonly #execCalls: MemoryExecCall[] = [];
  readonly #execHandler?: MemoryExecHandler;
  readonly #now: () => Date;
  readonly #capabilities: { userns?: boolean };

  constructor(options: MemoryProviderOptions = {}) {
    this.#execHandler = options.execHandler;
    this.#now = options.now ?? (() => new Date());
    this.#capabilities = options.capabilities ?? {};
  }

  /** 本实例收到的全部 exec 调用(供测试/调试断言)。 */
  get execCalls(): readonly MemoryExecCall[] {
    return this.#execCalls;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    // 语义对齐 DockerProvider:前置条件不满足在拉起之前显式拒绝
    validateSpec(spec);
    if (spec.baseRequirements?.userns === true && this.#capabilities.userns !== true) {
      throw new PrerequisiteNotMetError(
        `基座 ${spec.baseRequirements.harness ?? "(未声明)"} 要求 userns 内核能力(clone(CLONE_NEWUSER),bubblewrap 前置),` +
          "但本 memory 后端未声明 userns 能力,无法满足",
      );
    }

    const id = `mem-${randomUUID()}`;
    const createdAt = this.#now().toISOString();
    const handle: SandboxHandle = {
      id,
      status: "pending",
      createdAt,
      name: id,
      labels: mergeLabels(spec, this.backend, id, createdAt),
    };
    this.#registry.add(handle);
    this.#logLines.set(id, []);

    // 语义对齐 DockerProvider:pending → provisioning → running
    handle.status = "provisioning";
    handle.status = "running";
    return handle;
  }

  async exec(
    handle: SandboxHandle,
    cmd: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const record = this.#requireRunning(handle);
    this.#execCalls.push({ handleId: record.id, cmd: [...cmd], opts });
    const result = this.#execHandler !== undefined
      ? this.#execHandler(record, cmd, opts)
      : { exitCode: 0, stdout: "", stderr: "" };
    this.#appendLog(record.id, `[neoba] exec(exit ${result.exitCode}): ${cmd.join(" ")}`);
    return result;
  }

  async logs(handle: SandboxHandle, opts?: LogsOptions): Promise<string> {
    const record = this.#requireLive(handle);
    const lines = this.#logLines.get(record.id) ?? [];
    const selected = opts?.tail !== undefined ? lines.slice(-opts.tail) : lines;
    return selected.join("\n");
  }

  /** 幂等:对已销毁或未知句柄直接返回。 */
  async destroy(handle: SandboxHandle): Promise<void> {
    const record = this.#registry.find(handle.id);
    if (record === undefined || record.status === "removed") {
      handle.status = "removed";
      return;
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

  #appendLog(id: string, line: string): void {
    const lines = this.#logLines.get(id);
    if (lines !== undefined) lines.push(line);
  }
}
