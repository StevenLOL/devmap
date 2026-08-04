// Runtime detector: Node / Python / Go / Rust / Java / Ruby / Bun (version + path + multiple
// versions). Promotes the logic from the validated prototype/devinfo.js prototype into a structured
// Detector (PRD §9 / §14).
//
// Performance: the 7 runtimes are independent, so they run concurrently via Promise.all; within each
// runtime, the per-path version probes run concurrently through detectRuntimeAsync's pool.
// ~18s serial → a few seconds concurrent.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { register } from "./registry";
import { detectRuntimeAsync } from "./util";
import type { Install, ToolGroup } from "../types";
import { runAsync, versionOfAsync, IS_WIN, pool } from "../platform/exec";

const HOME = homedir();

/**
 * Enumerate conda interpreter paths offline (base + every env), covering the blind spot of a PATH
 * scan. Apart from a single `conda info --base` call this is pure filesystem work -- the pip and
 * condaenv detectors can reuse it directly.
 * runAsync is mandatory here: a synchronous spawnSync blocks the event loop and degrades the
 * concurrent scan back into a serial one.
 */
export async function condaPythonPaths(): Promise<{ path: string; env: string }[]> {
  const found: { path: string; env: string }[] = [];
  const bases = new Set<string>();
  const ci = await runAsync("conda", ["info", "--base"], 15000);
  if (ci) bases.add(ci.trim());
  bases.add(join(HOME, "miniconda3"));
  bases.add(join(HOME, "anaconda3"));
  bases.add("E:\\Users\\Administrator\\miniconda3"); // kept from the sample machine
  for (const base of bases) {
    if (!base || !existsSync(base)) continue;
    const basePy = IS_WIN ? join(base, "python.exe") : join(base, "bin", "python");
    if (existsSync(basePy)) found.push({ path: basePy, env: "base" });
    const envsDir = join(base, "envs");
    if (existsSync(envsDir)) {
      for (const e of readdirSync(envsDir)) {
        const py = IS_WIN ? join(envsDir, e, "python.exe") : join(envsDir, e, "bin", "python");
        if (existsSync(py)) found.push({ path: py, env: e });
      }
    }
  }
  return found;
}

/** Legacy signature: conda interpreters with versions (version probes run concurrently). */
export async function scanCondaPythons(): Promise<Install[]> {
  const paths = await condaPythonPaths();
  const versions = await pool(paths, 12, (p) => versionOfAsync(p.path, ["--version", "-V"]));
  return paths.map((p, i) => ({ path: p.path, onPath: false, version: versions[i], env: p.env }));
}

// Offline version enumeration for nvm / nvm-windows.
async function scanNvmNodes(): Promise<Install[]> {
  const cands = [join(HOME, "AppData", "Roaming", "nvm"), join(HOME, ".nvm", "versions", "node")];
  const found: { path: string; env: string }[] = [];
  for (const dir of cands) {
    if (!existsSync(dir)) continue;
    for (const v of readdirSync(dir)) {
      const bin = IS_WIN ? join(dir, v, "node.exe") : join(dir, v, "bin", "node");
      if (existsSync(bin)) found.push({ path: bin, env: v });
    }
  }
  const versions = await pool(found, 12, (f) => versionOfAsync(f.path, ["--version"]));
  return found.map((f, i) => ({ path: f.path, onPath: false, version: versions[i], env: f.env }));
}

async function scanKnownBinary(cands: string[], flags: string[]): Promise<Install[]> {
  const hits = cands.filter((c) => existsSync(c));
  const versions = await pool(hits, 12, (c) => versionOfAsync(c, flags));
  return hits.map((c, i) => ({ path: c, onPath: false, version: versions[i] }));
}

register({
  name: "runtimes",
  async scan(ctx) {
    ctx.progress?.sub("runtimes · probing 7 runtimes concurrently");
    const results = await Promise.all([
      detectRuntimeAsync("node", "node", ["--version"], scanNvmNodes),
      detectRuntimeAsync("python", "python", ["--version", "-V"], scanCondaPythons),
      detectRuntimeAsync("go", "go", ["version"]),
      detectRuntimeAsync("rustc", "rustc", ["--version"]),
      detectRuntimeAsync("java", "java", ["-version"]),
      detectRuntimeAsync("ruby", "ruby", ["--version"]),
      detectRuntimeAsync("bun", "bun", ["--version"], () =>
        scanKnownBinary([join(HOME, ".bun", "bin", "bun"), join(HOME, ".bun", "bin", "bun.exe")], ["--version"]),
      ),
    ]);
    const groups: ToolGroup[] = results.filter((g): g is ToolGroup => g !== null);
    return { data: groups, checks: [] };
  },
});
