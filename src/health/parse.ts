// Health layer (P1, product-plan.md): parsers for official "doctor"/self-check commands.
//
// These commands emit plain TEXT (unlike the SCA adapters which emit JSON), so each parser is a
// small pure function that turns command output into a normalized result. They are exported and
// unit-tested against captured fixtures in ./health.test.ts (mirrors the security/sca.ts design,
// where only parsers are unit-tested and the live spawner is exercised end-to-end).
export type HealthStatus = "ok" | "warn" | "info" | "skipped";

export interface HealthParse {
  status: HealthStatus;
  summary: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// pip check  (offline, deterministic)
//   clean : "No broken requirements found."
//   conflict lines look like:
//     "PyYAML 6.0.2 requires markupsafe>=2.0, but you have markupsafe 1.1.1."
//     "requests 2.32.3 has requirement charset-normalizer<4,>=2, but you have charset-normalizer 4.1.0."
// `pip check` prints EITHER the "No broken..." line (clean) OR one conflict line per broken
// requirement -- never both. A conflict line is anything that is not the clean marker.
export function parsePipCheck(text: string): HealthParse {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const clean = lines.some((l) => /^no broken requirements found/i.test(l));
  const conflicts = lines.filter((l) => !/^no broken requirements found/i.test(l));
  if (clean || conflicts.length === 0) {
    return { status: "ok", summary: "pip dependencies consistent" };
  }
  return {
    status: "warn",
    summary: `pip has ${conflicts.length} broken dependency requirement${conflicts.length === 1 ? "" : "s"}`,
    detail: conflicts.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// npm doctor  (network + filesystem checks; output format varies by npm version)
//   Real defect lines typically carry "npm error" or a ✗ / ✖ glyph.
//   Network failures (registry unreachable) look like "npm error code ECONNREFUSED",
//   "request to https://registry.npmjs.org/... failed", "getaddrinfo ENOTFOUND", etc.
//   These are NOT environment defects, so they degrade to "skipped" (info), not "warn".
export function parseNpmDoctor(text: string): HealthParse {
  const t = (text || "").trim();
  if (!t) return { status: "skipped", summary: "npm doctor produced no output (timed out or silent)" };

  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const NET_RE = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|EAI_|network request|registry\.npmjs\.org|request to https?:/i;
  // npm appends boilerplate (error-code echo, stack traces, "A complete log of this run can be
  // found in: ...") that is NOT an actual defect and must not inflate the failure count.
  const BOILER_RE = /complete log of this run|^\s+at\s|node:internal|file:\/\//i;

  const netLines = lines.filter((l) => NET_RE.test(l));
  const failLines = lines.filter((l) => /npm error|✗|✖/i.test(l) && !BOILER_RE.test(l));
  const realFails = failLines.filter((l) => !NET_RE.test(l));

  if (realFails.length) {
    return {
      status: "warn",
      summary: `npm doctor reported ${realFails.length} issue${realFails.length === 1 ? "" : "s"}`,
      detail: realFails.join("\n"),
    };
  }
  if (netLines.length) {
    return { status: "skipped", summary: "npm doctor skipped (registry/network unreachable)" };
  }
  return { status: "ok", summary: "npm doctor passed" };
}

// ---------------------------------------------------------------------------
// rustup check  (network; reports toolchain update availability)
//   "stable-x86_64-pc-windows-msvc - update available: 1.96.1 (...) -> 1.97.1 (...)"
//   "rustup - up to date : 1.29.0"
//   An available update is informational (not a defect) -> info.
export function parseRustupCheck(text: string): HealthParse {
  const t = (text || "").trim();
  if (!t) return { status: "skipped", summary: "rustup check produced no output (timed out or silent)" };

  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const updates = lines.filter((l) => /update available/i.test(l));
  const upToDate = lines.filter((l) => /up to date/i.test(l));

  if (updates.length) {
    return {
      status: "info",
      summary: `rustup: ${updates.length} toolchain update${updates.length === 1 ? "" : "s"} available`,
      detail: updates.join("\n"),
    };
  }
  if (upToDate.length) return { status: "ok", summary: "rustup toolchains up to date" };
  return { status: "ok", summary: "rustup check passed" };
}

// ---------------------------------------------------------------------------
// conda doctor  (offline; "Display a health report for your environment")
//   NOTE: `conda doctor --json` still prints the human report (NOT JSON) in
//   conda 26.x, so we parse TEXT. Sections are headed by a ❌ (problem) or ✅
//   (ok) glyph; problem sections then list affected packages as "pkg-1.2.3: N"
//   (N = number of affected files for that package).
//   Sample (conda doctor -n base):
//     Environment Health Report for: E:\Users\Administrator\miniconda3
//     ❌ Altered Files:
//     gdk-pixbuf-2.44.6-hd37cd66_1: 1
//     yaml-cpp-0.8.0-hd77b12b_1: 4
//     ✅ The environment is consistent.
//     ❌ Missing Files:
//     pip-25.2-pyhc872135_1: 61
//     setuptools-80.9.0-py313haa95532_0: 143
export function parseCondaDoctor(text: string): HealthParse {
  const t = (text || "").trim();
  if (!t) return { status: "skipped", summary: "conda doctor produced no output (timed out or silent)" };

  const lines = t.split(/\r?\n/).map((l) => l.trim());
  const problemSections: { name: string; items: number }[] = [];
  let cur: { name: string; items: number } | null = null;

  for (const line of lines) {
    if (!line) continue; // keep `cur` across blank lines (conda splits headers from items with blanks)
    // Section header: a ❌/✅ glyph followed by a name (optionally trailing ":").
    const hdr = line.match(/^[❌✅]\s*(.+?)\s*:?\s*$/);
    if (hdr) {
      const name = hdr[1].replace(/:\s*$/, "").trim();
      cur = { name, items: 0 };
      if (line.startsWith("❌")) problemSections.push(cur);
      continue;
    }
    // Item line under a problem section: "pkg-spec-1.2.3-hash_1: 61"
    if (cur) {
      const m = line.match(/:\s*(\d+)\s*$/);
      if (m) cur.items += parseInt(m[1], 10);
    }
  }

  const real = problemSections.filter((p) => p.items > 0);
  if (real.length === 0) {
    return { status: "ok", summary: "conda environment healthy", detail: t };
  }
  const total = real.reduce((a, p) => a + p.items, 0);
  const detail = real.map((p) => `${p.name}: ${p.items}`).join("\n");
  return {
    status: "warn",
    summary: `conda doctor: ${real.length} check${real.length === 1 ? "" : "s"} failed (${total} affected files)`,
    detail,
  };
}
