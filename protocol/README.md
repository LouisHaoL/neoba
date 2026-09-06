# neoba 协议 Schema(P0 冻结物)

本目录是 neoba 协议(设计文档 `docs/neoba-design-v0.2.md`)的 JSON Schema 冻结,
对应路线图 **P0 规范冻结**。设计文档是唯一事实来源;schema 只把文档字面结构化,
不扩大语义。

- Draft:JSON Schema 2020-12;协议版本字段 `protocol` 固定 `"1.0"`
- `$id` 命名空间:`https://neoba.dev/schemas/<name>.schema.json`
- 共享定义(cap id / agent_id / tenant / scope 枚举 / RFC3339 UTC 时间 / sha256 /
  secret id / 通配匹配元素等)集中在 `common.schema.json#/$defs/*`,其余 schema 一律
  `$ref` 引用
- 正例在 `examples/`,可直接取自设计文档示例(JSON/YAML 转 JSON)
- 描述/注释均为中文,与设计文档风格一致

## 根类型与版本轴(§3 总则决议,已落实到 schema)

协议文档分两类根,**字段互斥、不允许混用**,各走一条独立的 semver 轴:

| 根类型 | 首层字段 | schema | 互斥表达 |
|---|---|---|---|
| **信封类**(RPC 消息) | `protocol` + `spec_version` | handshake、grant-manifest(本体 + tool.request)、messaging、runtime-api(status/progress/事件)、capability-registry | 两字段必填 |
| **文档类**(独立流转的产物) | `api: <kind>/<major.minor>` | preset(`preset/1.0`)、intent(`intent/1.0`)、workflow(`workflow/1.0`)、artifact-manifest(`artifact-manifest/1.0`) | `not anyOf(required protocol / required spec_version)` + additionalProperties:false 双重禁止 |

semver 兼容规则(§3.0)**分别作用于两条轴**:接收方必须忽略未知字段;仅新增字段/新增
可选能力 = minor;删除字段、变更语义、收紧默认 = major;daemon 与绑定层支持相邻两个
major。

握手响应携带 **kind→版本映射** `document_kinds`(preset/intent/workflow/artifact-manifest
→ 支持版本列表,必填);文档类不匹配的错误语义 = 按 kind 报告,响应 `errors` 数组中的
`document_kind_version_mismatch` 结构(kind + expected + supported),不报协议级不匹配。

## 通用 Schema 约定(§3 总则,已逐条落实)

- **匹配语义**:`forbidden_caps` / `auto_approve` / `allowed_models` 等列表默认**精确
  匹配**;`*` 仅整串通配;前缀通配必须用显式语法(如 `mcp:*` = 命中该命名空间全部
  cap,模型侧 `provider/*` 同规则),匹配规则写死,不允许实现自定义模糊匹配——
  common 的 `cap_id_or_wildcard` / `identifier_or_wildcard` + 各字段描述冻结;
- **可空语义**:字段要么必填、要么显式 nullable。已落实:`grant.ttl`(必填,基线为
  null)、`progress.last_error`(必填,无错为 null)、`usage.cost_estimate`(必填,
  订阅制基座为 null)、`score.observed[tier]`(必填,无样本为 null);**字段省略 = 未
  提供,不等于 null**;
- **时间戳**:一律 RFC3339 UTC,common.timestamp 加 `Z` 结尾 pattern 强制(含 ttl);
- **摘要算法**:`args_digest` 等摘要字段统一 sha256,与工件哈希同一 `common.sha256`
  定义,不给实现留选择(`args_digest` 同时受 §3.8 凭据脱敏约束)。

## Schema ↔ 设计文档章节 ↔ 用途对照

