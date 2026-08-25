---
name: devmap
description: Install, configure, and call devmap (a zero-dependency dev-environment scanner / MCP server) from GitHub so AI coding agents (Codex, CodeBuddy, WorkBuddy, VS Code, Claude Desktop, Cursor, Cline) can pre-flight the local environment before making changes. Use when the user wants to "scan my dev environment", "set up devmap as an MCP server", "install devmap from GitHub", or "check PATH conflicts / ghost binaries / agent environment blockers".
---

# devmap — environment pre-flight for AI agents

devmap is a CLI + MCP server that maps a machine's development environment and
surfaces issues (PATH conflicts, ghost binaries, multi-version collisions, per-env
health, secret hygiene, Windows/PowerShell pre-flight, mobile SDK status). It is the
"neutral environment oracle" an AI agent should query **before** mutating the user's
machine — so the agent learns the environment is dirty *before* a shell command fails.

## Install from GitHub (no global install needed)

devmap ships as a single zero-dependency bundle. Any agent with `npx` or `bunx` can
pull it straight from GitHub:

- bun-based (CodeBuddy / WorkBuddy): `bunx github:StevenLOL/devmap --mcp`
- node-only (Codex / Claude Desktop): `npx github:StevenLOL/devmap --mcp`
- npm mirror (published from this repo): `npx -y devmap --mcp`

A plain scan (no agent) also works: `bunx github:StevenLOL/devmap scan --json`.

## Configure as an MCP server (per agent)

The MCP server is started with `--mcp`. Add the matching block to the agent's config:

| Agent | Config file | Block |
|---|---|---|
| Codex | `~/.codex/config.toml` | `[mcp_servers.devmap]` `command="bunx"` `args=["github:StevenLOL/devmap","--mcp"]` |
| CodeBuddy / WorkBuddy | `~/.workbuddy/mcp.json` | `{"mcpServers":{"devmap":{"command":"bunx","args":["github:StevenLOL/devmap","--mcp"]}}}` |
| VS Code (Copilot) | `.vscode/mcp.json` | `{"servers":{"devmap":{"type":"stdio","command":"bunx","args":["github:StevenLOL/devmap","--mcp"]}}}` |
| Claude Desktop | `claude_desktop_config.json` | `{"mcpServers":{"devmap":{"command":"bunx","args":["github:StevenLOL/devmap","--mcp"]}}}` |
| Cursor | `.cursor/mcp.json` | `{"mcpServers":{"devmap":{"command":"bunx","args":["github:StevenLOL/devmap","--mcp"]}}}` |
| Cline | `cline_mcp_settings.json` | `{"mcpServers":{"devmap":{"command":"bunx","args":["github:StevenLOL/devmap","--mcp"]}}}` |

For CodeBuddy / WorkBuddy, after writing `~/.workbuddy/mcp.json` the user must click
**Trust** on the `devmap` server in connector management before it activates.

If `bunx`/`npx` is unavailable in the agent's PATH, replace `command` with the absolute
path to the bundle: `node ["<repo>/bin/devmap.js", "--mcp"]` (Windows: forward or double backslashes).

## Tools devmap exposes over MCP

- `scan_environment` — full scan, returns the structured manifest. Call this FIRST to
  understand the machine. Params: `shells` (current|powershell|gitbash|wsl|all),
  `disable` (rule prefixes), `auditDeps` (bool, CVE audit, network), `healthNetwork` (bool).
- `query_tool` — query a specific tool / category / conflict / issue (e.g. `node`,
  `runtime.node`, `git`). Params: `selector`, `issuesOnly`, `conflictsOnly`, `offPathOnly`.

Both return `content[].text` (JSON) and an `isError` flag.

## Safety posture

- **Read-only**: the MCP adapter only emits a manifest; it never writes files or runs
  mutating commands.
- **Local / offline by default**: `scan_environment` does not hit the network unless
  `auditDeps` / `healthNetwork` are explicitly opted in.
- **Single source of truth**: one bundle, one engine, shared by every agent on the machine.

## Source / docs

- Repo: https://github.com/StevenLOL/devmap
- MCP integration rationale: `docs/mcp-integration.md`
- Per-agent GitHub-direct install guide: `docs/05_install_from_github.md`
