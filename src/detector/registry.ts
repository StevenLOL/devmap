// Detector registry and interface (PRD §14: the Detector interface Scan -> {data, checks[]}).
import type { DetectorResult, ShellId } from "../types";
import type { ScanProgress } from "../progress";

export interface ScanContext {
  shells: ShellId[];
  disabled: Set<string>; // rule IDs turned off via --disable (prefix match)
  projectRoots?: string[]; // roots to scan for project-local environments (Phase 2 projects detector)
  progress?: ScanProgress; // scan progress feedback (written to stderr, see progress.ts)
  checkOutdated?: boolean; // query the network for upgradable pip/conda packages (default false, keeps the scan fast)
  wslDeep?: boolean; // wake stopped WSL distros to probe their internal tools (default false)
  fast?: boolean; // fast pre-flight mode (MCP `preflight`): detectors should skip slow/network probes
}

export interface Detector {
  name: string;
  scan(ctx: ScanContext): DetectorResult | Promise<DetectorResult>;
}

export const registry: Detector[] = [];

export function register(d: Detector): Detector {
  registry.push(d);
  return d;
}

/**
 * Run all detectors concurrently.
 *
 * Detectors are independent of one another (each probes different tools), so running them serially
 * is pure waste -- total time would be the sum of all of them. Run concurrently, total time ≈ the
 * slowest one. The overall number of child processes is throttled by the global gate in
 * platform/exec, so concurrency will not explode into hundreds of processes.
 *
 * A failure in one detector does not affect the others (each has its own try/catch; the error is
 * recorded in byName[name].error).
 */
export async function runDetectors(
  ctx: ScanContext,
  progress?: ScanProgress,
  names?: string[],
): Promise<{ byName: Record<string, any>; allChecks: any[] }> {
  const byName: Record<string, any> = {};
  const allChecks: any[] = [];
  const selected = names ? registry.filter((d) => names.includes(d.name)) : registry;
  progress?.setTotal(selected.length);

  await Promise.all(
    selected.map(async (d) => {
      progress?.start(d.name);
      const t0 = Date.now();
      try {
        const r = await d.scan(ctx);
        byName[d.name] = r.data ?? {};
        if (r.checks && r.checks.length) allChecks.push(...r.checks);
        progress?.done(d.name, Date.now() - t0, false);
      } catch (e: any) {
        progress?.done(d.name, Date.now() - t0, true);
        byName[d.name] = { error: String(e?.message || e) };
      }
    }),
  );

  return { byName, allChecks };
}
