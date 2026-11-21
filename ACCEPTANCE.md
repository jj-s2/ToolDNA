# ToolDNA v0.1.0 发布验收

验收对象为 `dsh-tooldna-0.1.0.tgz`，SHA-256 为 `b773457101771546408a3d7cb0bfe639cbb6baf52e655ebc2e499c4b7e069715`。Windows x64 与 Ubuntu 22.04 x64（WSL2）使用 Node.js 24.18.0、DSH 0.2.2-rc.5。Web 分别使用 Edge 与 Chromium Headless Shell。两端各通过 16 项 Node 测试。

| 验收项 | 证据 |
| --- | --- |
| T01 安装与启动 | [Windows](demo/windows-release-receipt.json) 和 [Ubuntu](demo/linux-release-receipt.json) 从同一 tarball 安装并启动干净 Web、SDK profile。模型请求中可见查询工具 |
| T02 同名与范围 | 两端回执确认 A、B 分别可见。[作用域测试](tests/identity.test.mjs) 验证其他会话、条件禁用的工具，以及当前步骤的目录查询。[恢复测试](tests/recovery.test.mjs) 验证候选证据隔离 |
| T03 预检与冷启动 | [预检测试](tests/preflight.test.mjs) 验证必填、范围、不支持及超限输入，检查输入保持不变。[作用域测试](tests/identity.test.mjs) 验证空数据状态 |
| T04 结果分类 | [管线测试](tests/disposition.test.mjs) 验证普通策略拒绝、Guard、审批拒绝、调度前取消均让模拟工具调用计数保持为零。验证结构化超时和调度后取消记为未知。双服务演示另经 MCP Bridge 验证 `isError` 和成功 |
| T05 建议与恢复 | 两端 SDK、Web 回执各收到五次任务模型请求。模型检查 A 的原错误、B 的历史证据编号及 B 后续调用的结果。卸载对照只收到原错误 |
| T06 事件覆盖 | [管线测试](tests/disposition.test.mjs) 覆盖 Native executor 调用批收到非法 JSON 文本、参数未通过 JSON 快照、无 Agent、未知工具、提前完成。Windows PTC 回执确认真实嵌套调用有工具输出、无 ToolDNA 上下文、SQLite 观测为零 |
| T07 版本与证据 | [作用域测试](tests/identity.test.mjs) 验证并行调用、Schema 与定义代次替换。[存储测试](tests/evidence-store.test.mjs) 验证幂等提交、重启和归档。恢复端按当前定义与条件检查记录 |
| T08 故障降级 | [存储测试](tests/evidence-store.test.mjs) 验证 1,024 条背压、SQLite 写锁、路径错误、未知版本。[插件测试](tests/dsh-pipeline.test.mjs) 验证不可写时保留原失败并报告降级。Ubuntu 使用不可写目录，Windows 使用不可作为目录的路径 |
| T09 脱敏 | [插件测试](tests/dsh-pipeline.test.mjs) 在 SQLite、WAL、查询输出和诊断上下文中检查哨兵。原 DSH 错误保有原文本。插件日志发射点只提供固定原因码 |
| T10 配置与卸载 | [存储测试](tests/evidence-store.test.mjs) 验证超期和超量清理。[插件测试](tests/dsh-pipeline.test.mjs) 验证关闭历史时旧文件保持原样。双平台回执均含 Web、SDK 实际卸载后的模型请求 |
| T11 调度开销 | [基准脚本](demo/benchmark.mjs) 每组预热 50 次、测量 500 次。Windows p50/p95/p99 从 0.0840/0.1759/0.3524 ms 变为 0.1223/0.2449/0.4372 ms，Ubuntu 从 0.0661/0.1840/0.3986 ms 变为 0.1031/0.2737/0.6915 ms。p95 增量分别为 0.0690 ms 与 0.0897 ms，两端丢弃均为 0 |

## 复验命令

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node demo/benchmark.mjs
node demo/verify-package.mjs /path/to/dsh/lib/bin.js ./dsh-tooldna-0.1.0.tgz ./demo/local-receipt.json
```

失败运行包括 Windows Web 初次启动的引导弹窗阻挡、脚本误计 DSH 会话标题生成请求、Linux 缺少系统文档目录、SDK 与 Web 共用测试 home 导致工作区未初始化，以及 Windows PTC 默认工作区 ACL 拒绝。发布脚本为各 profile 分配独立 home，并仅对合成 PTC 测试使用只读模式。通过 OpenAI 适配器发出畸形 JSON 的实验未进入预期的下一模型请求，验收改在该版本 Native 执行器接收原始调用的接口验证。

发布范围为本地 npm bundle 与源码。DSH 为固定的预发行 Host。Ubuntu 测试装载 DSH 时，上游依赖的 npm 审计报告为 74 项 moderate 和 1 项 high。ToolDNA 的测试范围限本地合成服务，支持其他 DSH 版本前应重新执行验收。
