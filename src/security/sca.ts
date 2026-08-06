// Security layer — SCA ADAPTER (P1, product-plan.md). Decided 2026-08-06.
//
// devmap does NOT ship its own CVE database (that would compete with OSV-Scanner / govulncheck /
// pip-audit / Trivy and break the "全本地、可离线" principle). Instead it ADAPTS: it detects
// which of those tools are already installed, and — only when the user opts in with --audit-deps —
// shells out to them, parses their JSON, and merges the findings into devmap's unified view.
//
//   - computeScaInventory() : OFFLINE, default-on. One info check per tool (installed / not).
//                              Answers "what security tooling is in my env?" — a real dev-env fact.
//   - runScaAudit(cwd)      : OPT-IN (--audit-deps). Runs each installed tool on `cwd`, parses JSON,
//                              emits security.deps.* checks. NOTE: these tools fetch vuln DBs over the
//                              network, so this step is never on by default.
//
// Disable the whole security layer (incl. this adapter) via `--disable security`.
import type { Check } from "../types";
import { makeCheck } from "../check/model";
import { spawnSync } from "child_process";

// ---- platform-safe `which` ----
function whichTool(name: string): string | null {
  const isWin = process.platform === "win32";
  const r = spawnSync(isWin ? "where" : "command", isWin ? [name] : ["-v", name], { encoding: "utf-8" });
  if (r.error) return null;
  const out = (r.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return out || null;
}

function getVersion(toolId: string): string | null {
  const r = spawnSync(toolId, ["--version"], { encoding: "utf-8", timeout: 15000 });
  if (r.error || !r.stdout) return null;
  const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export function toSeverity(s: string | undefined): "warn" | "error" {
  const t = (s || "").toUpperCase();
  if (t === "CRITICAL" || t === "HIGH") return "error";
  return "warn";
}

export interface ScaTool {
  id: string;
  label: string;
  /** args appended to the tool id when running a dependency audit on `cwd` */
  auditArgs: string[];
  parse: (json: any, label: string) => Check[];
}

export const SCA_TOOLS: ScaTool[] = [
  {
    id: "osv-scanner",
    label: "OSV-Scanner",
    auditArgs: ["--format", "json", "."],
    parse: (json) => {
      const out: Check[] = [];
      for (const res of json?.results || []) {
        for (const v of res?.vulnerabilities || []) {
          const pkg = v?.package || {};
          const sev = toSeverity(v?.severity || v?.database_specific?.severity);
          const vid = v?.id || "UNKNOWN";
          out.push(
            makeCheck(
              `security.deps.osv.${vid}`,
              "vuln",
              sev,
              `${pkg.name || "?"}@${pkg.version || "?"} affected by ${vid} (${sev === "error" ? "HIGH" : "MEDIUM"})`,
              `${vid}: ${v?.summary || v?.details || ""}. Package ${pkg.name}@${pkg.version}.`,
              [pkg.name || ""],
            ),
          );
        }
      }
      return out;
    },
  },
  {
    id: "pip-audit",
    label: "pip-audit",
    auditArgs: ["-f", "json"],
    parse: (json) => {
      const out: Check[] = [];
      // pip-audit's JSON often omits `severity` (OSV-based). A *known* vuln with unknown
      // severity is still a real finding -> escalate to error so `--ci` breaks the build
      // instead of silently downgrading to warn.
      const sevOf = (s: string | undefined): "warn" | "error" => (s ? toSeverity(s) : "error");
      // Same vuln is sometimes reported once per alias (PYSEC + GHSA). Dedup by (pkg, id).
      const seen = new Set<string>();
      const push = (name: string, vid: string, sev: "warn" | "error", title: string, detail: string) => {
        const key = `${name}|${vid}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(makeCheck(`security.deps.pipaudit.${vid}`, "vuln", sev, title, detail, [name]));
      };
      for (const dep of json?.dependencies || []) {
        for (const v of dep?.vulns || []) {
          const sev = sevOf(v?.severity);
          const vid = v?.id || "UNKNOWN";
          push(
            dep?.name || "?",
            vid,
            sev,
            `${dep?.name || "?"}@${dep?.version || "?"} affected by ${vid} (${sev === "error" ? "HIGH" : "MEDIUM"})`,
            `${vid}: ${v?.description || ""}. Fix versions: ${(v?.fix_versions || []).join(", ") || "n/a"}.`,
          );
        }
      }
      // older pip-audit schema: top-level "vulnerabilities"
      for (const v of json?.vulnerabilities || []) {
        const sev = sevOf(v?.severity);
        const vid = v?.id || "UNKNOWN";
        push(
          v?.name || "?",
          vid,
          sev,
          `${v?.name || "?"} affected by ${vid}`,
          `${vid}: ${v?.description || ""}.`,
        );
      }
      return out;
    },
  },
  {
    id: "govulncheck",
    label: "govulncheck",
    auditArgs: ["-json", "."],
    parse: (json) => {
      const out: Check[] = [];
      for (const res of json?.Results || []) {
        for (const v of res?.Vulnerabilities || []) {
          const score = v?.Severity?.Score;
          const sev: "warn" | "error" = typeof score === "number" && score >= 9 ? "error" : "warn";
          const vid = v?.OSV?.id || "UNKNOWN";
          const pkg = v?.Package?.Path || v?.Package?.Name || "?";
          out.push(
            makeCheck(
              `security.deps.govulncheck.${vid}`,
              "vuln",
              sev,
              `${pkg}@${v?.Version || "?"} affected by ${vid} (${sev === "error" ? "HIGH" : "MEDIUM"})`,
              `${vid}: ${v?.Details || ""}. Package ${pkg}@${v?.Version || "?"}.`,
              [pkg],
            ),
          );
        }
      }
      return out;
    },
  },
  {
    id: "trivy",
    label: "Trivy",
    auditArgs: ["fs", "--format", "json", "."],
    parse: (json) => {
      const out: Check[] = [];
      for (const res of json?.Results || []) {
        for (const v of res?.Vulnerabilities || []) {
          const sev = toSeverity(v?.Severity);
          const vid = v?.VulnerabilityID || "UNKNOWN";
          out.push(
            makeCheck(
              `security.deps.trivy.${vid}`,
              "vuln",
              sev,
              `${v?.PkgName || "?"}@${v?.InstalledVersion || "?"} affected by ${vid} (${sev === "error" ? "HIGH" : "MEDIUM"})`,
              `${vid}: ${v?.Title || v?.Description || ""}. Fixed in ${v?.FixedVersion || "n/a"}.`,
              [v?.PkgName || ""],
            ),
          );
        }
      }
      return out;
    },
  },
];

export function detectScaTools(): { id: string; label: string; path: string | null; version: string | null }[] {
  return SCA_TOOLS.map((t) => {
    const p = whichTool(t.id);
    return { id: t.id, label: t.label, path: p, version: p ? getVersion(t.id) : null };
  });
}

// OFFLINE, default-on: one info check per tool (installed / not).
export function computeScaInventory(): Check[] {
  return detectScaTools().map((d) => {
    const id = `security.scanner.${d.id}`;
    if (d.path) {
      return makeCheck(
        id,
        "vuln",
        "info",
        `${d.label} available (${d.version || "?"})`,
        `${d.label} is installed at ${d.path}. devmap can shell out to it for dependency CVE audit with --audit-deps.`,
        [d.path || ""],
      );
    }
    return makeCheck(
      id,
      "vuln",
      "info",
      `${d.label} not installed`,
      `${d.label} not found on PATH. Install it to enable dependency CVE scanning via devmap --audit-deps (it fetches vuln DBs over the network).`,
      [],
    );
  });
}

// OPT-IN (--audit-deps): run each installed tool on `cwd`, merge parsed findings.
export function runScaAudit(cwd: string): Check[] {
  const present = detectScaTools().filter((d) => d.path);
  if (present.length === 0) {
    return [
      makeCheck(
        "security.deps.none",
        "vuln",
        "info",
        "no SCA tool installed — dependency CVE audit skipped",
        "Install osv-scanner / pip-audit / govulncheck / trivy to enable dependency CVE scanning via `devmap --audit-deps`.",
        [],
      ),
    ];
  }
  const checks: Check[] = [];
  for (const d of present) {
    const tool = SCA_TOOLS.find((t) => t.id === d.id)!;
    const r = spawnSync(d.id, tool.auditArgs, { cwd, encoding: "utf-8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    if (r.error || r.status === null) {
      checks.push(
        makeCheck(
          `security.deps.${d.id}.error`,
          "vuln",
          "info",
          `${d.label} audit failed to start`,
          `${d.label} could not be launched: ${r.error?.message || "unknown error"}.`,
          [],
        ),
      );
      continue;
    }
    if (r.status !== 0 && !r.stdout.trim()) {
      checks.push(
        makeCheck(
          `security.deps.${d.id}.skip`,
          "vuln",
          "info",
          `${d.label} audit produced no output (exit ${r.status})`,
          `${d.label} returned no scannable result in ${cwd} (no project / no lockfile / no module).`,
          [],
        ),
      );
      continue;
    }
    try {
      const json = JSON.parse(r.stdout);
      const parsed = tool.parse(json, d.label);
      checks.push(...parsed);
      if (parsed.length === 0) {
        checks.push(
          makeCheck(
            `security.deps.${d.id}.clean`,
            "vuln",
            "info",
            `${d.label} audit: no vulnerabilities found`,
            `${d.label} found no known vulnerabilities in ${cwd}.`,
            [],
          ),
        );
      }
    } catch (e: any) {
      checks.push(
        makeCheck(
          `security.deps.${d.id}.parse`,
          "vuln",
          "info",
          `${d.label} audit output not JSON`,
          `${d.label} returned output that could not be parsed as JSON: ${e?.message || e}.`,
          [],
        ),
      );
    }
  }
  return checks;
}
