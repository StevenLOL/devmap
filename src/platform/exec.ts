// platform layer -- cross-platform execution primitives (centralized). PRD §7 principles 4/5: Windows is a first-class citizen, detection is not PATH-only.
import { spawnSync, spawn } from "node:child_process";
import { readdirSync, statSync, lstatSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

export const IS_WIN = process.platform === "win32";
export const PATH_SEP = IS_WIN ? ";" : ":";
const PATHEXT = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((s) => s.toLowerCase());

/**
 * Decode subprocess output.
 *
 * Key gotcha: on Windows some system commands (wsl.exe being the classic case)
 * emit UTF-16LE rather than UTF-8. Reading them as utf8 yields strings with
 * interleaved \x00 bytes (e.g. "U\0b\0u\0n\0t\0u\0"), and any regex/column
 * parsing silently mismatches -- surfacing as "command has output but parsed
 * result is empty" (devmap once misreported 2 WSL distros from `wsl -l -v` as 0,
 * while available stayed true).
 *
 * Detection order: 1) UTF-16LE BOM (FF FE), 2) UTF-8 BOM (EF BB BF),
 * 3) heuristic -- ASCII text encoded as UTF-16LE has nearly all odd-position
 * bytes equal to 0x00, which we use to decide.
 */
export function decodeOutput(buf: Buffer): string {
  if (buf.length === 0) return "";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  // heuristic: sample the odd bytes of the first 512 bytes; >50% 0x00 => UTF-16LE (no BOM, as emitted by wsl.exe)
  const sample = Math.min(buf.length, 512);
  let odd = 0;
  let nulOdd = 0;
  for (let i = 1; i < sample; i += 2) {
    odd++;
    if (buf[i] === 0x00) nulOdd++;
  }
  if (odd >= 4 && nulOdd / odd > 0.5) return buf.toString("utf16le");
  return buf.toString("utf8");
}

/** Run a command, return trimmed combined stdout/stderr text; on error return empty string (never throws). */
export function run(cmd: string, args: string[] = [], timeout = 5000): string {
  try {
    const r = spawnSync(cmd, args, { encoding: "buffer", timeout, windowsHide: true });
    if (r.error) return "";
    const buf = Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]);
    return decodeOutput(buf).trim();
  } catch {
    return "";
  }
}

/**
 * Global subprocess concurrency gate (process gate).
 *
 * Detectors themselves run concurrently; if each also spawned 12 subcommands,
 * hundreds of subprocesses would appear at once -- and process creation is
 * expensive on Windows, so excessive concurrency is actually slower or can
 * grind the machine to a halt. Hence all `runAsync` calls are throttled here:
 * no matter how deeply callers nest, the global in-flight subprocess count
 * never exceeds MAX_PROC.
 */
const MAX_PROC = 16;
let activeProcs = 0;
const procWaiters: (() => void)[] = [];

function acquireProc(): Promise<void> {
  if (activeProcs < MAX_PROC) {
    activeProcs++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => procWaiters.push(resolve)).then(() => {
    activeProcs++;
  });
}

function releaseProc(): void {
  activeProcs--;
  const next = procWaiters.shift();
  if (next) next();
}

/**
 * Async version of `run`: does not block the event loop and runs in true
 * parallel with other detectors (the OS schedules the subprocesses in
 * parallel; the JS side merely awaits them concurrently). This is the key
 * primitive that cuts serial version probing from ~50s down to a few seconds.
 */
export async function runAsync(cmd: string, args: string[] = [], timeout = 5000): Promise<string> {
  await acquireProc();
  try {
    return await spawnCollect(cmd, args, timeout);
  } finally {
    releaseProc();
  }
}

function spawnCollect(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (s: string) => {
      if (settled) return;
      settled = true;
      resolve(s);
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch {
      return finish("");
    }
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (d) => chunks.push(Buffer.from(d)));
    child.stderr?.on("data", (d) => chunks.push(Buffer.from(d)));
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish("");
    }, timeout);
    child.on("error", () => {
      clearTimeout(timer);
      finish("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(decodeOutput(Buffer.concat(chunks)).trim());
    });
  });
}

/**
 * Bounded-concurrency Promise pool.
 * Spawning hundreds of subprocesses without a cap can grind the machine
 * (especially on Windows, where process creation is expensive), so version
 * probing routes through here with a default concurrency of 12.
 */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Translate a path that is wrapped in a .cmd/.bat/.ps1 shim into an actually spawnable (cmd, args) pair. */
