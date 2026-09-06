/**
 * daemon API 操作描述符表(M4 观测线):手写的每方法 summary / params /
 * result 形状描述,与 operations.ts 的 OPERATIONS 方法表**同源可对照** ——
 * 一致性测试(test/daemon/api-doc.test.ts)保证两个方向都不漂移:
 * 每个 OPERATIONS 方法都有描述符,每个描述符都对应真实方法。
 *
 * openapiDocument() 由描述符表机械生成 OpenAPI 3.1 JSON:单端点 POST /
 * (JSON-RPC 2.0 over HTTP,Bearer securityScheme),GET 白名单
 * (/、/openapi.json、/events/stream)在文档 description 中说明。
 * 运行时零第三方依赖,不引 openapi 工具链。
 */
import { OPERATIONS } from './operations.ts';

/** 单个 params 字段的描述。 */
export interface OperationParamDoc {
  readonly name: string;
  readonly type: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';
  readonly required: boolean;
  readonly description: string;
}

/** 单个操作(API 方法)的描述符。 */
export interface OperationDoc {
  /** JSON-RPC 方法名(= OPERATIONS 成员)。 */
  readonly method: string;
  readonly summary: string;
  readonly params: readonly OperationParamDoc[];
  /** result 形状的文字描述(人读;形状断言走 golden,不在此重复)。 */
  readonly result: string;
}

const PRINCIPAL_PARAMS: readonly OperationParamDoc[] = [
  {
    name: 'tenant',
    type: 'string',
    required: false,
    description: 'principal tenant 段;session 身份省略 = 取 token 绑定值,显式异值 → SESSION_FORBIDDEN',
  },
  {
    name: 'session',
    type: 'string',
    required: false,
    description: 'principal session 段;admin 省略 = 全部会话,session 身份省略 = 取 token 绑定值',
  },
];

