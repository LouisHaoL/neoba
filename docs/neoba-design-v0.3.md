# neoba 设计文档 v0.3(多 Agent 协作协议)

> 状态:定稿候选(v0.3,P0 前冻结 JSON Schema)
> 日期:2026-09-04
> 定位:**协议先行**。本协议是产品本体,daemon 只是参考实现;任何主控 harness(Claude Code / DeepSeek harness / 自研)与任何执行基座(Claude Code / Codex / OpenCode / …)都可经协议接入。
> 工作代号:**neoba**(已定名 2026-09-04),仓库:`D:\workspace\neoba`
> 实测依据:基座 enforcement 强度结论见 [spike-1-harness-enforcement.md](spike-1-harness-enforcement.md)

## v0.3 变更摘要(自 v0.2)

14. **排期补全(v0.3)**:P1 补 secret 最简注入、取消/超时 kill/孤儿容器回收(daemon 启动 reconcile)、daemon v1 鉴权、`neoba doctor` 最小版,并明确 usage 只记录不熔断;P2 补审批的人机入口(CLI)与任务暂停/恢复状态机;SecretStore 拆两期(P1 最简注入 / P2 完整版)。见 §9、§11;
15. **执行并行语义钉死(v0.3)**:P2 引擎仅顺序推进节点(依赖序);WorkflowSpec 的 `parallel` 字段 P0 预留并冻结语义,实现放 P3+;Intent 的 `max_parallel` 在 P1–P2 仅约束资源池并发容器数。见 §3.5。
16. **parallel 字段补录(P3 前)**:`parallel` 字段实际未随 P0 落入 workflow.schema.json,P3 落地前按 §3.0 增量规则补入——节点级布尔(缺省 false),语义 = 一组可同批启动的节点(与本条第 15 项冻结语义一致);纯新增字段,`api` 轴不动,旧实现忽略未知字段、新实现缺省 false,双向兼容。
17. **golden 场景执行器扩展(P3)**:scenario.schema.json 两处纯增量——事件断言 `match` 枚举新增 `set`(无序多重集包含,并行编排等顺序不确定场景用);步骤新增 `await.task` 操作(轮询 task.status 至指定 status,异步编排 `workflow.run` 的终态观察)。均为场景执行器侧约定,不触协议数据面。
18. **多基座 Adapter 落地(P3,§4)**:`HarnessAdapter` 统一接口(逐行翻译 → §3.6 统一事件 + 权威清单)与 `createAdapter` 工厂(注册表外显式拒绝);新增 codex(`codex exec --json` 事件流)与 opencode(`opencode run` 文本,简化模式)两基座;`preset.base='any'` 落位 daemon 级缺省基座;bypass 标志校验按基座分域(缺省全集并集,宁枉勿纵);doctor 增 `opencodeReady` 前置探测。协议枚举本就含三基座,数据面零改动。
19. **per-session token 与审批权绑定(P3,§6)**:双 token 模型——bootstrap token 语义不变(= admin,现有 golden/CLI/MCP 路径零漂移);`session.init` 应答新增顶层 `token` 字段(minor 增量,明文只出现一次,注册表只落 sha256 并持久化 `tokens.json`,重启恢复但会话须重新握手激活)。http 绑定解析 `RequestIdentity{admin|session}` 三元贯通 operations:session 身份 principal 锁死绑定二元组(省略 = 取绑定值,显式异值 → `SESSION_FORBIDDEN` 403,会话未激活 → `SESSION_UNKNOWN`);task 触达与 task.list 按绑定收窄;`approvals.decide` 仅限本人会话任务的审批单(`APPROVAL_FORBIDDEN` 403),定案人强制记会话身份。审批策略分层补 session 层接线(builtin < global < preset < session)。MCP 桥工具补齐 P1+P2 全集 19 个。golden 新增 `07-session-tokens`。
20. **观测线落地(M4,§6)**:新增 `events.list` RPC(读走事件日志 readByPrincipal —— 查询与审计同一份;admin 全量可按 tenant/session/task/type 收窄、limit 取最近 N 条,session 身份锁死绑定命名空间,越界 `SESSION_FORBIDDEN` 403);http 绑定 GET 白名单 —— `/`(只读 dashboard 静态单页:零构建、零依赖、vanilla JS,展示任务/审批队列/预算水位/preset 概览/SSE 事件流,无写操作)、`/openapi.json`(手写操作描述符表与 OPERATIONS 方法表同源对照、一致性测试防漂移,机械生成 OpenAPI 3.1:Bearer securityScheme、单端点 POST /)、`/events/stream`(SSE:冷启动先 replay 已有事件再推 live,onEvent 订阅 + 窗口内去重,注释行心跳保活;EventSource 无法自定义请求头,支持 `?token=` 兜底鉴权 —— 仅 localhost 监听前提下可用,TLS 为 P4 占位 `http.tls` 不实现,现状 127.0.0.1+Bearer 已满足威胁模型)。其余 GET 保持 405,POST / 语义零漂移。golden 新增 `08-events-list`。
21. **microsandbox 后端 + warm pool(P4,§5)**:沙箱后端抽象第二实现 `MicrosandboxProvider`——Firecracker microVM(msb CLI,create/exec/logs/stop/remove + snapshot create / run --from-snapshot 全生命周期;userns 天然满足无 docker 式前置),CliRunner 可注入,CLI 不可用 / msbd 不可达 → `PrerequisiteNotMetError` 不静默降级,未知 CLI 输出 → 类型化 `CliOutputParseError`;`neoba.config.json` 增 `sandbox.{provider,image,pool}` 小节,`createProvider` 工厂按配置实例化(缺省 memory 零漂移,未知后端名 `ProviderUnknownError` 显式拒绝),doctor 增 `msb-cli` 探测(linux only,win/mac N/A)联动推荐理由;warm pool 仅对 `snapshotCapable` 后端真池化——release 健康 → snapshot 固化 + destroy 释放 VM 内存,acquire 命中 → restore 回热,规格签名(镜像/env/挂载/资源/网络/用户/工作目录)不匹配不命中防挂载静默错配;pool 与 M1 ResourceGate 共用同一信号量,闸门在执行包裹层、pool 在闸门之内(空闲池条目不占槽,无 gate 时复用 sandbox.acquired/released 事件兜底,payload 带 pool 字段纯增量);NodeExecutor 镜像改配置注入(缺省 `neoba/sandbox:latest` 不变),池命中不虚报 sandbox.created、归池不落 sandbox.destroyed。docker/memory 等无快照介质后端直通退化为冷拉 + 销毁。

