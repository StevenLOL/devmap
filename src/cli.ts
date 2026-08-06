// CLI entry point (PRD §11). Subcommands: scan (default) / query / devdiff.
// Zero-dependency hand-rolled arg parsing; can be swapped for commander later.
import { VERSION } from "./version";
import type { ShellId } from "./types";
import { locationOf, locationTag } from "./install";
import { runScan } from "./scan";
import { queryManifest } from "./query";
import { diffManifests } from "./diff";
import { clean } from "./glyphs";
import "./detector/system";
import "./detector/runtimes";
import "./detector/pkgmgrs";
import "./detector/ides";
import "./detector/vcpkg";
import "./detector/pip";
import "./detector/apt";
import "./detector/condaenv";
import "./detector/docker";
import "./detector/wsl";
import "./detector/vsshells";
import "./detector/projects";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// --- Windows terminal UTF-8 display fix ---
// Background: cmd.exe / old PowerShell conhost default code page is GBK (936), which decodes this
// program's UTF-8 output as GBK, producing mojibake. Windows Terminal / Git Bash are already UTF-8 and unaffected.
// Fix: switch to UTF-8 code page (65001) on ANY Windows process, NOT gated on process.stdout.isTTY.
//   Why unconditionally: when launched via the npm `devmap.cmd` shim from PowerShell, node's
//   stdout/stderr are NOT seen as a TTY (isTTY === false), yet the console still decodes output bytes
//   with the legacy code page — so gating on isTTY skipped chcp and produced mojibake. chcp changes the
//   *whole console* code page (covers both stdout and stderr) and is a no-op when already UTF-8 or when
//   there is no console (redirect/CI: output is raw UTF-8 bytes, unaffected). If chcp is unavailable
//   (e.g. some MSYS), silently skip — UTF-8 terminals are unaffected.
if (process.platform === "win32") {
  try {
    execSync("chcp 65001 > nul 2>&1", { stdio: "ignore" });
  } catch {
    /* ignore: environment lacking chcp does not affect UTF-8 terminals */
  }
}

// Windows console / PowerShell decodes this program's UTF-8 output with the legacy code page (GBK),
// so any multibyte display glyph mojibake. console.* is used ONLY for human-readable text (the pretty
// report, help, devdiff, errors); machine output (--json / --report) goes through emitText and must
// stay raw UTF-8. On Windows, sanitize console output to ASCII-safe glyphs. See glyphs.ts for the why.
if (process.platform === "win32") {
  const olog = console.log.bind(console);
  console.log = (...a: unknown[]) => olog(...a.map((x) => (typeof x === "string" ? clean(x) : x)));
  const oerr = console.error.bind(console);
  console.error = (...a: unknown[]) => oerr(...a.map((x) => (typeof x === "string" ? clean(x) : x)));
}

const ALL_SHELLS: ShellId[] = ["current", "powershell", "gitbash", "wsl"];
const DEFAULT_MANIFEST = join(homedir(), ".devmap", "devmap.json");

// Text output helper. Default is plain UTF-8 without BOM (machine-friendly: Bun/Node/Python/jq all parse directly).
// With explicit --bom: prepend a UTF-8 BOM when redirecting/piping (non-TTY) so tools decoding as ANSI (e.g. Notepad) show correctly;
//   terminals (TTY) get no BOM to avoid showing ï»¿. readManifestFile tolerates the BOM, so devmap's own reads are unaffected.
function emitText(text: string, withBom = false): void {
  const prefix = withBom && !process.stdout.isTTY ? "\uFEFF" : "";
  process.stdout.write(prefix + text + "\n");
}

// ---- Generic flag parsing: supports `--k v` / `--k=v` / `--k` (bool) / `-v` (bool) ----
function tokenize(argv: string[]): { pos: string[]; opts: Record<string, string | boolean> } {
  const pos: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith("--")) {
        // Repeated flags accumulate: `--disable a --disable b` == `--disable a,b`.
        opts[key] = opts[key] !== undefined ? `${opts[key]},${nxt}` : nxt;
        i++;
      } else opts[key] = true;
    } else if (a.startsWith("-") && a.length > 1) {
      opts[a.slice(1)] = true;
    } else pos.push(a);
  }
  return { pos, opts };
}

