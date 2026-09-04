# neoba 设计文档 v0.1(多 Agent 协作协议)

> 状态:草案(待评审)
> 日期:2026-09-04
> 定位:**协议先行**。本协议是产品本体,daemon 只是参考实现;任何主控 harness(Claude Code / DeepSeek harness / 自研)与任何执行基座(Claude Code / Codex / OpenCode / …)都可经协议接入。
> 工作代号:**neoba**(已定名 2026-09-04),仓库:`D:\workspace\neoba`

---

## 1. 设计哲学

1. **协议即产品**:语义模型(规范的 JSON 结构)与传输绑定(MCP / HTTP / CLI)分离。语义层改一次,所有绑定跟随;新 harness 接入 = 写一个薄绑定层。
2. **决策与执行分离**:智能只出现在决策点(需求、审批、验收);供给、编排执行、观测全部是确定性代码,跑在 daemon 里。
3. **能力即挂载**:权限限制不靠提示词("不要用 shell"),靠物理挂载(grant manifest 之外的 MCP server / 工具根本不存在)。从"提示词约束"升级为"可执行层 enforcement"。
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
│  Daemon 服务层(参考实现,确定性代码)                   │
│  ├─ Provisioner   沙箱供给(SandboxProvider 抽象)      │
│  ├─ Capability    能力注册表 + 授予/回收执行器          │
│  ├─ Orchestrator  编排执行引擎(DAG 推进,无 LLM)       │
│  ├─ PlanCheck     编排静态校验器                       │
│  ├─ Messenger     消息通道(按 ID 点对点 / 广播)        │
│  └─ Observatory   Runtime API 聚合 + dashboard 托管    │
├─────────────────────────────────────────────────────┤
│  Planner(可选,本身是一个 Agent 预设,基座可替换)        │
│  职责:把需求翻译成 WorkflowSpec 编排产物               │
├─────────────────────────────────────────────────────┤
│  Worker Agent 层(每个 = 干净沙箱 + supervisor sidecar) │
│  sidecar:拉起 harness 基座 · 按 grant manifest 挂载能力 │
│           收集事件 · 暴露 Runtime API                  │
│  基座:Claude Code / Codex / OpenCode / …(可替换)      │
└─────────────────────────────────────────────────────┘
```

三个视角:

- **daemon = 供给 + 执行 + 审批执行 + 观测**(事实层)
- **主控 = 需求 + 审批决策 + 语义验收**(决策层)
- **dashboard = 人看的监督视图**(只读,不引入新状态)

## 3. 协议规范(九个部分)

协议版本字段:`protocol: "1.0"`。所有结构体首层含 `protocol` 与 `spec_version`。

### 3.0 握手与版本协商

任何接入方(bind 侧)与 daemon 建立会话时先握手,语义仿照 MCP initialize:

```json
{
  "method": "session.init",
  "params": {
    "protocol": "1.0",
    "role": "orchestrator",          // orchestrator | planner | observer
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

要点:预设与运行时环境分离(借鉴 homerail 的 workflow / runtime-profile 分离);`model.tier` 是抽象档位,具体模型名由 **Model Score Registry**(见 §3.9)解析——不是静态映射表,而是按实时评分动态决策。

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
    { "event": "granted", "cap": "mcp:mcp-server-browser", "by": "orchestrator", "at": "…" }
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
4. 审批通过 → daemon **动态挂载**对应 MCP server(物理生效);授权可**窄于申请**(申请 fs:rw,只授 workdir 子目录);
5. 所有临时授权带 **TTL**,到期自动回收;申请、审批、挂载、回收全量进审计日志。

安全不变量:
- **物理性**:未授予的能力在容器内不存在,而非"被告知不要用";
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

**(c) 静态校验(PlanCheck,确定性代码非 AI)**:schema 校验、契约类型匹配、依赖成环检测、禁授能力检查、验收项可追溯(每个 acceptance 至少被一个 output 覆盖)。

**(d) 语义验收**:校验通过的编排交主控审批(可配置自动放行阈值),主控只审"拆解合理性"。

**(e) 执行引擎**:DAG 推进、反馈回路计数、超限升级——纯确定性,无 LLM,跑在 daemon。

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

### 3.7 交付契约(Artifacts)

- Agent 间交互**只通过交付文件**;`inputs` 绑定在编排里声明(from 节点.工件);
- 每个工件落盘即记 sha256,`artifact_ready` 事件与编排 evidence 双重校验——子 Agent 声称完成但哈希不匹配 = 未完成;
- 工件在任务工作区内按协议目录约定存放(`{workdir}/artifacts/{node_id}/{name}`),跨容器经 daemon 的工件仓库传递,不依赖共享文件系统。

### 3.9 模型评分注册表(Model Score Registry)

解析 `model.tier` 抽象档位到具体模型的决策组件,核心是**评分随实测持续收敛**:

```json
{
  "model": "glm-4.7-air",
  "tier_fit": { "fast": 0.91, "standard": 0.62, "heavy": 0.30 },
  "score": {
    "prior": 0.82,                 // 初始分:公开基准/能力边界测试的网络评分
    "observed": 0.78,              // 实测综合分:随任务反馈滚动更新
    "samples": 47,
    "dimensions": {
      "quality": 0.80,             // 主控/验收方给出的质量分
      "success_rate": 0.85,        // 任务完成率
      "cost_efficiency": 0.74      // token 成效比
    }
  },
  "updated_at": "…"
}
```

闭环流程:

1. **冷启动**:用市面模型检测数据、基准测试(benchmark)与能力边界测试结果给出初始 prior 分;
2. **选型**:编排 Agent 选基座/模型时按 `tier_fit × observed score` 决策,而非写死映射表;
3. **反馈**:每次任务结束,验收方给该模型一次质量分/反馈分;
4. **收敛**:observed 分按样本滚动加权,逐步逼近真实能力,samples 不足时回退 prior 分。

### 3.10 传输绑定(Bindings)

| 绑定 | 适用 | 形态 |
|---|---|---|
| MCP 绑定 | Claude Code 等原生支持 MCP 的主控 | 协议 9 组操作映射为 MCP 工具,开箱即用 |
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
3. **授予执行**:基座的 MCP/tool 配置由 sidecar 按 grant manifest 生成,未授予的物理不挂载,**基座无关**。

## 5. 沙箱后端抽象(SandboxProvider)

"docker 只是概念,核心是干净环境"。供给接口:

```
create(spec) -> container     // 按镜像 + 资源限额 + 网络策略拉起
exec(container, cmd)          // supervisor 生命周期管理
snapshot()/restore()          // 可选:预热池,加速冷启动
destroy(container)            // 用完即毁
```

后端可插拔:Docker / gVisor / Firecracker microVM(microsandbox、E2B 类,秒级启动 + snapshot 预热)/ WASM。v0.1 参考 implementation 先做 Docker,接口预留其余。

## 6. daemon 参考实现架构

**形态:服务为核,工具为壳,MCP 为桥。**

- 单二进制/单脚本 daemon,**按需手动拉起**(不注册开机自启),状态落盘、重启可恢复——体验上就是个 CLI 工具;
- 对主控:暴露 MCP 绑定(主控"嵌入感"完整,以为在工具箱里操作,底下是服务);
- 对人:daemon 顺带托管 dashboard(静态页 + SSE 聚合 3.6 数据),零额外部署;
- 模块划分见 §2:Provisioner / Capability / Orchestrator / PlanCheck / Messenger / Observatory。

为何必须是服务而非嵌入式插件:容器生命周期、常驻状态、状态查询接口、dashboard 四者都要求独立于任何前端会话存活的进程;嵌入 Claude Code 插件形态会把系统绑死在单一 harness,与多基座目标矛盾。

## 7. 与 homerail 的对照

| 维度 | homerail | 本协议 |
|---|---|---|
| 能力限制 | 提示词级("Do not use shell") | 物理挂载 + grant manifest + TTL + 审计 |
| 主控 | 固定 Manager Agent | 可替换 orchestrator,握手协商能力 |
| 编排 | 静态 WorkflowSpec 手写 | Planner 生成 + 静态校验 + 主控语义验收 |
| 基座 | Claude Agent SDK 适配器 | 同思路,扩展 Codex / OpenCode 等 |
| 观测 | 日志为主 | Runtime API 标准(status/progress/events)+ dashboard |
| 沙箱 | Docker | SandboxProvider 抽象,多后端 |

直接借鉴:契约式边绑定、required_workspace_files + sha256 防编造、max_traversals 有界反馈、workflow/runtime-profile 分离、"smart brain, efficient workers"。

## 8. 外部先例

- **LSP**:一份规范,N 编辑器 × N 语言服务器自由组合——与本协议 N 主控 × N 基座同构;
- **MCP**:握手/版本协商、stdio 生命周期、instructions 语义,协议 3.0 直接仿照;
- **A2A**(Google):任务生命周期定义,消息通道部分可借鉴;
- **OAuth scope / sudo**:能力升级审批流(3.3)的模式来源。

## 9. 分期落地路线

- **P0 规范冻结**:本文档评审 → v0.2 定稿 9 部分规范的 JSON Schema;
- **P1 最小闭环**:Docker 供给 + 单基座(Claude Code)+ MCP 绑定 + 基线授予 + Runtime API;跑通"主控下单 → 单 Worker 交付工件 → sha256 校验"一条链;
- **P2 编排与审批**:WorkflowSpec 执行引擎 + PlanCheck + Planner 预设 + 能力升级审批流 + 有界反馈;
- **P3 多基座与多主控**:Codex / OpenCode Adapter,HTTP 绑定(验证 DeepSeek harness 接入);
- **P4 观测与沙箱进阶**:dashboard 完整版、Firecracker/microsandbox 后端、snapshot 预热池。

每期结束的验收标准 = 用协议文件(非代码改动)新增一个预设/一条编排并跑通。

## 10. 未决问题的处置(2026-09-04 评审结论)

1. **命名与仓库(已定)**:协议/项目命名 **neoba**,仓库 `D:\workspace\neoba`,本文档移交至该仓库;
2. **工件跨容器传递(方向已定)**:参考 **Java 内存屏障**与**数据库共享读/顺序写**的思路——
   - 工件仓库 = 只追加(append-only)的顺序写日志,写入完成并落盘 sha256 后才"发布";
   - 发布动作即**写屏障**:屏障之前的写入对所有后续读者可见,屏障之前读者拿到的只能是上一版快照;
   - 读者侧**共享读**:多个容器并发读同一份不可变工件,无需加锁;写写之间严格串行(同一路径只有一个写入者推进版本);
   - 待 P1 实测:容器间传递走 daemon 工件仓库(已倾向)还是共享卷;
3. **自动放行阈值(方向已定)**:做成**配置项**,初始默认值参考市面工具(如各 Agent harness 的权限模式/auto-approve 设计)给出一组参考值与默认值,后续按使用调参;
4. **多租户/并发任务隔离(待讨论)**:场景尚未明确,与用户讨论后定(每任务一 daemon vs 单 daemon 多任务);
5. **tier→模型映射(已定)**:不做静态映射表,改为 **Model Score Registry**(§3.9)——公开基准给初始分,每次任务实测反馈质量分,滚动收敛综合评分,编排 Agent 按评分选型;
6. **Windows 沙箱后端(方向已定)**:WSL2 内 Docker;并新增 **环境检测工具(neoba doctor)**——在 Linux / macOS / Windows 三平台检测 Docker/WSL/内核等条件,把检测结果写入配置,daemon 据此选 SandboxProvider 后端。

## 11. 新增工作项(自本次评审)

- `neoba doctor`:跨平台环境检测工具(Linux / macOS / Windows),输出结构化环境报告并写入配置;
- Model Score Registry:评分数据结构、反馈采集点、滚动更新算法(P2 落地,数据结构随 P0 冻结)。
