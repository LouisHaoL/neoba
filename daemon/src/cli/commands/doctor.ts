/**
 * neoba doctor:跑环境检测(接 src/doctor 的 runDoctor)。
 * 默认人读渲染(renderReport);--json 出结构化报告;--write 落配置(writeConfig)。
 * 检测逻辑全在 doctor 模块;探针经 deps.execProbe 注入,测试用假探针。
 *
 * 退出码(#30):存在 severity:'fail' 的检查项 → 1,与 status(不在 → 1)、
 * workflow check(失败 → 1)语义对齐;warning / unknown 不影响退出码。
 * --json 报告附顶层 ok 字段(fail 数为 0 即 true)。
 */

import { renderReport } from '../../doctor/index.ts';
import { flagBool, parseArgs } from '../args.ts';
import type { Command } from '../types.ts';

/** 统计报告里 severity:'fail' 的检查项数(退出码与 ok 字段的统一口径)。 */
export function countFailures(report: unknown): number {
  const checks = (report as { checks?: readonly { severity?: unknown }[] }).checks;
  if (!Array.isArray(checks)) return 0;
  return checks.filter((c) => c.severity === 'fail').length;
}

export const doctorCommand: Command = {
  name: 'doctor',
  summary: '环境检测(后端推荐 / Codex 前置 / 数据面路径)',
  usage: 'neoba doctor [--write] [--json]',
  async run(args, { io, deps }) {
    const { flags } = parseArgs(args, [], ['write', 'json']);
    const asJson = flagBool(flags, 'json');
    const doWrite = flagBool(flags, 'write');

    const report = await deps.runDoctor({ probe: deps.execProbe });
    const r = report as Parameters<typeof renderReport>[0];

    if (doWrite) {
      const configPath = deps.defaultConfigPath();
      await deps.writeConfig(report, configPath);
      if (!asJson) io.out(`配置已写入: ${configPath}`);
      else io.err(`doctor: 配置已写入 ${configPath}`);
    }

    if (asJson) io.out(JSON.stringify({ ...(report as object), ok: countFailures(report) === 0 }, null, 2));
    else io.out(renderReport(r));
    // 有 fail 级检查项 → 非 0(脚本/CI 可据此阻断);仅 warn/unknown 仍算通过。
    return countFailures(report) === 0 ? 0 : 1;
  },
};
