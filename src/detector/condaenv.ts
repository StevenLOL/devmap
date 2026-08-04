// conda environment detector (Phase 2): formally enumerate envs via `conda env list`, then run pip list in each env to get its packages.
// Complements runtimes.scanCondaPythons (which only lists each env's python as an interpreter): here we look at what's installed inside each env.
import { register } from "./registry";
import { runAsync, IS_WIN, pool } from "../platform/exec";
import { makeCheck } from "../check/model";
import { pipPackagesAsync } from "./piputil";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Check, CondaEnvInfo } from "../types";

function pythonOf(envPath: string): string | null {
  const py = IS_WIN ? join(envPath, "python.exe") : join(envPath, "bin", "python");
  return existsSync(py) ? py : null;
}

register({
  name: "condaenv",
  async scan(ctx) {
    const out = await runAsync("conda", ["env", "list"], 15000);
    const checks: Check[] = [];
    if (!out) return { data: { envs: [] }, checks };

    // First parse the env list without spawning subprocesses, then run pip list for each env concurrently
    const parsed: { name: string; active: boolean; py: string | null }[] = [];
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^(\S+)\s+(\*?)\s*(.+)$/);
      if (!m) continue;
      parsed.push({ name: m[1], active: m[2] === "*", py: pythonOf(m[3].trim()) });
    }

    const withOutdated = ctx.checkOutdated === true;
    let done = 0;
    const results = await pool(parsed, 6, async (e) => {
      const r = e.py
        ? await pipPackagesAsync(e.py, withOutdated ? 20000 : 8000, withOutdated)
        : { packages: [], outdated: [] };
      ctx.progress?.sub(`conda env · ${++done}/${parsed.length}`);
      return r;
    });

    const envs: CondaEnvInfo[] = [];
    let anyOutdated = 0;
    parsed.forEach((e, i) => {
      const r = results[i];
      anyOutdated += r.outdated.length;
      envs.push({ name: e.name, pythonPath: e.py, active: e.active, packages: r.packages, outdated: r.outdated });
    });

    if (anyOutdated > 0) {
      checks.push(
        makeCheck(
          "conda.env.outdated",
          "stale",
          "info",
          `conda envs have ${anyOutdated} upgradable packages`,
          `Use conda env export / pip list --outdated to view per-env details`,
          envs.map((e) => e.pythonPath || e.name),
        ),
      );
    }

    return { data: { envs }, checks };
  },
});
