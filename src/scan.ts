// Shared scan logic: detector -> conflicts -> manifest (reused by scan/query/devdiff).
import { runDetectors } from "./detector/registry";
import { computeConflicts, isCheckDisabled } from "./detector/conflicts";
import { buildManifest } from "./output/json";
import { ScanProgress } from "./progress";
import type { ShellId, ToolGroup, Check } from "./types";

export interface ScanOpts {
  projectRoots?: string[]; // project-local environment scan roots (Phase 2)
  silent?: boolean; // disable progress feedback (use --quiet for scripts/CI)
  checkOutdated?: boolean; // check network for upgradable pip/conda packages (default false)
  wslDeep?: boolean; // wake stopped WSL distros for in-distro probing (default false)
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
  };
  const { byName, allChecks } = await runDetectors(ctx, progress);
  const groups: ToolGroup[] = [
    ...(byName.runtimes || []),
    ...(byName.packageManagers || []),
    ...(byName.ides || []),
  ];
  const conflicts = computeConflicts(groups, shells, disabled);

  // Aggregate checks from all detectors (environment layer + conflict layer), apply --disable filtering uniformly
  const collected: Check[] = [...allChecks, ...conflicts.checks].filter((c) => !isCheckDisabled(c.ID, disabled));

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
