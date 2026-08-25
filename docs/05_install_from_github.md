# 05 · 让 AI agent 从 GitHub 直接安装 devmap（MCP）

> 目标：Codex / CodeBuddy / WorkBuddy / VS Code（以及 Claude Desktop / Cursor / Cline）都能**从 GitHub 直接**把 devmap 装成 MCP server，无需先 `npm i -g`、无需手动下载。
> 配套：CodeBuddy / WorkBuddy 还可安装 `skill/devmap` 这个**技能**（见 §4）。

---

## 1. 两条 GitHub-direct 命令（核心）

devmap 的 npm 包是**零依赖单文件 bundle**，且根仓库的 `bin/devmap.js` 已提交同一份 bundle。因此任何 agent 只要能跑 `npx` 或 `bunx`，就能**直接拉 GitHub 仓库运行**，不依赖全局安装：

| 运行时不带 bun（Codex / Claude Desktop 默认 node） | 带 bun（CodeBuddy / WorkBuddy / 多数 agent） |
|---|---|
| `npx github:StevenLOL/devmap --mcp` | `bunx github:StevenLOL/devmap --mcp` |
| 也可用 npm 镜像（由本仓库发布）：`npx -y devmap --mcp` | 同左 `npx -y devmap --mcp` |

> `npx github:<owner>/<repo>` / `bunx github:<owner>/<repo>` 会克隆仓库、跑 `bin` 指向的可执行文件。根 `package.json` 的 `bin.devmap` 现已指向 `bin/devmap.js`（node 可直接跑的 ESM bundle，shebang `#!/usr/bin/env node`），所以**纯 node 环境也能从 GitHub 直跑**。
>
> ⚠️ 前置：以上命令需在**能访问 github.com** 的网络下执行（首次会 clone 到本地缓存）。本机若被只读代理（如 WattToolkit）挡 github 写操作，只影响 `git push`，不影响 agent 侧的 `npx/bunx github:` 拉取。

---

## 2. 各 agent 配置片段

通用 MCP server 块（stdio，命令二选一）：

```jsonc
{
  "mcpServers": {
    "devmap": {
      "command": "bunx",                       // 或 "npx"
      "args": ["github:StevenLOL/devmap", "--mcp"]
      // 若用 npm 镜像："command": "npx", "args": ["-y", "devmap", "--mcp"]
    }
  }
}
```

### 2.1 Codex（OpenAI）— `~/.codex/config.toml`
```toml
[mcp_servers.devmap]
command = "bunx"
args = ["github:StevenLOL/devmap", "--mcp"]
# 无 bun 时改用：
# command = "npx"
# args = ["github:StevenLOL/devmap", "--mcp"]
```

### 2.2 CodeBuddy / WorkBuddy — `~/.workbuddy/mcp.json`
```json
{
  "mcpServers": {
    "devmap": { "command": "bunx", "args": ["github:StevenLOL/devmap", "--mcp"] }
  }
}
```
> 写入后，在「连接器管理」里对 `devmap` 点 **Trust** 才会激活（host 安全机制，非 devmap 限制）。

### 2.3 VS Code（Copilot agent mode）— `.vscode/mcp.json`（项目级）或用户 `settings.json`
```json
{
  "servers": {
    "devmap": {
      "type": "stdio",
      "command": "bunx",
      "args": ["github:StevenLOL/devmap", "--mcp"]
    }
  }
}
```

### 2.4 Claude Desktop — `claude_desktop_config.json`
```json
{ "mcpServers": { "devmap": { "command": "bunx", "args": ["github:StevenLOL/devmap", "--mcp"] } } }
```

### 2.5 Cursor — `.cursor/mcp.json`（项目级或 `~/.cursor/mcp.json`）
```json
{ "mcpServers": { "devmap": { "command": "bunx", "args": ["github:StevenLOL/devmap", "--mcp"] } } }
```

### 2.6 Cline — `cline_mcp_settings.json`
```json
{ "mcpServers": { "devmap": { "command": "bunx", "args": ["github:StevenLOL/devmap", "--mcp"] } } }
```

---

## 3. 验证装好了

```bash
# 直接跑一次扫描（无需 agent）
bunx github:StevenLOL/devmap scan --json | head

# 或测 MCP 握手
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | bunx github:StevenLOL/devmap --mcp
# 应看到 tools: scan_environment / query_tool
```

agent 侧：在 Cursor/Claude/Cline 里问 "scan my environment with devmap"，agent 会调用 `devmap` 的 `scan_environment` / `query_tool`。

---

## 4. CodeBuddy / WorkBuddy 技能（skill）安装

除 MCP 外，CodeBuddy / WorkBuddy 还能把 devmap 当**技能**从 GitHub 直接装：

```bash
# 1) 克隆 devmap 仓库（已含 skill/devmap）
git clone https://github.com/StevenLOL/devmap.git
# 2) 把技能目录复制到用户级技能目录
cp -r devmap/skill/devmap ~/.workbuddy/skills/devmap
#    或项目级：cp -r devmap/skill/devmap <你的项目>/.workbuddy/skills/devmap
```

装好后，在 CodeBuddy / WorkBuddy 对话里说"用 devmap 扫一下环境 / 帮我配置 devmap 的 MCP"，agent 即按 `skill/devmap/SKILL.md` 的指引工作（包含 §2 的各 agent 配置写法）。

> 技能只提供"怎么装、怎么配、怎么调"的知识与脚本，**不复制任何检测逻辑**——检测仍由 `bin/devmap.js` 这一份 bundle 完成（薄适配器原则）。

---

## 5. 推送前置（重要）

本仓库当前所有改动（根 `bin/devmap.js`、`package.json` 修正、`skill/devmap/`、本文档）**都是本地未推送**。

- 要在 GitHub 上真正可用 `npx/bunx github:StevenLOL/devmap`，必须先在**能写 github.com** 的干净网络环境执行：
  ```bash
  git add bin/devmap.js package.json scripts/prepublish.sh skill docs/05_install_from_github.md README.md
  git commit -m "feat: GitHub-direct install (root bin bundle + per-agent MCP configs + skill)"
  git push origin main
  git tag v0.3.10 && git push --tags      # 可选：用新版本号承载"可从 GitHub 装"能力
  ```
- 本机之前 `git push` 被 **WattToolkit 只读代理**挡写（读/clone 正常，写 401）。请在无该代理的机器或 CI 上 push。
- 推送后，`bin/devmap.js` 即随仓库出现在 GitHub，agent 侧 `npx/bunx github:` 立即可用。

---

## 6. 设计一致性 & 信源

- **薄适配器原则**（docs/mcp-integration.md）：devmap 不写 IDE 插件，只暴露一个 `--mcp` 薄 server；各 agent 通过标准 MCP 协议调用，跨厂商通用。
- **零依赖**：`bin/devmap.js` 是 `bun build --target=node --format=esm` 产物，无外部依赖，node/bun 皆可直跑。
- **MCP 已成 de-facto 标准**：agent 调用工具的通用协议，跨厂商比自研 Agent Skills 标准现实（doc 02 信源：MCP 月下载 9700 万 / IDE 扩展占 42%）。
- 内部：根 `package.json` 原 `bin` 指向 `src/index.ts`（仅 bun 能跑），现已改为提交的 node bundle，使 `npx github:` 也能直跑。
