# devmap

> A source-of-truth scanner and governance layer for your machine's development environment. One command maps the whole dev setup, draws the PATH-conflict graph, and surfaces ghost binaries and multi-version collisions.

`devmap` is the developer-focused spiritual successor to `fastfetch`: instead of only printing system specs, it scans the *development* surface of your machine — runtimes, package managers, IDEs, per-interpreter pip packages, conda/WSL/Docker environments, Visual Studio dev shells, and project-local virtual environments — and produces a single machine-readable manifest plus an actionable issue list.

## Features

- **One-command full scan** of the dev environment (runtimes, package managers, IDEs, and the Phase 2 environment layers below).
- **PATH conflict graph**: detects multi-version tools, shadowed binaries, and ghost/broken symlinks (e.g. Windows App Execution Aliases that look broken but aren't).
- **Off-PATH awareness**: reports installed-but-not-on-PATH tools, while correctly treating version-manager environments (conda envs, nvm versions) as by-design off-PATH.
- **Phase 2 environment layers**: vcpkg packages, per-python pip packages (incl. upgradable), apt packages (Linux), conda environments, Docker (binary + daemon + images/containers), WSL distros, Visual Studio dev shells, and project-local environments (`.venv`, `node_modules`).
- **Three sub-commands**: `scan` (the fact source), `query` (ask the manifest), `devdiff` (compare two manifests — environment drift / cross-machine consistency).
- **Zero external dependencies.** Pure TypeScript + [Bun](https://bun.sh). No `npm install` required.

## Requirements

- [Bun](https://bun.sh) runtime.
- Windows / macOS / Linux.

## Usage

Run directly from source (no build step):

```bash
bun run src/index.ts scan
```

If installed globally (`npm i -g devmap`, once published), the `devmap` bin works too:

```bash
devmap scan
```

### `scan` — scan and print

```bash
devmap scan                        # pretty-print to terminal, write ~/.devmap/devmap.json
devmap scan --json                # machine-readable JSON (devmap.json schema) to stdout
devmap scan --report              # full markdown report
devmap scan --scan-root C:\src     # also scan project-local envs under a root (comma-separated for many)
devmap scan --wsl-deep            # also wake stopped WSL distros and probe their tools (slower)
devmap scan --outdated            # hit PyPI to list upgradable pip/conda packages (slower, needs network)
devmap scan --ci                  # exit code 1 if any error-severity issue is found
```

Key `scan` flags:

| Flag | Description |
|------|-------------|
| `--json` | Emit machine-readable JSON (the `devmap.json` schema) to stdout. |
| `--report` | Emit a full markdown report. |
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
