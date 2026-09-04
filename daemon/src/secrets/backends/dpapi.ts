/**
 * Windows DPAPI 桥(仅 win32)。
 *
 * Node 无原生 DPAPI 绑定,零第三方依赖约束下经 powershell 子进程调
 * [System.Security.Cryptography.ProtectedData]::Protect/Unprotect
 * (CurrentUser 作用域:同用户任意进程可解,跨用户不可解)。
 *
 * 数据经 stdin(base64)进出,凭据明文不落命令行(进程列表/审计不可见);
 * 脚本本身不含数据,经 -Command 传入是安全的。超时与错误都类型化传播。
 */
import { spawn } from 'node:child_process';
import {
  SecretBackendError,
  SecretBackendTimeout,
  SecretCorrupt,
} from '../errors.ts';

export const DEFAULT_POWERSHELL = 'powershell.exe';
export const DEFAULT_DPAPI_TIMEOUT_MS = 10_000;

const PS_HEAD = '$ErrorActionPreference=\'Stop\';' +
  'Add-Type -AssemblyName System.Security;' +
  '$in=[Console]::In.ReadToEnd().Trim();' +
  '$b=[Convert]::FromBase64String($in);';

const PS_PROTECT =
  PS_HEAD +
  '[Console]::Out.Write([Convert]::ToBase64String(' +
  '[System.Security.Cryptography.ProtectedData]::Protect($b,$null,' +
  '[System.Security.Cryptography.DataProtectionScope]::CurrentUser)))';

const PS_UNPROTECT =
  PS_HEAD +
  '[Console]::Out.Write([Convert]::ToBase64String(' +
  '[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,' +
  '[System.Security.Cryptography.DataProtectionScope]::CurrentUser)))';

/** 跑一个 powershell 子进程:stdin 送 base64,stdout 收 base64。 */
function runBase64Roundtrip(
  script: string,
  inputB64: string,
  powershellPath: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellPath,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    // 守护进程场景:不因这枚定时器拖住进程退出。
    timer.unref();

    const fail = (err: SecretBackendError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err: Error) => {
      fail(
        new SecretBackendError(
          `powershell 子进程启动失败(${powershellPath}): ${err.message}`,
        ),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (timedOut) {
        fail(
          new SecretBackendTimeout(
            `powershell 子进程超时(>${timeoutMs}ms)被终止`,
            timeoutMs,
          ),
        );
        return;
      }
      if (code !== 0) {
        fail(
          new SecretBackendError(
            `powershell 退出码 ${code}: ${stderr.trim().slice(0, 500) || '(无 stderr)'}`,
          ),
        );
        return;
      }
      settled = true;
      resolve(stdout.trim());
    });

    // powershell 提前退出时写 stdin 会 EPIPE,吞掉以免砸出未捕获异常。
    child.stdin.on('error', () => {});
    child.stdin.end(inputB64, 'utf8');
  });
}

function assertB64Out(output: string, what: string): void {
  if (output === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) {
    throw new SecretBackendError(
      `DPAPI ${what} 返回不是合法 base64: ${JSON.stringify(output.slice(0, 100))}`,
    );
  }
}

/** DPAPI Protect(CurrentUser):明文字节 → 密文字节。 */
export async function dpapiProtect(
  plain: Uint8Array,
  options?: { powershellPath?: string; timeoutMs?: number },
): Promise<Uint8Array> {
  const inputB64 = Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength)
    .toString('base64');
  const output = await runBase64Roundtrip(
    PS_PROTECT,
    inputB64,
    options?.powershellPath ?? DEFAULT_POWERSHELL,
    options?.timeoutMs ?? DEFAULT_DPAPI_TIMEOUT_MS,
  );
  assertB64Out(output, 'Protect');
  return new Uint8Array(Buffer.from(output, 'base64'));
}

/** DPAPI Unprotect(CurrentUser):密文字节 → 明文字节。
 * 子进程正常启动但 Unprotect 失败(密文损坏 / 换用户换机器)→
 * 类型化为 SecretCorrupt;子进程没跑起来或超时 → SecretBackendError 系。 */
export async function dpapiUnprotect(
  blob: Uint8Array,
  options?: {
    powershellPath?: string;
    timeoutMs?: number;
    /** 归因上下文(损坏错误要指认是哪个 secret)。 */
    context?: { tenant: string; id: string };
  },
): Promise<Uint8Array> {
  const inputB64 = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
    .toString('base64');
  let output: string;
  try {
    output = await runBase64Roundtrip(
      PS_UNPROTECT,
      inputB64,
      options?.powershellPath ?? DEFAULT_POWERSHELL,
      options?.timeoutMs ?? DEFAULT_DPAPI_TIMEOUT_MS,
    );
  } catch (err) {
    if (
      options?.context !== undefined &&
      err instanceof SecretBackendError &&
      !(err instanceof SecretBackendTimeout)
    ) {
      throw new SecretCorrupt(
        options.context.tenant,
        options.context.id,
        `DPAPI Unprotect 失败: ${err.detail}`,
      );
    }
    throw err;
  }
  assertB64Out(output, 'Unprotect');
  return new Uint8Array(Buffer.from(output, 'base64'));
}
