/**
 * neoba-mcp 桥 CLI:手动拉起调试入口(node src/bindings/cli.ts)。
 *
 * env:
 *   NEOBA_BASE_URL    daemon 地址,默认 http://127.0.0.1:7917
 *   NEOBA_TOKEN_FILE  token 文件路径,默认 ~/.neoba/token
 *   NEOBA_TOKEN       直接给 token(优先于 token 文件;子进程注入场景)
 *   NEOBA_TIMEOUT_MS  单次 daemon 调用超时毫秒,默认 10000(与 cli/rpc.ts 口径一致)
 *
 * stdin 收 MCP(换行分隔 JSON-RPC),stdout 回应答;日志/错误走 stderr。
 */
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDaemonHttpClient } from './client.ts';
import { createMcpBridge, MCP_PROTOCOL_VERSIONS } from './mcp.ts';
import { BASE_URL_ENV, TIMEOUT_ENV, TOKEN_ENV, TOKEN_FILE_ENV } from './spawn.ts';

function fail(message: string): never {
  process.stderr.write(`[neoba-mcp] ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const baseUrl = process.env[BASE_URL_ENV] ?? 'http://127.0.0.1:7917';
  const tokenEnv = process.env[TOKEN_ENV];
  const tokenFile = process.env[TOKEN_FILE_ENV] ?? join(homedir(), '.neoba', 'token');
  const token = tokenEnv ?? await import('node:fs/promises')
    .then((fs) => fs.readFile(tokenFile, 'utf8'))
    .then((raw) => raw.replace(/\r?\n$/, ''))
    .catch(() => fail(`读不到 token(NEOBA_TOKEN 或 ${tokenFile})`));

  const timeoutRaw = process.env[TIMEOUT_ENV];
  const timeoutMs =
    timeoutRaw !== undefined && timeoutRaw !== '' && Number.isFinite(Number(timeoutRaw))
      ? Number(timeoutRaw)
      : undefined;
  const callDaemon = createDaemonHttpClient({ baseUrl, token, timeoutMs });
  const bridge = createMcpBridge({
    input: process.stdin,
    output: process.stdout,
    callDaemon,
    supportedVersions: MCP_PROTOCOL_VERSIONS,
  });

  // stdin 逐行进桥(readline 负责按 \n 切,与桥的帧格式一致;桥自带的
  // 缓冲解析用于注入流,这里直接喂完整行)。
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    void bridge
      .handleLine(line)
      .then((out) => {
        if (out !== null) process.stdout.write(out + '\n');
      })
      .catch((err: unknown) => {
        process.stderr.write(`[neoba-mcp] handleLine 失败: ${String(err)}\n`);
      });
  });
  process.stderr.write(`[neoba-mcp] bridge ready: daemon=${baseUrl}\n`);
}

main().catch((err: unknown) => fail(String(err)));
