// WSL detector (Phase 2): enumerates WSL distros, reports where they are installed, and optionally
// snapshots the tools inside them.
//
// Two pitfalls, both confirmed on real machines:
//  1. **wsl.exe writes UTF-16LE**: decoding it as utf8 yields "U\0b\0u\0n\0t\0u\0", the regexes
//     silently fail to match → 2 installed distros get reported as 0. exec.decodeOutput now sniffs
//     the encoding and decodes accordingly.
//  2. **Probing wakes distros up**: `wsl -d <name> bash -lc ...` boots a Stopped distro. That is
//     slow (a cold start takes seconds to tens of seconds) and has a side effect: it changes the
//     state of the user's machine. So by default we only probe distros that are **already running**;
//     probing everything requires an explicit --wsl-deep.
import { register } from "./registry";
import { runAsync, IS_WIN, pool } from "../platform/exec";
import { makeCheck } from "../check/model";
import type { Check, WslDistro } from "../types";

const PROBE_SCRIPT =
  "echo py3=$(command -v python3); echo py=$(command -v python); echo node=$(command -v node); " +
  "echo go=$(command -v go); echo rustc=$(command -v rustc); echo gcc=$(command -v gcc); " +
  "echo git=$(command -v git); echo docker=$(command -v docker)";

const TOOL_KEYS = ["py3", "py", "node", "go", "rustc", "gcc", "git", "docker"] as const;

async function probeDistro(name: string): Promise<Record<string, string | null>> {
  const tools: Record<string, string | null> = {};
  for (const k of TOOL_KEYS) tools[k] = null;
  const out = await runAsync("wsl", ["-d", name, "--", "bash", "-lc", PROBE_SCRIPT], 20000);
  if (!out) return tools;
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\w+)=(.*)$/);
    if (m && m[1] in tools) tools[m[1]] = m[2].trim() || null;
  }
  return tools;
}

/**
 * Read each distro's rootfs install location from the registry (answers "where is it installed").
 * DistributionName / BasePath live under
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss\{guid}.
 */
async function distroBasePaths(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!IS_WIN) return map;
  const root = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
  const keysRaw = await runAsync("reg", ["query", root], 5000);
  if (!keysRaw) return map;
  const keys = keysRaw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((k) => /\\\{[0-9a-fA-F-]+\}$/.test(k));
  const details = await pool(keys, 8, (k) => runAsync("reg", ["query", k], 5000));
  for (const detail of details) {
    if (!detail) continue;
    const nameM = detail.match(/DistributionName\s+REG_SZ\s+(.+)/);
    const baseM = detail.match(/BasePath\s+REG_SZ\s+(.+)/);
    if (nameM) map.set(nameM[1].trim(), baseM ? baseM[1].trim() : "");
  }
  return map;
}

/** Parse the `wsl -l -v` table. Distro names may contain spaces, so columns split on 2+ spaces. */
function parseList(raw: string): WslDistro[] {
  const distros: WslDistro[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.replace(/\u0000/g, "").trimEnd();
    if (!t.trim()) continue;
    if (/^\s*\*?\s*NAME\s+STATE\s+VERSION/i.test(t)) continue; // header row
    if (/^[\s-]+$/.test(t)) continue;
    // `* Ubuntu-22.04    Stopped         2`
    const m = t.match(/^(\*?)\s*(\S.*?)\s{2,}(\S+)\s+(\d+)\s*$/);
    if (!m) continue;
    distros.push({ name: m[2].trim(), state: m[3].trim(), version: m[4], default: m[1] === "*" });
  }
  return distros;
}

register({
  name: "wsl",
  async scan(ctx) {
    const checks: Check[] = [];
    if (!IS_WIN) return { data: { available: false, distros: [] }, checks };

    const raw = await runAsync("wsl", ["-l", "-v"], 8000);
    if (!raw) return { data: { available: false, distros: [] }, checks };

    const distros = parseList(raw);
    const bases = await distroBasePaths();
    for (const d of distros) {
      const bp = bases.get(d.name);
      if (bp) d.basePath = bp;
    }

    // Only probe running distros by default; --wsl-deep also wakes Stopped ones (see pitfall 2 above).
    const deep = ctx.wslDeep === true;
    const targets = distros.filter((d) => deep || /running/i.test(d.state));
    if (targets.length) {
      ctx.progress?.sub(`wsl · probing ${targets.length} distros`);
      const toolsList = await pool(targets, 4, (d) => probeDistro(d.name));
      targets.forEach((d, i) => {
        d.tools = toolsList[i];
        d.probed = true;
      });
    }
    for (const d of distros) if (!d.probed) d.probed = false;

    if (distros.length && !distros.some((d) => d.default)) {
      checks.push(
        makeCheck("wsl.no-default", "mismatch", "info", "WSL has no default distro", "Set one with wsl --set-default <name>", distros.map((d) => d.name)),
      );
    }
    const skipped = distros.filter((d) => !d.probed);
    if (skipped.length) {
      checks.push(
        makeCheck(
          "wsl.not-probed",
          "mismatch",
          "info",
          `${skipped.length} WSL distros were not probed for internal tools (not running)`,
          "Stopped distros are not woken up by default, to keep the scan fast; pass --wsl-deep to probe them all",
          skipped.map((d) => `${d.name}(${d.state})`),
        ),
      );
    }

    return { data: { available: true, distros }, checks };
  },
});
