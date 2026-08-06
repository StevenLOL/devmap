// Health layer (P1, product-plan.md): aggregate official "doctor" / self-check commands into
// the unified devmap issue view.
//
// WHY a post-step (like computeConflicts / computeSecurity): these commands are run AFTER the
// environment is mapped, and each shells out to an external tool. We reuse the shared async
// process gate + timeout (platform/exec.runAsync) so a slow/network probe can never stall the
// whole scan, and a missing/unavailable probe degrades to an `info` "skipped" check instead of
// failing the run.
//
// DESIGN DECISIONS (offline-first + fast scan + multi-env aware):
//   - Offline probes (`pip check`, `conda doctor`) run by DEFAULT on every scan, and are run
//     PER ENVIRONMENT: devmap already discovered every python interpreter / conda env, so we
//     check each one (e.g. `health.pip.ctf.check`, `health.conda.base.doctor`) instead of only
//     the PATH-first tool. This is what makes the health layer actually useful on a machine
//     with many environments -- it mirrors devmap's "multi-version / multi-env" philosophy.
//   - Network probes (`npm doctor`, `rustup check`) run ONLY with `--health-network`, because
//     they hit the network and would otherwise (a) add latency and (b) emit false positives
//     when offline. Single, PATH-first (these tools are global, not per-env).
//   - Disable the whole layer with `--disable health`; a single env with `--disable health.pip.ctf`
//     or `--disable health.conda.ctf` (prefix match on Check.ID).
//
// Check IDs are all prefixed `health.` so the existing prefix-based --disable filter applies.
import type { Check, Kind } from "../types";
import { makeCheck } from "../check/model";
import { pathDirs, whichInDirs, runAsync, runBinAsync } from "../platform/exec";
import {
  parsePipCheck,
  parseNpmDoctor,
  parseRustupCheck,
  parseCondaDoctor,
  type HealthParse,
  type HealthStatus,
} from "./parse";

/** A discovered python interpreter (from byName.pip.perInterpreter). */
export interface HealthPython {
  path: string;
  label: string; // short env label, e.g. "base" / "ctf" / "lingbot-map"
}

/** A discovered conda environment (from byName.condaenv.envs). */
export interface HealthCondaEnv {
  name: string;
  pythonPath: string | null;
}

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

// Network probes (npm/rustup): single, PATH-first, gated behind --health-network.
const NETWORK_PROBES: HealthProbe[] = [
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

const SEV_OF: Record<HealthStatus, HealthStatus> = {
  ok: "ok",
  warn: "warn",
  info: "info",
  skipped: "info",
};

export interface HealthOpts {
  healthNetwork?: boolean;
  /** Discovered python interpreters (from byName.pip.perInterpreter); enables per-env pip check. */
  pythons?: HealthPython[];
  /** Discovered conda environments (from byName.condaenv.envs); enables per-env conda doctor. */
  condaEnvs?: HealthCondaEnv[];
}

/** A single aggregate "skipped" check (e.g. no interpreters / conda not on PATH). */
function skippedCheck(prefix: string, kind: Kind, summary: string): Check {
  return makeCheck(`health.${prefix}.skipped`, kind, "info", summary, "");
}

/** Per-environment check (pip/conda): health.<prefix>.<env>.check, or .skipped when no output. */
function toCheckPerEnv(prefix: string, envLabel: string, r: HealthParse, kind: Kind, path?: string): Check {
  if (r.status === "skipped") {
    return makeCheck(
      `health.${prefix}.${envLabel}.skipped`,
      kind,
      "info",
      `${prefix} doctor (${envLabel}) produced no output`,
      "",
    );
  }
  const id = `health.${prefix}.${envLabel}.check`;
  const summary = r.status === "ok" ? `${prefix} check (${envLabel}): consistent` : r.summary;
  return makeCheck(id, kind, SEV_OF[r.status] as Check["Severity"], summary, r.detail || "", path ? [path] : []);
}

/** Pick the first candidate whose binary exists on the current PATH (single, PATH-first probes). */
function pickCandidate(p: HealthProbe): [string, string[]] | null {
  const dirs = pathDirs();
  for (const [cmd, args] of p.candidates) {
    if (whichInDirs(cmd, dirs).length > 0) return [cmd, args];
  }
  return null;
}

function toCheckNetwork(p: HealthProbe, r: HealthParse): Check {
  const sev = SEV_OF[r.status];
  const id = r.status === "skipped" ? `health.${p.id}.skipped` : `health.${p.id}.check`;
  return makeCheck(id, p.kind, sev as Check["Severity"], r.summary, r.detail || "");
}

/**
 * Run all health probes and return their aggregated checks.
 *
 * Per-check `--disable` filtering (e.g. `--disable health` / `--disable health.pip.ctf`) is
 * applied uniformly by runScan() via isCheckDisabled, mirroring computeSecurity -- we return all
 * emitted checks here.
 */
export async function computeHealth(opts: HealthOpts = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const network = opts.healthNetwork === true;

  // --- pip: per-interpreter (offline, default on) ---
  const pythons = opts.pythons || [];
  if (pythons.length === 0) {
    checks.push(skippedCheck("pip", "conflict", "no python interpreters detected (pip check skipped)"));
  } else {
    await Promise.all(
      pythons.map(async (py) => {
        const out = await runBinAsync(py.path, ["-m", "pip", "check"], 15000);
        const r = parsePipCheck(out);
        checks.push(toCheckPerEnv("pip", py.label, r, "conflict", py.path));
      }),
    );
  }

  // --- conda: per-environment (offline, default on) ---
  const condaEnvs = opts.condaEnvs || [];
  const condaOnPath = whichInDirs("conda", pathDirs()).length > 0;
  if (!condaOnPath) {
    checks.push(skippedCheck("conda", "stale", "conda not on PATH (conda doctor skipped)"));
  } else if (condaEnvs.length === 0) {
    checks.push(skippedCheck("conda", "stale", "no conda environments detected (conda doctor skipped)"));
  } else {
    await Promise.all(
      condaEnvs.map(async (e) => {
        const out = await runAsync("conda", ["doctor", "-n", e.name], 30000);
        const r = parseCondaDoctor(out);
        checks.push(toCheckPerEnv("conda", e.name, r, "stale", e.pythonPath || undefined));
      }),
    );
  }

  // --- network probes (npm doctor / rustup check): only with --health-network ---
  for (const p of NETWORK_PROBES) {
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
    const picked = pickCandidate(p);
    if (!picked) continue; // tool not installed -> no check
    const [cmd, args] = picked;
    const out = await runAsync(cmd, args, p.timeout);
    const result = p.parse(out);
    checks.push(toCheckNetwork(p, result));
  }

  return checks;
}
