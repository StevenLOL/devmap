// Project-local environment detector (Phase 2): scan repos under the dev root and find the local environments each carries
// (Python venv / node_modules etc.) -- answers "which projects still have their own shell / what's installed".
// Scans process.cwd() by default; use --scan-root <dir> to specify (repeatable). Depth-limited; does not recurse into node_modules.
import { register } from "./registry";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { makeCheck } from "../check/model";
import type { Check, ProjectEnvInfo } from "../types";

function isVenv(dir: string): boolean {
  if (!existsSync(join(dir, "pyvenv.cfg"))) return false;
  const child = IS_WIN_PYVENV(dir);
  return child;
}
function IS_WIN_PYVENV(dir: string): boolean {
  // windows venv: Scripts/activate.* ; linux venv: bin/activate
  return (
    existsSync(join(dir, "Scripts", "activate")) ||
    existsSync(join(dir, "Scripts", "activate.bat")) ||
    existsSync(join(dir, "bin", "activate"))
  );
}

function walk(root: string, maxDepth: number, out: ProjectEnvInfo[], seen: Set<string>): void {
  const stack: [string, number][] = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git" || e === "target" || e === "dist" || e === ".next" || e === "out") {
        // node_modules is only used as a "project-local environment" marker and is not traversed further; others are ignored
        if (e === "node_modules") {
          const p = join(dir, e);
          if (!seen.has(p.toLowerCase())) {
            seen.add(p.toLowerCase());
            out.push({ project: basename(dir), type: "node_modules", path: p });
          }
        }
        continue;
      }
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (e === ".venv" || e === "venv") {
        if (isVenv(full) && !seen.has(full.toLowerCase())) {
          seen.add(full.toLowerCase());
          out.push({ project: basename(dirname(full)), type: "venv", path: full });
        }
        continue; // do not descend into venv
      }
      if (depth < maxDepth) stack.push([full, depth + 1]);
    }
  }
}

register({
  name: "projects",
  scan(ctx) {
    const roots = ctx.projectRoots && ctx.projectRoots.length ? ctx.projectRoots : [process.cwd()];
    const envs: ProjectEnvInfo[] = [];
    const seen = new Set<string>();
    for (const r of roots) {
      if (existsSync(r)) walk(r, 4, envs, seen);
    }
    const checks: Check[] = [];
    if (envs.length) {
      const venv = envs.filter((e) => e.type === "venv").length;
      const nm = envs.filter((e) => e.type === "node_modules").length;
      checks.push(
        makeCheck(
          "project.envs",
          "mismatch",
          "info",
          `Found ${envs.length} project-local environment${envs.length === 1 ? "" : "s"} across ${roots.length} root director${roots.length === 1 ? "y" : "ies"} (venv×${venv} / node_modules×${nm})`,
          envs.slice(0, 10).map((e) => `${e.project}:${e.type}`).join(", "),
          envs.map((e) => e.path),
        ),
      );
    }
    return { data: { roots, envs }, checks };
  },
});