function wrapBin(binPath: string, args: string[]): [string, string[]] {
  if (IS_WIN && /\.(cmd|bat)$/i.test(binPath)) return ["cmd", ["/c", binPath, ...args]];
  if (IS_WIN && /\.ps1$/i.test(binPath)) {
    const quoted = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(" ");
    return ["powershell", ["-NoProfile", "-Command", `& '${binPath}' ${quoted}`]];
  }
  return [binPath, args];
}

/** Run an executable that may be wrapped in a .cmd/.ps1 shim (Windows gotcha: shell:false cannot run shims). */
export function runBin(binPath: string, args: string[] = [], timeout = 5000): string {
  const [c, a] = wrapBin(binPath, args);
  return run(c, a, timeout);
}

/** Async version of `runBin`. */
export function runBinAsync(binPath: string, args: string[] = [], timeout = 5000): Promise<string> {
  const [c, a] = wrapBin(binPath, args);
  return runAsync(c, a, timeout);
}

/** The current process PATH split into an ordered array of directories (by priority). */
export function pathDirs(): string[] {
  return (process.env.PATH || "").split(PATH_SEP).map((s) => s.trim()).filter(Boolean);
}

function hasExecExt(name: string): boolean {
  if (!IS_WIN) return true;
  const lower = name.toLowerCase();
  return PATHEXT.some((ext) => lower.endsWith(ext));
}

/**
 * Per-directory "executable" list cache.
 *
 * Performance-critical: `whichInDirs` is called 27+ times per scan (16 package
 * managers + 7 runtimes + pip/vcpkg/docker...), and each call does readdir + stat
 * across all 60~75 PATH directories -- roughly 2000 directory traversals and
 * tens of thousands of statSync calls. These are synchronous blocking calls that
 * stall the event loop and collapse concurrent detection back into serial
 * (observed in practice: the apt/system detector, which should take 0s, spiked
 * to 10~30s).
 *
 * PATH directory contents are treated as immutable within a single scan, so we
 * cache per directory once; whichInDirs / listPathExecutables share this cache.
 */
interface ExecEntry {
  name: string; // basename (lowercased on Windows)
  full: string;
}
const dirExecCache = new Map<string, ExecEntry[]>();

function execEntriesOf(dir: string): ExecEntry[] {
  const key = IS_WIN ? dir.toLowerCase() : dir;
  const hit = dirExecCache.get(key);
  if (hit) return hit;

  const out: ExecEntry[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    dirExecCache.set(key, out);
    return out;
  }
  for (const e of entries) {
    if (IS_WIN && !hasExecExt(e)) continue; // pre-filter by extension to skip the vast majority of statSync calls
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // EACCES from WindowsApps aliases (see scanBrokenSymlinks comment)
    }
    if (!st.isFile()) continue;
    if (!IS_WIN && !(st.mode & 0o111)) continue;
    out.push({ name: IS_WIN ? e.toLowerCase() : e, full });
  }
  dirExecCache.set(key, out);
  return out;
}

/** Clear the PATH directory cache (called on cross-shell view switch / long-lived process reuse). */
export function clearExecCache(): void {
  dirExecCache.clear();
}

/**
 * Scan for a tool basename across the given directories (without relying on the
 * shell's which/where), returning all matches by directory priority.
 * This directly produces the "same binary appearing in multiple directories"
 * data needed for the PATH conflict map (PRD H1).
 */
export function whichInDirs(name: string, dirs: string[]): string[] {
  const out: string[] = [];
  const target = IS_WIN ? name.toLowerCase() : name;
  for (const dir of dirs) {
    for (const e of execEntriesOf(dir)) {
      if (IS_WIN) {
        if (e.name === target || PATHEXT.some((ext) => e.name === target + ext)) out.push(e.full);
      } else if (e.name === target) {
        out.push(e.full);
      }
    }
  }
  return out;
}

// NOTE: the guards are `(?<![\d.])` / `(?![\d.])`, deliberately not `\b`.
// `\b` does not fire between `v` and `2` in `v22.22.2` (both are word chars), so a
// `\b`-anchored pattern silently truncates `v22.22.2` down to `22.2`.
//
// The trailing `(?:[-.+][0-9A-Za-z._-]+)*` accepts build/qualifier tails in EITHER
// semver form (`-`/`+`, e.g. `1.2.3-rc1`, `1.2.3+build.5`) OR the dot-separated form
// some tools use (e.g. `git version 2.53.0.windows.1`). Without this, git's `.windows.1`
// suffix made the whole match fail and the version fell back to `?`.
const SEMVER_RE = /(?<![\d.])(\d+\.\d+\.\d+)(?:[-.+][0-9A-Za-z._-]+)*(?![\d.])/;
const LOOSE_VERSION_RE = /(?<![\d.])(\d+\.\d+)(?:[-.+][0-9A-Za-z._-]+)*(?![\d.])/;

