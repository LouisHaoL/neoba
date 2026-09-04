# neoba

多 Agent 协作协议：N 主控 harness × N 执行基座自由组合。协议即产品，daemon 只是参考实现。

- 设计文档：[docs/neoba-design-v0.1.md](docs/neoba-design-v0.1.md)
- 状态：P0 规范冻结进行中（2026-09-04 启动实现）

## 目录约定

```
protocol/   协议本体(P0 冻结物):JSON Schema 九件套 + 示例
daemon/     daemon 参考实现(Node.js/TypeScript)
presets/    Agent 预设(设计产物单元,见 §3.2)
spike/      基座验证脚本与镜像(用完即扔)
docs/       设计文档
```

## 技术决策记录

| 决策 | 结论 | 日期 |
|---|---|---|
| daemon 技术栈 | Node.js ≥22.6 + TypeScript(可剥离语法,直接跑 .ts 零构建) + ESM + node:test,运行时零第三方依赖(ajv 仅 devDep 用于 schema 校验) | 2026-09-04 |
| 并行首批评审模块 | 协议 Schema / 工件仓库 / neoba doctor / SandboxProvider 抽象 | 2026-09-04 |
| 设计文档 | v0.2 为准(根类型二分、通用 Schema 约定、CAS、事件溯源、单 daemon 多任务) | 2026-09-04 |

## 实现进度

| 模块 | 状态 |
|---|---|
| protocol/(14 schema + 示例 + ajv 校验) | ✅ 20/20 |
| daemon: artifacts(CAS) / doctor / provision / session / capability / events / messenger / secrets / daemon 服务壳+MCP 绑定 | ✅ 全仓测试 |
| CLI 壳 / Claude 基座 Adapter+sidecar 配置 | ✅ |
| 一致性测试集(golden scenarios:5 场景 + schema 校验 + 执行器) | ✅ 全仓 369/369 测试 |

约束:TS 只用可剥离语法子集(无 enum/namespace/参数属性),类型导入用 `import type`,相对导入带 `.ts` 后缀——保证 `node` 直接执行,无构建步骤。
