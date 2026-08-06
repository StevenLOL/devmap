// vcpkg detector (Phase 2): detect the vcpkg binary (possibly multiple copies, same issue as node/npm) + installed package list.
// Note: the earlier pkgmgrs list did not include vcpkg, so devmap was unaware of it; this detector fills that gap.
import { register } from "./registry";
import { whichInDirs, fileExists, pathDirs, IS_WIN, pool } from "../platform/exec";
import { runAsync, runBinAsync } from "../platform/exec";
import { makeCheck } from "../check/model";
import { join } from "node:path";
import type { Install, Check, PkgInfo } from "../types";

const CANDIDATES = [
  "C:\\vcpkg\\vcpkg.exe",
  "C:\\src\\vcpkg\\vcpkg.exe",
  "C:\\tools\\vcpkg\\vcpkg.exe",
  "C:\\vcpkg\\vcpkg",
];

// vcpkg uses a date + commit-hash version scheme (e.g.
// "vcpkg package management program version 2026-07-13-bf04c909169fdbb30821c02c6eb01f1cd1295d05"),
// which is NOT x.y.z, so the generic extractVersion() returns null. Parse it explicitly.
export function parseVcpkgVersion(out: string | null): string | null {
  if (!out) return null;
  const m = out.match(/version\s+(\d{4}-\d{2}-\d{2}(?:-[0-9a-f]+)?)/i);
  return m ? m[1] : null;
}

async function findVcpkg(): Promise<Install[]> {
  const cands: { path: string; onPath: boolean }[] = [];
  const seen = new Set<string>();
  const add = (p: string, onPath: boolean) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    cands.push({ path: p, onPath });
  };
  for (const c of CANDIDATES) if (fileExists(c)) add(c, false);
  if (process.env.VCPKG_ROOT) {
    const p = join(process.env.VCPKG_ROOT, IS_WIN ? "vcpkg.exe" : "vcpkg");
    if (fileExists(p)) add(p, false);
  }
  for (const p of whichInDirs("vcpkg", pathDirs())) add(p, true);

  const versions = await pool(cands, 8, (c) => runBinAsync(c.path, ["version"], 9000).then(parseVcpkgVersion));
  return cands.map((c, i) => ({ path: c.path, onPath: c.onPath, version: versions[i] }));
}

function parseList(out: string): (PkgInfo & { triplet: string })[] {
  const pkgs: (PkgInfo & { triplet: string })[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(\S+?):(\S+)\s+(\S+)/);
    if (m) pkgs.push({ name: m[1], triplet: m[2], version: m[3] });
  }
  return pkgs;
}

register({
  name: "vcpkg",
  async scan() {
    const installs = await findVcpkg();
    const checks: Check[] = [];
    if (!installs.length) return { data: { installed: false, installs: [], packages: [] }, checks };

    const primary = installs[0].path;
    const raw = await runBinAsync(primary, ["list"], 15000);
    const fallback = raw
      ? ""
      : IS_WIN
        ? await runAsync("cmd", ["/c", primary, "list"], 15000)
        : await runAsync(primary, ["list"], 15000);
    const packages = parseList(raw || fallback);

    if (installs.length > 1) {
      checks.push(
        makeCheck(
          "version.multi.vcpkg",
          "conflict",
          "warn",
          `vcpkg has ${installs.length} installed copies`,
          `Multiple vcpkg copies can mix different triplet libraries; active → ${installs[0].path}; others: ${installs.slice(1).map((i) => i.path).join(", ")}`,
          installs.map((i) => i.path),
        ),
      );
    }

    return { data: { installed: true, installs, packages }, checks };
  },
});
