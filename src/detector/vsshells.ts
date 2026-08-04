// Visual Studio dev shell detector (Phase 2): enumerates the VS dev shells ("Developer Command
// Prompt" / "Developer PowerShell" / "Native Tools") and locates the toolchain (cl/msbuild/cmake/
// dotnet) each of them exposes.
//
// Pitfall we hit: sourcing the shell via `call VsDevCmd.bat && (...)` does not work. When called
// non-interactively, VsDevCmd.bat runs `exit` on the whole cmd process, so the diagnostic commands
// after it never run and the output comes back empty -- which we would misreport as "no toolchain".
// The right approach: a dev shell is really just VS install-tree directories prepended to PATH, so
// scanning the fixed locations inside the VS install tree
// (VC\Tools\MSVC\<ver>\bin\Host<arch>\<arch>\cl.exe and friends) tells us which tools each dev shell
// exposes -- and it is both more reliable and faster.
import { register } from "./registry";
import { run, IS_WIN, whichInDirs, pathDirs } from "../platform/exec";
import { makeCheck } from "../check/model";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Check, VsShellInfo } from "../types";

const VS_BASES = [
  "C:\\Program Files\\Microsoft Visual Studio",
  "C:\\Program Files (x86)\\Microsoft Visual Studio",
];
const START_MENU = [
  "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "C:\\Users\\Administrator\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
];

const EDITIONS = ["Community", "Professional", "Enterprise", "BuildTools"];

// VS install-tree layout: <Base>\<version>\<Edition>\..., e.g.
//   C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat
// The toolchain (cl/msbuild/cmake) lives below the Edition directory, so we must descend all the
// way to the Edition level to resolve it correctly.
function vsRoots(): string[] {
  const roots: string[] = [];
  for (const b of VS_BASES) {
    if (!existsSync(b)) continue;
    for (const v of readdirSync(b)) {
      const verDir = join(b, v);
      if (!existsSync(verDir) || !statSync(verDir).isDirectory()) continue;
      // Does the version directory contain edition subdirectories (the standard layout)? If so,
      // descend into them; otherwise the version directory itself is the toolchain root (fallback
      // for rare layouts).
      const hasEdition = EDITIONS.some((e) => { const ed = join(verDir, e); return existsSync(ed) && statSync(ed).isDirectory(); });
      if (hasEdition) {
        for (const e of EDITIONS) {
          const ed = join(verDir, e);
          if (existsSync(ed) && statSync(ed).isDirectory()) roots.push(ed);
        }
      } else {
        roots.push(verDir);
      }
    }
  }
  return roots;
}

