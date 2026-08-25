// Shared scan logic: detector -> conflicts -> manifest (reused by scan/query/devdiff).
import { runDetectors } from "./detector/registry";
import { computeConflicts, isCheckDisabled } from "./detector/conflicts";
import { computeSecurity } from "./security/scan";
import { computeScaInventory, runScaAudit } from "./security/sca";
import { scanSecrets } from "./security/secrets";
import { computeHealth, type HealthPython, type HealthCondaEnv } from "./health/scan";
import { buildManifest } from "./output/json";
import { ScanProgress } from "./progress";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { ShellId, ToolGroup, Check } from "./types";

export interface ScanOpts {
  projectRoots?: string[]; // project-local environment scan roots (Phase 2)
  silent?: boolean; // disable progress feedback (use --quiet for scripts/CI)
  checkOutdated?: boolean; // check network for upgradable pip/conda packages (default false)
  wslDeep?: boolean; // wake stopped WSL distros for in-distro probing (default false)
  auditDeps?: boolean; // opt-in dependency CVE audit via installed SCA tools (--audit-deps; uses network)
  healthNetwork?: boolean; // opt-in network health probes (--health-network; npm doctor / rustup check need network)
  scanSecrets?: boolean; // opt-in hardcoded-secret scan (--scan-secrets; offline, curated files only)
  fast?: boolean; // fast pre-flight path (MCP `preflight`): moat + conflict detectors only, no health/security layers
}

/**
 * Human-readable label for a python interpreter, used in health check IDs/summaries.
 * Conda envs get their env name (base/ctf/...); standalone installs get a location-ish label.
 */
function healthPythonLabel(path: string): string {
  const lower = path.toLowerCase().replace(/\\/g, "/");
  const env = lower.match(/[\\/]envs[\\/]([^\\/]+)[\\/]/);
  if (env) return env[1];
  if (/miniconda3[\\/]python/i.test(lower) || /anaconda3[\\/]python/i.test(lower)) return "base";
  if (lower.includes("workbuddy/binaries/python")) return "managed";
  if (lower.includes("/nvm") || lower.includes("\\nvm")) return "nvm";
  const parts = lower.split("/").filter(Boolean);
  const parent = parts[parts.length - 2] || "";
  return parent || "python";
}

/**
 * Collapse duplicate interpreters before health-checking:
 *  - `python` and `python3` in the SAME directory are the same install -> one entry.
 *  - distinct installs keep distinct entries; if two still map to the same label,
 *    disambiguate with a "#2"/"#3" suffix so Check.IDs stay unique.
 */
function dedupePythons(raw: { pythonPath: string }[]): HealthPython[] {
  const byDir = new Map<string, string>(); // install dir (realpath) -> original path
  for (const p of raw) {
    let rp = p.pythonPath;
    try {
      rp = realpathSync(p.pythonPath);
    } catch {
      /* keep original path as key */
    }
    const dir = dirname(rp);
    if (!byDir.has(dir)) byDir.set(dir, p.pythonPath);
  }
  const out: HealthPython[] = [];
  const used = new Set<string>();
  for (const path of byDir.values()) {
    let label = healthPythonLabel(path);
    let n = 2;
    while (used.has(label)) label = `${healthPythonLabel(path)}#${n++}`;
    used.add(label);
    out.push({ path, label });
  }
  return out;
}

export async function runScan(shells: ShellId[], disabled: Set<string>, opts: ScanOpts = {}): Promise<any> {
  const progress = opts.silent ? undefined : new ScanProgress(0, process.stderr.isTTY);
  const ctx = {
    shells,
    disabled,
    projectRoots: opts.projectRoots,
    progress,
    checkOutdated: opts.checkOutdated,
    wslDeep: opts.wslDeep,
    auditDeps: opts.auditDeps,
    healthNetwork: opts.healthNetwork,
    fast: opts.fast,
  };
  const { byName, allChecks } = await runDetectors(
    ctx,
    progress,
    // Fast path (MCP `preflight`): only the moat (sdks/windows) + conflict-relevant (runtimes/pkg/ides)
    // detectors run. This skips the slow health/security layers and turns a ~75s full scan into a
    // few-second pre-flight oracle -- agents call this on every turn, so latency matters.
    opts.fast ? ["runtimes", "packageManagers", "ides", "sdks", "windows"] : undefined,
  );
  const groups: ToolGroup[] = [
    ...(byName.runtimes || []),
    ...(byName.packageManagers || []),
    ...(byName.ides || []),
  ];
  const conflicts = computeConflicts(groups, shells, disabled);

  // Health + Security layers (P1) are the slow part of a full scan (per-interpreter pip check ~30s,
  // conda doctor, EOL lookups). They are irrelevant to the pre-flight verdict, so skip them in fast mode.
  let healthChecks: Check[] = [];
  let securityChecks: Check[] = [];
  if (!opts.fast) {
    // Health layer: aggregate official doctor / self-check commands.
    //   - offline probe (pip check) runs by default;
    //   - network probes (npm doctor / rustup check) only when opts.healthNetwork (they need network).
    // Each probe is timeout-isolated via runAsync; missing/unavailable probes degrade to info.
    // We feed the interpreters/envs devmap already discovered so the health layer checks EVERY
    // environment, not just the PATH-first tool.
    const pythons: HealthPython[] = dedupePythons((byName.pip?.perInterpreter as { pythonPath: string }[]) || []);
    const condaEnvs: HealthCondaEnv[] = ((byName.condaenv?.envs as HealthCondaEnv[]) || []).map((e) => ({
      name: e.name,
      pythonPath: e.pythonPath,
    }));
    healthChecks = await computeHealth({ healthNetwork: opts.healthNetwork, pythons, condaEnvs });

    // Security layer:
    //   - computeSecurity: OFFLINE runtime EOL, read from already-detected runtime versions (default on).
    //   - computeScaInventory: OFFLINE inventory of installed SCA tools (default on, info checks).
    //   - runScaAudit: OPT-IN dependency CVE audit via installed SCA tools (--audit-deps), uses network.
    securityChecks = [
      ...computeSecurity(byName),
      ...computeScaInventory(),
      ...(opts.auditDeps ? runScaAudit(process.cwd()) : []),
      ...(opts.scanSecrets ? scanSecrets(opts.projectRoots) : []),
    ];
  }

  // Aggregate checks from all detectors (environment layer + conflict layer + security layer),
  // apply --disable filtering uniformly (e.g. `--disable security` turns the whole security layer off).
  const collected: Check[] = [...allChecks, ...conflicts.checks, ...securityChecks, ...healthChecks].filter((c) => !isCheckDisabled(c.ID, disabled));

  // Assemble the Phase 2 top-level environments section
  const environments = {
    vcpkg: byName.vcpkg,
    pip: byName.pip,
    apt: byName.apt,
    condaEnvs: byName.condaenv,
    docker: byName.docker,
    wsl: byName.wsl,
    vsShells: byName.vsshells,
    projectEnvs: byName.projects,
    // Moat layer: mobile SDKs + Windows pre-flight (optimization doc §2.A/§2.B).
    sdks: byName.sdks,
    windows: byName.windows,
  };

  if (progress) progress.finish();
  return buildManifest(byName, conflicts, collected, environments, shells);
}
