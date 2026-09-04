/**
 * spawn 硬规则(§4.4 v0.2,spike #1 E6):禁用 bypass 类标志。
 *
 * 实测依据:嵌套 `claude --dangerously-skip-permissions` 可整体击穿基座
 * 权限层,故 spawn 命令行绝不出现 bypass 标志,permissionMode 写死进
 * settings.json 且取值不得为 bypassPermissions。两个 assert 均为纯函数,
 * 由 buildSandboxConfig 在生成后自动调用(生成后校验),测试可直接单测。
 */
import { BypassFlagDetected, SidecarConfigInvalid } from './errors.ts';

/** 已知 bypass 类 CLI 标志(匹配语义:整串或作为子串出现即命中)。 */
export const BYPASS_FLAGS: readonly string[] = ['--dangerously-skip-permissions', '--yolo'];

/** 基座权限模式中被禁的取值(§1.3:该层可被击穿,更不允许主动开启)。 */
export const FORBIDDEN_PERMISSION_MODE = 'bypasspermissions';

/**
 * 校验启动命令行argv:出现 bypass 标志(含 --permission-mode
 * bypassPermissions 两种写法)→ BypassFlagDetected。
 */
export function assertNoBypassFlags(argv: readonly string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    const lower = token.toLowerCase();
    for (const flag of BYPASS_FLAGS) {
      if (lower.includes(flag)) {
        throw new BypassFlagDetected(token, `argv[${i}]`);
      }
    }
    // --permission-mode <mode> 与 --permission-mode=<mode> 两种写法。
    if (lower === '--permission-mode') {
      const value = (argv[i + 1] ?? '').toLowerCase();
      if (value === FORBIDDEN_PERMISSION_MODE) {
        throw new BypassFlagDetected(`${token} ${argv[i + 1] ?? ''}`, `argv[${i}]`);
      }
    } else if (lower.startsWith('--permission-mode=')) {
      const value = lower.slice('--permission-mode='.length);
      if (value === FORBIDDEN_PERMISSION_MODE) {
        throw new BypassFlagDetected(token, `argv[${i}]`);
      }
    }
  }
}

/** 校验 settings.json 内容:permissionMode 不得为 bypassPermissions。 */
export function assertNoBypassSettings(settingsJson: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(settingsJson) as unknown;
  } catch (err) {
    throw new SidecarConfigInvalid([`settings.json 不是合法 JSON (${String(err)})`]);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new SidecarConfigInvalid(['settings.json: 必须是 JSON 对象']);
  }
  const permissions = (raw as Record<string, unknown>)['permissions'];
  const mode =
    typeof permissions === 'object' && permissions !== null
      ? (permissions as Record<string, unknown>)['defaultMode']
      : undefined;
  if (typeof mode === 'string' && mode.toLowerCase() === FORBIDDEN_PERMISSION_MODE) {
    throw new BypassFlagDetected(mode, 'settings.json permissions.defaultMode');
  }
}