function toShells(v: any): ShellId[] {
  if (typeof v !== "string") return ["current"];
  const list = v.split(",").map((s) => s.trim()) as ShellId[];
  return list.includes("all" as ShellId) ? ALL_SHELLS : list.length ? list : ["current"];
}

function toSet(v: any): Set<string> {
  if (typeof v !== "string") return new Set();
  return new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
}

function toRoots(v: any): string[] | undefined {
  if (typeof v !== "string") return undefined;
  const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
}

function readManifestFile(path: string): any {
  if (!existsSync(path)) throw new Error(`manifest file not found: ${path}`);
  try {
    // Tolerate a leading UTF-8 BOM (some viewers/manual saves add one); strip before parsing to avoid Bun JSON.parse errors
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`manifest parse failed (${path}): ${e.message}`);
  }
}

// Resolve a manifest: explicit path > stored default > live scan
async function resolveManifest(
  explicitPath: string | undefined,
  shells: ShellId[],
  disabled: Set<string>,
  label: string,
  roots?: string[],
): Promise<{ manifest: any; source: string }> {
  if (explicitPath) return { manifest: readManifestFile(explicitPath), source: explicitPath };
  if (existsSync(DEFAULT_MANIFEST)) return { manifest: readManifestFile(DEFAULT_MANIFEST), source: DEFAULT_MANIFEST };
  const manifest = await runScan(shells, disabled, { projectRoots: roots });
  return { manifest, source: label + "(live scan)" };
}

// ===================== scan =====================
async function cmdScan(opts: Record<string, string | boolean>, pos: string[]): Promise<number> {
  const shells = toShells(opts.shell);
  const disabled = toSet(opts.disable);
  const roots = toRoots(opts["scan-root"]);
  const manifest = await runScan(shells, disabled, {
    projectRoots: roots,
    silent: opts.quiet === true,
    checkOutdated: opts.outdated === true,
    wslDeep: opts["wsl-deep"] === true,
    auditDeps: opts["audit-deps"] === true,
  });

  if (opts.json) {
    emitText(JSON.stringify(manifest, null, 2), opts.bom === true);
  } else if (opts.report) {
    // report needs byName; here we render a degraded manifest view (markdown simplifies via conflicts)
    emitText(clean(renderMarkdownLite(manifest)), opts.bom === true);
  } else {
    renderPrettyFromManifest(manifest);
    if (opts["no-manifest"] !== true) {
      try {
        mkdirSync(join(DEFAULT_MANIFEST, ".."), { recursive: true });
        // manifest is the program's interchange format; keep plain UTF-8 without BOM so all languages (Node/Python/jq) can parse directly.
        writeFileSync(DEFAULT_MANIFEST, JSON.stringify(manifest, null, 2));
        console.log(`  ${"\x1b[2m"}manifest → ${DEFAULT_MANIFEST}${"\x1b[0m"}`);
      } catch {
        /* disk write failure does not abort */
      }
    }
  }
  // `--ci`: exit code for CI gating. Clean -> 0; any warn-level issue -> 2; any error-level issue -> 1.
  // (warn=2 takes precedence over clean, but error=1 takes top precedence.)
  if (opts.ci) {
    const hasError = (manifest.checks || []).some((c: any) => c.Severity === "error");
    if (hasError) return 1;
    const hasWarn = (manifest.checks || []).some((c: any) => c.Severity === "warn");
    if (hasWarn) return 2;
    return 0;
  }
  return 0;
}

