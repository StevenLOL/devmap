// Windows pre-flight oracle -- the battlefield where AI agents die most often (optimization doc §2.B,
// derived from docs/03_Windows_agent大战PowerShell对本项目的启发.md).
//
// devmap's own source already solved GBK mojibake / UTF-16LE decoding / schannel evasion / the
// WindowsApps pseudo-symlink trap (see src/glyphs.ts, src/platform/exec.ts). This detector turns those
// hard-won lessons into EXPLICIT health checks so an agent can read the machine's real constraints
// *before* it shells out a command and gets "could not be parsed safely" (gemini-cli #12519) or silent
// UTF-8 corruption. It is the concrete landing spot for the agent pre-flight thesis.
//
// Six checks (all local, zero telemetry):
//   win.execpolicy    Restricted/AllSigned blocks agent scripts            -> warn
//   win.langmode      Constrained Language Mode / WDAC blocks agent cmds   -> error
//   win.console.cp    non-65001 codepage corrupts UTF-8 subprocess output  -> info
//   win.schannel      cert revocation check on (curl CRYPT_E_NO_REVOCATION)  -> warn
//   win.appalias      App Execution Alias shadows real python/curl          -> info
//   win.safedelete    safe-delete shim fails deletes closed (agent cleanup) -> warn
//
// IMPORTANT: this detector inherits the ASCII-only discipline (src/glyphs.ts `clean`) so the oracle
// itself never mojibakes inside a GBK console -- that would be the irony of ironies.
import { readdirSync, lstatSync } from "node:fs";
import type { ScanContext } from "./registry";
import { join } from "node:path";
import { register } from "./registry";
import { makeCheck } from "../check/model";
import { run, pathDirs, IS_WIN } from "../platform/exec";

/** Probe surface the Windows detector depends on. Injected so tests are deterministic. */
export interface WinProbe {
  isWin: boolean;
  execPolicy: () => string; // raw output of `powershell -NoProfile -Command "Get-ExecutionPolicy -List"`
  languageMode: () => string | null; // $ExecutionContext.SessionState.LanguageMode (null if unreadable)
  codepage: () => number | null; // active console code page (null if unreadable)
  schannelRevokeEnabled: () => boolean | null; // true => cert revocation check ON (curl breakage)
  appAliases: () => { tool: string; target: string }[]; // WindowsApps APPEXECLINK entries found on PATH
  safeDeleteActive: () => boolean; // true => deletion is fail-closed (agent cleanup silently fails)
}

const realProbe: WinProbe = {
  isWin: IS_WIN,
  execPolicy: () => run("powershell", ["-NoProfile", "-Command", "Get-ExecutionPolicy -List"]),
  languageMode: () => {
    const out = run("powershell", [
      "-NoProfile",
      "-Command",
      "$ExecutionContext.SessionState.LanguageMode",
    ]);
    return out ? out.trim() : null;
  },
  codepage: () => {
    const out = run("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding.CodePage"]);
    const n = parseInt((out || "").trim(), 10);
    return Number.isFinite(n) ? n : null;
  },
  schannelRevokeEnabled: () => {
    // Probe: can we reach a TLS endpoint with the *default* schannel settings? If the default
    // (revocation check ON) fails but --ssl-no-revoke works, revocation checking is the culprit.
    const url = "https://github.com";
    const def = run("curl", ["-sS", "-o", "nul", "-w", "%{http_code}", "--max-time", "6", url]);
    if (def && /^2|3/.test(def.trim())) return false; // default works -> revocation check not blocking
    const bypass = run("curl", [
      "-sS",
      "-o",
      "nul",
      "-w",
      "%{http_code}",
      "--ssl-no-revoke",
      "--max-time",
      "6",
      url,
    ]);
    if (bypass && /^2|3/.test(bypass.trim())) return true; // default blocked, bypass works -> revocation ON
    return null; // could not determine (offline); degrade to info, not a false alarm
  },
  appAliases: () => {
    const found: { tool: string; target: string }[] = [];
    if (!IS_WIN) return found;
    for (const dir of pathDirs()) {
      if (!/[\\/]microsoft[\\/]windowsapps[\\/]?$/i.test(dir)) continue;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = join(dir, e);
        let st;
        try {
          st = lstatSync(full);
        } catch {
          continue;
        }
        // App Execution Aliases are reparse points (IO_REPARSE_TAG_APPEXECLINK); lstat reports them
        // as symlinks. The WindowsApps store dir contains ONLY these aliases, so any symlink here is
        // one. We don't try to resolve the target (it isn't a realpath we can stat).
        if (st.isSymbolicLink()) {
          found.push({ tool: e, target: "WindowsApps (App Execution Alias)" });
        }
      }
    }
    return found;
  },
  safeDeleteActive: () => {
    // The sandbox safe-delete shim sets this env when active (see docs memory: "safe-delete shim").
    return !!process.env.CODEBUDDY_SAFE_DELETE_SANDBOX;
  },
};