## v0.2 变更摘要(自 v0.1)

1. §1.3 "物理性"改写为**分层保证**(依据 spike #1 实测);
2. 新增 **§3.8 Secrets**(凭据管理,协议级概念);
3. §3.5 补 `timeout`/`retry` 失败语义字段;§3.5a 补 `allowed_models`;
4. §3.6 明确**事件流为唯一事实源**(禁止采信模型自述);
5. §3.7 工件仓库定为 **CAS 实现**(manifest 结构、去重、GC 字段位);
6. §3.9 Score Registry 补 **per-tier observed、样本元数据、模型准入**;
7. §3.3 审批补**分层配置 + 协议层硬底线 + decision_source 审计**;
8. §3.0 握手补 principal 四层身份;新增**协议版本兼容策略**;
9. §5 SandboxProvider 契约新增**基座前置条件**(codex 需 userns);
10. §6 补 daemon **本机 token 鉴权、事件溯源恢复、任务级 failure domain、资源池**;
11. §10.4 多租户决议:**单 daemon 多任务 + 四层 principal 命名空间,真多租户为 non-goal**;
12. **文档根类型与版本轴决议(v0.2 补充)**:协议文档分两类根,字段互斥、各走一条 semver 轴——信封类(RPC 消息)用 `protocol` + `spec_version`,文档类(独立流转的产物)用 `api: <kind>/<major.minor>`;握手交换 kind→支持版本映射。见 §3 总则与 §3.0。
13. **兼容性补全决议(v0.2 补充)**:sidecar↔daemon 握手版本协商(§3.6)、事件日志版本化与重放兼容(§6)、通用 Schema 约定(匹配语义/可空/RFC3339/摘要算法,§3 总则)、工件 manifest 自版本化(§3.7)、编排可移植性与三档导出(§3.5g)。

---

## 1. 设计哲学

1. **协议即产品**:语义模型(规范的 JSON 结构)与传输绑定(MCP / HTTP / CLI)分离。语义层改一次,所有绑定跟随;新 harness 接入 = 写一个薄绑定层。
2. **决策与执行分离**:智能只出现在决策点(需求、审批、验收);供给、编排执行、观测全部是确定性代码,跑在 daemon 里。
3. **能力限制 = 分层 enforcement**(v0.2 修订,原"能力即挂载")。限制不靠提示词,靠可执行层,但各层强度不同,承诺必须分层表述:
   - **容器层(物理边界)**:未挂载的 MCP server / 工具在容器内不存在;未挂载的 fs 路径不可读;网络策略由容器 netns 决定——这一层是安全承诺的主体;
   - **基座内建沙箱(纵深)**:基座各异(Codex 有 OS 级写/网络沙箱,Claude Code 无),不可依赖,存在即加分;
   - **基座权限模式(便利层)**:默认模式可拦误操作,但可被 bypass 标志或嵌套逃逸击穿(spike #1 E6 实测)。**凡授予 shell 的 agent,一律按此层不存在来设计**;
   - **提示词:不设防**,不作为任何约束的载体。
4. **产物即证据**:Agent 间交互靠交付文件,所有交付工件带 sha256,防"编造产物"。
5. **环境与权限皆最小化、皆可回收**:容器用完即毁,临时授权到期即收。
6. **一切可替换**:主控可替换、基座可替换、沙箱后端可替换、Planner 可替换——靠的都是同一份协议。

## 2. 角色与架构总览

```
┌─────────────────────────────────────────────────────┐
│  Orchestrator 主控层(可替换)                          │
│  Claude Code / DeepSeek harness / 自研 Agent          │
│  职责:提需求 · 能力审批决策 · 编排合理性验收 · 结果验收   │
│  经协议绑定层(MCP / HTTP / CLI)接入 ↓                │
├─────────────────────────────────────────────────────┤
│  Daemon 服务层(参考实现,确定性代码,单实例多任务)       │
│  ├─ Provisioner   沙箱供给(SandboxProvider 抽象)      │
│  ├─ Capability    能力注册表 + 授予/回收执行器          │
│  ├─ Orchestrator  编排执行引擎(DAG 推进,无 LLM)       │
│  ├─ PlanCheck     编排静态校验器                       │
│  ├─ Messenger     消息通道(按 ID 点对点 / 广播)        │
│  ├─ SecretStore   凭据存取(§3.8)                      │
│  └─ Observatory   Runtime API 聚合 + dashboard 托管    │
├─────────────────────────────────────────────────────┤
│  Planner(可选,本身是一个 Agent 预设,基座可替换)        │
│  职责:把需求翻译成 WorkflowSpec 编排产物               │
├─────────────────────────────────────────────────────┤
│  Worker Agent 层(每个 = 干净沙箱 + supervisor sidecar) │
│  sidecar:拉起 harness 基座 · 按 grant manifest 生成容器  │
│           挂载/网络/凭据配置 · 收集事件 · 暴露 Runtime API│
│  基座:Claude Code / Codex / OpenCode / …(可替换)      │
└─────────────────────────────────────────────────────┘
```

三个视角:

- **daemon = 供给 + 执行 + 审批执行 + 观测**(事实层)
- **主控 = 需求 + 审批决策 + 语义验收**(决策层)
- **dashboard = 人看的监督视图**(只读,不引入新状态)

**身份分层(v0.2 新增)**:`tenant → orchestrator session → task → agent instance` 四层 principal。事件日志、工件 CAS、审批队列、secret、budget 全部按此四层命名空间化。单人部署 tenant 恒为默认值;多 session / 多租户是同一机制的配置档位,不是不同架构。

## 3. 协议规范(十个部分)

**文档根类型(v0.2 补充决议)**:协议文档分两类根,**字段互斥、不允许混用**,各走一条独立的 semver 轴:

| 根类型 | 首层字段 | 适用 | 理由 |
|---|---|---|---|
| **信封类**(RPC 消息) | `protocol` + `spec_version` | session.init、grant、审批、消息、事件 | 版本随会话握手协商,全局单一轴 |
| **文档类**(独立流转的产物) | `api: <kind>/<major.minor>` | preset、intent、workflow、工件 manifest | 自描述,离开 daemon 可读(进 git、被无会话上下文的工具读取);版本按 kind 独立演进 |

先例:文档类学 Kubernetes `apiVersion: apps/v1`,信封类学 MCP `protocolVersion`。semver 规则(§3.0)**分别作用于两条轴**。

**通用 Schema 约定(v0.2 补充,P0 冻结时逐条落实到 Schema)**:
- **匹配语义**:`forbidden_caps`、`auto_approve`、`allowed_models` 等列表默认**精确匹配**;`*` 仅允许整串通配;前缀通配必须用显式语法(如 `mcp:*`)且匹配规则写死——PlanCheck 与审批器是确定性代码,不允许实现自定义模糊匹配;
- **可空语义**:字段要么必填、要么显式 `nullable`(如 `cost_estimate` 在订阅制基座下为 null、`observed[tier]` 样本不足时为 null);**字段省略 = 未提供,不等于 null**;
- **时间戳**:一律 RFC3339 UTC(含 `ttl`);
- **摘要算法**:`args_digest` 等摘要字段统一 sha256(与工件哈希一致,不给实现留选择)。

### 3.0 握手与版本协商

任何接入方(bind 侧)与 daemon 建立会话时先握手,语义仿照 MCP initialize:

```json
{
  "method": "session.init",
  "params": {
    "protocol": "1.0",
    "role": "orchestrator",          // orchestrator | planner | observer
    "principal": {
      "tenant": "default",           // v0.2:四层身份随握手声明
      "session": "sess-8f3a"
    },
    "harness": "claude-code",
    "capabilities": {
      "broadcast": false,            // 我不支持广播,daemon 据此降级
      "async_events": true,
      "interactive_approval": true   // 审批请求能否实时推给我
    }
  }
}
```

daemon 回以自身版本、可选能力集与降级说明。**没有版本协商,多 harness 生态必然碎片化。**

**版本兼容策略(v0.2 新增)**:semver + 两条确定性规则,**作用于上述两条版本轴各自**——
1. 接收方**必须忽略未知字段**;仅新增字段/新增可选能力 = minor;
2. 删除字段、变更字段语义、收紧默认行为 = major;daemon 与绑定层支持相邻两个 major。

**kind→版本映射协商(v0.2 补充)**:握手响应除 `protocol` 版本外,必须携带文档类的支持版本映射,如 `{"workflow": ["1.0"], "preset": ["1.0"], "intent": ["1.0"]}`;文档类不匹配时的错误语义 = 按 kind 报告(kind + 期望版本 + 支持列表),不报协议级不匹配。

### 3.1 能力注册表(Capability Registry)

主控可查询"这个世界里有哪些能力可授予",不必自己持有全量工具:

```json
{
  "capabilities": [
    {
      "id": "mcp:github",
      "kind": "mcp_server",                    // mcp_server | skill | fs_path | model
      "description": "GitHub 仓库/issue/PR 读写",
      "tools": ["create_pr", "list_issues", "…"],
      "risk_level": "medium",                  // low | medium | high
      "grantable_scopes": ["read", "write", "admin"]
    },
    {
      "id": "fs:workdir",
      "kind": "fs_path",
      "description": "任务工作目录",
      "grantable_scopes": ["ro", "rw"],
      "path_template": "${task.workdir}"
    }
  ]
}
```

### 3.2 Agent 预设(Preset)

声明式描述一个可实例化的 Agent,是系统的"设计产物"单元。长期由主控(或 Planner)自行设计新预设:

```yaml
# presets/e2e-tester.yaml
api: preset/1.0
name: e2e-tester
description: "端到端测试执行者:跑 Playwright 用例并输出报告"
base: any                        # 基座偏好:any | claude-code | codex | opencode
model:                           # 可选模型预设(基座无关的抽象档位)
  tier: standard                 # fast | standard | heavy
  fallback: [standard, fast]
skills:
  - playwright-basics
baseline_grants:                 # 基线授予(见 3.3)
  - { cap: fs:workdir, scope: rw }
  - { cap: mcp:playwright, scope: write }
io_contracts:                    # 与编排契约对应(见 3.5)
  inputs:  [{ name: test_plan, type: file:markdown }]
  outputs: [{ name: test_report, type: file:markdown },
            { name: artifacts, type: dir }]
escalation_policy:               # 升级申请默认策略(可被主控会话覆盖)
  auto_approve: []               # 自动放行清单
  require_approval: ["*"]
```

要点:预设与运行时环境分离(借鉴 homerail 的 workflow / runtime-profile 分离);`model.tier` 是抽象档位,具体模型名由 **Model Score Registry**(见 §3.9)解析——按实时评分动态决策。

### 3.3 授予清单(Grant Manifest)与能力审批流

**grant manifest** = 某个 Agent 实例实际持有的能力,是挂载的唯一事实来源:

```json
{
  "agent_id": "task-42/e2e-tester-01",
  "grants": [
    { "cap": "fs:workdir", "scope": "rw", "source": "baseline", "ttl": null },
    { "cap": "mcp:mcp-server-browser", "scope": "write",
      "source": "escalation:req-7", "ttl": "2026-09-04T18:00:00Z",
      "constraint": { "fs_scope_narrowed_to": "${task.workdir}/screenshots" } }
  ],
  "audit": [
    { "event": "granted", "cap": "mcp:mcp-server-browser", "by": "orchestrator",
      "decision_source": "auto_rule:default-low", "at": "…" }
  ]
}
```

**能力审批流**(基线授予 + 按需升级,先例:OAuth scope / sudo):

1. Agent 实例化时按预设置入基线授予;
2. 运行中不够用时,子 Agent 经消息通道反向发送升级申请:

```json
{
  "type": "tool.request",
  "from": "task-42/e2e-tester-01",
  "req_id": "req-7",
  "cap": "mcp:mcp-server-browser",
  "reason": "需要截图验证登录流程渲染结果",
  "scope": "write",
  "duration": "2h"
}
```

3. 主控按策略三级处理:自动放行清单 / 逐条审批 / 拒绝;
4. 审批通过 → daemon **动态挂载**对应 MCP server(容器层物理生效);授权可**窄于申请**(申请 fs:rw,只授 workdir 子目录);
5. 所有临时授权带 **TTL**,到期自动回收;申请、审批、挂载、回收全量进审计日志(与 §6 事件日志为同一份)。

**审批配置分层(v0.2 新增)**,合并优先级从低到高:

```
内置默认 < 全局配置 < preset.escalation_policy < orchestrator session 覆盖
```

**协议层硬底线(不进配置,不可被任何层级覆盖)**:`risk_level = high` 且 scope ∈ {write, admin} 的能力,禁止自动放行。每条审批记录必须带 `decision_source: auto_rule:{id} | manual:{principal}`,自动放行同样全量入审计——调参依据是"默认规则放行次数 × 事后问题率"。

安全不变量:
- **分层物理性**(§1.3):fs/网络/MCP 存在性由容器层保证;基座权限模式仅为纵深防御;
- **最小化**:基线 = 完成典型任务的最小集;升级 = 用完即走;
- **可审计**:主控验收时可看到该 Agent 全部超越基线的能力使用记录。

### 3.4 消息通道(Messaging)

特殊通信渠道的规范化,复用同一条通道承载审批流:

```json
{ "type": "msg.direct",  "to": "task-42/impl-01", "body": { … }, "priority": "normal" }
{ "type": "msg.broadcast", "topic": "deps-changed", "body": { … } }
{ "type": "msg.feedback", "to": "task-42/impl-01",
  "kind": "correction",                       // correction | question | ack
  "ref": "artifact:test_report", "body": "登录用例断言反了,重做",
  "traversal": 2 }                            // 有界反馈计数,见 3.5
```

语义:按 ID 点对点(主控→子、子→主控双向)、广播(可选能力)、纠偏指令结构化(kind + ref + traversal)。

### 3.5 编排服务(Orchestration)

**三分离**:主控提需求 → Planner 产编排 → 校验器静态检查 → 主控语义验收 → 执行引擎确定性推进 → 结果回交验收。

**(a) 编排需求单(Intent Spec)** — 主控唯一要填的东西:

```yaml
api: intent/1.0
goal: "为订单模块新增优惠券功能并通过全部测试"
acceptance:                        # 验收标准,结果验收的依据
  - "pytest tests/ 全绿"
  - "新字段有迁移脚本"
constraints:
  max_parallel: 3
  budget_tokens: 2_000_000
  forbidden_caps: ["mcp:prod-db"]  # 全局禁授清单
  allowed_models: ["*"]            # v0.2:模型准入 allowlist,与 forbidden_caps 平级
```

**(b) 编排产物(WorkflowSpec)** — Planner 的输出语言,借鉴 homerail WorkflowSpec v1:

```yaml
api: workflow/1.0
intent_ref: intent-001
nodes:
  - id: plan
    preset: planner/tech-split
  - id: impl
    preset: coder/backend
    inputs:  [{ from: plan.outputs.split_plan }]
    timeout: 3600                   # v0.2:节点级超时(秒)
    retry: { max: 1, on: [crash] }  # v0.2:重试策略(crash 可重试;副作用型操作默认不重试)
  - id: test
    preset: e2e-tester
    inputs:  [{ from: impl.outputs.patch }]
outputs:
  - { from: test.outputs.test_report, required: true }
feedback:
  - from: test, to: impl           # test 失败可打回 impl
    max_traversals: 2              # 有界反馈:超限升级给主控
evidence:                          # 防编造(借鉴 required_workspace_files + sha256)
  - node: test
    artifact: test_report
    must_exist: true
    sha256_recorded: true
```

失败语义默认从简(v0.2 定版):crash / timeout → 节点 fail → 按.retry 重试或升级主控;副作用型工具(node 输出已发布)默认**不自动重试**,幂等性由预设声明(`idempotent: true`)后引擎才可重试。

**执行并行语义(v0.3 钉死)**:P2 引擎仅**顺序推进节点**(按依赖序,无并行调度);WorkflowSpec 的 `parallel` 字段由 P0 冻结 Schema 并预留(语义 = 一组可同批启动的节点),实现放 P3+——顺序引擎与并行引擎复杂度差一倍以上,P2 先交付正确性。Intent 的 `max_parallel` 在 P1–P2 仅作为**资源池并发容器数上限**传入 Provisioner 排队,不是编排并行度。

**(c) 静态校验(PlanCheck,确定性代码非 AI)**:schema 校验、契约类型匹配、依赖成环检测、禁授能力检查、**模型准入检查(§3.9)**、验收项可追溯(每个 acceptance 至少被一个 output 覆盖)。

**(d) 语义验收**:校验通过的编排交主控审批(可配置自动放行阈值),主控只审"拆解合理性"。

**(e) 执行引擎**:DAG 推进、反馈回路计数、超限升级——纯确定性,无 LLM,跑在 daemon。

**(f) 预算执行(v0.2 新增)**:daemon 为每个 task 维护 budget ledger,聚合 §3.6 usage 事件;soft limit(默认 80%)→ 发 warning 事件;hard limit → **pause 节点 + 升级主控**(续预算或终止)。token 计量语义 = "sidecar 尽力上报 + daemon 估算硬切",不是精确计费。

**(g) 可移植性与导出(v0.2 补充)**:编排按名字引用外部实体(preset / cap / secret),名字**只在本地解析**,不承诺跨部署语义一致——但可移植性靠"检查 + 导出"支持,不靠"是否移植"的状态判断(本机工具库同样会变,所以**每次都查**才是对的,不引入设备 ID 这类脆弱状态):
- **workflow check 常开**:引用解析本来就由 PlanCheck 常开执行;另提供显式入口 `neoba workflow check`,对任意 workflow 文件输出本地缺失清单(缺哪个 preset / cap / 模型准入不通过),移植前后各跑一次即可。模型准入口径与 daemon 对齐(issue #5):workflow 存在声明 `model.tier` 的节点而未给 `--models` 注册表时,check 报 `models_registry_missing` 且退出非 0;无 model 声明则不强制;
- **三档导出**(`neoba workflow export --level minimal|brief|full`):

| 档位 | 内容 |
|---|---|
| minimal | workflow 本体(内含用到的 cap 清单及用途描述) |
| brief | + capability manifest(Registry 对应条目快照:description / tools / risk_level) |
| full | + preset 文件、基线 grant 清单、环境搭建指引(MCP server 安装规格、镜像依赖) |

- **"完整档附带工具"的边界**:能力无法打包(`mcp:github` 背后是需在目标机安装运行的 MCP server),full 档附带的是**安装规格**而非工具本体;
- 导出包附带 **README**:列出目标机需自行补充的信息(凭据类型与用途、本地路径、模型准入要求);
- **铁律:任何档位不含凭据**——secret 永不离开 tenant(§3.8),导出包中只允许"此处需要什么类型的凭据"的占位说明。

### 3.6 Runtime API(容器观测规范)

每个容器由 supervisor sidecar 暴露统一接口:

| 端点 | 说明 |
|---|---|
| `GET /status` | `pending / provisioning / running / waiting_feedback / blocked / completed / failed` |
| `GET /progress` | 当前步骤、token 消耗、已产出工件(含 sha256)、最近错误 |
| `GET /events` (SSE) | 统一事件流,主控"跟踪反馈"消费此流,不轮询 |

统一事件 schema(基座 Adapter 负责把各家输出翻译成它):

```json
{ "event": "tool_call",   "ts": "…", "agent": "…", "tool": "…", "args_digest": "…" }
{ "event": "message_delta", "ts": "…", "text": "…" }
{ "event": "artifact_ready", "ts": "…", "name": "test_report", "sha256": "…" }
{ "event": "usage", "ts": "…", "tokens_in": 0, "tokens_out": 0, "cost_estimate": 0 }
{ "event": "error", "ts": "…", "kind": "harness_crash", "detail": "…" }
```

**唯一事实源原则(v0.2 新增,spike #1 F3)**:工具清单、能力使用、工件完成状态**一律以 sidecar 事件流与文件系统事实为准,禁止采信模型自述**。实测依据:模型会幻觉出不存在的 MCP 工具、谎报文件修改成功。基座 init/system 事件中的 tools / mcp_servers / permissionMode 为工具清单的权威来源。

**sidecar↔daemon 握手(v0.2 补充)**:sidecar 打包在容器镜像里,与 daemon 更新节奏天然独立(升级日并存新旧版本是常态),其接口必须有版本协商——sidecar 启动时对 daemon 执行 §3.0 同款握手(能力 + kind→版本映射),协商失败则该容器不进入 running。事件 schema(本节)为握手覆盖的对象之一。

两家基座的实测映射可行性:Claude Code `stream-json`(init/assistant/result,含 usage/cost/modelUsage/permission_denials);Codex `--json`(thread/turn/item,含 tokens)。差异由 Adapter 吸收。

### 3.7 交付契约(Artifacts)

- Agent 间交互**只通过交付文件**;`inputs` 绑定在编排里声明(from 节点.工件);
- 每个工件落盘即记 sha256,`artifact_ready` 事件与编排 evidence 双重校验——子 Agent 声称完成但哈希不匹配 = 未完成;
- 工件在任务工作区内按协议目录约定存放(`{workdir}/artifacts/{node_id}/{name}`),跨容器经 daemon 的工件仓库传递,**不走共享文件系统**;
- **任务间默认物理无共享**:跨任务只有工件仓库一条路(显式发布)。这是多任务隔离的安全根基(§10.4)。

**工件仓库 = 内容寻址存储(CAS,v0.2 定版)**,参考 git/OCI;manifest 本身按文档类自版本化(`api: artifact-manifest/1.0`,§3 总则)——工件要活得比 daemon 版本久,结构变更走独立版本轴,旧工件库永远可读:

```
objects/aa/bb/<sha256>                 // 内容块,不可变,天然跨任务去重
manifests/{tenant}/{task}/{node}/{artifact}   // 清单指针(内容为 artifact-manifest 文档)
```

- 目录型工件 = manifest 文件清单 + 每文件各自 hash(去重与完整性校验同时获得);
- **发布 = 写屏障**:worker 写临时目录 → daemon ingest 进 CAS → 原子更新 manifest 指针。屏障之前对所有读者不可见;发布后多读者并发共享读(不可变,无锁);同一路径写写严格串行;
- worker 崩溃的半写状态:留在 `.staging/`,永不进入 CAS;daemon 启动时与定期扫描清理孤儿 staging;
- **GC(v0.2)**:工件节点预留 `retention` 字段位;P1 提供 `neoba prune` 手动清理,自动 GC 为 P2+ 工作项。

### 3.8 Secrets(v0.2 新增)

凭据是一等协议概念,与工件同级:

- daemon 内置 **SecretStore**(参考实现:OS keyring 起步),凭据按 tenant 分桶;
- grant manifest 与预设只引用 **secret id**,任何协议结构体中禁止出现凭据明文;
- 凭据经 sidecar 以环境变量注入容器,只进入**被授予对应能力的容器**;daemon 绝不把 A 任务的凭据注入 B 任务的容器;
- 审计日志与事件流对凭据值强制脱敏(`args_digest` 等字段不含 secret 内容);
- 实测依据(spike #1 E5):模型会主动尝试自改配置/自加 MCP server——**基座配置文件与凭据文件一律 ro 挂载或独立属主**,不依赖模型自觉。

### 3.9 模型评分注册表(Model Score Registry)

解析 `model.tier` 抽象档位到具体模型的决策组件,核心是**评分随实测持续收敛**:

```json
{
  "model": "glm-4.7-air",
  "tier_fit": { "fast": 0.91, "standard": 0.62, "heavy": 0.30 },
  "score": {
    "prior": { "fast": 0.88, "standard": 0.55, "heavy": 0.20 },
    "observed": { "fast": 0.86, "standard": 0.61, "heavy": null },
    "samples": { "fast": 31, "standard": 16, "heavy": 0 },
    "dimensions": {
      "quality": 0.80,
      "success_rate": 0.85,
      "cost_efficiency": 0.74
    }
  },
  "updated_at": "…"
}
```

闭环流程:

1. **冷启动**:用市面模型检测数据、基准测试与能力边界测试给出初始 prior 分;
2. **准入**:解析时先过 `allowed_models`(Intent Spec/组织 policy),**准入是安全面,评分只是排序**——分数低是不推荐,准入不过是一票否决;
3. **选型**:按 `tier_fit × observed[tier]` 决策;
4. **反馈**:每次任务结束,验收方给该模型一次质量分/反馈分;
5. **收敛**:observed **按 tier 分桶**,各桶独立 EMA(α≈0.15),samples 按桶计数,不足回退 prior 同档值。

评分诚实性约定(v0.2 新增):
- 每条样本记录任务元数据(task_type、budget 档、traversal 次数作为难度代理)——选型偏差(简单任务倾向便宜模型 → success_rate 虚高)短期只记录不校准,数据足够后归一;
- 本分数定位为"**本系统内的实测表现**",不是通用能力榜;
- 质量分为可选项,缺省时仅以 success_rate 收敛,权重降低,防单次噪声振荡。

### 3.10 传输绑定(Bindings)

| 绑定 | 适用 | 形态 |
|---|---|---|
| MCP 绑定 | Claude Code 等原生支持 MCP 的主控 | 协议 10 组操作映射为 MCP 工具,开箱即用 |
| HTTP 绑定 | 任何会 function calling 的 harness(DeepSeek 等) | OpenAPI 文档直接接 |
| CLI 绑定 | 人肉调试与兜底 | `map` 命令行工具 |

新 harness 接入 = 写一个薄绑定层(小时级工作量)。

## 4. 多基座集成(Harness Adapter,南向)

| 基座 | 程序化接口 | 指令文件 |
|---|---|---|
| Claude Code | Agent SDK / `claude -p` stream-json | CLAUDE.md |
| Codex | `codex exec` / app-server 协议 | AGENTS.md |
| OpenCode | `opencode run` / server API | AGENTS.md |

Adapter 统一职责:

1. **事件归一化**:各家输出流 → 3.6 统一事件 schema,上层(编排/观测/dashboard)不认基座;
2. **预设落地**:同一份预设按基座生成对应指令文件与配置(技能 → SKILL.md 或 AGENTS.md 段落,模型档位 → 具体模型名);
3. **授予执行**:基座的 MCP/tool 配置由 sidecar 按 grant manifest 生成,未授予的物理不挂载,基座无关;
4. **spawn 硬规则(v0.2,spike #1)**:禁用 bypass 类标志(Claude 不传 `--dangerously-skip-permissions`,permissionMode 写死 settings);基座配置与凭据一律 ro 挂载(§3.8)。

## 5. 沙箱后端抽象(SandboxProvider)

"docker 只是概念,核心是干净环境"。供给接口:

```
create(spec) -> container     // 按镜像 + 资源限额 + 网络策略拉起
exec(container, cmd)          // supervisor 生命周期管理
snapshot()/restore()          // 可选:预热池,加速冷启动
destroy(container)            // 用完即毁
```

后端可插拔:Docker / gVisor / Firecracker microVM(microsandbox、E2B 类,秒级启动 + snapshot 预热)/ WASM。v0.1 参考实现先做 Docker,接口预留其余。

**基座前置条件契约(v0.2 新增,spike #1 F5)**:SandboxProvider 的 create spec 携带基座要求,后端必须满足或显式拒绝:
- Codex 基座需 **userns 能力**(bubblewrap 依赖 `clone(CLONE_NEWUSER)`;docker 默认 seccomp 会拦,需 unconfined 或放行 userns 的 profile)+ 镜像内预装 bubblewrap;
- Claude Code 基座无特殊内核要求;
- `neoba doctor`(§11)负责在部署前检测这些条件并写入配置。

**网络策略**:每任务独立 netns;"可出网/可达某地址段"本身是 grant 项。理由(spike #1):Claude 基座无进程级网络沙箱,网络隔离只能在容器层做,基座差异因此被抹平。

## 6. daemon 参考实现架构

**形态:服务为核,工具为壳,MCP 为桥。**

- 单二进制/单脚本 daemon,**按需手动拉起**(不注册开机自启),状态落盘、重启可恢复——体验上就是个 CLI 工具;
- **多任务架构(v0.2 决议,§10.4)**:单 daemon 多任务,不采用每任务一 daemon。理由:工件 CAS、事件日志、budget ledger、审批队列、Registry 样本池都是集中才有意义的状态;隔离边界是容器,控制面分裂无安全收益。配套要求:**任务级 failure domain**——单任务把引擎搞崩不得影响其他任务(任务循环隔离 + 全局状态原子写入);
- **鉴权(v0.2 新增)**:v1 daemon 每次启动生成随机 token 落盘(权限 600),绑定层读取并携带;daemon 仅监听 localhost / 命名管道。多 session(P3)时升级为 per-session token;HTTP 绑定时 Bearer + TLS;真多租户鉴权为 non-goal(§10.4);
- 对主控:暴露 MCP 绑定(主控"嵌入感"完整,以为在工具箱里操作,底下是服务);
- 对人:daemon 顺带托管 dashboard(静态页 + SSE 聚合 3.6 数据),零额外部署;
- 模块划分见 §2:Provisioner / Capability / Orchestrator / PlanCheck / Messenger / SecretStore / Observatory。

**状态与恢复:事件溯源(v0.2 定版)**:
- daemon 所有状态变更追加写入**事件日志(JSONL)**,内存态 = 重放;
- **日志自身带版本(v0.2 补充)**:每条事件记录含 `v` 字段;§3.0 的"忽略未知字段"规则同样适用于**持久化日志**——daemon 升级后必须能重放旧版本日志,否则"升级 daemon"= "丢弃运行中状态",违背可恢复承诺;日志格式破坏性变更(major)时,daemon 版本必须附带日志迁移工具;
- **审计日志 = 事件日志,同一份**,不做两套(§3.3 的审批审计、§3.6 的运行事件、本节的恢复日志同源);
- 恢复 = 重放事件 + **对账**:逐个 in-flight 容器查 `/status`;TTL 定时器从落盘时间戳重推导,已过期立即回收;DAG 状态与容器实态不一致时以容器实态为准并记 correction 事件;
- 资源池(并发容器数、CPU/内存配额、并发任务上限)由 Provisioner 确定性排队,状态同样走事件日志。

为何必须是服务而非嵌入式插件:容器生命周期、常驻状态、状态查询接口、dashboard 四者都要求独立于任何前端会话存活的进程;嵌入 Claude Code 插件形态会把系统绑死在单一 harness,与多基座目标矛盾。

## 7. 与 homerail 的对照

| 维度 | homerail | 本协议 |
|---|---|---|
| 能力限制 | 提示词级("Do not use shell") | 分层 enforcement(§1.3):容器物理边界 + grant manifest + TTL + 审计 |
| 主控 | 固定 Manager Agent | 可替换 orchestrator,握手协商能力 |
| 编排 | 静态 WorkflowSpec 手写 | Planner 生成 + 静态校验 + 主控语义验收 |
| 基座 | Claude Agent SDK 适配器 | 同思路,扩展 Codex / OpenCode 等 |
| 观测 | 日志为主 | Runtime API 标准(status/progress/events)+ 事件流唯一事实源 |
| 沙箱 | Docker | SandboxProvider 抽象,多后端 + 基座前置条件契约 |

直接借鉴:契约式边绑定、required_workspace_files + sha256 防编造、max_traversals 有界反馈、workflow/runtime-profile 分离、"smart brain, efficient workers"。

## 8. 外部先例

- **LSP**:一份规范,N 编辑器 × N 语言服务器自由组合——与本协议 N 主控 × N 基座同构;
- **MCP**:握手/版本协商、stdio 生命周期、instructions 语义、版本兼容规则,协议 3.0 直接仿照;
- **A2A**(Google):任务生命周期定义,消息通道部分可借鉴;
- **OAuth scope / sudo**:能力升级审批流(3.3)的模式来源;
- **git / OCI**:工件仓库 CAS + manifest 结构(3.7)的模式来源。

## 9. 分期落地路线

- **P0 规范冻结**:本文档评审 → v0.3 定稿 10 部分规范的 JSON Schema(含 `parallel` 字段预留与语义冻结)+ **版本兼容策略落地** + **一致性测试集**(JSON Schema + golden scenario:给定编排输入,断言事件序列)——一致性测试集是"任何 harness 小时级接入"承诺的验收物,P0 产物之一;
- **P1 最小闭环**:Docker 供给 + 单基座(Claude Code)+ MCP 绑定 + 基线授予 + Runtime API(**含 daemon v1 鉴权:启动 token + localhost,§6**)+ **事件日志(第一天就有)** + 工件 CAS(含 prune)+ **secret 最简注入**(host 配置 → 容器 env,协议结构仍只引用 secret id;不做 keyring)+ **取消/清理语义**(task cancel、节点超时 kill、daemon 启动时对 `neoba-` 前缀孤儿容器 reconcile)+ **`neoba doctor` 最小版**(Docker/WSL/跨界路径检测,结果写入配置);usage 事件**只记录不熔断**(budget ledger 是 P2)。跑通"主控下单 → 单 Worker 交付工件 → sha256 校验"一条链。**明确不做**:Planner(主控手写单节点 workflow)、审批流(只有基线授予)、Registry(固定模型)、自动 GC、SecretStore 完整版(keyring/tenant 分桶);
- **P2 编排与审批**:WorkflowSpec 执行引擎(**顺序推进**,`parallel` 字段 P0 已预留、本段不实现)+ PlanCheck + Planner 预设 + 能力升级审批流(**含人机入口:P2 用 CLI 交互;任务暂停 → 等审批 → 恢复的状态机扩展**)+ 有界反馈 + 预算熔断(ledger + soft/hard limit)+ Registry 数据结构启用 + SecretStore 完整版(OS keyring、按 tenant 分桶、脱敏规则,§3.8);
- **P3 多 session 与多基座**:Codex / OpenCode Adapter(含 userns 前置条件)、HTTP 绑定(验证 DeepSeek harness 接入)、per-session token 与审批权绑定、**`parallel` 字段启用(DAG 并行调度)**;
- **P4 观测与沙箱进阶**:dashboard 完整版、Firecracker/microsandbox 后端、snapshot 预热池、工件自动 GC。

每期结束的验收标准 = 用协议文件(非代码改动)新增一个预设/一条编排并跑通。

## 10. 未决问题的处置(2026-09-04,评审结论 v0.2)

1. **命名与仓库(已定)**:协议/项目命名 **neoba**,仓库 `D:\workspace\neoba`,本文档移交至该仓库;
2. **工件跨容器传递(已定,v0.2)**:**CAS 工件仓库**,不做共享卷为主路径——共享卷把所有容器绑死在同一宿主文件系统,堵死远端沙箱后端(P4);仓库天然带去重、哈希校验、审计点。同机场景共享卷可作为实现层优化,不进协议。细节见 §3.7;
3. **自动放行阈值(已定,v0.2)**:配置项 + **分层合并**(内置 < 全局 < preset < session)+ **协议层硬底线**(high-risk 写/管理能力永不自动放行)+ `decision_source` 全量审计。见 §3.3;
4. **多租户/并发任务隔离(已定,v0.2)**:**单 daemon 多任务**;身份四层化 `tenant → session → task → agent`,全部状态按四层命名空间化;任务间**默认物理无共享**(fs 靠挂载、网络靠 netns、跨任务只走工件仓库);P1–P2 单 tenant 单 session,`tenant_id` 字段恒默认值;P3 起 per-session token 与审批权绑定;**多用户真多租户(认证/计费/SLA)为 non-goal**——协议保证命名空间化正确,将来加鉴权层即可开启,现在不为它付复杂度。每任务一 daemon 保留为调试入口(`neoba task spawn --isolated`),不是部署形态;
5. **tier→模型映射(已定)**:**Model Score Registry**(§3.9)——公开基准给初始分,每次任务实测反馈,按 tier 分桶滚动收敛;模型准入(`allowed_models`)与评分分离,准入是一票否决,评分只是排序;
6. **Windows 沙箱后端(已定)**:WSL2 内 Docker;数据面(workdir、镜像、工件仓库、docker context)必须全在 WSL2 原生文件系统,`neoba doctor` 对跨界路径(如 `/mnt/d/...`)报 **error**(性能悬崖,非建议);新增**环境检测工具(neoba doctor)**——在 Linux / macOS / Windows 三平台检测 Docker/WSL/内核/userns 等条件(含 Codex 基座的 userns 前置,§5),输出机器可读 JSON + 人读摘要,写入配置供 daemon 选 SandboxProvider 后端。

## 11. 新增工作项(自 v0.1 评审,含 v0.2/v0.3 更新)

- `neoba doctor`:跨平台环境检测(Linux / macOS / Windows);检测项包括:Docker 可用性与版本、WSL2 发行版与内核、`.wslconfig` 资源限额、**数据面路径跨界检测(error 级)**、**userns 能力(Codex 基座前置)**;输出 JSON + 摘要,写入配置。**排期(v0.3):P1 交付最小版**(Docker/WSL/跨界路径),**userns 检测 P3 前补齐**(Codex Adapter 接入前置);
- Model Score Registry:评分数据结构(§3.9 v0.2 版)、反馈采集点、按 tier 分桶 EMA 更新算法(P2 落地,数据结构随 P0 冻结);
- SecretStore:**拆两期(v0.3)**——P1 只做最简注入(host 配置 → 容器 env,协议结构仍只引用 secret id、审计仍脱敏,§3.8 语义不变);P2 补 OS keyring 适配、按 tenant 分桶、注入与脱敏规则完整版;
- **取消/清理与 reconcile(v0.3 新增,P1)**:task cancel 语义、节点超时 kill、daemon 启动时扫描 `neoba-` 前缀容器对不上任务记录即回收(孤儿容器 reconcile,防容器泄漏)——与 §6 事件溯源恢复的对账共用一套机制;
- **daemon v1 鉴权(v0.3 排期,P1)**:启动 token + 仅 localhost(§6),与 Runtime API 同批交付,不单独后补;
- 预算 ledger:聚合/熔断/升级事件(P2;P1 usage 只记录不熔断);
- 一致性测试集:JSON Schema + golden scenarios(P0 产物);
- `neoba workflow check` / `neoba workflow export`(三档 + README):编排查缺与可移植性入口(§3.5g,P2 与编排同批落地);
- spike #1 遗留(可选,P1 前补):Codex `network = true` 开启态与细粒度沙箱配置;Claude settings.json 细粒度 permissions 穷举;rootless/受限 userns 宿主上的退化行为。
