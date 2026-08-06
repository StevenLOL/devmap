// Conflict / ghost / cross-shell analysis -- the core of what makes devmap different (PRD H1/H2).
import type { Check, ToolGroup, ShellId } from "../types";
import { makeCheck } from "../check/model";
import { isIsolated } from "../install";
import { pathDirs, whichInDirs, scanBrokenSymlinks } from "../platform/exec";
import { shellPathDirs, shellName } from "../platform/shells";

/**
 * Platform probes computeConflicts depends on. Injected so the conflict layer can be
 * unit-tested deterministically (PATH contents, broken-symlink scan, cross-shell which)
 * without touching the real machine. Defaults to the real implementations.
 */
export interface ConflictPlatform {
  pathDirs: () => string[];
  whichInDirs: (name: string, dirs: string[]) => string[];
  scanBrokenSymlinks: (dirs: string[]) => { path: string; reason: string }[];
  shellPathDirs: (s: ShellId) => string[];
  shellName: (s: ShellId) => string;
}

const realPlatform: ConflictPlatform = { pathDirs, whichInDirs, scanBrokenSymlinks, shellPathDirs, shellName };

export interface ConflictReport {
  checks: Check[];
  multiVersionTools: { id: string; count: number; versions: (string | null)[] }[];
  pathConflicts: { name: string; resolvedTo: string; alsoAt: string[] }[];
  ghostBinaries: { path: string; reason: string }[];
  offPathNotes: { id: string; path: string }[];
}

