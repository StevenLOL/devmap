// apt detector (Phase 2): Linux-only. Enumerate installed packages via `apt list --installed` + upgradable via `apt list --upgradable`.
// On Windows, available:false directly (apt absent) -- no error, no blocking.
import { register } from "./registry";
import { runAsync, IS_WIN } from "../platform/exec";
import { makeCheck } from "../check/model";
import type { Check, PkgInfo } from "../types";

function parseApt(out: string): PkgInfo[] {
  const pkgs: PkgInfo[] = [];
  for (const line of out.split("\n")) {
    // format: zlib1g:amd64/stable,now 1:1.2.11.dfsg-1 amd64 [installed]
    const m = line.match(/^([^:\s]+)(?::[^\s]+)?\S*\s+(\S+)\s/);
    if (m) pkgs.push({ name: m[1], version: m[2] });
  }
  return pkgs;
}

register({
  name: "apt",
  async scan() {
    const checks: Check[] = [];
    if (IS_WIN) return { data: { available: false, count: 0, packages: [], upgradable: 0 }, checks };

    const [installedRaw, upRaw] = await Promise.all([
      runAsync("apt", ["list", "--installed"], 20000),
      runAsync("apt", ["list", "--upgradable"], 15000),
    ]);
    const packages = installedRaw ? parseApt(installedRaw) : [];
    const upgradable = upRaw ? parseApt(upRaw).length : 0;

    if (upgradable > 0) {
      checks.push(
        makeCheck(
          "apt.upgradable",
          "stale",
          "info",
          `apt has ${upgradable} upgradable packages`,
          `Run sudo apt upgrade to update; or apt list --upgradable to view`,
          [],
        ),
      );
    }
    return { data: { available: true, count: packages.length, packages, upgradable }, checks };
  },
});