// Sort MSVC toolset directories by version, highest first (e.g. 14.51 > 14.29), so we pick cl from
// the newest toolset.
function msvcVersionsDesc(msvc: string): string[] {
  let vers: string[] = [];
  try { vers = readdirSync(msvc); } catch { return []; }
  return vers.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

function vsCl(root: string, arch: string): string | null {
  const msvc = join(root, "VC", "Tools", "MSVC");
  if (!existsSync(msvc)) return null;
  for (const v of msvcVersionsDesc(msvc)) {
    const p = join(msvc, v, "bin", `Host${arch}`, arch, "cl.exe");
    if (existsSync(p)) return p;
  }
  return null;
}
function vsMsbuild(root: string): string | null {
  const base = join(root, "MSBuild");
  if (!existsSync(base)) return null;
  const cands = [join(base, "Current", "Bin", "MSBuild.exe")];
  try {
    for (const v of readdirSync(base)) cands.push(join(base, v, "Bin", "MSBuild.exe"));
  } catch {
    /* ignore */
  }
  return cands.find((c) => existsSync(c)) || null;
}
function vsCMake(root: string): string | null {
  const p = join(root, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe");
  return existsSync(p) ? p : null;
}
function vsDotnet(): string | null {
  return whichInDirs("dotnet", pathDirs())[0] || null;
}

/** Aggregate toolchain locations across every VS install tree (a hit in any root counts). */
function scanToolchain(): { cl_x64: string | null; cl_x86: string | null; cl_arm64: string | null; msbuild: string | null; cmake: string | null; dotnet: string | null } {
  const out = { cl_x64: null, cl_x86: null, cl_arm64: null, msbuild: null, cmake: null, dotnet: vsDotnet() };
  for (const r of vsRoots()) {
    if (!out.cl_x64) out.cl_x64 = vsCl(r, "x64");
    if (!out.cl_x86) out.cl_x86 = vsCl(r, "x86");
    if (!out.cl_arm64) out.cl_arm64 = vsCl(r, "arm64");
    if (!out.msbuild) out.msbuild = vsMsbuild(r);
    if (!out.cmake) out.cmake = vsCMake(r);
  }
  return out;
}

/** Recursively collect Start Menu .lnk names matching a "dev shell" (the entries users actually see). */
function shortcutNames(): string[] {
  const names: string[] = [];
  const stack = [...START_MENU.filter((d) => existsSync(d))];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e);
      try {
        if (statSync(full).isDirectory()) stack.push(full);
        else if (e.toLowerCase().endsWith(".lnk") && /developer|native tools|vs 20/i.test(e)) names.push(e.replace(/\.lnk$/i, ""));
      } catch {
        /* ignore */
      }
    }
  }
  return names;
}

function inferKindArch(name: string): { kind: "command" | "powershell"; arch: string } {
  const kind: "command" | "powershell" = /powershell/i.test(name) ? "powershell" : "command";
  const am = name.match(/x64|x86|arm64/i);
  const arch = am ? am[0].toLowerCase() : "auto";
  return { kind, arch };
}

// VsDevCmd.bat / Launch-VsDevShell.ps1 are only referenced as entry points (never sourced).
function entryRef(kind: "command" | "powershell"): string | null {
  const fn = kind === "powershell" ? "Launch-VsDevShell.ps1" : "VsDevCmd.bat";
  for (const r of vsRoots()) {
    const p = join(r, "Common7", "Tools", fn);
    if (existsSync(p)) return p;
  }
  return null;
}

register({
  name: "vsshells",
  scan() {
    const checks: Check[] = [];
    if (!IS_WIN) return { data: { shells: [] }, checks };

    const tc = scanToolchain();
    const names = shortcutNames();
    const shells: VsShellInfo[] = [];
    const seen = new Set<string>();
    const anyCl = !!(tc.cl_x64 || tc.cl_x86 || tc.cl_arm64);

    for (const name of names) {
      const { kind, arch } = inferKindArch(name);
      const key = `${kind}:${arch}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // The cl this shell exposes: Native Tools uses its own arch; Developer (auto) defaults to x64.
      const clPath = arch === "auto" ? tc.cl_x64 : (tc as any)[`cl_${arch}`];
      const tools: Record<string, string | null> = {
        cl: clPath,
        msbuild: tc.msbuild,
        cmake: tc.cmake,
        dotnet: tc.dotnet,
      };
      shells.push({ name, kind, arch, entry: entryRef(kind), pathDirs: Object.values(tools).filter(Boolean).length, tools });
    }

    if (shells.length) {
      checks.push(
        makeCheck(
          "vs.shells",
          "mismatch",
          "info",
          `Found ${shells.length} Visual Studio dev shells`,
          shells.map((s) => s.name).join("; "),
          shells.map((s) => s.entry || s.name),
        ),
      );
    }
    if (shells.length && !anyCl) {
      checks.push(
        makeCheck(
          "vs.no-vc-tools",
          "missing",
          "warn",
          "Visual Studio is installed but no cl.exe was found (the \"Desktop development with C++\" workload may be missing)",
          "Dev shells will have no MSVC toolchain; select the C++ workload in the Visual Studio Installer",
          vsRoots(),
        ),
      );
    }

    return { data: { shells }, checks };
  },
});
