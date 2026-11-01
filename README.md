# devmap

> **The environment-reliability insurance for AI agents.** Before an agent changes *your* machine, let it ask devmap one question: *"can this environment run my command cleanly right now?"* — and get a structured answer instead of a mid-run failure.

`devmap` is the developer-focused spiritual successor to `fastfetch`: instead of only printing system specs, it scans the *development* surface of your machine — runtimes, package managers, IDEs, per-interpreter pip packages, conda/WSL/Docker environments, Visual Studio dev shells, project-local virtual environments, **mobile SDKs (Android / Flutter / Dart / NDK)**, and the **Windows pre-flight** state an AI agent dies on — and produces a single machine-readable manifest plus an actionable issue list. As an MCP server it plugs straight into Cursor / Cline / Claude Desktop / Codex / CodeBuddy / WorkBuddy, so the agent calls `preflight` *before* it ever shells out a command.

## Why devmap (and why it is built for agents)

- **AI agents break on dirty environments, not on missing specs.** An agent that shells out a `flutter build` or `pip install` on a machine with a Constrained-Language-Mode PowerShell, a Restricted execution policy, a GBK codepage, or an unset `ANDROID_HOME` fails mid-run (the `gemini-cli #12519` "could not be parsed safely" class of failure). `devmap --mcp` exposes a **`preflight`** tool the agent calls *first* — it returns `ok / blockers / warnings` plus the exact Windows and mobile-SDK constraints, so the agent fixes (or asks the user to fix) them up front.
- **The agent stays in control.** devmap is a read-only oracle. It never modifies your environment — it reports, and the agent decides. No hidden mutations, no "helpful" auto-fixes.

## Features