| Schema | 根类型 | 章节 | 用途 |
|---|---|---|---|
| `common.schema.json` | — | §3 总则 / §2 / §3.8 | 跨 schema 共享定义:protocol/spec_version、RFC3339 UTC 时间、cap_id(+通配变体)、模型名通配、agent_id、node_id、工件名/引用、scope 与 risk_level/kind 枚举、model tier/base、时长、io 类型、输出绑定、sha256、secret_id、tenant_id |
| `handshake.schema.json` | 信封 | §3.0 握手与版本协商 | `session.init` 请求(role/principal{tenant,session}/harness/capabilities)与 daemon 应答(版本 + 能力集 + **document_kinds** + errors + degradations),顶层 oneOf |
| `capability-registry.schema.json` | 信封* | §3.1 能力注册表 | 可授予能力条目:id/kind/tools/risk_level/grantable_scopes/path_template(fs_path 强制) |
| `preset.schema.json` | 文档 | §3.2 Agent 预设 | api=preset/1.0、base、model.tier/fallback、skills、idempotent、baseline_grants、io_contracts、escalation_policy(分层合并 + 硬底线注释) |
| `grant-manifest.schema.json` | 信封 | §3.3 授予清单与审批流 | grants(source/ttl/constraint 含 secret 引用)+ audit(**decision_source 必填**);oneOf:tool.request 升级申请 |
| `messaging.schema.json` | 信封 | §3.4 消息通道 | oneOf:msg.direct / msg.broadcast / msg.feedback(kind + ref + traversal) |
| `intent.schema.json` | 文档 | §3.5(a) | goal、acceptance、constraints(max_parallel/budget_tokens/forbidden_caps/allowed_models,通配匹配语义入注) |
| `workflow.schema.json` | 文档 | §3.5(b)(c) | nodes(preset + inputs 边绑定 + timeout + retry)/outputs/feedback(max_traversals)/evidence;幂等-重试组合等运行时校验属 PlanCheck |
| `runtime-api.schema.json` | 信封 | §3.6 Runtime API | oneOf:status 七态 / progress / 五种统一事件;事件流唯一事实源(禁止采信模型自述)为运行时原则 |
| `artifact-manifest.schema.json` | 文档 | §3.7 交付契约(CAS) | api=artifact-manifest/1.0 清单文档:file/dir(每文件 hash)、**revision = 同路径发布计数**(与 api 轴是两条独立版本概念)、retention GC 字段位 |
| `model-score-registry.schema.json` | 信封* | §3.9 模型评分注册表 | prior/observed/samples **per-tier 分桶**(observed 可 null)、dimensions、可选 sample_records(task_type/budget 档/traversals 难度代理) |

`*` capability-registry 与 model-score-registry 未出现在 §3 总则根类型决议的枚举表里
(该表只列了 session.init、grant、审批、消息、事件与四个文档类);两者是随会话查询的
daemon 数据,暂按信封类处理——见模糊点 14。

未单列 schema 的章节:§3.8 SecretStore(daemon 内部实现,协议层只有 secret_id 引用与
脱敏约定);§3.10 传输绑定、§4 Adapter、§5 SandboxProvider、§6 daemon 架构——行为性
内容,不产生独立协议数据结构。

## Secrets 约定(§3.8)

**任何协议结构体中禁止出现凭据明文。** grant manifest 与预设只引用 secret id
(`common.secret_id`;grant constraint 的 `secret_ids`);凭据值由 SecretStore 按
tenant 分桶持有,经 sidecar 以环境变量注入**被授予对应能力的容器**;审计日志与事件流
对凭据值强制脱敏(`args_digest` 不含 secret 内容)。

## 使用方式

校验正例(daemon 已自带 ajv,本目录零依赖):

```
node D:\workspace\neoba\protocol\examples\validate.mjs
```

在自己的代码里用(以 Node + ajv 8 为例):

```js
const Ajv = require("ajv/dist/2020");            // 2020-12 draft
const ajv = new Ajv({ strict: false });          // 装了 ajv-formats 可去掉 strict:false
ajv.addSchema(require("./schemas/common.schema.json"));   // 先注册共享定义
const validate = ajv.compile(require("./schemas/workflow.schema.json"));
validate(myDoc); // 顶层 oneOf 的 schema(handshake / grant-manifest / messaging /
                 // runtime-api)会自动落到匹配的分支
```

## 文档模糊点记录