export function computeConflicts(
  groups: ToolGroup[],
  shells: ShellId[],
  disabled?: Set<string>,
  platform: ConflictPlatform = realPlatform,
): ConflictReport {
  const checks: Check[] = [];
  const multiVersionTools: ConflictReport["multiVersionTools"] = [];
  const pathConflicts: ConflictReport["pathConflicts"] = [];
  const offPathNotes: ConflictReport["offPathNotes"] = [];
  const multiShell = shells.length > 1;

  for (const g of groups) {
    // 1) Multiple versions installed: only counts when there are >=2 distinct versions.
    //    Several entry points for the same version (e.g. conda's conda.bat/conda.exe/condabin\conda.bat
    //    all pointing at one install) belong to path.duplicate and must not be reported here as
    //    "multiple versions installed" (PRD AC1 false-positive boundary).
    const distinctVersions = new Set(g.installs.map((i) => i.version || ""));
    if (g.installs.length > 1 && distinctVersions.size > 1) {
      multiVersionTools.push({ id: g.id, count: g.installs.length, versions: g.installs.map((i) => i.version) });
      checks.push(
        makeCheck(
          `version.multi.${g.id}`,
          "conflict",
          "warn",
          `${g.id} has ${g.installs.length} installs (${distinctVersions.size} distinct versions)`,
          `Versions: ${g.installs.map((i) => i.version || "?").join(", ")} (multiple versions installed, check which one is active)`,
          g.installs.map((i) => i.path),
        ),
      );
    }

    // 2) Cross-shell resolution differences (H2)
    if (multiShell) {
      const res: Record<string, string | null> = {};
      for (const s of shells) res[s] = (platform.whichInDirs(g.id, platform.shellPathDirs(s)) || [])[0] || null;
      g.shellResolution = res;
      const vals = Object.values(res).filter(Boolean) as string[];
      if (new Set(vals).size > 1) {
        checks.push(
          makeCheck(
            `shell.mismatch.${g.id}`,
            "mismatch",
            "info",
            `${g.id} resolves differently across shells`,
            shells.map((s) => `${platform.shellName(s)} → ${res[s] || "(not found)"}`).join("  |  "),
            vals,
          ),
        );
      }
    }

    // 3) Off-PATH install notice (H2: installed, but absent from the current shell's PATH).
    //    Installs tagged with `env` (conda envs, nvm versions) are skipped: for a version manager,
    //    being off-PATH is by design -- they only join PATH after `conda activate` / `nvm use`, so it
    //    is not a problem. They still show up in the runtime manifest, they just do not raise an issue.
    const off = g.installs.filter(isIsolated);
    if (off.length) {
      const dedupe = Array.from(new Set(off.map((i) => i.path)));
      offPathNotes.push(...off.map((i) => ({ id: g.id, path: i.path })));
      checks.push(
        makeCheck(
          `path.off.${g.id}`,
          "mismatch",
          "info",
          `${g.id} is installed but not on the current shell's PATH`,
          `Not a version-manager environment, so nothing will activate it for you; add it to PATH manually to use it: ${dedupe.join(", ")}`,
          dedupe,
        ),
      );
    }
  }

  // 4) PATH conflict: one binary name resolves to several *different* files (shadowed copies).
  //    Deduplicated by absolute path so a duplicated PATH directory does not split one file into
  //    N entries (PRD AC1 false-positive boundary).
  //    Version-aware: if every copy is the SAME version (e.g. conda's conda.bat / conda.exe /
  //    condabin\conda.bat all 26.1.1), it is harmless redundancy -> info, not a conflict. Only
  //    when copies differ in version is one actually shadowing a different one -> warn.
  for (const g of groups) {
    const seen = new Set<string>();
    const unique: { path: string; version: string | null }[] = [];
    for (const i of g.installs) {
      if (!i.onPath) continue;
      const k = i.path.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push({ path: i.path, version: i.version || null });
    }
    if (unique.length > 1) {
      const versions = new Set(unique.map((u) => u.version || ""));
      const sameVersion = versions.size === 1;
      const resolvedTo = unique[0].path;
      const alsoAt = unique.slice(1).map((u) => u.path);
      if (!sameVersion) {
        pathConflicts.push({ name: g.id, resolvedTo, alsoAt });
      }
      checks.push(
        makeCheck(
          `path.duplicate.${g.id}`,
          "conflict",
          sameVersion ? "info" : "warn",
          sameVersion
            ? `${g.id} has ${unique.length} launcher entries on PATH (all ${unique[0].version || "same version"}; no version conflict)`
            : `${g.id}: version ${unique[0].version} shadows ${[...versions].slice(1).join(", ")} on PATH`,
          sameVersion
            ? `active → ${resolvedTo}; also at: ${alsoAt.join(", ")} — identical version, harmless redundancy`
            : `active → ${resolvedTo}; shadowed (different version): ${alsoAt.join(", ")}`,
          unique.map((u) => u.path),
        ),
      );
    }
  }

  // 5) Ghosts: broken symlinks in PATH directories (orphaned / ghost shims).
  //    Deduplicate the directories first, so a directory listed twice in PATH is scanned once and
  //    the same ghost is not reported repeatedly.
  const seenDir = new Set<string>();
  const uniqueDirs: string[] = [];
  for (const d of platform.pathDirs()) {
    const k = d.toLowerCase();
    if (seenDir.has(k)) continue;
    seenDir.add(k);
    uniqueDirs.push(d);
  }
  const ghosts = platform.scanBrokenSymlinks(uniqueDirs);

  // 6) Duplicate PATH directories (hygiene/performance + amplifies shadowing): the same directory
  //    string appears more than once in PATH. This is one of the root causes behind H1 "PATH
  //    conflict", so it is reported on its own to make cleanup easy (documented in PRD §17).
  const dirFreq = new Map<string, number>();
  for (const d of platform.pathDirs()) {
    const k = d.toLowerCase();
    dirFreq.set(k, (dirFreq.get(k) || 0) + 1);
  }
  const dupDirs = [...dirFreq.entries()].filter(([, c]) => c > 1).map(([d, c]) => ({ d, c }));
  if (dupDirs.length) {
    const redundant = dupDirs.reduce((s, x) => s + x.c - 1, 0);
    checks.push(
      makeCheck(
        "path.duplicate-dir",
        "conflict",
        "info",
        `PATH contains ${dupDirs.length} duplicate directories (${redundant} redundant entries, amplifies shadowing)`,
        `Duplicates: ${dupDirs.map((x) => `${x.d} ×${x.c}`).join("; ")}`,
        dupDirs.map((x) => x.d),
      ),
    );
  }
  for (const gh of ghosts) {
    checks.push(
      makeCheck(
        `ghost.broken.${gh.path}`,
        "ghost",
        "warn",
        `Broken symlink found (ghost binary)`,
        `${gh.path} -- ${gh.reason}`,
        [gh.path],
      ),
    );
  }

  // Conservative: rules turned off via --disable (prefix match) are not reported.
  const filtered = disabled && disabled.size ? checks.filter((c) => !isDisabled(c.ID, disabled)) : checks;
  return { checks: filtered, multiVersionTools, pathConflicts, ghostBinaries: ghosts, offPathNotes };
}

function isDisabled(id: string, disabled: Set<string>): boolean {
  for (const d of disabled) if (id === d || id.startsWith(d + ".") || id.startsWith(d)) return true;
  return false;
}

/** Exported so the scan layer can filter checks from every detector with the same rule used here. */
export function isCheckDisabled(id: string, disabled: Set<string> | undefined): boolean {
  if (!disabled || !disabled.size) return false;
  return isDisabled(id, disabled);
}
