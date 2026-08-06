// Health layer (P1, product-plan.md): aggregate official "doctor" / self-check commands into
// the unified devmap issue view.
//
// WHY a post-step (like computeConflicts / computeSecurity): these commands are run AFTER the
// environment is mapped, and each shells out to an external tool. We reuse the shared async
// process gate + timeout (platform/exec.runAsync) so a slow/network probe can never stall the
// whole scan, and a missing/unavailable probe degrades to an `info` "skipped" check instead of
// failing the run.
//
// DESIGN DECISIONS (offline-first + fast scan):
//   - Offline probe (`pip check`) runs by DEFAULT on every scan.
//   - Network probes (`npm doctor`, `rustup check`) run ONLY with `--health-network`, because they
//     hit the network and would otherwise (a) add latency to every scan and (b) emit false
//     positives when the machine is offline. This keeps devmap's "全本地、可离线" promise while
//     still offering deep health checks on demand.
//   - Disable the whole layer with `--disable health`; a single probe with `--disable health.pip`.
//
// Check IDs are all prefixed `health.` so the existing prefix-based --disable filter applies.
import type { Check, Kind } from "../types";
import { makeCheck } from "../check/model";
import { pathDirs, whichInDirs, runAsync } from "../platform/exec";
import { parsePipCheck, parseNpmDoctor, parseRustupCheck, type HealthParse, type HealthStatus } from "./parse";

interface HealthProbe {
  id: string; // tool id, also the Check ID segment (health.<id>.check)
  label: string; // human label
  kind: Kind; // issue category for emitted checks
  network: boolean; // requires network -> gated behind --health-network
  // ordered candidate (cmd, args); first whose binary is on PATH wins
  candidates: [string, string[]][];
  timeout: number;
  parse: (text: string) => HealthParse;
}

const PROBES: HealthProbe[] = [
  {
    id: "pip",
    label: "pip",
    kind: "conflict",
    network: false,
    candidates: [
      ["pip", ["check"]],
      ["pip3", ["check"]],
      ["python", ["-m", "pip", "check"]],
      ["python3", ["-m", "pip", "check"]],
    ],
    timeout: 15000,
    parse: parsePipCheck,
  },
  {
    id: "npm",
    label: "npm",
    kind: "mismatch",
    network: true,
    candidates: [["npm", ["doctor"]]],
    timeout: 20000,
    parse: parseNpmDoctor,
  },
  {
    id: "rustup",
    label: "rustup",
    kind: "stale",
    network: true,
    candidates: [["rustup", ["check"]]],
    timeout: 15000,
    parse: parseRustupCheck,
  },
];

/** Pick the first candidate whose binary exists on the current PATH. */
function pickCandidate(p: HealthProbe): [string, string[]] | null {
  const dirs = pathDirs();
  for (const [cmd, args] of p.candidates) {
    if (whichInDirs(cmd, dirs).length > 0) return [cmd, args];
  }
  return null;
}

const SEV_OF: Record<HealthStatus, HealthStatus> = {
  ok: "ok",
  warn: "warn",
  info: "info",
  skipped: "info",
};

function toCheck(p: HealthProbe, r: HealthParse): Check {
  const sev = SEV_OF[r.status];
  const id = `health.${p.id}.check`;
  // For "skipped" we reword the ID so it reads clearly and is distinguishable in --disable.
  const realId = r.status === "skipped" ? `health.${p.id}.skipped` : id;
  return makeCheck(realId, p.kind, sev as Check["Severity"], r.summary, r.detail || "", [], r.status === "ok" ? undefined : undefined);
}

export interface HealthOpts {
  healthNetwork?: boolean;
}

/**
 * Run all health probes and return their aggregated checks. Per-check `--disable` filtering
 * (e.g. `--disable health` / `--disable health.pip`) is applied uniformly by runScan() via
 * isCheckDisabled, mirroring computeSecurity.
 */
export async function computeHealth(opts: HealthOpts = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const network = opts.healthNetwork === true;

  for (const p of PROBES) {
    const picked = pickCandidate(p);
    if (!picked) continue; // tool not installed -> no check (mirrors security.scanner inventory)

    if (p.network && !network) {
      checks.push(
        makeCheck(
          `health.${p.id}.skipped`,
          p.kind,
          "info",
          `${p.label} doctor skipped (offline by default)`,
          `Run with --health-network to invoke ${p.label} self-checks (they require network).`,
        ),
      );
      continue;
    }

    const [cmd, args] = picked;
    const out = await runAsync(cmd, args, p.timeout);
    const result = p.parse(out);
    checks.push(toCheck(p, result));
  }

  // NOTE: per-check --disable filtering (e.g. `--disable health` / `--disable health.pip`) is
  // applied uniformly by runScan() via isCheckDisabled, mirroring computeSecurity. We return all
  // emitted checks here.
  return checks;
}