/** 操作描述符表(与 OPERATIONS 方法表一一对照;一致性测试防漂移)。 */
export const API_OPERATIONS: readonly OperationDoc[] = [
  {
    method: 'session.init',
    summary: '会话握手:校验 protocol/role,登记活跃会话;配置 token 注册表时签发会话 token(明文只出现一次)。session token 调用方 principal.tenant 必须等于绑定 tenant(#9),admin 不受限',
    params: [
      { name: 'protocol', type: 'string', required: true, description: '协议版本,如 "1.0"' },
      { name: 'role', type: 'string', required: true, description: '会话角色,如 orchestrator' },
      { name: 'principal', type: 'object', required: true, description: '{tenant, session} 二元组;session token 调用方 tenant 必须与 token 绑定一致' },
      { name: 'harness', type: 'string', required: false, description: '主控 harness 标识' },
      { name: 'capabilities', type: 'object', required: false, description: '客户端能力声明' },
    ],
    result: '{response, warnings, session: {tenant, session, role}, token?}',
  },
  {
    method: 'capabilities.list',
    summary: '列出能力注册表(§3.3 授权的 cap 闭集与风险分级)',
    params: [],
    result: '{capabilities: [...]}',
  },
  {
    method: 'task.create',
    summary: '单节点任务闭环:登记任务 → 基线授予 → completed/failed(同步返回)',
    params: [
      { name: 'intent', type: 'string', required: true, description: '任务意图(自然语言)' },
      { name: 'preset', type: 'string', required: true, description: '预设名(preset/1.0)' },
      ...PRINCIPAL_PARAMS,
    ],
    result: '{task_id, agent_id, status, manifest, mount_intents}',
  },
  {
    method: 'task.status',
    summary: '查单个任务状态(事件重放态)',
    params: [{ name: 'task_id', type: 'string', required: true, description: '任务 id' }],
    result: '{task: TaskRecord};session 身份只能查本人会话名下任务',
  },
  {
    method: 'task.list',
    summary: '列任务:admin 全量;session 身份只见本人会话名下的任务',
    params: [],
    result: '{tasks: [TaskRecord]}',
  },
  {
    method: 'artifacts.publish',
    summary: '发布工件进 CAS 仓库(写屏障完成 = 落 artifact.published 事件)',
    params: [
      { name: 'task', type: 'string', required: true, description: '工件命名空间的 task 段' },
      { name: 'node', type: 'string', required: true, description: '节点 id' },
      { name: 'name', type: 'string', required: true, description: '工件名' },
      { name: 'content', type: 'string', required: false, description: '单文件内容(与 files 二选一)' },
      { name: 'files', type: 'array', required: false, description: '树形:[{path, content}](与 content 二选一)' },
      ...PRINCIPAL_PARAMS,
    ],
    result: '{tenant, task, node, name, version, root_sha256, size, kind: file|tree}',
  },
  {
    method: 'artifacts.resolve',
    summary: '解析工件当前版本引用(manifest 指针)',
    params: [
      { name: 'task', type: 'string', required: true, description: 'task 段' },
      { name: 'node', type: 'string', required: true, description: '节点 id' },
      { name: 'name', type: 'string', required: true, description: '工件名' },
      ...PRINCIPAL_PARAMS,
    ],
    result: 'ArtifactRef(manifest 指针)',
  },
  {
    method: 'artifacts.read',
    summary: '读工件内容:可整读或按 entry_path 读树内单文件;UTF-8 可解码则明文回,否则 base64',
    params: [
      { name: 'task', type: 'string', required: true, description: 'task 段' },
      { name: 'node', type: 'string', required: true, description: '节点 id' },
      { name: 'name', type: 'string', required: true, description: '工件名' },
      { name: 'entry_path', type: 'string', required: false, description: '树内条目路径(缺省整读)' },
      ...PRINCIPAL_PARAMS,
    ],
    result: '{encoding: utf8|base64, data, size}',
  },
  {
    method: 'grants.of',
    summary: '查 agent 的授权 manifest(含审计轨迹;事件重放重建)',
    params: [{ name: 'agent_id', type: 'string', required: true, description: 'agent id' }],
    result: '{manifest: GrantManifest | null}',
  },
  {
    method: 'workflow.run',
    summary: '提交 WorkflowSpec 异步执行;handler 立即返回 task_id,终态经 task.status / 事件流观察',
    params: [
      { name: 'workflow', type: 'object', required: true, description: 'WorkflowSpec(workflow/1.0,先过 PlanCheck)' },
      { name: 'intent', type: 'object', required: false, description: 'IntentSpec(intent/1.0)' },
      { name: 'budget', type: 'object', required: false, description: '{limit_tokens, soft_ratio?}' },
      { name: 'secret_ids', type: 'array', required: false, description: '注入容器的 secret id 列表(§3.8)' },
      ...PRINCIPAL_PARAMS,
    ],
    result: '{task_id, status};校验失败 → WORKFLOW_INVALID(-32013,issues 一次回全)',
  },
  {
    method: 'task.pause',
    summary: '暂停运行中的编排任务',
    params: [{ name: 'task_id', type: 'string', required: true, description: '任务 id' }],
    result: '{task_id, paused}',
  },
  {
    method: 'task.resume',
    summary: '恢复暂停的任务(续跑异步推进)',
    params: [{ name: 'task_id', type: 'string', required: true, description: '任务 id' }],
    result: '{task_id, status}',
  },
  {
    method: 'task.cancel',
    summary: '取消任务',
    params: [{ name: 'task_id', type: 'string', required: true, description: '任务 id' }],
    result: '{task_id, cancelled}',
  },
  {
    method: 'approvals.list',
    summary: '列审批单:status=pending(缺省语义)/all;session 身份只见本人会话任务的审批单',
    params: [{ name: 'status', type: 'string', required: false, description: 'pending | all' }],
    result: '{approvals: [...]}',
  },
  {
    method: 'approvals.submit',
    summary: '提交审批单(tool.request 公面入口,外部编排者发起审批闭环):复用台账校验;引擎 v0.x 不做 require_approval 自动挂起,pending 单经此显式产生',
    params: [
      { name: 'task_id', type: 'string', required: true, description: '申请人所属任务 id(申请人 agent 取任务记录的 agent_id)' },
      { name: 'cap', type: 'string', required: true, description: '申请的能力(须在注册表内)' },
      { name: 'scope', type: 'string', required: true, description: '申请的 scope(须在该 cap 的 grantable_scopes 内)' },
      { name: 'duration', type: 'string', required: true, description: '授权时长,匹配 ^\\d+[smhd]$(如 2h)' },
      { name: 'reason', type: 'string', required: false, description: '申请说明' },
      { name: 'req_id', type: 'string', required: false, description: '审批单 id;缺省自动生成,重复 → REQ_DUPLICATE(-32000)' },
    ],
    result: '{req_id, status: pending|auto_granted, record[, manifest]};session 身份仅限本人会话任务,越权 → SESSION_FORBIDDEN(-32014/403)',
  },
  {
    method: 'approvals.decide',
    summary: '定案审批单;授予经 escalation 入事件流 + manifest;session 身份仅限本人会话任务',
    params: [
      { name: 'req_id', type: 'string', required: true, description: '审批单 id' },
      { name: 'decision', type: 'string', required: true, description: 'granted | denied' },
      { name: 'by', type: 'string', required: false, description: '定案人;admin 自由填,session 身份强制记会话身份' },
      { name: 'narrowed_to', type: 'string', required: false, description: '授予可窄于申请的 scope' },
    ],
    result: '{decision, record};越权 → APPROVAL_FORBIDDEN(-32016/403)',
  },
  {
    method: 'budget.status',
    summary: '查任务预算水位(§3.5f)',
    params: [{ name: 'task_id', type: 'string', required: true, description: '任务 id' }],
    result: '{task_id, budget: {limit_tokens, soft_tokens, observed_tokens, level} | null}',
  },
  {
    method: 'budget.raise',
    summary: '续预算(hard 处置):抬 limit 并重新武装,配 task.resume 续跑',
    params: [
      { name: 'task_id', type: 'string', required: true, description: '任务 id' },
      { name: 'limit_tokens', type: 'integer', required: true, description: '新上限(非负整数)' },
    ],
    result: '{task_id, raised, re_armed, limit_tokens, soft_tokens, observed_tokens, level}',
  },
  {
    method: 'models.list',
    summary: '列 Model Score Registry(§3.9:per-tier observed + 样本)',
    params: [],
    result: '{models: [...]}',
  },
  {
    method: 'models.feedback',
    summary: '反馈模型实测表现(EMA 按 tier 分桶收敛;registry 不可变替换 + 回写)',
    params: [
      { name: 'model', type: 'string', required: true, description: '模型名' },
      { name: 'tier', type: 'string', required: true, description: '档位(frontier/standard/fast 闭集)' },
      { name: 'success', type: 'boolean', required: true, description: '任务是否成功' },
      { name: 'quality', type: 'number', required: false, description: '质量分 [0,1]' },
      { name: 'traversals', type: 'integer', required: false, description: '遍历数(≥0)' },
      { name: 'task_type', type: 'string', required: false, description: '任务类型标注' },
      { name: 'budget_tier', type: 'string', required: false, description: '预算档位标注' },
    ],
    result: '{model, tier, observed, samples, alpha_applied}',
  },
  {
    method: 'events.list',
    summary: '查询事件日志(§6 唯一事实源):admin 全量可按 tenant/session/task/type 收窄;session 身份锁死绑定命名空间;limit 取最近 N 条',
    params: [
      ...PRINCIPAL_PARAMS,
      { name: 'task', type: 'string', required: false, description: 'principal task 段精确过滤' },
      { name: 'type', type: 'string', required: false, description: '事件类型(闭集,如 node.started)' },
      { name: 'limit', type: 'integer', required: false, description: '非负整数;返回时间序最近 N 条' },
    ],
    result: '{events: [Event(v/seq/ts/type/principal/payload)], count};越权 → SESSION_FORBIDDEN(-32014/403)',
  },
];

