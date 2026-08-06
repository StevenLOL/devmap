// Offline version-interval matcher (paradigm copied from AI-Infra-Guard pkg/vulstruct +
// Wazuh vulnerability_scanner versionMatch). This is the reusable core that lets devmap
// match a detected runtime version against a CVE/EOL "affected range" entirely offline,
// with zero network or API-key dependency (a hard devmap principle).
//
// Supported DSL (the same shape A.I.G / Wazuh use):
//   operators:  <  <=  >  >=  ==  !=
//   combinators: && (AND, higher precedence)  || (OR, lower precedence)
//   example:  ">=18.0.0 <18.20.4 || >=20.0.0 <20.12.2"
//
// Versions are compared semver-style (component-wise numeric), just like npm/node.

/** Pull a clean `MAJOR.MINOR.PATCH` out of noisy `--version` output. Returns null if none. */
export function normalizeVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = String(raw).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return `${m[1]}.${m[2] ?? "0"}.${m[3] ?? "0"}`;
}

function cmp(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function evalTerm(term: string, v: string): boolean {
  const m = term.trim().match(/^(<=|>=|==|!=|<|>)\s*(.+)$/);
  if (!m) return true; // unparseable term -> treat as pass (never false-positive)
  const op = m[1];
  const target = normalizeVersion(m[2]);
  if (!target) return true;
  const c = cmp(v, target);
  switch (op) {
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case ">=":
      return c >= 0;
    case "==":
      return c === 0;
    case "!=":
      return c !== 0;
  }
  return true;
}

/**
 * Evaluate a full DSL expression against an installed version.
 * Top-level `||` splits OR-branches; within a branch AND-terms are separated by
 * whitespace and/or `&&` (mirrors the A.I.G / Wazuh DSL, e.g. ">=18.0.0 <18.20.4").
 * An empty/blank expression is treated as "unconditional match" (true).
 */
export function versionMatch(installed: string | null, expr: string): boolean {
  if (!expr || !expr.trim()) return true;
  const v = normalizeVersion(installed);
  if (!v) return false;
  const orParts = expr.split("||").map((s) => s.trim());
  return orParts.some((or) => {
    if (!or) return false;
    // AND-terms: split on whitespace and on `&&` (normalize `&&` to space first).
    const andParts = or
      .replace(/&&/g, " ")
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return andParts.every((t) => evalTerm(t, v));
  });
}