// ===================== query =====================
async function cmdQuery(opts: Record<string, string | boolean>, pos: string[]): Promise<number> {
  const selector = pos[1];
  const shells = toShells(opts.shell);
  const disabled = toSet(opts.disable);
  const { manifest, source } = await resolveManifest(opts.manifest as string, shells, disabled, "query", toRoots(opts["scan-root"]));
  const result = queryManifest(manifest, {
    selector,
    issues: opts.issues === true,
    conflicts: opts.conflicts === true,
    offPath: opts["off-path"] === true || opts.offpath === true,
    kind: opts.kind as any,
    where: opts.where as string,
  });

  if (opts.json) {
    emitText(JSON.stringify({ source, ...result }, null, 2), opts.bom === true);
    return 0;
  }

  console.log(`\x1b[1m🔍 query:\x1b[0m ${selector || "(all)"}  \x1b[2m(source: ${source})\x1b[0m`);
  for (const g of result.groups) {
    console.log(`  \x1b[36m${g.category}\x1b[0m ${g.id}  \x1b[2m(${g.installs.length})\x1b[0m`);
    for (const inst of g.installs) {
      const loc = locationOf(inst);
      const tag =
        loc === "PATH"
          ? "\x1b[32m[onPath]\x1b[0m"
          : loc === "env"
            ? `\x1b[36m[env: ${inst.env}]\x1b[0m`
            : "\x1b[33m[off-path]\x1b[0m";
      console.log(`    ${inst.path}  \x1b[2m${inst.version || "?"}\x1b[0m  ${tag}`);
    }
  }
  if (result.conflicts) {
    const c = result.conflicts;
    console.log(`  \x1b[1mconflicts\x1b[0m  multiVersion=${c.multiVersionTools?.length || 0}  path=${c.pathConflicts?.length || 0}  ghost=${c.ghostBinaries?.length || 0}`);
  }
  if (result.checks && result.checks.length) {
    console.log(`  \x1b[1missues (${result.checks.length})\x1b[0m`);
    for (const c of result.checks) {
      const sev = sevColor(c.Severity);
      console.log(`    ${sev}${c.Severity}\x1b[0m  ${c.ID}  ${c.Label}`);
    }
  }
  if (!result.groups.length && !result.checks.length && !result.conflicts) {
    console.log("  (no match)");
  }
  return 0;
}

// ===================== devdiff =====================
async function cmdDevdiff(opts: Record<string, string | boolean>, pos: string[]): Promise<number> {
  const shells = toShells(opts.shell);
  const disabled = toSet(opts.disable);
  const files = pos.slice(1).filter((p) => !p.startsWith("-"));

  let A: any, labelA: string;
  let B: any, labelB: string;

  if (files.length >= 2) {
    A = readManifestFile(files[0]);
    labelA = files[0];
    B = readManifestFile(files[1]);
    labelB = files[1];
  } else if (files.length === 1) {
    const before = await resolveManifest(opts.manifest as string, shells, disabled, "devdiff-before", toRoots(opts["scan-root"]));
    A = before.manifest;
    labelA = before.source;
    B = readManifestFile(files[0]);
    labelB = files[0];
  } else {
    const before = await resolveManifest(opts.manifest as string, shells, disabled, "devdiff-before", toRoots(opts["scan-root"]));
    A = before.manifest;
    labelA = before.source;
    B = await runScan(shells, disabled, { projectRoots: toRoots(opts["scan-root"]) });
    labelB = "current live scan";
  }

  const diff = diffManifests(A, B);

  if (opts.json) {
    emitText(JSON.stringify({ before: labelA, after: labelB, ...diff }, null, 2), opts.bom === true);
    return 0;
  }

  console.log(`\x1b[1m⚖ devdiff\x1b[0m  before: \x1b[2m${labelA}\x1b[0m  →  after: \x1b[2m${labelB}\x1b[0m`);
  for (const t of diff.tools) {
    for (const inst of t.added) console.log(`  \x1b[32m+ ${t.category} ${t.id}\x1b[0m  ${inst.path}  ${inst.version || "?"}`);
    for (const inst of t.removed) console.log(`  \x1b[31m- ${t.category} ${t.id}\x1b[0m  ${inst.path}  ${inst.version || "?"}`);
    for (const vc of t.versionChanged)
      console.log(`  \x1b[33m~ ${t.category} ${t.id}\x1b[0m  ${vc.path}  ${vc.from || "?"} → ${vc.to || "?"}`);
  }
  for (const iss of diff.issues) {
    for (const c of iss.added) console.log(`  \x1b[31m+ issue\x1b[0m  ${sevColor(c.Severity)}${c.Severity}\x1b[0m  ${c.ID}  ${c.Label}`);
    for (const c of iss.resolved) console.log(`  \x1b[32m- issue\x1b[0m  ${sevColor(c.Severity)}${c.Severity}\x1b[0m  ${c.ID}  ${c.Label}`);
  }
  const s = diff.summary;
  console.log(
    `  \x1b[2m→ +${s.installsAdded} installs / -${s.installsRemoved} installs / ~${s.versionChanges} version changes / +${s.issuesAdded} issues / -${s.issuesResolved} resolved\x1b[0m`,
  );
  if (!diff.tools.length && !diff.issues.length) console.log("  \x1b[32mno diff\x1b[0m");
  return 0;
}