### 已被 v0.2 补充决议回答(原记录销号)

1. ~~首层 protocol/spec_version 与 api 字段并存~~ → 根类型二分决议:字段互斥,文档类
   只用 api、禁止信封字段(preset/intent/workflow/artifact-manifest),信封类保持
   protocol+spec_version。
2. ~~escalation_policy 通配符~~ → 通用 Schema 约定:精确匹配 + `*` 整串通配 + 显式
   前缀语法 `mcp:*`,规则写死。
3. 可空语义(ttl/last_error/cost_estimate/observed 逐处落实,"省略 ≠ null")、时间戳
   RFC3339 UTC、摘要统一 sha256 → 均已冻结进 common 与相关字段。

### 仍待 v0.3 拍板(14 条)

1. **scope 枚举按能力类别不同**:MCP 类 `read/write/admin` vs fs 类 `ro/rw`,无
   per-kind 合法组合表 → 并集枚举,组合校验留 PlanCheck。
2. **audit 事件枚举**:v0.2 补了 decision_source,但 `event` 仍只有示例字面 `granted`
   + 正文生命周期词 → 维持八值闭枚举,新增须改 schema。
3. **feedback 边 YAML 单行笔误**:`- from: test, to: impl` 按 YAML 解析为单标量
   (v0.1/v0.2 均未改)→ 按语义冻结为 `{from, to, max_traversals}` 全必填。
4. **msg body 类型不一致**:direct/broadcast 为对象,feedback 为字符串 → 按字面冻结。
5. **握手应答字段级定义**:kind→版本映射与错误结构已定,但 `daemon_version`/
   `capabilities`/`degradations` 的字段名仍是文档一句话的最小冻结。
6. **capability 条目可选字段**:`tools` 仅 mcp_server 示例、`path_template` 仅 fs_path
   示例 → path_template 对 fs_path if/then 强制;tools 不强制(未声明专属规则)。
7. **constraint 键集**:`fs_scope_narrowed_to` + v0.2 的 `secret_ids` 之外键名开放。
8. **progress 字段名 / error.kind 字面值**:`/progress` 只有中文描述(冻结为
   step/tokens_in/tokens_out/artifacts/last_error);`error.kind` 仅 `harness_crash`
   一例值,未做闭枚举。
9. **principal 是否可省**:§10.4 说 P1–P2 tenant 恒默认值,但握手示例必带 → 从严
   必填(tenant 带 default 建议值);若 v0.3 决定 P1 可省需改。
10. **sample_records 字段名与挂载位置**:中文描述无字面字段名;budget 档位取值集未
    定义 → 冻结为注册表内可选数组,开放字符串。
11. **retention 字段位**:无类型定义 → 开放对象,自动 GC(P2+)时收紧。
12. **secret id 字面格式**:只说"引用 secret id" → 从严冻结为小写标识符 pattern。
13. **decision_source 的 id/principal 字符集**:仅格式骨架 → pattern 约束前缀 + 非空
    非空白值。
14. **capability-registry / model-score-registry 的根类型归类**:决议表未列;暂按
    信封类(protocol+spec_version)处理,若定稿归文档类需加 api 字段。

### 修订记录

- **2026-09-06(#24)**:`handshake.schema.json` 的 `sessionInitRequest`(顶层信封)与
  `clientCapabilities` 移除 `additionalProperties: false`。原冻结与 §3.0 规则 1
  ("接收方必须忽略未知字段;仅新增字段/新增可选能力 = minor")自相矛盾,实现一直按
  规则 1 走(忽略未知键);本次裁决:按设计文档走,握手请求信封与能力声明层允许扩展
  字段,`params`/`principal` 等字段级定义维持最小冻结。集成方无所适从的问题就此销号。

## 版本

- 冻结依据:`docs/neoba-design-v0.2.md`(2026-09-04,含 v0.2 变更摘要 13 项)
- 协议版本 `protocol: "1.0"`;文档类各 kind `api: <kind>/1.0`;信封示例
  `spec_version: "0.2"`
