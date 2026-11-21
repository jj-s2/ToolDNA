# ToolDNA

**工具调用失败后，让 Agent 知道下一步该怎么做。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Status: Preview](https://img.shields.io/badge/status-developer%20preview-orange)](#支持范围)

[快速安装](#快速安装) · [交给 AI 安装](#交给-ai-安装) · [支持范围](#支持范围) · [验收与复现](#验收与复现) · [v0.2.0 预览版](https://github.com/jj-s2/ToolDNA/releases/tag/v0.2.0)

ToolDNA 为 **Codex、Claude Code 和 DeepSeek Harness** 提供工具参数预检和失败诊断。支持按宿主事件观察内置工具与 MCP 工具，也可以显式诊断 API 状态和 CLI 退出码。对于已配置的等价只读工具，ToolDNA 可以引用同一会话的成功记录，给出有证据的替代建议。

> **例子**　PDF 工具 A 读取失败。ToolDNA 查到工具 B 在同一条件下读成功过，于是把 B 和证据编号提供给 Agent。Agent 确认 B 可用后，通过宿主正常的权限检查发起下一次调用。

## 快速安装

环境要求为 Git、Node.js 24（至少 24.9）和 pnpm 11。

```sh
git clone https://github.com/jj-s2/ToolDNA.git
cd ToolDNA
pnpm install --frozen-lockfile
pnpm build
```

**Codex / Claude Code**　选用自己的客户端命令。将示例路径替换成上面克隆目录的绝对路径。

```sh
codex mcp add tooldna -- node "/absolute/path/to/ToolDNA/dist/host-mcp.js"
claude mcp add --scope user tooldna -- node "/absolute/path/to/ToolDNA/dist/host-mcp.js"
```

打开新会话，试着说：「调用 ToolDNA，检查 `maxPages=21` 是否符合整数且上限 20 的 Schema。」预期输出为 `invalid`，字段为 `maxPages`，约束为 `maximum`。

**DeepSeek Harness（DSH）**　已验证 `0.2.2-rc.5`。可从发布页下载 `dsh-tooldna-0.2.0.tgz`，也可以在完成上面的构建后运行 `pnpm pack`。将安装包装到要使用的 profile。

```sh
dsh plugin --profile web add ./dsh-tooldna-0.2.0.tgz
```

重启 DSH 并进入 Native preset。配置等价工具或卸载的方法见 [DSH 使用说明](DSH.md)。Claude Code 项目 Hook 和示例配置见 [跨客户端接入](HOSTS.md)。

## 交给 AI 安装

把下面这段复制给 **有本机终端和文件权限的 Codex 或 Claude Code**。如有指定的宿主、目标项目或安装位置，可以直接在提示词首行补上。

```text
请在这台机器上为我安装 ToolDNA，并实际完成验证。仓库是 https://github.com/jj-s2/ToolDNA 。

1. 确认我当前使用的客户端（Codex、Claude Code 或 DeepSeek Harness）、操作系统及安装范围。优先只装到当前客户端。先检查 git、Node.js 24（至少 24.9）和 pnpm 11 是否可用。若需要安装系统依赖或扩大配置范围，先告诉我。
2. 克隆到持久目录，例如当前用户的 tools 目录。若已有 ToolDNA checkout，核实 remote 和本地修改，保留已有文件。记录本次安装的 commit SHA。执行 pnpm install --frozen-lockfile 和 pnpm build。
3. Codex 或 Claude Code 使用本仓库 HOSTS.md 的 MCP 安装命令，把 dist/host-mcp.js 替换为这次构建的绝对路径。先检查是否已有同名 tooldna 配置；若指向别的程序，暂停并说明冲突。Claude Code 若需要自动失败诊断，再按 HOSTS.md 为目标项目安装 Hook，并保留已有 hooks。若客户端需要我在界面信任 Hook，告诉我准确的界面操作。
4. 如果目标是 DSH，仅在已验收的 0.2.2-rc.5 上执行。运行 pnpm pack，把生成的 tarball 安装到我使用的 profile，并按 DSH.md 验证。发现其他版本时保留现有 DSH，并告诉我兼容状态。
5. 用客户端确认 tooldna 已注册。能开启新会话时，调用 ToolDNA 检查 maxPages=21 与最大值 20 的输入 Schema，确认返回 invalid 和 maximum。若当前会话不能刷新 MCP 工具，只报告注册已验证，并说明如何在新会话验证实际调用。
6. 最后简短列出安装位置、修改的配置、验证结果以及卸载命令。请直接在终端执行安装，不要只给我命令。
```

## 支持范围

| 宿主 | 怎么接入 | 已验证能力 |
| --- | --- | --- |
| Codex CLI `0.159.0` | 本地 MCP Server | 参数预检和显式诊断 |
| Claude Code `2.1.330` | 本地 MCP Server，可选项目 Hook | 参数预检、显式诊断、Bash 与 MCP 自动失败建议、本地证据 |
| DSH `0.2.2-rc.5` | DSH bundle | 内置及 MCP 工具目录与诊断、会话历史、PTC 子调用、基于证据的恢复建议 |

Codex 的自动诊断 Hook 尚未通过真实客户端验证。DSH 和 Claude Code 的证据存储按会话隔离，默认保留 30 天，最多 10,000 条。ToolDNA 不把调用实参、错误正文或工具输出写入自己的证据库；宿主日志遵循宿主设置。

## 验收与复现

```sh
pnpm test
```

- [DSH v0.1.0 历史验收](ACCEPTANCE.md)覆盖 Windows x64 和 Ubuntu 22.04（WSL2）的安装、恢复与卸载。当前版本的验证范围见发布页。
- [Codex 和 Claude Code 联调](HOSTS.md#本地联调)使用真实 CLI 和本地模拟模型。
- [技术方案](ToolDNA-v0.1-技术方案.md)记载数据边界、诊断规则和验收门槛。

这是开发者预览版。跨客户端联调使用本地合成工具，DSH 上游依赖审计见验收报告。

## License

[MIT](LICENSE)