// ===================== render helpers =====================
function sevColor(sev: string): string {
  switch (sev) {
    case "error":
      return "\x1b[31m";
    case "warn":
      return "\x1b[33m";
    case "info":
      return "\x1b[36m";
    case "ok":
      return "\x1b[32m";
    default:
      return "\x1b[0m";
  }
}

// pretty render for scan (consumes the manifest directly to avoid re-scanning)
function renderPrettyFromManifest(m: any): void {
  const sys = m.system || {};
  console.log(`\x1b[1mdevmap\x1b[0m v${m.meta?.version || VERSION}  \x1b[2m${sys.hostname || "?"}\x1b[0m  ${sys.platform}/${sys.arch}`);
  console.log(`  shell=${sys.shell || "?"}  pathDirs=${sys.pathDirCount ?? "?"}`);
  console.log("  " + "─".repeat(40));
  for (const key of ["runtimes", "packageManagers", "ides"] as const) {
    for (const g of m[key] || []) {
      console.log(`  \x1b[36m${key === "runtimes" ? "runtime" : key === "packageManagers" ? "pkg" : "ide"}\x1b[0m ${g.id}  \x1b[2m(${g.installs.length})\x1b[0m`);
      for (const inst of g.installs.slice(0, 6)) {
        const tag = inst.onPath
          ? ""
          : inst.env
            ? ` \x1b[36m[env: ${inst.env}]\x1b[0m`
            : " \x1b[33m[off-path]\x1b[0m";
        console.log(`    ${inst.path}  \x1b[2m${inst.version || "?"}\x1b[0m${tag}`);
      }
    }
  }
  const checks = m.checks || [];
  renderEnvironments(m.environments);
  if (checks.length) {
    console.log("  " + "─".repeat(40));
    console.log(`  \x1b[1missues (${checks.length})\x1b[0m`);
    for (const c of checks) console.log(`    ${sevColor(c.Severity)}${c.Severity}\x1b[0m  ${c.ID}  ${c.Label}`);
  }
}

