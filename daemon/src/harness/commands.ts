/**
 * 基座命令表(§4 多基座集成):base → 容器内启动命令。
 *
 * 集中一处维护,ExecRuntime 按 preset.base 查表生成 argv;命令行不出现
 * bypass 类标志(§4.4 硬规则,sidecar/bypass.ts 生成后校验兜底)。
 * - claude-code:stream-json 逐行输出,P1 已实测;
 * - codex:`codex exec --json` 实验性 JSONL 事件流(spike #1 C7 采样);
 *   --sandbox workspace-write 对齐节点写工件的工作目录语义;
 * - opencode:`opencode run` 文本输出(M2 简化模式,server API 模式推迟)。
 */
import type { Base } from '../capability/types.ts';

/** preset.base = 'any'(无偏好)时的落位基座。 */
export const DEFAULT_BASE: Base = 'claude-code';

/** 已注册基座名(工厂与 doctor 共用)。 */
export const KNOWN_BASES: readonly Base[] = ['any', 'claude-code', 'codex', 'opencode'];

/** 生成基座启动命令(容器内 argv;'any' 应先经 resolveBase 落位)。 */
export function baseCommand(
  base: Base,
  ctx: { readonly instruction: string },
): readonly string[] {
  switch (base) {
    case 'claude-code':
      return ['claude', '-p', ctx.instruction, '--output-format', 'stream-json'];
    case 'codex':
      return [
        'codex', 'exec', '--json',
        '--skip-git-repo-check',
        '--sandbox', 'workspace-write',
        ctx.instruction,
      ];
    case 'opencode':
      return ['opencode', 'run', ctx.instruction];
    case 'any':
      // 防御:未落位的 'any' 按 DEFAULT_BASE 处理(正常路径经 resolveBase)。
      return baseCommand(DEFAULT_BASE, ctx);
  }
}

/** 'any' → 落位基座;其余原样(未知值由上层 AdapterUnknown 拦截)。 */
export function resolveBase(base: Base, defaultBase: Base = DEFAULT_BASE): Base {
  return base === 'any' ? defaultBase : base;
}
