// Shared detector helpers: detectRuntime (with extra multi-version sweeps) / detectSimple, plus
// their **concurrent variants**.
//
// Performance: version probing (`bin --version`) dominates the cost of a scan -- every probe spawns
// a child process, which is especially expensive on Windows. The sync variants block on spawnSync
// one call at a time (measured: runtimes 18s + pkgmgrs 35s). The async variants separate
// "enumerate candidate paths" (pure fs, fast) from "probe the version" (child process, slow) and
// push the latter through `pool()` -- the OS schedules the child processes in parallel, so total
// time ≈ the slowest single probe.
import { pathDirs, whichInDirs, versionOf, versionOfAsync, pool } from "../platform/exec";
import type { Install, ToolGroup } from "../types";

const CONCURRENCY = 12;
const GENERIC_FLAGS = ["--version", "version", "-v", "-V"];

/** Deduplicate by absolute path (case-insensitive), preserving the original order. */
function dedupe(paths: string[], seen: Set<string>): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** Detect one runtime: a full PATH scan plus an optional multi-version sweep (conda envs, nvm
 *  versions, known directories). Installs are deduplicated by resolved absolute path -- the same
 *  executable hit several times because PATH lists a directory twice counts once (PRD AC1
 *  false-positive boundary). */
export function detectRuntime(id: string, bin: string, flags: string[], multiFn?: () => Install[]): ToolGroup | null {
  const dirs = pathDirs();
  const matches = whichInDirs(bin, dirs);
  const installs: Install[] = [];
  const seen = new Set<string>();
  const add = (path: string, onPath: boolean, version?: string | null) => {
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    installs.push({ path, onPath, version: version ?? versionOf(path, flags) });
  };
  for (const p of matches) add(p, true);
  if (multiFn) {
    for (const m of multiFn()) {
      if (!m.path) continue;
      if (seen.has(m.path.toLowerCase())) continue;
      seen.add(m.path.toLowerCase());
      installs.push({ ...m, onPath: false });
    }
  }
  return installs.length ? { id, installs } : null;
}

/** Concurrent variant of `detectRuntime`: version probes for PATH hits all run in parallel. */
export async function detectRuntimeAsync(
  id: string,
  bin: string,
  flags: string[],
  multiFn?: () => Install[] | Promise<Install[]>,
): Promise<ToolGroup | null> {
  const seen = new Set<string>();
  const onPathPaths = dedupe(whichInDirs(bin, pathDirs()), seen);

  const extras: Install[] = [];
  if (multiFn) {
    for (const m of await multiFn()) {
      if (!m.path) continue;
      const k = m.path.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      extras.push({ ...m, onPath: false });
    }
  }

  const versions = await pool(onPathPaths, CONCURRENCY, (p) => versionOfAsync(p, flags));
  const installs: Install[] = onPathPaths.map((p, i) => ({ path: p, onPath: true, version: versions[i] }));
  installs.push(...extras);
  return installs.length ? { id, installs } : null;
}

/** Simple detection: PATH scan only, returning the tool groups that were hit (also deduplicated by
 *  absolute path). */
export function detectSimple(list: string[]): ToolGroup[] {
  const out: ToolGroup[] = [];
  const dirs = pathDirs();
  for (const name of list) {
    const paths = whichInDirs(name, dirs);
    const seen = new Set<string>();
    const installs = paths
      .filter((p) => {
        const k = p.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((p) => ({ path: p, onPath: true, version: versionOf(p, GENERIC_FLAGS) }));
    if (installs.length) out.push({ id: name, installs });
  }
  return out;
}

/**
 * Concurrent variant of `detectSimple`: version probes for **every hit path of every tool** run in
 * one batch. This is the single biggest speedup (16 package managers: 35s serial → a few seconds
 * concurrent).
 */
export async function detectSimpleAsync(list: string[], onProgress?: (done: number, total: number) => void): Promise<ToolGroup[]> {
  const dirs = pathDirs();
  const byName = new Map<string, string[]>();
  const jobs: { name: string; path: string }[] = [];

  for (const name of list) {
    const paths = dedupe(whichInDirs(name, dirs), new Set<string>());
    if (!paths.length) continue;
    byName.set(name, paths);
    for (const p of paths) jobs.push({ name, path: p });
  }

  let done = 0;
  const versions = await pool(jobs, CONCURRENCY, async (j) => {
    const v = await versionOfAsync(j.path, GENERIC_FLAGS);
    onProgress?.(++done, jobs.length);
    return v;
  });

  const vmap = new Map<string, string | null>();
  jobs.forEach((j, i) => vmap.set(`${j.name}\u0000${j.path}`, versions[i]));

  const out: ToolGroup[] = [];
  for (const name of list) {
    const paths = byName.get(name);
    if (!paths) continue;
    out.push({
      id: name,
      installs: paths.map((p) => ({ path: p, onPath: true, version: vmap.get(`${name}\u0000${p}`) ?? null })),
    });
  }
  return out;
}