- **One-command full scan** of the dev environment (runtimes, package managers, IDEs, environment layers, mobile SDKs, and Windows pre-flight).
- **PATH conflict graph**: detects multi-version tools, shadowed binaries, and ghost/broken symlinks (e.g. Windows App Execution Aliases that look broken but aren't). This is devmap's original wedge — **14 source-available rivals all lack it**.
- **Off-PATH awareness**: reports installed-but-not-on-PATH tools, while correctly treating version-manager environments (conda envs, nvm versions) as by-design off-PATH.
- **Mobile SDK moat (exclusive)**: Android SDK (`ANDROID_HOME`/`sdkmanager`/`adb`), Flutter (version + channel + bundled Dart), standalone Dart, and NDK — flags `ANDROID_HOME` unset while tools are on PATH, dev/beta Flutter channels, and multiple NDK versions silently shadowing each other. No competitor scans this.
- **Windows pre-flight moat (exclusive)**: six checks an agent dies on — PowerShell execution policy, Constrained Language Mode (error), console code page, schannel cert-revocation (curl `CRYPT_E_NO_REVOCATION_CHECK`), App Execution Aliases shadowing real `python`/`curl`, and the safe-delete shim that makes deletions fail closed.
- **Phase 2 environment layers**: vcpkg packages, per-python pip packages (incl. upgradable), apt packages (Linux), conda environments, Docker (binary + daemon + images/containers), WSL distros, Visual Studio dev shells, and project-local environments (`.venv`, `node_modules`).
- **Three sub-commands**: `scan` (the fact source), `query` (ask the manifest), `devdiff` (compare two manifests — environment drift / cross-machine consistency).
- **Health layer (P1)**: converges official self-checks into one view, **per environment**. Offline by default: `pip check` runs for **every** Python interpreter, and `conda doctor` runs for **every** conda env. With `--health-network`, `npm doctor` / `rustup check` are added. Missing/offline probes degrade gracefully to `info` (skipped). Passing checks are summarized as `✓ N checks passed` — only `warn`/`error` surface under `issues (N)`.
- **Share card**: `devmap --card` prints a screenshot-friendly ASCII/Markdown card (tool count, conflicts, issues, Windows pre-flight status, mobile SDK state) — the zero-cost growth flywheel. `devmap --share` writes it to `./devmap-card.md`.
- **Zero external dependencies.** Pure TypeScript + [Bun](https://bun.sh). No `npm install` required.

## Requirements

- To **run from source**: the [Bun](https://bun.sh) runtime.
- To **use the published package** (`npm i -g devmap`): Node.js 18+ (no Bun needed — it ships a Node-runnable bundle).
- Windows / macOS / Linux.

## Install

Install the prebuilt bundle (runs on Node, no Bun required) via the official one-liner:

```bash
# Linux / macOS / Git Bash / WSL
bash <(curl -fsSL https://raw.githubusercontent.com/StevenLOL/devmap/main/install.sh)

# Windows (PowerShell)
irm https://raw.githubusercontent.com/StevenLOL/devmap/main/install.ps1 | iex
```

Or install manually from the official sources:

```bash
npm install -g devmap                       # npm — ships the real Node-runnable bundle
pip install --user devmap                   # PyPI — also ships the real bundled app (launches it via Node/Bun)
```

Then verify:

```bash
devmap --version
```

> Both channels ship the **real CLI**. The npm package is a prebuilt Node-runnable bundle; the PyPI wheel embeds the same bundle (`devmap/_devmap.mjs`) and launches it with Node (or Bun) — so `pip install devmap && devmap` works standalone. Either way a JavaScript runtime must be on `PATH`; Python is only the installer/launcher wrapper.

### Install from GitHub (for AI coding agents)

devmap is also an [MCP](https://modelcontextprotocol.io) server, so Codex / CodeBuddy / WorkBuddy / VS Code / Claude Desktop / Cursor / Cline can pull it **straight from GitHub** — no global install needed:

```bash
# bun-based agents (CodeBuddy / WorkBuddy)
bunx github:StevenLOL/devmap --mcp
# node-only agents (Codex / Claude Desktop)
npx github:StevenLOL/devmap --mcp
# or the npm mirror published from this repo
npx -y devmap --mcp
```

Drop the matching block into your agent's MCP config (full snippets + per-agent paths in [`docs/05_install_from_github.md`](./docs/05_install_from_github.md)):

```jsonc
{
  "mcpServers": {
    "devmap": { "command": "bunx", "args": ["github:StevenLOL/devmap", "--mcp"] }
  }
}
```

For CodeBuddy / WorkBuddy you can also install the `devmap` **skill** from this repo (`skill/devmap`) so the agent knows how to configure and call devmap. Details: [`docs/05_install_from_github.md`](./docs/05_install_from_github.md).

## Usage

`devmap` **defaults to `scan`** — you can drop the `scan` word entirely. `devmap` and `devmap scan` are identical.

Run directly from source (no build step):

```bash
bun run src/index.ts            # scan (default)
bun run src/index.ts scan       # explicit, same thing
```

If installed globally (`npm i -g devmap`), the `devmap` bin works too — and `scan` is optional there as well:

```bash
devmap                           # same as `devmap scan`
```

### `scan` — scan and print (the default subcommand; `scan` is optional)

```bash
devmap                          # pretty-print to terminal, write ~/.devmap/devmap.json
devmap --json                   # machine-readable JSON (devmap.json schema) to stdout
devmap --report                 # full markdown report
devmap --scan-root C:\src       # also scan project-local envs under a root (comma-separated for many)
devmap --wsl-deep               # also wake stopped WSL distros and probe their tools (slower)
devmap --outdated               # hit PyPI to list upgradable pip/conda packages (slower, needs network)
devmap --ci                     # exit code 1 if any error-severity issue is found
devmap --card                  # print a screenshot-friendly share card
devmap --share                 # write the share card to ./devmap-card.md
```

Key `scan` flags:

| Flag | Description |
|------|-------------|
| `--json` | Emit machine-readable JSON (the `devmap.json` schema) to stdout. |
| `--report` | Emit a full markdown report. |
| `--card` | Print a screenshot-friendly share card (pure ASCII/Markdown — never mojibakes on GBK consoles). |
| `--share` | Write the share card to `./devmap-card.md` (and print the path). |
| `--no-manifest` | Do not persist the manifest to disk. |
| `--manifest <path>` | Read/write the manifest at a custom path (default `~/.devmap/devmap.json`). |
| `--disable <r1,r2>` | Disable check rules by ID prefix (e.g. `path.duplicate`, `pip.outdated`). |
| `--shell <list>` | Which shell views to reconstruct: `current\|powershell\|gitbash\|wsl\|all`. |
| `--scan-root <dir>` | Root(s) to scan for project-local environments (comma-separated). Default: cwd. |
| `--outdated` | Network check for upgradable pip/conda packages (off by default). |
| `--wsl-deep` | Probe inside stopped WSL distros (off by default to avoid waking them). |
| `--ci` | Exit non-zero on any error-severity issue. |
| `--quiet` | Suppress the live scan progress feedback (for scripts/CI). |
| `--bom` | Prefix output with a UTF-8 BOM so Notepad-like viewers render it correctly (stdout redirect/pipe only). |
| `--audit-deps` | Invoke installed SCA tools (OSV-Scanner/pip-audit/govulncheck/Trivy) and merge CVE findings into the report (opt-in, uses network). |
| `--scan-secrets` | Scan a curated allowlist of `$HOME`/project credential files for hardcoded secrets (opt-in, fully offline, values redacted on output). |
| `--health-network` | Also run network health probes (`npm doctor` / `rustup check`); off by default to keep scans offline-fast. |
| `--mcp` | Run as an MCP server over stdio instead of scanning (see below). |

### `preflight` — the agent's first call (via MCP)

When running as an MCP server (`devmap --mcp`), agents get three tools: `scan_environment`, `query_tool`, and **`preflight`**. Call `preflight` *before* any shell command:

```jsonc
// agent -> devmap (MCP)
{ "tool": "preflight", "arguments": { "target": "powershell", "forAgent": true } }
// -> { "ok": false, "blockers": ["win.langmode"], "warnings": ["win.execpolicy", "win.schannel"],
//      "languageMode": "ConstrainedLanguage", "codepage": 936, "schannelRevoke": true, ... }
```

`blockers` non-empty ⇒ fix first. `ok: true` ⇒ the agent can proceed. This is the concrete realization of devmap's thesis: *be the neutral environment oracle an agent consults before it touches your machine.*

### `query` — ask the manifest

```bash
devmap query                       # everything
devmap query node                 # tools whose id contains "node"
devmap query runtime.node         # dot-form category.tool selector (runtime / pkg / ide)
devmap query --issues             # only issues
devmap query --conflicts          # only conflicts (multiVersion / path / ghost)
devmap query --off-path           # only off-PATH installs
devmap query --kind runtime       # filter by category
devmap query --where conda        # filter by install path substring
```

### `devdiff` — compare two manifests

```bash
devmap devdiff                    # stored manifest  vs  current live scan
devmap devdiff <file>             # stored/before    vs  <file>
devmap devdiff <a> <b>            # compare two manifest files
```

Reports added/removed installs, version changes, and issues added/resolved.

## Output

- The default `scan` writes the manifest to **`~/.devmap/devmap.json`** (pure UTF-8, no BOM — directly parseable by Bun/Node/Python/jq).
- Use `query` / `devdiff` against a stored manifest without re-scanning.

### Encoding note

Output is UTF-8. Windows Notepad may mojibake a BOM-less UTF-8 file — open it in VS Code, Windows Terminal (`cat`), or an IDE, or add `--bom` when redirecting. When reading a BOM-prefixed file in Python, use `open(p, encoding="utf-8-sig")`.

## Development

```bash
bun run src/index.ts scan                                         # run from source
bun build --compile --minify src/index.ts --outfile dist/devmap   # standalone binary
```

CI (`.github/workflows/ci.yml`) runs a scan on Linux / macOS / Windows and builds the
standalone binary on every push.

## License

[MIT](./LICENSE)