// Offline variant for fast/pre-flight mode: the schannel revocation probe is a network call to
// github.com (up to ~12s when the endpoint is slow/unreachable). A pre-flight oracle must stay
// offline-fast, so we report schannelRevokeCheck as null (unknown) instead of probing the network.
// The full scan still runs the real probe for completeness.
const offlineProbe: WinProbe = { ...realProbe, schannelRevokeEnabled: () => null };

export interface WinPreflight {
  windows: boolean;
  executionPolicy?: { scope: string; level: string }[];
  languageMode?: string | null;
  codepage?: number | null;
  schannelRevokeCheck?: boolean | null;
  appAliases?: { tool: string; target: string }[];
  safeDeleteActive?: boolean;
}

/**
 * Parse `Get-ExecutionPolicy -List` raw output into scope/level pairs.
 * Example line: "MachinePolicy    Undefined" or "CurrentUser       RemoteSigned".
 */
export function parseExecPolicy(out: string): { scope: string; level: string }[] {
  const rows: { scope: string; level: string }[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const m = raw.trim().match(/^([A-Za-z]+)\s+(\S+)$/);
    if (m && /policy/i.test(raw) === false && m[2] !== "Undefined") {
      // skip header row ("Scope  ExecutionPolicy")
      if (/scope/i.test(m[1])) continue;
      rows.push({ scope: m[1], level: m[2] });
    }
  }
  return rows;
}

/**
 * Pure detection logic. `plat` defaults to the real machine probes. On non-Windows returns
 * `{ windows: false }` with no checks -- the Windows oracle is meaningless off Windows, and emitting
 * noise there would dilute its signal.
 */
