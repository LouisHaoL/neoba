/**
 * neoba doctor - 后端判定。
 *
 * 依据设计文档 §10.6:Windows 沙箱后端 = WSL2 内 Docker;
 * Linux / macOS 直接用 host 侧 Docker。判定只依赖检查结果,不执行命令。
 */

import type { CheckResult, RecommendedBackend } from './types.ts';

export interface BackendDecision {
  backend: RecommendedBackend;
  reason: string;
}

function find(checks: CheckResult[], id: string): CheckResult | undefined {
  return checks.find((c) => c.id === id);
}

function passed(checks: CheckResult[], id: string): boolean {
  const c = find(checks, id);
  return c !== undefined && c.ok;
}

export function recommendBackend(
  checks: CheckResult[],
  platformName: string,
): BackendDecision {
  if (platformName === 'win32') {
    const wslOk =
      passed(checks, 'wsl-status') &&
      passed(checks, 'wsl-docker-cli') &&
      passed(checks, 'wsl-docker-daemon');
    if (wslOk) {
      return {
        backend: 'docker-wsl2',
        reason: 'Windows 平台按设计约定使用 WSL2 内 Docker 作为沙箱后端;WSL2 与 WSL 内 docker daemon 均可用',
      };
    }
    if (passed(checks, 'docker-cli') && passed(checks, 'docker-daemon')) {
      return {
        backend: 'docker',
        reason: 'WSL2 内 Docker 不可用,但 host 侧 Docker Desktop daemon 可达,退化为 docker 后端',
      };
    }
    if (!passed(checks, 'wsl-status')) {
      return {
        backend: 'none',
        reason: 'WSL2 未安装或默认版本不是 2,且无其他可用 Docker daemon',
      };
    }
    if (!passed(checks, 'wsl-docker-cli')) {
      return {
        backend: 'none',
        reason: 'WSL2 已安装,但 WSL 内缺少 docker CLI',
      };
    }
    return {
      backend: 'none',
      reason: 'WSL2 已安装,但 WSL 内 docker daemon 不可达',
    };
  }

  // linux / darwin 及其他平台:host 侧 Docker
  if (!passed(checks, 'docker-cli')) {
    return {
      backend: 'none',
      reason: '未检测到可用的 docker CLI',
    };
  }
  if (!passed(checks, 'docker-daemon')) {
    return {
      backend: 'none',
      reason: 'docker CLI 存在,但 daemon 不可达',
    };
  }
  const composeNote = passed(checks, 'docker-compose')
    ? ''
    : '(compose 缺失,不影响单容器后端)';
  return {
    backend: 'docker',
    reason: `host 侧 docker CLI 与 daemon 均可用${composeNote}`,
  };
}
