/**
 * neoba doctor - 数据面路径跨界检测(设计文档 v0.2 §10.6)。
 *
 * Windows 后端 = WSL2 内 Docker,数据面(workdir / 工件仓库 / docker context)
 * 必须全在 WSL2 原生文件系统内;落在 Windows 盘符(drvfs/9p 跨界)是 error 级
 * 性能悬崖,不是警告。
 *
 * 纯函数:输入路径 + 平台上下文,无任何 IO,可直接单测。
 */

export type DataPlaneLocation =
  | 'wsl-native' // \\wsl$\... / \\wsl.localhost\... 或 WSL 发行版内 POSIX 路径
  | 'wsl-mnt-bridge' // /mnt/c/... 经 drvfs/9p 跨界
  | 'windows-drive' // C:\... / D:/... 或其他 UNC,跨界
  | 'host-native' // Linux / macOS 原生路径
  | 'unknown'; // 无法判断(空串、相对路径等)

export interface DataPlaneContext {
  platform: string;
}

export interface DataPlaneClassification {
  location: DataPlaneLocation;
  crossBoundary: boolean;
  detail: string;
}

/** 反斜杠字符(避免源码中出现转义歧义)。 */
const BS = String.fromCharCode(92);
const UNC_PREFIX = BS + BS;

export function classifyDataPlanePath(
  rawPath: string,
  ctx: DataPlaneContext,
): DataPlaneClassification {
  const p = rawPath.trim();
  if (p === '') {
    return { location: 'unknown', crossBoundary: false, detail: '路径为空,无法判断' };
  }
  if (ctx.platform !== 'win32') {
    return {
      location: 'host-native',
      crossBoundary: false,
      detail: `${ctx.platform} 原生文件系统,无跨界问题`,
    };
  }

  const lower = p.toLowerCase().split('/').join(BS);
  if (lower.startsWith(UNC_PREFIX + 'wsl$') || lower.startsWith(UNC_PREFIX + 'wsl.localhost')) {
    return {
      location: 'wsl-native',
      crossBoundary: false,
      detail: 'WSL2 原生文件系统(wsl$ 访问路径)',
    };
  }
  // /mnt/c/... → drvfs/9p 跨界
  if (/^\/mnt\/[a-z](\/|$)/i.test(p)) {
    return {
      location: 'wsl-mnt-bridge',
      crossBoundary: true,
      detail: '经 /mnt/<盘符> 访问 Windows 盘(drvfs/9p 跨界,性能悬崖)',
    };
  }
  // C:\... / D:/... → Windows 盘符路径
  if (/^[a-z]:[\\/]/i.test(p)) {
    return {
      location: 'windows-drive',
      crossBoundary: true,
      detail: 'Windows 盘符路径,位于 WSL2 原生文件系统之外(drvfs/9p 跨界,性能悬崖)',
    };
  }
  // 其他 UNC 共享(\\server\share)也不在 WSL 原生 FS 内
  if (lower.startsWith('\\\\')) {
    return {
      location: 'windows-drive',
      crossBoundary: true,
      detail: 'UNC 网络共享路径,不在 WSL2 原生文件系统内',
    };
  }
  // 其余 POSIX 绝对路径视为 WSL 发行版内(如 /home/...、/opt/...)
  if (p.startsWith('/')) {
    return {
      location: 'wsl-native',
      crossBoundary: false,
      detail: '视为 WSL 发行版内 POSIX 路径(ext4 原生)',
    };
  }
  return {
    location: 'unknown',
    crossBoundary: false,
    detail: '相对路径,无法判断所在文件系统',
  };
}

/** 从 daemon 配置对象中收集数据面路径(纯函数,只读已知键)。 */
export interface DataPlanePathInput {
  kind: string;
  path: string;
}

export function collectDataPlanePaths(
  config: Record<string, unknown>,
): DataPlanePathInput[] {
  const out: DataPlanePathInput[] = [];
  const pick = (section: unknown, keys: [string, string][]) => {
    if (typeof section !== 'object' || section === null) return;
    const rec = section as Record<string, unknown>;
    for (const [key, kind] of keys) {
      const v = rec[key];
      if (typeof v === 'string' && v.trim() !== '') {
        out.push({ kind, path: v });
      }
    }
  };
  pick(config['sandbox'], [['workdir', 'workdir']]);
  pick(config['artifacts'], [['repoPath', 'artifact-repo']]);
  pick(config['docker'], [['contextPath', 'docker-context']]);
  return out;
}
