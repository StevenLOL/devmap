// Shared scan logic: detector -> conflicts -> manifest (reused by scan/query/devdiff).
import { runDetectors } from "./detector/registry";
import { computeConflicts, isCheckDisabled } from "./detector/conflicts";
import { computeSecurity } from "./security/scan";
import { computeScaInventory, runScaAudit } from "./security/sca";
import { computeHealth } from "./health/scan";
import { buildManifest } from "./output/json";
import { ScanProgress } from "./progress";
import type { ShellId, ToolGroup, Check } from "./types";

export interface ScanOpts {
  projectRoots?: string[]; // project-local environment scan roots (Phase 2)
  silent?: boolean; // disable progress feedback (use --quiet for scripts/CI)
  checkOutdated?: boolean; // check network for upgradable pip/conda packages (default false)
  wslDeep?: boolean; // wake stopped WSL distros for in-distro probing (default false)
  auditDeps?: boolean; // opt-in dependency CVE audit via installed SCA tools (--audit-deps; uses network)
  healthNetwork?: boolean; // opt-in network health probes (--health-network; npm doctor / rustup check need network)
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
  };
  const { byName, allChecks } = await runDetectors(ctx, progress);
  const groups: ToolGroup[] = [
    ...(byName.runtimes || []),
    ...(byName.packageManagers || []),
    ...(byName.ides || []),
  ];
  const conflicts = computeConflicts(groups, shells, disabled);

  // Health layer (P1): aggregate official doctor / self-check commands.
  //   - offline probe (pip check) runs by default;
  //   - network probes (npm doctor / rustup check) only when opts.healthNetwork (they need network).
  // Each probe is timeout-isolated via runAsync; missing/unavailable probes degrade to info.
  const healthChecks: Check[] = await computeHealth({ healthNetwork: opts.healthNetwork });

  // Security layer (P1):
  //   - computeSecurity: OFFLINE runtime EOL, read from already-detected runtime versions (default on).
  //   - computeScaInventory: OFFLINE inventory of installed SCA tools (default on, info checks).
  //   - runScaAudit: OPT-IN dependency CVE audit via installed SCA tools (--audit-deps), uses network.
  const securityChecks: Check[] = [
    ...computeSecurity(byName),
    ...computeScaInventory(),
    ...(opts.auditDeps ? runScaAudit(process.cwd()) : []),
  ];

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
  };

  if (progress) progress.finish();
  return buildManifest(byName, conflicts, collected, environments, shells);
}
