/**
 * neoba doctor:跑环境检测(接 src/doctor 的 runDoctor)。
 * 默认人读渲染(renderReport);--json 出结构化报告;--write 落配置(writeConfig)。
 * 检测逻辑全在 doctor 模块;探针经 deps.execProbe 注入,测试用假探针。
 */

import { renderReport } from '../../doctor/index.ts';
import { flagBool, parseArgs } from '../args.ts';
import type { Command } from '../types.ts';

export const doctorCommand: Command = {
  name: 'doctor',
  summary: '环境检测(后端推荐 / Codex 前置 / 数据面路径)',
  usage: 'neoba doctor [--write] [--json]',
  async run(args, { io, deps }) {
    const { flags } = parseArgs(args, []);
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

    if (asJson) io.out(JSON.stringify(report, null, 2));
    else io.out(renderReport(r));
    return 0;
  },
};
