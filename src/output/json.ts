// Output layer: build the devmap.json manifest (PRD §9.4 schema).
import type { Check, ToolGroup, ShellId } from "../types";
import type { ConflictReport } from "../detector/conflicts";
import type { Environments } from "../types";
import { VERSION } from "../version";

export function buildManifest(
  byName: Record<string, any>,
  conflicts: ConflictReport,
  checks: Check[],
  environments: Environments,
  shells: ShellId[],
): any {
  const sys = byName.system || {};
  const runtimes: ToolGroup[] = byName.runtimes || [];
  const pkg: ToolGroup[] = byName.packageManagers || [];
  const ides: ToolGroup[] = byName.ides || [];

  const issueCountBySeverity: Record<string, number> = { error: 0, warn: 0, info: 0, missing: 0, ok: 0 };
  for (const c of checks) issueCountBySeverity[c.Severity] = (issueCountBySeverity[c.Severity] || 0) + 1;

  const totalInstallations =
    runtimes.reduce((a, g) => a + g.installs.length, 0) +
    pkg.reduce((a, g) => a + g.installs.length, 0) +
    ides.reduce((a, g) => a + g.installs.length, 0);

  const env = environments || {};
  const envSummary = {
    vcpkgPackages: env.vcpkg?.packages?.length || 0,
    pipInterpreters: env.pip?.perInterpreter?.length || 0,
    pipPackages: env.pip?.perInterpreter?.reduce((a, p) => a + p.packages.length, 0) || 0,
    pipOutdated: env.pip?.perInterpreter?.reduce((a, p) => a + p.outdated.length, 0) || 0,
    condaEnvs: env.condaEnvs?.envs?.length || 0,
    dockerInstalled: !!env.docker?.installed,
    wslDistros: env.wsl?.distros?.length || 0,
    vsShells: env.vsShells?.shells?.length || 0,
    projectEnvs: env.projectEnvs?.envs?.length || 0,
  };

  return {
    meta: { tool: "devmap", version: VERSION, generatedAt: new Date().toISOString(), schema: "devmap.manifest/1.0", shells },
    system: sys,
    runtimes,
    packageManagers: pkg,
    ides,
    environments: env,
    checks,
    conflicts: {
      multiVersionTools: conflicts.multiVersionTools,
      pathConflicts: conflicts.pathConflicts,
      ghostBinaries: conflicts.ghostBinaries,
    },
    summary: {
      runtimeKinds: runtimes.length,
      packageManagerKinds: pkg.length,
      ideKinds: ides.length,
      totalInstallations,
      toolsWithMultipleVersions: conflicts.multiVersionTools.length,
      issueCountBySeverity,
      environments: envSummary,
    },
  };
}
