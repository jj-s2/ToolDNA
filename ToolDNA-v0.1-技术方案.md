# ToolDNA v0.1 技术方案

版本 1.0 · 2026-11-22 · 开发与验收基线

ToolDNA 是一个安装到 DeepSeek Harness（DSH）的 MCP 调用诊断插件。它读取当前会话可见的工具，在工具失败时给 Agent 提供可执行的下一步，并保留本地证据供开发者查看。首版的交付标准是一次失败可以被解释、追溯，并通过 Agent 的下一次真实工具调用验证恢复结果。

## 1. 产品范围

| 交付项 | v0.1 行为 | 验收边界 |
| --- | --- | --- |
| 工具发现 | 按当前 Agent 作用域读取已注册的 MCP 工具、名称及输入 Schema | 当前会话可见、以 `mcp__` 命名的 MCP 工具。命名是识别约定，来源未经独立认证 |
| 参数预检 | 支持显式检查。运行时提前识别已知的 Schema 违规，在失败反馈中提供字段级修正建议 | 默认透传调用。Schema 无法验证时返回「未知」 |
| 失败诊断 | 根据可信的 DSH 错误身份、可确认的阶段和 Schema 校验情况生成固定模板建议 | 只有工具调用结果的证据，任务整体是否完成由实际后续结果判断 |
| 能力画像 | 查询工具在本会话中的观测记录、当前有效记录和分组计数 | 空数据展示「未观测」。历史观察注明时间、样本和适用条件 |
| 恢复建议 | 对配置过的等价只读工具，在证据吻合时推荐有限候选 | Agent 另发新调用，继续走 DSH 原有调度和审批 |
| 安装与交付 | 一个预编译的 DSH npm bundle，含可本地安装的 tarball、示例、自动化验收 | Windows x64 与 Linux x64 的 Node.js CLI Web profile，验证 Native 工具调用路径 |

首版使用 TypeScript、Node.js 和本地 SQLite。后续版本再评估 PTC、其他 Host 及 MCP 客户端、跨会话统计、主动探测、图形报告和概率评分。概率评分的启动条件是取得任务结果标签和足量可比较样本，并能与分组计数基线做校准对比。

