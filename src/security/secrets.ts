// Security layer — SECRET SCANNER (P2, the last dimension of the security layer).
//
// devmap does NOT ship a CVE database (see ./scan.ts + ./sca.ts), but hardcoded-credential
// detection is a different, fully-offline capability: it is rule-based pattern matching over a
// CURATED allowlist of credential/config files in the user's HOME and project roots. No network,
// no file-tree traversal, no reading of source code. This makes it safe to ship as an OPT-IN
// check (default OFF) that respects the "全本地、可离线、只读不修" principles.
//
// Design guardrails (privacy + noise):
//   - Only a fixed allowlist of well-known credential files is inspected (never arbitrary traversal).
//   - Files larger than 512 KB are skipped (config files are small).
//   - Every matched secret value is REDACTED before it touches any output (prefix + "****" + len).
//     The full secret NEVER appears in the manifest, --json, --report, or logs.
//   - Generic assignment patterns are gated by a light entropy/length heuristic to cut trivial
//     false positives (e.g. `debug = true`).
//   - Enable with --scan-secrets. Disable the whole security layer (incl. this) via --disable security.
import type { Check } from "../types";
import { makeCheck } from "../check/model";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

// ---------------- rules ----------------

interface SecretRule {
  name: string;
  re: RegExp; // must carry the `g` flag (we reset lastIndex per line)
  capture?: boolean; // if true, redact the captured group; else use `mask`
  captureGroup?: number; // which capture group holds the secret (default 1)
  mask?: string; // shown when capture is false
  generic?: boolean; // subject to entropy/length gating + per-line dedup against high-confidence rules
}

const RULES: SecretRule[] = [
  { name: "AWS Access Key ID", re: /\b(AKIA[0-9A-Z]{16})\b/g, capture: true },
  { name: "AWS Secret Access Key", re: /aws_secret_access_key\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi, capture: true },
  { name: "GitHub Token", re: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/g, capture: true },
  { name: "GitLab Personal Access Token", re: /\bglpat-[A-Za-z0-9_-]{20}\b/g, capture: true },
  { name: "Slack Token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, capture: true },
  {
    name: "Slack Incoming Webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
    capture: false,
    mask: "https://hooks.slack.com/services/***",
  },
  { name: "Stripe Secret Key", re: /\bsk_live_[A-Za-z0-9]{24,}\b/g, capture: true },
  { name: "OpenAI API Key", re: /\bsk-[A-Za-z0-9]{20,}\b/g, capture: true },
  { name: "GCP API Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, capture: true },
  { name: "Google OAuth Client Secret", re: /"client_secret"\s*:\s*"([A-Za-z0-9-_]{20,})"/g, capture: true },
  {
    name: "Private Key Block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    capture: false,
    mask: "[PRIVATE KEY BLOCK]",
  },
  { name: "Bearer Token", re: /\bBearer\s+([A-Za-z0-9._-]{20,})\b/g, capture: true },
  { name: "Database URL with password", re: /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^:/\s]+:([^@\s]+)@/gi, capture: true },
  { name: "npm authToken", re: /\/\/registry\.npmjs\.org\/:_authToken=([A-Za-z0-9_]{36,})/g, capture: true },
  {
    name: "Git URL with embedded credentials",
    re: /[a-z]+:\/\/([^\s:@/]+):([^\s:@/]+)@/gi,
    capture: true,
    captureGroup: 2, // redact the password, keep the username visible for context
  },
  {
    name: "Generic Secret Assignment",
    re: /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret|passwd|password|token)\s*[=:]\s*['"]?([A-Za-z0-9/+=_\-]{8,64})['"]?/gi,
    capture: true,
    generic: true,
  },
];

function redactText(v: string): string {
  if (v.length <= 4) return "*".repeat(v.length);
  return v.slice(0, 4) + "****" + (v.length > 8 ? " (len " + v.length + ")" : "");
}

// Light entropy/length gate so `token = abc` / `debug = true` do not trip the generic rule.
function looksSecret(v: string): boolean {
  if (v.length >= 32) return true;
  if (v.length < 12) return false;
  let classes = 0;
  if (/[a-z]/.test(v)) classes++;
  if (/[A-Z]/.test(v)) classes++;
  if (/[0-9]/.test(v)) classes++;
  if (/[^A-Za-z0-9]/.test(v)) classes++;
  return classes >= 3;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toRel(p: string): string {
  const home = homedir();
  const lower = p.replace(/\\/g, "/");
  const homeLower = home.replace(/\\/g, "/");
  if (lower.startsWith(homeLower)) return "~" + lower.slice(homeLower.length);
  try {
    const r = relative(process.cwd(), p).replace(/\\/g, "/");
    if (!r.startsWith("..") && !isAbsolute(r)) return r;
  } catch {
    /* ignore */
  }
  return p;
}

// ---------------- file discovery (curated allowlist only) ----------------

function discoverFiles(projectRoots: string[], includeHome: boolean): string[] {
  const home = homedir();
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    try {
      if (existsSync(p) && statSync(p).isFile()) {
        const rp = p.replace(/\\/g, "/");
        if (!seen.has(rp)) {
          seen.add(rp);
          out.push(p);
        }
      }
    } catch {
      /* ignore unreadable */
    }
  };

  if (includeHome) {
    const homeFiles = [
      ".env",
      ".bashrc",
      ".zshrc",
      ".bash_profile",
      ".profile",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".git-credentials",
      ".gitconfig",
      ".docker/config.json",
      ".kube/config",
      ".aws/credentials",
      ".config/gcloud/application_default_credentials.json",
      ".azure/accessTokens.json",
      ".ssh/id_rsa",
      ".ssh/id_ecdsa",
      ".ssh/id_ed25519",
      ".ssh/id_dsa",
      ".envrc",
    ];
    for (const f of homeFiles) add(join(home, f));
    // top-level .env.* variants in HOME (e.g. .env.production)
    try {
      for (const e of readdirSync(home)) {
        if (e.startsWith(".env") && e !== ".env") add(join(home, e));
      }
    } catch {
      /* ignore */
    }
  }

  const roots = [...new Set([process.cwd(), ...projectRoots])];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (
        e === ".env" ||
        e.startsWith(".env.") ||
        e === ".envrc" ||
        e === ".npmrc" ||
        e === ".pypirc" ||
        e === ".netrc" ||
        e === ".gitconfig" ||
        e === "credentials.json" ||
        e === "secrets.json" ||
        e.endsWith(".pem") ||
        e.endsWith(".key") ||
        e.endsWith(".p12") ||
        e.endsWith(".pfx") ||
        /^service-?account.*\.json$/i.test(e)
      ) {
        add(join(root, e));
      }
    }
    add(join(root, ".git", "config"));
  }
  return out;
}