// Pluralize a count for display: plur(1, "package") -> "1 package", plur(2, "package") -> "2 packages".
const plur = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// Phase 2: package contents / environments / dev-shell layer pretty rendering
function renderEnvironments(env: any): void {
  if (!env) return;
  const rule = "  " + "─".repeat(40);

  if (env.vcpkg?.installed) {
    console.log(rule);
    console.log(`  \x1b[1mvcpkg\x1b[0m  ${plur(env.vcpkg.packages.length, "package")}  (\x1b[33m${plur(env.vcpkg.installs.length, "install")}\x1b[0m)`);
    for (const p of env.vcpkg.packages.slice(0, 6)) console.log(`    ${p.name}@${p.version}  \x1b[2m${p.triplet}\x1b[0m`);
  }

  if (env.pip?.perInterpreter?.length) {
    console.log(rule);
    console.log(`  \x1b[1mpip\x1b[0m  ${plur(env.pip.perInterpreter.length, "interpreter")}`);
    for (const pi of env.pip.perInterpreter) {
      const short = pi.pythonPath.split(/[\\/]/).slice(-2).join("/").replace(/\.exe$/i, "");
      console.log(`    ${short}  \x1b[2m${plur(pi.packages.length, "package")}${pi.outdated.length ? " · " + pi.outdated.length + " upgradable" : ""}\x1b[0m`);
    }
  }

  if (env.apt?.available) {
    console.log(rule);
    console.log(`  \x1b[1mapt\x1b[0m  ${plur(env.apt.count, "package")}  ·  ${env.apt.upgradable} upgradable`);
  }

  if (env.condaEnvs?.envs?.length) {
    console.log(rule);
    console.log(`  \x1b[1mconda envs\x1b[0m  (${env.condaEnvs.envs.length})`);
    for (const e of env.condaEnvs.envs)
      console.log(`    ${e.active ? "*" : " "} ${e.name}  \x1b[2m${plur(e.packages.length, "package")}${e.outdated.length ? " · " + e.outdated.length + " upgradable" : ""}\x1b[0m`);
  }

  if (env.docker?.installed) {
    console.log(rule);
    console.log(
      `  \x1b[1mdocker\x1b[0m  daemon=${env.docker.daemonRunning ? "\x1b[32mrunning\x1b[0m" : "\x1b[31mnot running\x1b[0m"}  images=${env.docker.images}  containers=${env.docker.containers}`,
    );
  }

  if (env.wsl?.available && env.wsl.distros.length) {
    console.log(rule);
    console.log(`  \x1b[1mWSL\x1b[0m  (${plur(env.wsl.distros.length, "distro")})`);
    for (const d of env.wsl.distros) {
      const running = /running/i.test(d.state);
      const state = running ? `\x1b[32m${d.state}\x1b[0m` : `\x1b[2m${d.state}\x1b[0m`;
      console.log(`    ${d.default ? "*" : " "} ${d.name}  ${state} \x1b[2m· WSL${d.version}\x1b[0m`);
      if (d.basePath) console.log(`        \x1b[2mlocation: ${d.basePath}\x1b[0m`);
      if (d.probed && d.tools) {
        const have = Object.entries(d.tools).filter(([, v]) => v);
        console.log(
          have.length
            ? `        \x1b[2mtools:\x1b[0m ${have.map(([k, v]) => `${k}=${v}`).join("  ")}`
            : `        \x1b[2mtools: (not detected)\x1b[0m`,
        );
      } else {
        console.log(`        \x1b[2mtools: not probed (distro not running; add --wsl-deep to probe)\x1b[0m`);
      }
    }
  }

  if (env.vsShells?.shells?.length) {
    console.log(rule);
    console.log(`  \x1b[1mVisual Studio dev shells\x1b[0m  (${env.vsShells.shells.length})`);
    for (const s of env.vsShells.shells) {
      const present = Object.entries(s.tools)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const tag = present.length ? `\x1b[32m${present.join("/")}\x1b[0m` : `\x1b[33mno C++ toolchain\x1b[0m`;
      console.log(`    ${s.name}  \x1b[2m[${s.kind}/${s.arch}]\x1b[0m  ${tag}`);
    }
  }

  if (env.projectEnvs?.envs?.length) {
    console.log(rule);
    console.log(`  \x1b[1mproject-local environments\x1b[0m  (${env.projectEnvs.envs.length})`);
    for (const e of env.projectEnvs.envs.slice(0, 12)) console.log(`    ${e.project}  \x1b[2m${e.type}\x1b[0m  ${e.path}`);
  }
}

// report mode degraded rendering (simplified markdown, reuses the manifest)
function renderMarkdownLite(m: any): string {
  const lines: string[] = [`# devmap report`, "", `> host: ${m.system?.hostname} · ${m.system?.platform}/${m.system?.arch} · pathDirs=${m.system?.pathDirCount}`, ""];
  for (const key of ["runtimes", "packageManagers", "ides"] as const) {
    lines.push(`## ${key}`);
    for (const g of m[key] || []) {
      lines.push(`- **${g.id}** (${g.installs.length})`);
      for (const inst of g.installs) {
        const tag = locationTag(inst);
        lines.push(`  - ${inst.path} — ${inst.version || "?"}${tag ? ` (${tag})` : ""}`);
      }
    }
    lines.push("");
  }
  if ((m.checks || []).length) {
    lines.push(`## issues (${m.checks.length})`);
    for (const c of m.checks) lines.push(`- [${c.Severity}] \`${c.ID}\` ${c.Label} — ${c.Detail}`);
  }
  const env = m.environments || {};
  const envLines: string[] = [];
  if (env.vcpkg?.installed) envLines.push(`- vcpkg: ${plur(env.vcpkg.packages.length, "package")} / ${plur(env.vcpkg.installs.length, "install")}`);
  if (env.pip?.perInterpreter?.length)
    envLines.push(
      `- pip: ${plur(env.pip.perInterpreter.length, "interpreter")} / ${plur(env.pip.perInterpreter.reduce((a: number, p: any) => a + p.packages.length, 0), "package")}`,
    );
  if (env.apt?.available) envLines.push(`- apt: ${plur(env.apt.count, "package")} / ${env.apt.upgradable} upgradable`);
  if (env.condaEnvs?.envs?.length) envLines.push(`- conda envs: ${env.condaEnvs.envs.length}`);
  if (env.docker?.installed) envLines.push(`- docker: daemon=${env.docker.daemonRunning} images=${env.docker.images} containers=${env.docker.containers}`);
  if (env.wsl?.available) envLines.push(`- WSL: ${plur(env.wsl.distros?.length || 0, "distro")}`);
  if (env.vsShells?.shells?.length) envLines.push(`- Visual Studio dev shells: ${env.vsShells.shells.length}`);
  if (env.projectEnvs?.envs?.length) envLines.push(`- project-local environments: ${env.projectEnvs.envs.length}`);
  if (envLines.length) {
    lines.push("", `## environments (Phase 2)`);
    lines.push(...envLines);
  }
  return lines.join("\n");
}

