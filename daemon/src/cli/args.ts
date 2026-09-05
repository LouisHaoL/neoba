/**
 * CLI 参数解析(纯函数,零依赖,够用即可):
 * 支持 `--flag value` / `--flag=value` / 布尔 `--flag` / `--` 终止符。
 * 值型选项由各命令声明(valueFlags),未声明的 `--x` 视为布尔开关。
 */

/** 用法错误(缺值/类型不对);由 runCli 统一捕获并回 usage,退出码 2。 */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export type FlagValue = string | true;

export interface ParsedArgs {
  readonly flags: Record<string, FlagValue>;
  readonly positionals: string[];
}

export function parseArgs(
  argv: readonly string[],
  valueFlags: readonly string[] = [],
): ParsedArgs {
  const takesValue = new Set(valueFlags);
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (onlyPositionals || token === '-' || !token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      onlyPositionals = true;
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (takesValue.has(body)) {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new CliUsageError(`选项 --${body} 缺少值`);
      }
      flags[body] = next;
      i += 1;
      continue;
    }
    flags[body] = true;
  }

  return { flags, positionals };
}

export function flagString(flags: Record<string, FlagValue>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

/** 取数值型选项;未给返回 undefined,给了但不是整数则报用法错误。 */
export function flagInt(flags: Record<string, FlagValue>, key: string): number | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new CliUsageError(`选项 --${key} 需要一个数值`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new CliUsageError(`选项 --${key} 不是合法端口/数值: ${v}`);
  }
  return n;
}

/** 取非负整数选项(无端口上限,预算 token 数等大数值用)。 */
export function flagCount(flags: Record<string, FlagValue>, key: string): number | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new CliUsageError(`选项 --${key} 需要一个数值`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new CliUsageError(`选项 --${key} 必须是非负整数: ${v}`);
  }
  return n;
}

export function flagBool(flags: Record<string, FlagValue>, key: string): boolean {
  return flags[key] !== undefined;
}

/**
 * 命令路由(纯函数):argv 首个非选项 token 即命令名,其余透传给命令。
 * 这里不处理 --help/--version(由 runCli 先行拦截)。
 */
export function routeCommand(
  argv: readonly string[],
): { name: string; args: string[] } | null {
  const first = argv[0];
  if (first === undefined || first.startsWith('-')) return null;
  return { name: first, args: argv.slice(1).map((s) => s ?? '') };
}
