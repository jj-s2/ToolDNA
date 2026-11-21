# 在 Codex 和 Claude Code 中使用 ToolDNA

Codex 和 Claude Code 都可以把 ToolDNA 加为本地 MCP Server，为本地工具、自定义函数、Shell 和 HTTP API 做参数预检与显式诊断。Claude Code 还可以配置项目 Hook，对宿主交付事件的内置工具及 MCP 工具自动补充诊断。

## 构建和安装

使用 Node.js 24，在 ToolDNA 源码目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm build
codex mcp add tooldna -- node "D:/AItools/ToolDNA/dist/host-mcp.js"
claude mcp add --scope user tooldna -- node "D:/AItools/ToolDNA/dist/host-mcp.js"
```

重新打开客户端后，Agent 可调用 `tooldna` 的 `check_arguments` 或 `diagnose_failure`。例如直接传 `{"exitCode":7}` 诊断 CLI，或传 `{"httpStatus":429}` 诊断 API 限流。MCP Server 本身只处理显式输入。卸载使用对应客户端的 `mcp remove`。

## 可选的自动诊断 Hook

```powershell
node dist/host-config.js claude "D:/路径/开发项目" --write
```

Claude 配置写到 `.claude/settings.local.json`。文件存在时，去掉 `--write` 生成配置片段，再把 ToolDNA 的事件组添加到对应的 `hooks` 数组。已装过仅匹配 `mcp__` 的旧 Hook 时，只替换对应的 ToolDNA 项。Windows Hook 通过 PATH 查找 Node.js。重新启动会话，按客户端提示审查并信任 Hook。把项目下的 `.tooldna/` 和本机 Hook 配置排除在版本控制之外。

生成器也能输出 Codex 的 `.codex/hooks.json`。该接入在合成事件测试中可用，但本机 Codex CLI 0.159.0 的真实 MCP 调用未观察到这个 Hook 触发，因此 Codex 当前推荐采用上述 MCP 安装方式。

## 功能边界

- Codex Hook 接收客户端交付的 `PostToolUse`。支持识别结构化 MCP 结果和已知的 Shell 退出状态。缺少可靠结果状态的调用记为未知。托管工具如 WebSearch 不走这条本地事件路径。
- Claude Code 用 `PostToolUse`、`PostToolUseFailure` 观察内置和 MCP 工具。已实测 Bash 退出码和 MCP 执行失败的诊断。PowerShell 同样识别受支持的失败格式。自动审批拒绝用 `PermissionDenied` 记录为未执行。已知中断时提示先核实操作状态。
- 诊断通过 `additionalContext` 返回给模型。插件本身不发起替代调用。证据默认保留 30 天、最多 10,000 条，保存在项目下的 `.tooldna/host-evidence.sqlite3`。证据按客户端和会话隔离；若客户端提供 Agent ID，也按该 ID 隔离。
- 两种 Hook 都没有 DSH 的完整工具注册表视图。字段级诊断使用本地配置提供的 Schema；候选名称由当前 Agent 再确认是否可用及已授权。

## 可选的 Schema 与恢复配置

在目标项目创建 `tooldna.hosts.json`。以下均是示例工具名，需替换成客户端实际暴露的名称。只为同数据、同语义的只读工具配置候选；工具实例、凭据或权限变化时更新 `generation`。

```json
{
  "generation": "example-v1",
  "schemas": {
    "mcp__pdf_a__read_pdf": {"type":"object","required":["maxPages"],"properties":{"maxPages":{"type":"integer"}}},
    "mcp__pdf_b__read_pdf": {"type":"object","required":["maxPages"],"properties":{"maxPages":{"type":"integer"}}}
  },
  "conditions": {
    "mcp__pdf_a__read_pdf": {"field":"maxPages","cutoffs":[20]},
    "mcp__pdf_b__read_pdf": {"field":"maxPages","cutoffs":[20]}
  },
  "readOnlyAlternatives": {
    "mcp__pdf_a__read_pdf": "mcp__pdf_b__read_pdf"
  }
}
```

候选提示要求当前会话同分桶已有成功观察，且两项已配置 Schema 都接受原参数。原始入参、错误正文和工具返回内容不会写入 ToolDNA 的证据库。

可在配置中通过 `includeTools` 或 `excludeTools` 按工具名筛选 Hook 的观测范围。自定义工具若返回稳定的状态字段，可加 `outcomes`，例如 `{"outcomes":{"my_fetch":{"kind":"httpStatus","field":"statusCode"}}}`。支持 `httpStatus`、`exitCode` 和 `successFlag`。只读取声明的顶层字段，缺失或不符类型记为未知。

参考：[Codex Hooks](https://developers.openai.com/codex/hooks) · [Claude Code Hooks](https://code.claude.com/docs/en/hooks)

## 本地联调

Codex CLI 0.159.0 和 Claude Code 2.1.330 均通过真实 CLI 加载 MCP Server 并将字段级预检结果送到下一次模型请求的测试。Claude Code 另通过真实 MCP 失败触发 Hook、注入建议和 SQLite 落盘测试。联调仅使用本地模拟模型，不使用账户凭据。

```powershell
node demo/verify-codex-mcp.mjs "C:/路径/codex/bin/codex.js"
node demo/verify-claude-mcp.mjs "C:/路径/claude.exe"
node demo/verify-claude-mcp.mjs "C:/路径/claude.exe" --hook
node demo/verify-claude-mcp.mjs "C:/路径/claude.exe" --shell
```
