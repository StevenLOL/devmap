// Shared: enumerate pip-installed packages + upgradable packages under a given python interpreter.
// Reused by the Phase 2 pip / condaenv detectors to avoid duplicate implementations.
import { runBin, runBinAsync } from "../platform/exec";
import type { PkgInfo, PipOutdatedInfo } from "../types";

export interface PythonPkgs {
  packages: PkgInfo[];
  outdated: PipOutdatedInfo[];
  error?: string;
}

function parseList(raw: string): PkgInfo[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((p: any) => ({ name: p.name, version: p.version || "?" })) : [];
  } catch {
    return [];
  }
}

function parseOutdated(raw: string): PipOutdatedInfo[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.map((p: any) => ({ name: p.name, installed: p.version || "?", latest: p.latest_version || "?" }))
      : [];
  } catch {
    return [];
  }
}

/** Async version of `pipPackages`, for concurrent enumeration across interpreters. */
export async function pipPackagesAsync(pythonPath: string, timeout = 6000, withOutdated = false): Promise<PythonPkgs> {
  try {
    const packages = parseList(await runBinAsync(pythonPath, ["-m", "pip", "list", "--format", "json"], timeout));
    let outdated: PipOutdatedInfo[] = [];
    if (withOutdated) {
      outdated = parseOutdated(
        await runBinAsync(pythonPath, ["-m", "pip", "list", "--outdated", "--format", "json"], timeout),
      );
    }
    return { packages, outdated };
  } catch {
    return { packages: [], outdated: [], error: "pip list failed" };
  }
}

/** Run `pip list` (JSON) + optional `pip list --outdated` (JSON) for a given python interpreter.
 *  --outdated needs network (queries PyPI); off by default (see --outdated flag) to avoid slowing the whole scan;
 *  when explicitly enabled, use a short timeout; on failure/timeout outdated stays empty and the main manifest is unaffected. */
export function pipPackages(pythonPath: string, timeout = 6000, withOutdated = false): PythonPkgs {
  try {
    const listRaw = runBin(pythonPath, ["-m", "pip", "list", "--format", "json"], timeout);
    let packages: PkgInfo[] = [];
    if (listRaw) {
      try {
        const arr = JSON.parse(listRaw);
        if (Array.isArray(arr)) packages = arr.map((p: any) => ({ name: p.name, version: p.version || "?" }));
      } catch {
        packages = [];
      }
    }
    let outdated: PipOutdatedInfo[] = [];
    if (withOutdated) {
      const outRaw = runBin(pythonPath, ["-m", "pip", "list", "--outdated", "--format", "json"], timeout);
      if (outRaw) {
        try {
          const arr = JSON.parse(outRaw);
          if (Array.isArray(arr))
            outdated = arr.map((p: any) => ({ name: p.name, installed: p.version || "?", latest: p.latest_version || "?" }));
        } catch {
          outdated = [];
        }
      }
    }
    return { packages, outdated };
  } catch {
    return { packages: [], outdated: [], error: "pip list failed" };
  }
}
