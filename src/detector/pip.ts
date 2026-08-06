// pip detector (Phase 2): run `pip list` for each discovered python interpreter, enumerating installed packages + upgradable packages.
// Covers python/python3 on PATH and each conda env's python (offline enumeration, covering PATH blind spots).
import { register } from "./registry";
import { whichInDirs, pathDirs, pool } from "../platform/exec";
import { makeCheck } from "../check/model";
import { condaPythonPaths } from "./runtimes";
import { pipPackagesAsync } from "./piputil";
import { basename } from "node:path";
import type { Check, PythonPkgReport } from "../types";

export function shortName(pythonPath: string): string {
  const lower = pythonPath.toLowerCase();
  const m = lower.match(/[\\/]envs[\\/]([^\\/]+)[\\/]/);
  if (m) return m[1];
  if (/miniconda3[\\/]python/i.test(lower) || /anaconda3[\\/]python/i.test(lower)) return "base";
  return basename(pythonPath).replace(/\.exe$/i, "").replace(/\.cmd$/i, "");
}

async function findPythons(): Promise<{ path: string; onPath: boolean }[]> {
  const found: { path: string; onPath: boolean }[] = [];
  const seen = new Set<string>();
  const add = (p: string, onPath: boolean) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    found.push({ path: p, onPath });
  };
  for (const p of whichInDirs("python", pathDirs())) add(p, true);
  for (const p of whichInDirs("python3", pathDirs())) add(p, true);
  for (const inst of await condaPythonPaths()) add(inst.path, false);
  return found;
}

register({
  name: "pip",
  async scan(ctx) {
    const pythons = await findPythons();
    const perInterpreter: PythonPkgReport[] = [];
    const checks: Check[] = [];
    const withOutdated = ctx.checkOutdated === true;

    // Concurrent enumeration across interpreters (each is a separate subprocess, truly parallel at the OS level)
    let done = 0;
    const results = await pool(pythons, 6, async (py) => {
      const r = await pipPackagesAsync(py.path, withOutdated ? 20000 : 8000, withOutdated);
      ctx.progress?.sub(`pip · ${++done}/${pythons.length} interpreters`);
      return r;
    });

    pythons.forEach((py, i) => {
      const r = results[i];
      const short = shortName(py.path);
      perInterpreter.push({ pythonPath: py.path, version: null, packages: r.packages, outdated: r.outdated });
      if (r.outdated.length) {
        checks.push(
          makeCheck(
            `pip.outdated.${short}`,
            "stale",
            "info",
            `python(${short}) has ${r.outdated.length} upgradable packages`,
            `e.g.: ${r.outdated.slice(0, 5).map((o) => `${o.name} ${o.installed}→${o.latest}`).join(", ")}`,
            [py.path],
          ),
        );
      }
    });
    return { data: { perInterpreter }, checks };
  },
});