function printHelp(): void {
  console.log(`devmap v${VERSION} — machine dev-environment source of truth

Usage:
  devmap [scan] [options]    scan and render nicely (scan is the DEFAULT — 'devmap' alone is enough)
  devmap query <tool>        query a generated manifest (devmap.json)
  devmap devdiff [a] [b]     compare two manifests (environment drift / cross-machine consistency)

  Tip: every 'devmap scan ...' also works as just 'devmap ...' (the 'scan' word is optional).

scan options:
  --json            emit machine-readable JSON (devmap.json schema)
  --report          emit full markdown report
  --no-manifest     do not persist the manifest to disk
  --manifest <p>    specify the manifest location (default ~/.devmap/devmap.json)
  --disable <r1,r2> disable check rules (prefix match, e.g. path.duplicate / pip.outdated)
  --shell <list>    which shell views to reconstruct (current|powershell|gitbash|wsl|all)
  --scan-root <dir> project-local environment scan root (comma-separated; default cwd). e.g. --scan-root C:\\src
  --outdated        check pip/conda upgradable packages online (off by default: requires PyPI access and slows the scan)
  --wsl-deep        probe inside stopped WSL distros (default probes only running ones to avoid waking distros)
  --ci              CI gate: clean → exit 0; any warn → exit 2; any error → exit 1
  --audit-deps      dependency CVE audit via OSV-Scanner/pip-audit/govulncheck/Trivy (opt-in, uses network)
  --quiet           suppress scan progress feedback (for scripts/CI)
  --bom             prepend UTF-8 BOM for viewing in Notepad etc. (only on redirect/pipe)
  --version / --help

Phase 2 environment layer (covered by this scan):
  vcpkg pkgs / per-python-interpreter pip packages (incl. upgradable) / apt packages (Linux) / conda env packages /
  docker (binary+daemon+images/containers) / WSL distros / Visual Studio dev shells / project-local environments (venv, node_modules)

Encoding note: output is plain UTF-8. Opening BOM-less UTF-8 in Windows Notepad may show mojibake,
  use VS Code / Windows Terminal cat / an IDE to open it; or add --bom then redirect.
  When reading a BOM file in Python use open(p, encoding="utf-8-sig").

query options:
  <tool>            tool id substring (e.g. node), or "category.tool" dotted form (e.g. runtime.node / pkg.npm)
  --issues          list issues only
  --conflicts       list conflicts only (multiVersion/path/ghost)
  --off-path        list isolated off-PATH installs only (version-manager envs excluded)
  --kind <runtime|packageManager|ide>   filter by category
  --where <substr>  filter by install-path substring
  --manifest <p>    manifest to query (default ~/.devmap/devmap.json; live scan if absent)
  --json            emit JSON

devdiff options:
  (no args)         compare "stored manifest" vs "current live scan"
  <file>            compare "stored/specified before" vs <file>
  <a> <b>           compare manifests a and b
  --json            emit JSON
`);
}

async function main(): Promise<void> {
  const { pos, opts } = tokenize(process.argv.slice(2));
  if (opts.help || opts.h) {
    printHelp();
    process.exit(0);
  }
  if (opts.version || opts.v) {
    console.log(VERSION);
    process.exit(0);
  }

  const sub = (pos[0] || "scan") as "scan" | "query" | "devdiff";
  let code = 0;
  try {
    if (sub === "query") code = await cmdQuery(opts, pos);
    else if (sub === "devdiff") code = await cmdDevdiff(opts, pos);
    else code = await cmdScan(opts, pos);
  } catch (e: any) {
    console.error(`\x1b[31merror:\x1b[0m ${e.message}`);
    process.exit(2);
  }
  process.exit(code);
}

main();
