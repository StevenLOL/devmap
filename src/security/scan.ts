// Security layer (P1, product-plan.md): OFFLINE runtime EOL detection.
//
// This is a POST-STEP (like computeConflicts), not a registered Detector: it needs the
// runtime versions that the runtimes detector already collected, and detectors run
// concurrently/independently without sharing data. So runScan() calls computeSecurity(byName)
// after runDetectors() returns. It reads `byName.runtimes` (ToolGroup[] with installs[].version)
// and flags any install past its END-OF-LIFE date (slow-changing, shippable offline data).
//
// WHY ONLY EOL (not a CVE library): see ./runtimeAdvisories.ts header. Real dependency-CVE
// scanning is handled by the SCA ADAPTER (./sca.ts) which shells out to OSV-Scanner /
// govulncheck / pip-audit and merges their output; that part is opt-in (--audit-deps) because
// those tools fetch vuln DBs over the network.
//
// Disable via `--disable security` (prefix match on Check.ID `security.*`).
import type { Check, ToolGroup } from "../types";
import { makeCheck } from "../check/model";
import { RUNTIME_ADVISORIES } from "./runtimeAdvisories";

/** Candidate lookup keys for an EOL table: major only, and major.minor. */
function eolKeys(version: string): string[] {
  const parts = version.split(".");
  const maj = parts[0];
  const min = parts[1] ?? "0";
  return [maj, `${maj}.${min}`];
}

export function computeSecurity(byName: Record<string, any>): Check[] {
  const checks: Check[] = [];
  const runtimes: ToolGroup[] = byName.runtimes || [];
  const now = Date.now();

  for (const g of runtimes) {
    const adv = RUNTIME_ADVISORIES[g.id];
    if (!adv) continue;
    for (const inst of g.installs) {
      const v = inst.version;
      if (!v) continue;

      // EOL check (per detected version)
      for (const key of eolKeys(v)) {
        const eol = adv.eolByVersion[key];
        if (eol) {
          const eolT = Date.parse(eol + "T00:00:00Z");
          if (!isNaN(eolT) && eolT < now) {
            checks.push(
              makeCheck(
                `security.eol.${g.id}`,
                "stale",
                "warn",
                `${g.id} ${v} is end-of-life (since ${eol})`,
                `${g.id} ${v} reached end-of-life on ${eol} and no longer receives security patches. Upgrade to a supported release. (${inst.path})`,
                [inst.path],
              ),
            );
          }
          break;
        }
      }
    }
  }
  return checks;
}