同生态的 `dsh-mcp-view` 已提供工具清单、Schema 和使用统计。ToolDNA 的发布演示以「解释失败 → 提供依据 → 观察后续调用」为主线。 [dsh-mcp-view 项目说明](https://github.com/stopchewing/dsh-mcp-view)

## 2. 版本与兼容契约

- **Host** 使用 npm 发布的 `@deepseek-ai/dsh@0.2.2-rc.5`。上游标签为 `dsh-v0.2.2-rc.5`，发布页标注提交 `9c2670d`。插件 manifest 初始设置 `"engines": { "dsh": "0.2.2-rc.5", "node": ">=24.9.0 <25" }`。只在实测通过的 DSH 版本加入兼容矩阵。 [npm 包](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.2-rc.5) · [DSH 发布记录](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5) · [CLI 包清单](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/package.json)
- **开发环境** 使用 Node.js 24.18.0 作为首个 CI 基线，依赖以 `pnpm-lock.yaml` 锁定。DSH 共享运行时依赖以实际已发布的包版本声明为 peer 和开发依赖；仅类型导入的包用开发依赖。各 DSH 子包按其发布版本核对，不能把 CLI 版本自动填给每个子包。 [DSH 打包指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/user/develop/basic/publish.md)
- **MCP 接入** 复用 DSH 已挂载的 `@deepseek-ai/dsh-mcp-client`。测试 fixture 使用本机 stdio。工具目录以实际注册结果为准。部署阶段验证所选 Agent 确实使用 Native 执行器，因为不同 preset 可挂载不同执行路径。 [DSH 作用域工具注册表](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/core/tools/src/index.ts) · [DSH MCP Bridge](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/mcp/mcp-client/src/tools.ts)

当前证据为版本发布元数据和固定标签源码。第一个开发里程碑必须补齐打包安装、事件顺序和模型收到建议的运行证据。

## 3. 组件与执行流程

```text
DSH Agent → DSH 工具执行链 → 已安装的 MCP Server
                  │
                  ├─ pre-execute / execute → ToolDNA 记录预检和调度阶段
                  ├─ post-execute          → 诊断上下文进入 Agent 的下一次模型请求
                  └─ result                → 已脱敏观测进入 SQLite 写入队列
                                                 ↑
Agent → tooldna_inspect → 当前作用域目录、预检和历史查询
```

| 模块 | 责任 | 实现位置 |
| --- | --- | --- |
| DSH 适配 | 插件生命周期、事件订阅、作用域解析、结果分类所需的阶段信息 | `src/dsh-plugin.ts` |
| 工具目录与预检 | 每次检查从实际可见定义获取 Schema，缓存稳定 Schema 对象的编译结果，并按内容生成指纹 | `src/dsh-plugin.ts`、`src/preflight.ts` |
| 诊断与恢复 | 错误分类、建议措辞、条件证据和候选工具资格 | `src/diagnosis.ts`、`src/recovery.ts`、`src/dsh-plugin.ts` |
| 证据存储 | 有界队列、Worker 内数据库连接、时间窗口、查询和过期清理 | `src/evidence-store.ts`、`src/sqlite-worker.ts` |
| 交互 | 一个只读 DSH 工具，统一校验参数，返回范围受限的结构化结果 | `src/dsh-plugin.ts` |
| 测试与打包 | 固定版本 DSH、可控 MCP 服务、脚本模型、安装和卸载验证 | `tests/`、`demo/`、`cordis.patch.yml` |

### 3.1 DSH 事件契约

| 接口 | ToolDNA 用法 |
| --- | --- |
| `ctx.tools.definitions(scope, toolSet?)` / `get(name, scope, toolSet?)` | 查询真实注册定义。运行中使用 `exec.agent` 和 `exec.toolSet`。从 `get` 获取的对象身份用于区分同名定义换代 |
| `tools/change` | 标记工具目录已变化。下一次按实际作用域读取。该通知覆盖多个作用域，不能直接用它广播或读取历史 |
| `tools/pre-execute` | 读取本次已解析参数、可见定义和作用域，计算有界的校验摘要。委托给 `next()`，保存可识别的策略结果 |
| `tools/execute` | 标记已进入调度包装段并测量历时，`next()` 只调用一次。包装段开始只证明进入该阶段，不能证明请求已到达远端或已产生副作用 |
| `tools/post-execute` | 保留 `await next()` 的决策；对可解释且符合预算的失败，在允许的决策上追加 `additionalContexts`。保持原始结果、错误身份及其他监听器的决策 |
| `tools/result` | 读取冻结后的最终结果，完成阶段归因并入队。事件回调只保留白名单字段，返回 `undefined` |

插件入口声明 `inject = ['tools']` 并用 Cordis 生命周期注册监听器。目录查询携带当前调用的 `toolSet` 时返回本步骤已准入的定义。没有该参数时可以读取当前作用域注册项，并用 `availability: "registered"` 标记。候选推荐需要 `toolSet`。

阶段数据以 DSH 的 `exec.token` 关联，并在终态清理。使用仅在进程内存在的有界映射，过期条目定时回收。生成证据的唯一入口是终态观测，防止一次调用被三个 Hook 各记一条。缺失阶段信息按未知处理。只采集具备 Agent 的 MCP 调用。取消需要归因，`exec.parent` 存在的 PTC 内部调度和 ToolDNA 自己的工具均跳过。工具调用去重以本次执行的 Token 为准，落盘重试以插件生成的 UUID 为准。 [执行对象与 Token](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/core/tools/src/contracts.ts#L157-L230) · [DSH 事件定义](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/core/tools/src/events.ts) · [DSH 执行管线](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/core/tools/src/pipeline.ts)

在 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap` 声明 `tooldna` 来源，通过 `createUserMessage({ source: { kind: 'tooldna' }, content: [...] })` 生成一条固定模板文本。验收时脚本模型必须在下一次请求里读到该文本。未获准、已取消、无后续请求或绕开 post hook 的调用，依靠 `tooldna_inspect` 查看可获得的诊断。插件自身逻辑出错时沿用 DSH 返回。若 `next()` 抛出，保持 DSH 原有异常传递，单次 Hook 内只委托一次。 [DSH 消息构造和来源类型](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/llm/llm/src/message.ts) · [结果上下文进入 Agent Inbox](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/core/agent-loop/src/agent.ts#L565-L582)

### 3.2 参数预检

1. 使用 Ajv 8，按声明的 Draft 7 或 2020-12 选校验实例。MCP Schema 未声明 `$schema` 时使用 2020-12。初始化时校验所支持的输入 Schema，运行时缓存编译结果。关闭类型转换、默认值填充和字段删除。 [MCP 工具 Schema 约定](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool) · [Ajv 选项](https://ajv.js.org/options.html)
2. v0.1 支持对象和数组基本结构、`required`、`type`、`enum`、`const`、数字或长度范围、`additionalProperties`。对超出支持子集的校验词、远程引用、正则 `pattern` 或编译失败返回 `unavailable`。不加载外部 Schema。Schema 和检查输入各限 32 KiB、嵌套深度 16。超限只跳过 ToolDNA 校验。
3. 结果为 `valid`、`invalid`、`unavailable` 之一。`invalid` 最多给出三条字段级规则，输出安全字段名和关键词，无原始值或 Schema 自定义错误正文。显式 `check` 仅评估传入参数。运行时检查为建议模式，即使发现错误，也保持原调用走完 DSH 原有流程。
4. 证据分组可使用显式配置的低敏感度数值参数桶。没有可验证的条件输入时，只提供工具级观测。远端文件路径无法提供实际文件大小，不能把文件名、扩展名或 `max_size` 参数当成实测值。

### 3.3 失败分类与建议

先按阶段及已验证的 DSH 错误身份分类，再结合 Schema 校验信号。`INVALID_ARGS` 等具体映射以固定版本夹具断言为准。该版本的 MCP Bridge 会在部分分支抛出普通 `Error`，导致业务失败、传输失败或上游策略的详细类型不一定还在。无结构化来源时默认保留 `UNCLASSIFIED_ERROR`，当前没有确认远端拒绝原因。 [固定版本 MCP 错误归一化](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/mcp/mcp-client/src/tools.ts#L144-L156) · [MCP isError 投影](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/mcp/mcp-client/src/tools.ts#L286-L313)

| ToolDNA 分类 | 判定 | Agent 下一步 |
| --- | --- | --- |
| `INVALID_INPUT` | 可信参数错误码，或调用失败且本次 Schema 校验找到明确违规。后一种注明是校验发现 | 检查具体字段，构造修正后的新调用 |
| `NOT_DISPATCHED` | 阶段与可信信号证明被策略拒绝、审批拒绝或在调度前取消 | 保留原审批结果，授权问题由当前用户和 DSH 权限配置处理 |
| `TRANSPORT_UNCERTAIN` | 可确认的超时、连接失败或调度阶段进入后的取消，远端状态未知 | 优先核实业务状态。可写工具和副作用未知的工具尤需核实 |
| `ACCESS_DENIED`、`RATE_LIMITED` | 本版本中可验证的正向结构化信号。文本相似性不足以触发 | 分别检查账户权限、当前配额或可信的等待信息 |
| `UNCLASSIFIED_ERROR` | 失败但原因信号不足。可附「同条件下多次观察到失败」 | 查看工具状态或使用明确配对且已有相同条件成功证据的候选 |
| `SUCCESS` | DSH 最终返回成功，且有对应调度包装段 | 计入「调用返回成功」，由后续任务结果判断是否达成目标 |

自动诊断每次调用最多一条，文本限 512 字符。同一 Agent 在滚动 10 秒内最多附加三条，批量失败的其余条目可以查询。诊断只引用已提交且当前有效的历史证据。本次失败的建议可以使用本次已知情况，即使尚无落盘记录。只在失败时自动附加内容，历史证据的预先查看由 `check` 入口提供。

### 3.4 候选工具资格

默认替代表为空。开发者针对两个已知等价的只读工具配置有向替代规则，确认它们处理同一数据集和输入语义。使用完整公开工具名，配置只作用于标准 MCP 客户端注册的全局定义。候选必须在当前 Agent 作用域可见，运行时检查还要在本步骤的 `toolSet` 中获准；缩小为相同参数约定，候选 Schema 必须验证本次参数；历史辅助推荐要求候选在本会话、当前定义和相同条件至少存在一次成功记录。存在已观测失败时一并显示，不能据一次成功保证后续结果。

访问拒绝、调度前阻断、超时可能产生副作用等情况按原分类处理。MCP 的 `readOnlyHint` 和 `idempotentHint` 只作描述，无法授予替换或重试权限。建议最多列一个候选及证据编号。找不到匹配证据时，显示「暂无经过观测验证的候选」。 [MCP 对工具注解的约束](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool)

## 4. 证据数据与存储

### 4.1 作用域与有效性

- 数据库路径固定为 `<ctx.profileContext.dir>/tooldna/evidence.sqlite3`。配置只作用于当前 profile。缺失可信 profile 路径或启动时目录不可写，历史存储降级，实时诊断继续工作。 [DSH ProfileContext 定义](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/app-boot/src/profile-context.ts#L11-L32)
- `session_key` 取数据库随机盐对 `exec.agent.id` 做 HMAC-SHA256。查询从当前 Agent 推导，不接受任意 session 参数。会话恢复复用该 ID 时可回读，子 Agent 和新会话使用各自键。此隔离针对 ToolDNA 的 Agent 接口，同一操作系统账户持有数据库时可读其文件。 [DSH Agent Session 身份](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/core/agent/src/types.ts#L12-L16)
- 工具身份使用完整公开名。将输入 Schema 按对象键排序、保留数组顺序后做 SHA-256。以「本次插件启动 ID + 注册定义的对象身份」生成 `definition_epoch`。在调用开始锁定定义与指纹，工具更新后旧观测继续归原版本，无法关联定义的结果仅记为未知阶段且不参与建议。
- **当前有效证据** 需要同一 profile、会话、公开名、Schema 指纹、定义代次和特征规则版本。服务器重连导致定义重新注册时，旧代次归档。Host 重启后原记录仍可在恢复的会话内查到，自动推荐从新代次重新积累。这个选择覆盖同名同 Schema 的服务端或权限变化无法可靠识别的情形。

### 4.2 数据结构

| 表 | 字段 |
| --- | --- |
| `store_meta` | `key TEXT PRIMARY KEY`、`value TEXT`，保存本库随机盐等存储元数据 |
| `observations` | `id TEXT PRIMARY KEY`（插件生成 UUID）、`session_key TEXT`、`tool_name TEXT`、`schema_hash TEXT NULL`、`definition_epoch TEXT NULL`、`observed_at_ms INTEGER`、`dispatch_ms INTEGER NULL`、`dispatch_seen INTEGER`、`host_status TEXT`、`diagnosis_code TEXT`、`error_code TEXT NULL`（已验证允许列表）、`feature_key TEXT NULL`、`feature_bucket INTEGER NULL` |

按 `(session_key, tool_name, schema_hash, definition_epoch, observed_at_ms)` 和 `(observed_at_ms, id)` 建索引。事件从锁定快照构建，分别记录观测状态和诊断推断。`host_status` 按顺序判定为已证实未调度的 `not_dispatched`，超时、调度中取消或无足够阶段依据的 `uncertain`，以及剩余可确认调度的最终 `success` 或 `error`。后一类 `error` 仅表示 DSH 返回错误，远端根因可能仍是未知。同一工具查询分别返回四类计数。以当前有效记录为默认视图，归档记录在同一会话内按明确请求读取。实时建议仅引用当前视图中可见的记录。

条件桶配置为某工具的低敏感度数值参数名与最多四个有限、递增的边界。桶号从 0 开始，计数规则为严格小于当前输入值的边界数。`[20]` 把 20 分到桶 0，21 分到桶 1。负载中只保存规则指纹和区间编号。条件未知时跳过分桶。首版以三次及以上同条件、同一错误类的已观测失败作为显示「多次失败」提示的产品阈值，同时展示该条件下的成功数和失败数。计数反映调用次数，重复调用之间可能相关。

### 4.3 生命周期与故障处理

- SQLite 使用 Node.js 内置 `node:sqlite`。每个插件实例一个 Worker，Worker 持有连接并使用准备语句、WAL、100 ms busy timeout。主线程向有界队列投递经白名单投影的记录，最多缓存 1,024 条。每批最多 64 条，约每 50 ms 刷新，批写入用事务及主键幂等去重。超过队列容量时丢弃新记录并更新当前会话的降级状态。 [Node.js SQLite API](https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html)
- 主线程接收 Worker 提交确认后更新近期记录缓存。Worker 同步返回裁剪的记录 ID，主线程清理缓存对应项，读取时过滤超期和旧代次。post hook 只查询已有缓存，预检和观测链路不等待写盘。显式查询通过 Worker 查询历史，按查询之前已入队的观测完成写入后取快照。250 ms 预算内响应，超时返回 `degraded` 并注明证据可能不完整。范围、数量和总输出分开限制。
- 首次启动初始化 `PRAGMA user_version = 1`。未来迁移逐版本在事务中执行。遇到未知新版本、I/O 错误或损坏进入降级，记录原因代码，保护原数据库。运行中先把 SQLite 写满、锁冲突等情况纳入隔离测试。停用或热卸载时先停止接收新观测，最多等待 1 秒刷盘，再释放 Worker 和所有监听器。
- 默认保留 30 天且每 profile 最多 10,000 条。启动、成功批写入后到达清理间隔或显式查询时触发清理，按时间和 ID 稳定裁剪。查询本身应用时间窗口，超期记录等待物理清理期间也不会出现在响应里。`historyEnabled: false` 时停止历史读写，实时诊断可独立使用。清除历史是本地运维操作，先停 Host，再处理该 profile 的 ToolDNA 数据目录。

### 4.4 数据保护

ToolDNA 不保存或导出原始调用参数、输出正文、异常堆栈、服务器 URL、文件路径、请求头、环境变量或凭据。错误文本只用于 DSH 本身的结果，ToolDNA 仅处理可校验的错误身份和固定模板。查询、日志及演示产物同样使用白名单字段。插件不会发出自有遥测或外部请求。DSH 自身的会话日志和模型请求遵循 DSH 的设置，ToolDNA 本地存储开关只控制插件自己的副本。

## 5. 用户接口与配置

首版对 Agent 注册一个 `tooldna_inspect` 工具，输入按下表校验。执行时再次读取调用者作用域。所有列表稳定排序，默认 10 条，单次上限 25 条。输出使用结构化 JSON，另有一行中文摘要，总输出预算 8 KiB。超预算时保留状态、分类和最多三条证据，用 `truncated` 标记结果有截断。

| 操作 | 参数 | 返回要点 |
| --- | --- | --- |
| `list` | 可选 `limit` | 当前可见的 MCP 工具名、Schema 指纹和证据状态 |
| `history` | `tool`、可选 `includeArchived` 和 `limit` | 当前会话计数、按时间倒序证据编号、条件桶、错误分类、当前或归档状态 |
| `check` | `tool`、`argumentsJson`（JSON 对象文本） | 校验结论、字段规则、当前适用的历史风险提示和已验证可用的候选 |

响应公共字段为 `version: 1`、`op`、`status`、`truncated`。操作成功用 `ok`。工具不可见或调用者缺少 Agent 时用 `tool_unavailable`。请求当前工具历史且没有观测用 `no_observations`。请求依赖历史但存储故障时用 `degraded`。关闭历史时用 `history_disabled`，仍可返回 Schema 校验。参数格式错误用 `invalid_request`。校验结论用操作自己的 `validation` 字段，避免把无历史、日志不可用或工具调用结果混为一类。API 返回值不含路径、会话键和别的会话记录。调用者提供的 `argumentsJson` 仍会经过 DSH 正常的工具调用日志，使用方式和隐私边界在 README 说明。

以下是 `check` 的合成响应示例，表示操作成功执行，但被检查的参数越界。

```json
{
  "version": 1,
  "op": "check",
  "status": "ok",
  "truncated": false,
  "tool": "mcp__pdf_a__read_pdf",
  "validation": "invalid",
  "issues": [{ "field": "maxPages", "keyword": "maximum" }],
  "evidenceIds": [],
  "candidate": null
}
```

配置用 DSH plugin Config 校验。默认启用本地历史、30 天与 10,000 条上限，条件规则和候选列表为空。以下仅为本地合成演示的 profile patch，生产配置使用实际可见工具的完整名称。

```yaml
- id: tooldna
  config:
    historyEnabled: true
    retentionDays: 30
    maxEvents: 10000
    conditionRules:
      - tool: mcp__pdf_a__read_pdf
        numericField: maxPages
        cutoffs: [20]
      - tool: mcp__pdf_b__read_pdf
        numericField: maxPages
        cutoffs: [20]
    readOnlyAlternatives:
      - from: mcp__pdf_a__read_pdf
        to: mcp__pdf_b__read_pdf
```

同一条配对规则的数值字段和区间边界必须一致，比较区间时采用相同字段及分桶约定。条件规则变更后会生成不同的特征版本，旧条件桶归档。没有设置共同条件时，首版只显示工具级观测和显式配对关系。真实工具的同等访问条件仍由实际后续调用和 DSH 的授权检查决定。

## 6. 安装、发布和回滚

插件包名暂定 `dsh-tooldna`。发布前确认 npm 名称归属。包内含 ESM 编译产物、`dsh.bundle.patch` 指向的 `cordis.patch.yml`、README、LICENSE 和必要类型文件。包入口 `exports["."]` 指向 `./dist/dsh-plugin.js`，Worker 文件随包发布。由 `pnpm install --frozen-lockfile`、类型检查、测试、构建和 `pnpm pack` 生成 tarball，再从干净环境安装。 [DSH 插件发布方式](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/user/develop/basic/publish.md)

```yaml
- insert:
    - id: tooldna
      name: dsh-tooldna
```

### 6.1 干净环境的验证命令

在新的终端进程执行。PowerShell 示例为 CI 流程，步骤执行的前提是插件已构建出 tarball 且当前 PATH 可找到 pnpm。Linux 脚本用相同的固定包版本及隔离规则。

```powershell
$env:DSH_HOME = Join-Path ([IO.Path]::GetTempPath()) ("tooldna-" + [guid]::NewGuid())
$env:DSH_TELEMETRY_DISABLED = "1"
$dshSpec = "@deepseek-ai/dsh@0.2.2-rc.5"
$bundle = (Resolve-Path ".\dsh-tooldna-0.1.0.tgz").Path
npm.cmd exec --yes --package=$dshSpec -- dsh --version
npm.cmd exec --yes --package=$dshSpec -- dsh --profile web --dump-default-config
npm.cmd exec --yes --package=$dshSpec -- dsh plugin --profile web add $bundle
npm.cmd exec --yes --package=$dshSpec -- dsh --profile web --dump-config
```

接着由集成脚本挂载两个测试 MCP Server，本机回环启动 DSH Web Host，选用 Native preset，连接脚本模型并完成调用矩阵。`--dump-config` 中有插件行只证明配置合成，实际启动与调用是另外两项验收。正式包验证也从新 DSH home 运行。卸载通过 `dsh plugin --profile web remove <实际包名>`，重启后检查 ToolDNA 查询工具消失、原 MCP 工具仍可用。需要回滚版本时安装上一个已验收的精确 tarball。数据库不兼容时降级并保留原库，数据清理由本地操作者执行。 [DSH CLI 与 profile 规则](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/reference/README.md)

## 7. 测试与验收

### 7.1 可复现实验环境与演示

两台本地模拟 MCP 服务暴露相同原始工具名 `read_pdf`，并读取同一组合成文档。输入含固定测试文档 ID 与请求页数 `maxPages`。服务 A 接受 Schema 范围内的参数，但对超过 20 页的请求返回 `isError`；服务 B 对同一请求返回夹具的预期内容。这个结果说明演示路径可复现，不能外推真实 PDF 服务能力。

脚本模型是绑定在本机回环地址的测试 HTTP 服务。由 Web profile 的自定义 OpenAI Chat Completions provider 访问，返回确定性的流式工具调用，拦收下一次模型请求用于断言。用浏览器自动化向 Native preset 发出测试输入。先调用 B 获得同条件的观测并等待其可查，再触发 A 失败。脚本模型只有在下一次请求检测到 ToolDNA 的预期提示和 B 的证据编号时才发起对 B 的新调用，并校验 B 返回的内容。另跑关闭 ToolDNA 的同夹具对照，用于确认诊断确由插件注入。若后续需要评估 Agent 整体任务表现，使用固定模型、权限和任务集记录任务完成、额外调用、错误建议及回退结果。 [DSH 自定义模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/user/guide/providers.md)

### 7.2 必过用例

| 编号 | 场景 | 通过条件 |
| --- | --- | --- |
| T01 | 干净安装与启动 | 两个平台从 tarball 安装成功。固定 DSH 版本启动，`tooldna_inspect` 可调用 |
| T02 | 同名工具与可见性 | A、B 公开名独立；受限定义与其他会话的观测不出现在查询结果；候选在当前步骤披露范围内 |
| T03 | 首次调用与预检 | 空库为「未观测」。缺参、错误类型、范围违规可定位字段；不支持的 Schema 返回 `unavailable`；值及原调用保持原样 |
| T04 | 最终结果分类 | 验证成功、MCP `isError`、普通 Error、策略拒绝、审批拒绝、超时、调度前取消和进入调度后取消。用 mock server 收到的请求数证明未执行分支。观察不到的阶段标记未知 |
| T05 | 建议送达与恢复 | 脚本模型捕获下一次输入并验证原工具错误和插件上下文；新调用走原 DSH 调度；通过 B 输出验证任务动作完成 |
| T06 | 事件覆盖 | 畸形 JSON、无 Agent 调用、PTC、未知工具、提前结束结果逐个形成实测覆盖表。PTC 内调用不写入 v0.1 统计，不影响原工具结果 |
| T07 | 证据稳定性 | 并行同名调用各自关联一次；Schema 更换、同 Schema 重注册及重启后，旧证据只能按本会话查询归档，不能用于新代次推荐 |
| T08 | 状态与故障 | 队列背压、只读目录、SQLite 锁和版本异常时，DSH 工具照常完成或返回原失败。能查询到降级状态或看到一次性本地原因代码 |
| T09 | 脱敏 | 在 fixture 注入哨兵 token、路径、URL 和结果文本，扫描数据库、WAL、插件日志、查询响应与插件注入上下文，均无哨兵值。DSH 自身日志单独管理 |
| T10 | 配置与卸载 | 小窗口触发保留清理；关闭历史停止插件读写；卸载并重启后插件工具消失，基线 MCP 结果语义一致 |
| T11 | 调度开销 | 本地固定 fixture，分别开关插件，预热 50 次，再各执行至少 500 次。记录 p50、p95、p99 和丢弃数。首版目标为增量 p95 ≤ 10 ms、正常负载丢弃数为零 |

测试用例断言要覆盖挂钩报错时 `next()` 不被调用两次，以及恢复建议不会触发额外的 ToolDNA 发起的业务调用。集成结果保留 DSH 和 Node 版本、OS、比较组、锁文件与 tarball 哈希、测试命令、夹具版本、各用例状态和已有失败。CI 禁用真实服务凭据并保留原始 fixture 回执。涉及跨平台的支持声明只写已完成安装与集成验证的平台。

## 8. 开发顺序与交付门槛

| 阶段 | 实现任务 | 完成条件 |
| --- | --- | --- |
| M0 接入验证 | 初始化单包，固定 DSH，最小 bundle 和双 MCP fixture。实现一次最小 post hook 反馈 | 干净 profile 确实加载插件，访问两项同名工具；脚本模型下一次收到诊断；记录各阶段结果及结构化错误实际可用范围 |
| M1 诊断 | 作用域目录、`tooldna_inspect`、预检、失败分类及上下文模板，定义生命周期 | T02–T06 通过；MCP 结构化信号缺失时归为未知，显示可追溯建议 |
| M2 证据 | SQLite、脱敏、保留窗口、重启回读、候选配置和故障降级 | T05、T07–T10 通过，数据和策略隔离可复验 |
| M3 发布候选 | 跨平台安装、性能测量、README、模拟 Demo 和卸载验证 | T01–T11 通过，生成版本、哈希和运行回执；可下载 tarball 支持干净安装 |

M0 优先验证反馈路径，路径通过后再编写持久化和候选推荐。若固定版本无法把 post 上下文送到预期下一次请求，保留查询型诊断并记录实测证据，等兼容路径重新通过后才宣称支持自动反馈。若 DSH 版本、输出类型或插件安装方式改变，先更新 M0 兼容矩阵，再重跑相应发布用例。

发布版交付源码与锁文件、已构建的 tarball、Git tag、README、双服务演示脚本和验收记录。README 首页演示插件如何处理一次已发生的失败，安装、权限和证据边界与使用示例一起呈现。

## 9. 后续版本入口

- 第二个 Host 复用独立的预检、诊断和存储模块。接入先证明工具身份、终态、隔离范围和建议送达可与 v0.1 用例对应，再承诺支持。
- 主动探测从自有本地 fixture 的契约测试开始。真实服务扩展需单独确定权限、数据和副作用边界，再制定目标服务的验收计划。
- 跨会话画像需要可稳定验证的服务实例、凭据及权限作用域标识，并提供用户可控的数据范围。概率模型需先证明对下一步建议有增益，算法可在独立实验中选择。