/**
 * Pull a version out of a `--version` style output.
 *
 * Matching the first number anywhere in the blob is not good enough in practice:
 *  - JVM-based launchers (PyCharm, IntelliJ) print a log line first,
 *    `[0.022s][warning][cds] ...`, whose timing looks exactly like a version and
 *    changes on every run -- which made devdiff report phantom version changes.
 *  - `npm version` prints an object whose FIRST entry is the *host project's*
 *    version (e.g. `devmap: '0.2.0'`), not npm's.
 *
 * So: drop bracketed log lines, prefer the entry keyed by the tool's own name if
 * the output looks like a map, then prefer a full x.y.z over a loose x.y.
 */
export function extractVersion(out: string, binPath?: string): string | null {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("["));

  if (binPath) {
    const self = basename(binPath)
      .replace(/\.(exe|cmd|bat|ps1|sh)$/i, "")
      .toLowerCase();
    const own = lines.find((l) => {
      const key = l.toLowerCase().replace(/^['"]/, "");
      return key.startsWith(self + ":") || key.startsWith(self + "':") || key.startsWith(self + '":');
    });
    if (own) {
      const m = own.match(SEMVER_RE) || own.match(LOOSE_VERSION_RE);
      if (m) return m[0];
    }
  }

  for (const l of lines) {
    const m = l.match(SEMVER_RE);
    if (m) return m[0];
  }
  for (const l of lines) {
    const m = l.match(LOOSE_VERSION_RE);
    if (m) return m[0];
  }
  return null;
}

/** Run `bin flag` and extract the version it reports. */
export function versionOf(binPath: string, flags: string[]): string | null {
  for (const f of flags) {
    const out = runBin(binPath, [f]);
    if (out) {
      const v = extractVersion(out, binPath);
      if (v) return v;
    }
  }
  return null;
}

/**
 * Async version of `versionOf`: short-circuits in flag order, returning on first hit.
 * The timeout is generous because a cold `npm.cmd` / JVM launcher on Windows can
 * take several seconds; timing out here silently falls through to a worse flag
 * (e.g. bare `version`) and yields a wrong answer rather than no answer.
 */
export async function versionOfAsync(binPath: string, flags: string[], timeout = 9000): Promise<string | null> {
  for (const f of flags) {
    const out = await runBinAsync(binPath, [f], timeout);
    if (out) {
      const v = extractVersion(out, binPath);
      if (v) return v;
    }
  }
  return null;
}

export function fileExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** List all executables in PATH directories (grouped by basename) for ghost / conflict analysis. Reuses the per-directory cache. */
export function listPathExecutables(dirs: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const dir of dirs) {
    for (const e of execEntriesOf(dir)) {
      let arr = map.get(e.name);
      if (!arr) {
        arr = [];
        map.set(e.name, arr);
      }
      arr.push(e.full);
    }
  }
  return map;
}

/**
 * Detect broken symlinks (orphan / ghost shims) in PATH directories.
 *
 * Key gotcha (Windows): bash.exe / wt.exe / python.exe ... under `WindowsApps`
 * are App Execution Aliases (IO_REPARSE_TAG_APPEXECLINK reparse points). lstat
 * reports them as symlinks, and following with stat throws `EACCES` (not ENOENT)
 * -- yet they are perfectly callable (bash.exe -> WSL, wt.exe -> Terminal) and
 * are by no means broken. Treating every error code as broken would emit 20+
 * false positives and destroy H1's credibility.
 *
 * Hence the rules:
 *  1) Exclude the `WindowsApps` directory entirely (a system alias store with no
 *     real dev-tool ghosts inside);
 *  2) Only a stat that throws `ENOENT` (target genuinely missing) counts as
 *     broken; EACCES and similar reparse-point/permission errors do not.
 */
export function scanBrokenSymlinks(dirs: string[]): { path: string; reason: string }[] {
  const ghosts: { path: string; reason: string }[] = [];
  for (const dir of dirs) {
    // 1) skip the system App Execution Alias store (see function comment)
    if (/[\\/]microsoft[\\/]windowsapps[\\/]?$/i.test(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let lstat;
      try {
        lstat = lstatSync(full);
      } catch {
        continue;
      }
      if (lstat.isSymbolicLink()) {
        try {
          statSync(full);
        } catch (err) {
          // 2) only a genuinely missing target (ENOENT) is a true broken symlink; EACCES etc. are reparse points/permissions, not broken
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") {
            ghosts.push({ path: full, reason: "broken-symlink (target missing)" });
          }
        }
      }
    }
  }
  return ghosts;
}
