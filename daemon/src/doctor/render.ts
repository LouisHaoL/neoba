/**
 * neoba doctor - 人类可读的终端文本渲染。
 */

import type { CheckResult, DoctorReport, Severity } from './types.ts';

const ICONS: Record<Severity, string> = {
  ok: '✅',
  warn: '⚠️',
  fail: '❌',
  unknown: '❔',
};

function renderCheck(c: CheckResult): string {
  const icon = ICONS[c.severity];
  const lines = [`  ${icon} ${c.id.padEnd(18)} ${c.detail}`];
  if (c.suggestion !== undefined) {
    lines.push(`       └─ 建议: ${c.suggestion}`);
  }
  return lines.join('\n');
}

export function renderReport(report: DoctorReport): string {
  const p = report.platform;
  const kernel =
    p.kernelVersion === null ? '未知' : p.kernelVersion;
  const disk =
    p.targetDiskFreeBytes === null
      ? '未知'
      : `${(p.targetDiskFreeBytes / 1024 ** 3).toFixed(1)} GiB`;

  const lines: string[] = [
    'neoba doctor 环境检测报告',
    `时间: ${report.generatedAt}`,
    `平台: ${p.platform} ${p.arch} (release=${p.release}, version=${p.version})`,
    `内核: ${kernel} | CPU ${p.cpuCount} 核 | 内存 ${(p.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB | 目标盘剩余 ${disk}`,
    '',
    '检查项:',
  ];
  for (const c of report.checks) lines.push(renderCheck(c));
  lines.push('');
  lines.push(`推荐后端: ${report.recommendedBackend}`);
  lines.push(`判定理由: ${report.backendReason}`);
  lines.push(
    `Codex 基座前置: ${report.codexReady ? '满足' : `不满足(${report.codexReadyReason ?? '未知原因'})`}`,
  );
  lines.push(
    `数据面: ${report.dataPlane.length === 0
      ? '未配置路径'
      : report.dataPlaneCrossBoundary
        ? '存在跨界路径(error 级,需迁移到 WSL2 原生文件系统)'
        : '均在原生文件系统内'}`,
  );
  const wc = report.wslconfig;
  lines.push(
    `.wslconfig: ${wc.found
      ? `memory=${wc.memory ?? '(默认)'} processors=${wc.processors ?? '(默认)'}`
      : '未找到(使用 WSL 默认限额)'}${wc.parseError === null ? '' : ` 解析异常: ${wc.parseError}`}`,
  );
  return lines.join('\n');
}
