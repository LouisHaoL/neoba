/**
 * ExecRuntime:NodeRuntime 的参考实现 —— 在沙箱内以 exec 方式跑基座 CLI,
 * stdout 逐行经 HarnessAdapter(preset.base 分派,§4 多基座)归一为 §3.6
 * 统一事件;产物按 preset.io_contracts.outputs 的端口名从约定路径
 * `/workspace/artifacts/<nodeId>/<name>` 逐文件读回(exec `cat`)。
 *
 * 定位:参考实现,不追求产线完备 ——
 * - provider.exec 是整段返回(v0.2 接口无流式),事件在跑完后统一归一;
 * - 产物只支持单文件(目录型端口需 sidecar 文件系统事实,属 §3.7 sidecar 职责);
 * - 取消经 ctx.signal 协作:已发出的 exec 无法中断,下一边界检查生效。
 *
 * 测试注入 MemoryProvider + 自定义 execHandler 即可覆盖全部语义。
 */
import { createAdapter, baseCommand, DEFAULT_BASE, resolveBase } from '../harness/index.ts';
import type { Base } from '../capability/types.ts';
import type { SandboxProvider } from '../provision/types.ts';
import type { UnifiedEvent } from '../harness/types.ts';
import type { NodeRunContext, NodeRuntime, RuntimeArtifact, RuntimeResult } from './types.ts';

export interface ExecRuntimeOptions {
  /**
   * 构造基座命令;缺省按 ctx.preset.base 查 harness/commands.ts 命令表
   * (claude-code / codex / opencode,'any' 落位 defaultBase)。
   */
  readonly buildCommand?: (ctx: NodeRunContext) => readonly string[];
  /** 产物在容器内的目录(缺省 /workspace/artifacts)。 */
  readonly artifactDir?: string;
  /** preset.base = 'any'(无偏好)时的落位基座(缺省 claude-code)。 */
  readonly defaultBase?: Base;
}

/**
 * 构造绑定 provider 的 ExecRuntime(node 运行 .ts、零 DI 容器,用工厂注入)。
 */
export function makeExecRuntime(provider: SandboxProvider, options: ExecRuntimeOptions = {}): NodeRuntime {
  const artifactDir = options.artifactDir ?? '/workspace/artifacts';
  return {
    async run(ctx: NodeRunContext): Promise<RuntimeResult> {
      if (ctx.signal.aborted) throw new Error('执行已取消');
      // 基座分派(§4 多基座):preset.base 落位后查命令表 + 选 adapter。
      const base = resolveBase(ctx.preset.base, options.defaultBase ?? DEFAULT_BASE);
      const cmd = options.buildCommand !== undefined
        ? options.buildCommand(ctx)
        : baseCommand(base, { instruction: ctx.instruction });
      const exec = await provider.exec(ctx.handle, [...cmd], { workdir: '/workspace' });

      // 基座输出 → §3.6 统一事件(坏行由 adapter 发 parse_error,不炸流)。
      const adapter = createAdapter(base);
      const events: UnifiedEvent[] = [];
      for (const line of exec.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        events.push(...adapter.translate(trimmed));
      }

      // 产物读回:契约端口逐个 cat;读不到 = 缺口(引擎按 output_missing 处理)。
      const artifacts: RuntimeArtifact[] = [];
      for (const port of ctx.preset.io_contracts.outputs) {
        const path = `${artifactDir}/${ctx.nodeId}/${port.name}`;
        const read = await provider.exec(ctx.handle, ['cat', path], { workdir: '/workspace' });
        if (read.exitCode === 0) {
          artifacts.push({ name: port.name, payload: read.stdout });
        }
      }

      return { exitCode: exec.exitCode, events, artifacts };
    },
  };
}
