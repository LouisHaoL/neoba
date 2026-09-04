/**
 * 小型 docker CLI runner:以子进程方式调 docker,零第三方依赖。
 * CliRunner 作为类型可注入假实现供测试使用。
 */
import { spawn } from "node:child_process";

export interface CliResult {
  /** 进程退出码;被信号杀死等无码场景为 -1 */
  code: number;
  stdout: string;
  stderr: string;
}

/** 执行一条后端 CLI 命令。spawn 失败(ENOENT 等)以 reject 表达。 */
export type CliRunner = (args: string[]) => Promise<CliResult>;

export function createDockerCliRunner(binary: string = "docker"): CliRunner {
  return (args) =>
    new Promise<CliResult>((resolve, reject) => {
      const child = spawn(binary, args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        reject(err);
      });
      child.on("close", (code) => {
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
}
