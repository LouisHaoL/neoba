/**
 * supervisor sidecar 配置生成器对外类型(§2 Worker Agent 层 / §4 Adapter
 * 统一职责 3"授予执行" / §4.4 spawn 硬规则 / §3.3 grant manifest 唯一事实源)。
 *
 * 产物 = 可 JSON 序列化的 SidecarPlan(容器配置 + 文件清单 + 启动命令),
 * 纯函数产出;真正写文件 / 拉容器属后续 Provisioner 接线,不在本模块。
 */
import type { NetworkPolicy, SandboxResources, SandboxSpec } from '../provision/types.ts';

/**
 * MCP server 启动规格(catalog:cap id -> 怎么拉起)。
 * grant manifest 决定"挂载什么"(唯一事实源,§3.3),catalog 只提供
 * "怎么拉"的安装规格 —— 清单外 server 一个都不会出现在产物里。
 */
export interface McpServerSpec {
  /** stdio 启动命令(如 "npx")。 */
  readonly command: string;
  readonly args?: readonly string[];
  /**
   * 环境变量名 -> secret id(§3.8)。值绝不进入任何配置产物:
   * SidecarPlan.secrets 只带 id -> 变量名映射,Provisioner 拉容器时
   * 经 SecretStore 解析成容器环境变量;MCP server 经进程环境继承。
   */
  readonly envSecrets?: Readonly<Record<string, string>>;
}

/** cap id -> MCP server 启动规格。 */
export type McpCatalog = Readonly<Record<string, McpServerSpec>>;

export type SafePermissionMode = 'default' | 'acceptEdits' | 'plan';

export interface BuildSandboxConfigOptions {
  /** 任务工作目录(宿主侧真实路径,fs 授权挂载的 source 根)。 */
  readonly workdir: string;
  /** MCP 启动规格目录;manifest 授予的 mcp_server cap 必须能在其中解析。 */
  readonly mcpCatalog: McpCatalog;
  /** 基座镜像;缺省 DEFAULT_WORKER_IMAGE。 */
  readonly image?: string;
  /** 容器内工作目录;缺省 CONTAINER_WORKDIR。 */
  readonly containerWorkdir?: string;
  /** 基座权限模式(便利层,§1.3):写死进 settings.json,禁 bypass。 */
  readonly permissionMode?: SafePermissionMode;
  readonly resources?: SandboxResources;
  /** secret id -> 环境变量名 resolver;缺省 defaultSecretEnvName。 */
  readonly secretEnvName?: (secretId: string) => string;
}

/** 计划中的配置文件:内容齐备,Provisioner 落盘后一律 ro 挂载(§3.8)。 */
export interface PlanFile {
  readonly path: string;
  readonly content: string;
  readonly format: 'json';
  readonly mount: 'ro';
}

/**
 * secret 注入段(§3.8):只有 secret id -> 环境变量名映射 + ro 标记。
 * 值经 Provisioner 注入的 resolver 在拉容器时取,产物里永不出现明文。
 */
export interface SecretInjectionEntry {
  readonly secretId: string;
  readonly envVarName: string;
  /** 标记位:凭据注入通道只读语义(值只进环境,不落任何可写文件)。 */
  readonly ro: true;
}

/**
 * sidecar 配置计划(P1 形态:纯数据,可 JSON 序列化)。
 * sandbox 字段对齐 src/provision 的 SandboxSpec(结构兼容,不重复定义)。
 */
export interface SidecarPlan {
  readonly planVersion: '1.0';
  readonly agentId: string;
  readonly harness: 'claude-code';
  /** 容器规格(镜像 / 挂载 / 网络 / 用户),可直接喂 SandboxProvider.create。 */
  readonly sandbox: SandboxSpec;
  /** 基座配置文件(内容 + ro 挂载),Provisioner 落盘。 */
  readonly files: readonly PlanFile[];
  /** secret 注入段(§3.8,无明文)。 */
  readonly secrets: readonly SecretInjectionEntry[];
  /** 基座启动命令(容器内由 sidecar exec);生成后过 assertNoBypassFlags。 */
  readonly harnessSpawn: { readonly argv: readonly string[] };
}

/** 计划容器内的固定路径约定(与 spike/Dockerfile 的 worker 用户对齐)。 */
export const CONTAINER_WORKDIR = '/home/worker/work';
export const CONTAINER_CONFIG_DIR = '/home/worker/.claude';
/** 缺省基座镜像(spike 验证形态:node:22-slim + claude-code + 非 root worker)。 */
export const DEFAULT_WORKER_IMAGE = 'neoba/claude-code-worker:0.1';

/**
 * 缺省 secret id -> 环境变量名映射:NEOBA_SECRET_<大写化 id,非字母数字转 _>。
 * 确定性纯函数,部署无需额外配置即可用;可经 options.secretEnvName 覆盖。
 */
export function defaultSecretEnvName(secretId: string): string {
  const suffix = secretId.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_');
  return `NEOBA_SECRET_${suffix}`;
}

/** 网络策略重导出便于调用方构造。 */
export type { NetworkPolicy };
