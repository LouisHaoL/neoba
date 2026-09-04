/**
 * 句柄注册表:provider 内部记录本实例创建过的沙箱。
 * create 返回的是注册表内的活动对象,destroy 等状态变更对所有持引用方可见。
 */
import { labelsMatch } from "./labels.ts";
import type { SandboxHandle } from "./types.ts";

export class HandleRegistry {
  readonly #records = new Map<string, SandboxHandle>();

  add(handle: SandboxHandle): SandboxHandle {
    this.#records.set(handle.id, handle);
    return handle;
  }

  find(id: string): SandboxHandle | undefined {
    return this.#records.get(id);
  }

  /** 列出未销毁句柄;labels 为子集匹配。 */
  list(labels?: Record<string, string>): SandboxHandle[] {
    const out: SandboxHandle[] = [];
    for (const record of this.#records.values()) {
      if (record.status === "removed") continue;
      if (labelsMatch(record.labels, labels)) out.push(record);
    }
    return out;
  }
}