/** OpenAPI 文档版本(info.version;独立于 daemon 版本轴)。 */
export const OPENAPI_VERSION = '0.3.0';

/**
 * 由描述符表生成 OpenAPI 3.1 文档:单端点 POST /,JSON-RPC 2.0 信封 +
 * 逐方法 (method const, params schema) oneOf;Bearer securityScheme。
 */
export function openapiDocument(
  version: string = OPENAPI_VERSION,
): Record<string, unknown> {
  const paramSchemas: Record<string, unknown> = {};
  const methodVariants: Record<string, unknown>[] = [];
  for (const op of API_OPERATIONS) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const param of op.params) {
      properties[param.name] = { type: param.type, description: param.description };
      if (param.required) required.push(param.name);
    }
    const schemaName = `params.${op.method}`;
    paramSchemas[schemaName] = {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      description: op.summary,
    };
    methodVariants.push({
      type: 'object',
      properties: {
        jsonrpc: { const: '2.0' },
        method: { const: op.method, description: op.summary },
        params: { $ref: `#/components/schemas/${schemaName}` },
      },
      required: ['jsonrpc', 'method'],
    });
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'neoba daemon localhost API',
      version,
      description:
        'JSON-RPC 2.0 over HTTP POST 单端点(127.0.0.1 + Bearer token 鉴权,§6)。\n\n' +
        'GET 白名单(M4 观测线):`/` 只读 dashboard 静态页、`/openapi.json` 本文档、' +
        '`/events/stream` SSE 事件流(冷启动先 replay 已有事件再推 live;鉴权支持 ' +
        'Bearer 头或 `?token=` 兜底 —— EventSource 无法自定义请求头;仅 localhost ' +
        '监听前提下可用,跨主机暴露前必须先上 TLS)。其余 GET 保持 405。',
      'x-operations': API_OPERATIONS.map((op) => op.method),
    },
    servers: [{ url: 'http://127.0.0.1:7917', description: '本机 daemon(缺省端口)' }],
    paths: {
      '/': {
        post: {
          operationId: 'rpc',
          summary: 'JSON-RPC 2.0 单端点(全部操作经 method 分发)',
          description:
            'method 取值见 x-operations / components.schemas.params.*;' +
            'params 形状按方法见对应 schema。',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { oneOf: methodVariants },
              },
            },
          },
          responses: {
            '200': {
              description: 'JSON-RPC 2.0 应答(result 或 error;错误码 -32700…-32603 协议层,' +
                '-32000 区段应用层,data 统一 {code, …})',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/JsonRpcResponse' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'bootstrap token = admin;session.init 签发的会话 token 绑定 (tenant, session)',
        },
      },
      schemas: {
        JsonRpcResponse: {
          type: 'object',
          required: ['jsonrpc', 'id'],
          properties: {
            jsonrpc: { const: '2.0' },
            id: { type: ['string', 'number', 'null'] },
            result: { description: '成功应答载荷(形状按方法,见 x-operations)' },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'integer' },
                message: { type: 'string' },
                data: { type: 'object', description: '统一 {code, …} 结构' },
              },
            },
          },
        },
        ...paramSchemas,
      },
    },
  };
}
