/**
 * neoba start:拉起 daemon(§6)。默认(也是唯一)前台运行,Ctrl+C 优雅关闭;
 * --foreground 与缺省同义;--daemonize 明确报 not-supported(v0.2 不做后台化)。
 *
 * #6 外部编排文档常驻交接:--presets DIR / --registry FILE / --models FILE
 * 装载外部预设目录、能力注册表、模型评分表(装载器与 workflow check 同源);
 * 缺省回落 neoba.config.json 顶层 presets/registry/models 字段(相对路径相对
 * config 文件所在目录解析),再缺省 = 内置 minimal + 缺省注册表(models 走
 * <stateDir>/modelscore.json)。装载失败类型化报错(StartArtifactLoadError)
 * 退出非 0,不静默降级。
 */

import { DaemonPortInUse } from '../../daemon/index.ts';
import { flagBool, flagInt, flagString, parseArgs, CliUsageError } from '../args.ts';
import type { Command } from '../types.ts';

export const startCommand: Command = {
  name: 'start',
  summary: '拉起 neoba daemon(前台运行,Ctrl+C 优雅关闭)',
  usage:
    'neoba start [--state-dir DIR] [--port N] [--presets DIR] [--registry FILE] [--models FILE] [--foreground]',
  async run(args, { io, deps }) {
    const { flags } = parseArgs(args, ['state-dir', 'port', 'presets', 'registry', 'models']);
    if (flagBool(flags, 'daemonize')) {
      throw new CliUsageError('--daemonize not-supported:v0.2 仅支持前台运行');
    }

    const stateDir = flagString(flags, 'state-dir');
    const port = flagInt(flags, 'port');
    const presetsDir = flagString(flags, 'presets');
    const registryFile = flagString(flags, 'registry');
    const modelsFile = flagString(flags, 'models');
    let handle: Awaited<ReturnType<typeof deps.startDaemon>>;
    try {
      handle = await deps.startDaemon({
        ...(stateDir !== undefined ? { stateDir } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(presetsDir !== undefined ? { presetsPath: presetsDir } : {}),
        ...(registryFile !== undefined ? { registryPath: registryFile } : {}),
        ...(modelsFile !== undefined ? { modelsPath: modelsFile } : {}),
      });
    } catch (err) {
      if (err instanceof DaemonPortInUse) {
        io.err(`neoba: 端口 ${err.port} 已被占用(PORT_IN_USE);可用 --port N 换端口`);
        return 1;
      }
      throw err;
    }
    const h = handle as {
      baseUrl: string;
      stateDir: string;
      tokenFile: string;
      pid: unknown;
    };
    for (const line of [
      `neoba daemon 已启动: ${h.baseUrl}`,
      `  stateDir = ${h.stateDir}`,
      `  token    = ${h.tokenFile}`,
      '按 Ctrl+C 优雅关闭',
    ]) {
      io.out(line);
    }

    let stopping = false;
    const shutdown = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      io.out(`收到 ${signal},正在优雅关闭...`);
      void (handle as { stop(): Promise<void> })
        .stop()
        .then(() => {
          process.exitCode = 0;
          process.exit(0);
        })
        .catch((err: unknown) => {
          io.err(`neoba: 关闭失败: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // 前台常驻:直到信号触发 stop() 后进程退出。
    return await new Promise<number>(() => {});
  },
};
