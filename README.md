# neoba

多 Agent 协作协议：N 主控 harness × N 执行基座自由组合。协议即产品，daemon 只是参考实现。

- 设计文档：[docs/neoba-design-v0.3.md](docs/neoba-design-v0.3.md)（历史版本 v0.1/v0.2 留档）
- 状态：P0 协议冻结 + P1 最小闭环 + P2 编排与审批 + P3 多 session/多基座 + P4 观测与沙箱进阶 已全部落地（2026-09-06，全仓 690/690 测试(649 基线 + e2e 37 + issue 修复回归 4)）
- 许可：[Apache-2.0](LICENSE)

## 目录约定

```
protocol/   协议本体(P0 冻结物):JSON Schema + 示例 + golden 一致性场景
daemon/     daemon 参考实现(Node.js/TypeScript)
presets/    Agent 预设(设计产物单元,见 §3.2)
spike/      基座验证脚本与镜像(用完即扔)
docs/       设计文档
```

## 技术决策记录

| 决策 | 结论 | 日期 |
|---|---|---|
| daemon 技术栈 | Node.js ≥22.6 + TypeScript(可剥离语法,直接跑 .ts 零构建) + ESM + node:test,运行时零第三方依赖(ajv 仅 devDep 用于 schema 校验) | 2026-09-04 |
| 设计文档 | v0.3 为准(并行编排、双 token、观测线、GC、keyring、microsandbox 全部增量入档) | 2026-09-05 |

## 实现进度

| 模块 | 状态 |
|---|---|
| protocol/(schema 套件 + 示例 + ajv 校验 + golden 场景 01–08) | ✅ 20/20 |
| P0 协议冻结:节点级 `parallel` 字段 + PlanCheck 解析 | ✅ |
| P1 最小闭环:task.create 执行链 / 工件发布 / 重启对账(recover) | ✅ |
| P2 编排与审批:PlanCheck(§3.5c)/ 审批流+策略分层+TTL(§3.3)/ 预算 ledger+熔断(§3.5f)/ 执行引擎(反馈回打/重试/取消/超时)/ CLI 人机入口 / `workflow export` 三档可移植 | ✅ |
| P3 · M1:DAG 并行(ready 集合批量派发,全串行路径事件序零漂移)+ ResourceGate 信号量(`sandbox.queued/acquired/released` 事件) | ✅ |
| P3 · M2:HarnessAdapter 抽象 + Codex(`codex exec --json`)/ OpenCode 基座,bypass 标志按基座分域,doctor 探测 | ✅ |
| P3 · M3:双 token 模型(bootstrap=admin + `session.init` 签发 per-session token,sha256 落盘)+ principal 贯通(SESSION_FORBIDDEN/ApprovalForbidden)+ 审批 policy session 层 + MCP 桥 19 工具全集 | ✅ |
| P3 · M5:工件自动 GC(retention 定型 / plan-collect 分离 / 孤儿清扫 / `artifact.gc` 事件 / `prune --plan`) | ✅ |
| P4 · M4:观测线 `events.list` + OpenAPI 3.1(`GET /openapi.json`,api-doc 一致性单测防漂移)+ SSE 事件流(replay+live 去重)+ 零构建只读 dashboard | ✅ |
| P4 · M6:Linux keyring 后端(libsecret `secret-tool` 桥)+ `createSecretStore` 工厂 + `neoba.config.json` 生产接线 + doctor `keyringReady` | ✅ |
| P4 · M7:microsandbox(Firecracker microVM)后端 + provider 工厂(memory/docker/microsandbox)+ warm pool(snapshot 回热,与 ResourceGate 共槽)+ 镜像配置注入 | ✅ |
| 一致性测试:全仓 690/690(golden 01–08 零漂移回归 + e2e 子进程 32 + 驱动/审计回归) | ✅ |

运行示例:`neoba workflow check presets/examples/workflow.json --presets presets/examples --intent presets/examples/intent.json`。示例预设声明了 `model.tier`,请追加 `--models <模型注册表.json>`(口径与 daemon 一致:声明 model.tier 的工作流 check 时不传 `--models` 会报 `models_registry_missing` 且退出非 0,见 issue #5)。

约束:TS 只用可剥离语法子集(无 enum/namespace/参数属性),类型导入用 `import type`,相对导入带 `.ts` 后缀——保证 `node` 直接执行,无构建步骤。

真机冒烟(docker/keyring/microsandbox 等 Linux 侧能力)以 `neoba doctor` 结论为准,CI 覆盖以可注入假桥的语义矩阵为准。

## License

Apache-2.0,见 [LICENSE](LICENSE)。