export function detectWindows(plat: WinProbe = realProbe): { data: WinPreflight; checks: any[] } {
  if (!plat.isWin) return { data: { windows: false }, checks: [] };

  const checks: any[] = [];
  const data: WinPreflight = { windows: true };

  // 1) Execution policy -- Restricted/AllSigned blocks agent-generated scripts.
  //    Effective policy follows precedence MachinePolicy > UserPolicy > Process > CurrentUser >
  //    LocalMachine; when EVERY scope is Undefined, PowerShell's built-in default is Restricted,
  //    so we must treat "all Undefined" as Restricted rather than silently reporting nothing.
  const epOut = plat.execPolicy();
  const ep = parseExecPolicy(epOut);
  data.executionPolicy = ep;
  const EP_ORDER = ["MachinePolicy", "UserPolicy", "Process", "CurrentUser", "LocalMachine"];
  const defined = EP_ORDER.map((s) => ep.find((r) => r.scope === s)).filter(Boolean) as {
    scope: string;
    level: string;
  }[];
  const effective = defined.length ? defined[0].level : "Restricted";
  if (/^(Restricted|AllSigned)$/i.test(effective)) {
    checks.push(
      makeCheck(
        "win.execpolicy",
        "mismatch",
        "warn",
        `PowerShell execution policy is '${effective}' (blocks script execution)`,
        `Agent-generated .ps1 scripts will be refused under policy '${effective}'. Set RemoteSigned (or Bypass for the agent session) so the agent can run commands.`,
        [],
      ),
    );
  }

  // 2) Language mode -- Constrained Language Mode / WDAC / AppLocker reject agent commands outright.
  const lm = plat.languageMode();
  data.languageMode = lm;
  if (lm && /constrained/i.test(lm)) {
    checks.push(
      makeCheck(
        "win.langmode",
        "mismatch",
        "error",
        "PowerShell is in Constrained Language Mode (agent commands will be rejected)",
        "Constrained Language Mode (often enforced via WDAC / AppLocker / Device Guard) strips cmdlets and .NET calls agents rely on. This is a hard blocker -- the agent cannot operate until the policy is relaxed for its session.",
        [],
      ),
    );
  }

  // 3) Console code page -- a non-UTF-8 codepage corrupts UTF-8 subprocess output.
  const cp = plat.codepage();
  data.codepage = cp;
  if (cp !== null && cp !== 65001) {
    checks.push(
      makeCheck(
        "win.console.cp",
        "mismatch",
        "info",
        `Console code page is ${cp} (not UTF-8 65001)`,
        `Subprocess UTF-8 output will be decoded with the legacy code page (e.g. GBK) and mojibake. devmap emits ASCII-safe glyphs on Windows, but package managers / tool output may still corrupt. Run 'chcp 65001' or use Windows Terminal.`,
        [],
      ),
    );
  }

  // 4) Schannel cert revocation -- when ON, curl fails with CRYPT_E_NO_REVOCATION_CHECK.
  const revoke = plat.schannelRevokeEnabled();
  data.schannelRevokeCheck = revoke;
  if (revoke === true) {
    checks.push(
      makeCheck(
        "win.schannel",
        "mismatch",
        "warn",
        "Schannel certificate revocation check is blocking network fetches",
        "curl/pip/git report CRYPT_E_NO_REVOCATION_CHECK because the revocation server is unreachable. Pass --ssl-no-revoke to curl (and the equivalent to git/Invoke-WebRequest) or disable revocation check in schannel.",
        [],
      ),
    );
  }

  // 5) App Execution Aliases -- python/curl resolve to WindowsApps shims instead of real installs.
  const aliases = plat.appAliases();
  data.appAliases = aliases;
  if (aliases.length) {
    checks.push(
      makeCheck(
        "win.appalias",
        "mismatch",
        "info",
        `${aliases.length} App Execution Alias(es) shadow real tools on PATH`,
        `These resolve to the Microsoft Store stub rather than a real install: ${aliases
          .map((a) => a.tool)
          .join(", ")}. If 'python'/'curl' behave oddly, disable the alias in Settings > Apps > Advanced app execution aliases.`,
        aliases.map((a) => a.tool),
      ),
    );
  }

  // 6) Safe-delete shim -- deletions are fail-closed, so agent cleanup silently does nothing.
  const sd = plat.safeDeleteActive();
  data.safeDeleteActive = sd;
  if (sd) {
    checks.push(
      makeCheck(
        "win.safedelete",
        "mismatch",
        "warn",
        "Safe-delete shim is active (deletions fail closed)",
        "A sandbox safe-delete shim intercepts removals and fails them closed. Agent cleanup steps (rm / shutil) will silently no-op -- temp artifacts accumulate and 'did it delete?' checks are misleading.",
        [],
      ),
    );
  }

  return { data, checks };
}

register({
  name: "windows",
  async scan(ctx: ScanContext) {
    const { data, checks } = detectWindows(ctx?.fast ? offlineProbe : realProbe);
    return { data, checks };
  },
});
