// Offline runtime EOL database for devmap's security layer (P1, product-plan.md).
//
// POSITIONING (decided 2026-08-06):
//   devmap's security layer is NOT a CVE database of its own. Building a hand-curated CVE
//   library would (a) directly compete with OSV-Scanner / govulncheck / pip-audit / Trivy,
//   all of which have continuously-updated feeds devmap cannot match offline, and (b) violate
//   devmap's "全本地、可离线" principle. Instead:
//     - THIS file handles the honest, OFFLINE part: runtime END-OF-LIFE. EOL dates are
//       slow-changing and can be shipped in-repo without a network dependency.
//     - Real dependency-CVE scanning is an ADAPTER (see ./sca.ts) that shells out to the
//       user's already-installed SCA tools and merges their output into devmap's unified view.
//       It is strictly opt-in (--audit-deps) because those tools fetch vuln DBs over the network.
//
// DATA VERIFIED against upstream sources on 2026-08-06:
//   - Node.js: https://endoflife.date/node  (date = end of security support)
//   - Python : https://devguide.python.org/versions/  (date = end-of-life)
//   - Go     : https://endoflife.date/go  (each major supported ~12 months; date = EOL)

export interface RuntimeAdvisory {
  /**
   * EOL lookup table.
   * Key = version prefix to match against the detected version:
   *   - Node.js / Go: major only ("20", "1.24")
   *   - Python      : major.minor ("3.10") because Python EOLs per minor
   * Value = EOL date (YYYY-MM-DD). If the date is in the past, the install is flagged `stale`/warn.
   * Versions whose major/minor is NOT a key are treated as still-supported (no flag).
   */
  eolByVersion: Record<string, string>;
}

export const RUNTIME_ADVISORIES: Record<string, RuntimeAdvisory> = {
  node: {
    eolByVersion: {
      "16": "2023-09-11",
      "18": "2025-04-30",
      "20": "2026-04-30", // Maintenance LTS; security support ended 2026-04-30
      "22": "2027-04-30", // Maintenance LTS (Jod); still supported
      "24": "2028-04-30", // Active LTS (Krypton); supported
      "26": "2029-04-30", // Current (upcoming LTS); supported
      // odd lines (17/19/21/23/25) are short-lived and EOL'd quickly; not enumerated here
    },
  },
  python: {
    eolByVersion: {
      "3.7": "2023-06-27",
      "3.8": "2024-10-07",
      "3.9": "2025-10-31",
      "3.10": "2026-10-31", // security-only support until 2026-10-31
      "3.11": "2027-10-31",
      "3.12": "2028-10-31",
      "3.13": "2029-10-31",
    },
  },
  go: {
    eolByVersion: {
      "1.20": "2024-02-06",
      "1.21": "2024-08-13",
      "1.22": "2025-02-11",
      "1.23": "2025-08-12",
      "1.24": "2026-02-11", // EOL as of 2026-02-11
      // 1.25 / 1.26: supported (no EOL yet)
    },
  },
  // rustc: continuous 6-week release train, no fixed per-version EOL schedule -> omitted for now
};
