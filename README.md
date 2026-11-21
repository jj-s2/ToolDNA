# ToolDNA for DeepSeek Harness

ToolDNA 在 MCP 调用失败时向 Agent 提供诊断，并在当前 profile 中保留结构化证据。Agent 可以通过 `tooldna_inspect` 查看当前可见的工具、检查参数或查询这次会话的观测记录。

## 安装

开发与测试基线为 Node.js 24.18.0、DSH 0.2.2-rc.5 和 pnpm 11。构建后从本地 tarball 安装。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm pack
dsh plugin --profile web add ./dsh-tooldna-0.1.0.tgz
```

重新启动 Web profile 并使用 Native preset。卸载命令为 `dsh plugin --profile web remove dsh-tooldna`，之后重启 profile。卸载后如需清理历史，可在停止 Host 后处理该 profile 下的 `tooldna` 目录。

## 在 Agent 中使用

- `{"op":"list"}` 查看作用域内的 MCP 工具。
- `{"op":"check","tool":"mcp__pdf_a__read_pdf","argumentsJson":"{\"documentId\":\"demo\",\"maxPages\":21}"}` 检查参数并查看同条件证据。
- `{"op":"history","tool":"mcp__pdf_a__read_pdf","includeArchived":true}` 查询当前会话的历史。默认只查询当前工具定义下的观测。

插件通过当前 Agent 和步骤权限查询工具。只有显式配置的只读等价候选才参与推荐，而且需要本会话的同条件成功记录。推荐由 Agent 另发调用，并继续受 DSH 权限检查约束。远端执行状态未知时应先核实业务结果。

## 本地证据

默认保存 30 天、每 profile 最多 10,000 条，位置为 `<profile>/tooldna/evidence.sqlite3`。在 `id: tooldna` 的配置中设置 `historyEnabled: false` 可关闭历史读写。ToolDNA 只保存调用状态、工具身份和指定数值参数的区间等元数据。DSH 自己的日志可能保存正常的工具参数和结果，其中包括传给 `check` 的内容。

## 本地联调

`demo/` 中的两个 stdio MCP 服务只返回合成 PDF 数据。SDK 联调脚本在本机启动一个固定响应的模型服务。它先调用 B 获取一个成功观测，再触发 A 失败，检查下一条模型请求里的建议是否引用 B 的证据，最后验证 B 的后续结果。

```sh
node demo/verify-sdk.mjs /absolute/path/to/dsh/lib/bin.js /absolute/path/to/isolated-dsh-home
```

隔离目录的 `sdk` profile 需先安装本项目 tarball。末尾加 `--web` 则从实际 Web 界面执行同一组用例，安装目标也改为 `web`。使用 `--control` 及未装插件的对应 profile，运行无插件对照。Windows Web 测试使用 Edge，Linux Web 测试使用 Playwright Chromium。

Linux 可用 `bash demo/run-linux-sdk.sh` 从干净 profile 执行安装、联调和卸载回归。运行 `pnpm exec playwright install chromium --only-shell` 后，以 `TOOLDNA_VERIFY_WEB=1 bash demo/run-linux-sdk.sh` 加测 Web 路径。调度开销通过 `pnpm build && node demo/benchmark.mjs` 测量。

完整实现契约和发布验收见 [ToolDNA v0.1 技术方案](./ToolDNA-v0.1-技术方案.md)。