// ---------------- public API ----------------

/**
 * Scan a curated allowlist of credential/config files for hardcoded secrets.
 * OFFLINE + OPT-IN (call only when the user passed --scan-secrets). Never returns the raw secret.
 * @param projectRoots extra roots to scan (in addition to cwd); default scans cwd only.
 * @param includeHome also scan well-known dotfiles in $HOME (default true for the CLI; tests pass false).
 */
export function scanSecrets(projectRoots: string[] = [], includeHome = true): Check[] {
  const files = discoverFiles(projectRoots, includeHome);
  const checks: Check[] = [];
  let scanned = 0;

  for (const f of files) {
    let content: string;
    try {
      const st = statSync(f);
      if (!st.isFile() || st.size > 512 * 1024) continue; // size guard
      content = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    scanned++;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const accepted: Array<[number, number]> = []; // spans already flagged by high-confidence rules
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.re.exec(line)) !== null) {
          if (m.index === rule.re.lastIndex) rule.re.lastIndex++; // guard against zero-width loops
          const start = m.index;
          const end = start + m[0].length;
          if (rule.generic === true) {
            const val = (rule.captureGroup ? m[rule.captureGroup] : m[1]) || m[0];
            if (!looksSecret(val)) continue;
            // skip if it overlaps a span already flagged by a high-confidence rule on this line
            if (accepted.some(([s, e]) => start < e && end > s)) continue;
          }
          const masked = redactValue(rule, m);
          const rel = toRel(f);
          const id = `security.secrets.${slug(rule.name)}.${checks.length + 1}`;
          checks.push(
            makeCheck(
              id,
              "secret",
              "warn",
              `${rule.name} in ${rel}:${i + 1} (${masked})`,
              `${rule.name} detected at ${f}:${i + 1}. The value is redacted (${masked}) and never printed in full. ` +
                `Rotate or remove the credential and prefer a secret manager or build-time env injection.`,
              [f],
            ),
          );
          accepted.push([start, end]);
        }
      }
    }
  }

  if (checks.length === 0) {
    checks.push(
      makeCheck(
        "security.secrets.ok",
        "secret",
        "info",
        `No hardcoded secrets found in ${scanned} scanned config file(s)`,
        `Scanned ${scanned} credential/config file(s) under HOME and project roots (opt-in --scan-secrets). ` +
          `No known secret patterns matched.`,
        files.slice(0, 20),
      ),
    );
  }
  return checks;
}

function redactValue(rule: SecretRule, m: RegExpExecArray): string {
  if (rule.capture) {
    const g = m[rule.captureGroup ?? 1];
    if (g) return redactText(g);
  }
  return rule.mask ?? "[redacted]";
}
