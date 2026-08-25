#!/usr/bin/env node
// @bun

// src/version.ts
var VERSION = "0.4.1";

// src/install.ts
function isIsolated(i) {
  return !i.onPath && !i.env;
}
function locationOf(i) {
  if (i.onPath)
    return "PATH";
  if (i.env)
    return "env";
  return "off-path";
}
function locationTag(i) {
  if (i.onPath)
    return "";
  return i.env ? `env: ${i.env}` : "off-path";
}

// src/detector/registry.ts
var registry = [];
function register(d) {
  registry.push(d);
  return d;
}
async function runDetectors(ctx, progress, names) {
  const byName = {};
  const allChecks = [];
  const selected = names ? registry.filter((d) => names.includes(d.name)) : registry;
  progress?.setTotal(selected.length);
  await Promise.all(selected.map(async (d) => {
    progress?.start(d.name);
    const t0 = Date.now();
    try {
      const r = await d.scan(ctx);
      byName[d.name] = r.data ?? {};
      if (r.checks && r.checks.length)
        allChecks.push(...r.checks);
      progress?.done(d.name, Date.now() - t0, false);
    } catch (e) {
      progress?.done(d.name, Date.now() - t0, true);
      byName[d.name] = { error: String(e?.message || e) };
    }
  }));
  return { byName, allChecks };
}

// src/check/model.ts
function makeCheck(id, kind, severity, label, detail, path = [], fix) {
  const c = { ID: id, Kind: kind, Severity: severity, Label: label, Detail: detail, Path: path };
  if (fix)
    c.Fix = fix;
  return c;
}

// src/platform/exec.ts
import { spawnSync, spawn } from "node:child_process";
import { readdirSync, statSync, lstatSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
var IS_WIN = process.platform === "win32";
var PATH_SEP = IS_WIN ? ";" : ":";
var PATHEXT = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((s) => s.toLowerCase());
function decodeOutput(buf) {
  if (buf.length === 0)
    return "";
  if (buf.length >= 2 && buf[0] === 255 && buf[1] === 254)
    return buf.subarray(2).toString("utf16le");
  if (buf.length >= 3 && buf[0] === 239 && buf[1] === 187 && buf[2] === 191)
    return buf.subarray(3).toString("utf8");
  const sample = Math.min(buf.length, 512);
  let odd = 0;
  let nulOdd = 0;
  for (let i = 1;i < sample; i += 2) {
    odd++;
    if (buf[i] === 0)
      nulOdd++;
  }
  if (odd >= 4 && nulOdd / odd > 0.5)
    return buf.toString("utf16le");
  return buf.toString("utf8");
}
function run(cmd, args = [], timeout = 5000) {
  try {
    const r = spawnSync(cmd, args, { encoding: "buffer", timeout, windowsHide: true });
    if (r.error)
      return "";
    const buf = Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]);
    return decodeOutput(buf).trim();
  } catch {
    return "";
  }
}
var MAX_PROC = 16;
var activeProcs = 0;
var procWaiters = [];
function acquireProc() {
  if (activeProcs < MAX_PROC) {
    activeProcs++;
    return Promise.resolve();
  }
  return new Promise((resolve) => procWaiters.push(resolve)).then(() => {
    activeProcs++;
  });
}
function releaseProc() {
  activeProcs--;
  const next = procWaiters.shift();
  if (next)
    next();
}
async function runAsync(cmd, args = [], timeout = 5000) {
  await acquireProc();
  try {
    return await spawnCollect(cmd, args, timeout);
  } finally {
    releaseProc();
  }
}
function spawnCollect(cmd, args, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (s) => {
      if (settled)
        return;
      settled = true;
      resolve(s);
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch {
      return finish("");
    }
    const chunks = [];
    child.stdout?.on("data", (d) => chunks.push(Buffer.from(d)));
    child.stderr?.on("data", (d) => chunks.push(Buffer.from(d)));
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish("");
    }, timeout);
    child.on("error", () => {
      clearTimeout(timer);
      finish("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(decodeOutput(Buffer.concat(chunks)).trim());
    });
  });
}
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;; ) {
      const i = cursor++;
      if (i >= items.length)
        return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
function wrapBin(binPath, args) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(binPath))
    return ["cmd", ["/c", binPath, ...args]];
  if (IS_WIN && /\.ps1$/i.test(binPath)) {
    const quoted = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(" ");
    return ["powershell", ["-NoProfile", "-Command", `& '${binPath}' ${quoted}`]];
  }
  return [binPath, args];
}
function runBinAsync(binPath, args = [], timeout = 5000) {
  const [c, a] = wrapBin(binPath, args);
  return runAsync(c, a, timeout);
}
function pathDirs() {
  return (process.env.PATH || "").split(PATH_SEP).map((s) => s.trim()).filter(Boolean);
}
function hasExecExt(name) {
  if (!IS_WIN)
    return true;
  const lower = name.toLowerCase();
  return PATHEXT.some((ext) => lower.endsWith(ext));
}
var dirExecCache = new Map;
function execEntriesOf(dir) {
  const key = IS_WIN ? dir.toLowerCase() : dir;
  const hit = dirExecCache.get(key);
  if (hit)
    return hit;
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    dirExecCache.set(key, out);
    return out;
  }
  for (const e of entries) {
    if (IS_WIN && !hasExecExt(e))
      continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile())
      continue;
    if (!IS_WIN && !(st.mode & 73))
      continue;
    out.push({ name: IS_WIN ? e.toLowerCase() : e, full });
  }
  dirExecCache.set(key, out);
  return out;
}
function whichInDirs(name, dirs) {
  const out = [];
  const target = IS_WIN ? name.toLowerCase() : name;
  for (const dir of dirs) {
    for (const e of execEntriesOf(dir)) {
      if (IS_WIN) {
        if (e.name === target || PATHEXT.some((ext) => e.name === target + ext))
          out.push(e.full);
      } else if (e.name === target) {
        out.push(e.full);
      }
    }
  }
  return out;
}
var SEMVER_RE = /(?<![\d.])(\d+\.\d+\.\d+)(?:[-.+][0-9A-Za-z._-]+)*(?![\d.])/;
var LOOSE_VERSION_RE = /(?<![\d.])(\d+\.\d+)(?:[-.+][0-9A-Za-z._-]+)*(?![\d.])/;
function extractVersion(out, binPath) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("["));
  if (binPath) {
    const self = basename(binPath).replace(/\.(exe|cmd|bat|ps1|sh)$/i, "").toLowerCase();
    const own = lines.find((l) => {
      const key = l.toLowerCase().replace(/^['"]/, "");
      return key.startsWith(self + ":") || key.startsWith(self + "':") || key.startsWith(self + '":');
    });
    if (own) {
      const m = own.match(SEMVER_RE) || own.match(LOOSE_VERSION_RE);
      if (m)
        return m[0];
    }
  }
  for (const l of lines) {
    const m = l.match(SEMVER_RE);
    if (m)
      return m[0];
  }
  for (const l of lines) {
    const m = l.match(LOOSE_VERSION_RE);
    if (m)
      return m[0];
  }
  return null;
}
async function versionOfAsync(binPath, flags, timeout = 9000) {
  for (const f of flags) {
    const out = await runBinAsync(binPath, [f], timeout);
    if (out) {
      const v = extractVersion(out, binPath);
      if (v)
        return v;
    }
  }
  return null;
}
function fileExists(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
function scanBrokenSymlinks(dirs) {
  const ghosts = [];
  for (const dir of dirs) {
    if (/[\\/]microsoft[\\/]windowsapps[\\/]?$/i.test(dir))
      continue;
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let lstat;
      try {
        lstat = lstatSync(full);
      } catch {
        continue;
      }
      if (lstat.isSymbolicLink()) {
        try {
          statSync(full);
        } catch (err) {
          const code = err?.code;
          if (code === "ENOENT") {
            ghosts.push({ path: full, reason: "broken-symlink (target missing)" });
          }
        }
      }
    }
  }
  return ghosts;
}

// src/platform/shells.ts
function shellName(s) {
  return { current: "current", powershell: "PowerShell", gitbash: "Git Bash", wsl: "WSL" }[s];
}
function shellPathDirs(shell) {
  if (shell === "current" || !IS_WIN)
    return pathDirs();
  try {
    if (shell === "powershell") {
      const out = run("powershell", [
        "-NoProfile",
        "-Command",
        "$p=[Environment]::GetEnvironmentVariable('PATH','Process');$u=[Environment]::GetEnvironmentVariable('PATH','User');$m=[Environment]::GetEnvironmentVariable('PATH','Machine'); ($p,$u,$m) -join ';'"
      ]);
      return (out || "").split(";").map((s) => s.trim()).filter(Boolean);
    }
    if (shell === "gitbash") {
      const out = run("bash", ["-lc", 'echo "$PATH"']);
      return (out || "").split(":").map((s) => s.trim()).filter(Boolean);
    }
    if (shell === "wsl") {
      const out = run("wsl", ["bash", "-lc", 'echo "$PATH"']);
      return (out || "").split(":").map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    return pathDirs();
  }
  return pathDirs();
}

// src/detector/conflicts.ts
var realPlatform = { pathDirs, whichInDirs, scanBrokenSymlinks, shellPathDirs, shellName };
function computeConflicts(groups, shells, disabled, platform = realPlatform) {
  const checks = [];
  const multiVersionTools = [];
  const pathConflicts = [];
  const offPathNotes = [];
  const multiShell = shells.length > 1;
  for (const g of groups) {
    const distinctVersions = new Set(g.installs.map((i) => i.version || ""));
    if (g.installs.length > 1 && distinctVersions.size > 1) {
      multiVersionTools.push({ id: g.id, count: g.installs.length, versions: g.installs.map((i) => i.version) });
      checks.push(makeCheck(`version.multi.${g.id}`, "conflict", "warn", `${g.id} has ${g.installs.length} installs (${distinctVersions.size} distinct versions)`, `Versions: ${g.installs.map((i) => i.version || "?").join(", ")} (multiple versions installed, check which one is active)`, g.installs.map((i) => i.path)));
    }
    if (multiShell) {
      const res = {};
      for (const s of shells)
        res[s] = (platform.whichInDirs(g.id, platform.shellPathDirs(s)) || [])[0] || null;
      g.shellResolution = res;
      const vals = Object.values(res).filter(Boolean);
      if (new Set(vals).size > 1) {
        checks.push(makeCheck(`shell.mismatch.${g.id}`, "mismatch", "info", `${g.id} resolves differently across shells`, shells.map((s) => `${platform.shellName(s)} → ${res[s] || "(not found)"}`).join("  |  "), vals));
      }
    }
    const off = g.installs.filter(isIsolated);
    if (off.length) {
      const dedupe = Array.from(new Set(off.map((i) => i.path)));
      offPathNotes.push(...off.map((i) => ({ id: g.id, path: i.path })));
      checks.push(makeCheck(`path.off.${g.id}`, "mismatch", "info", `${g.id} is installed but not on the current shell's PATH`, `Not a version-manager environment, so nothing will activate it for you; add it to PATH manually to use it: ${dedupe.join(", ")}`, dedupe));
    }
  }
  for (const g of groups) {
    const seen = new Set;
    const unique = [];
    for (const i of g.installs) {
      if (!i.onPath)
        continue;
      const k = i.path.toLowerCase();
      if (seen.has(k))
        continue;
      seen.add(k);
      unique.push({ path: i.path, version: i.version || null });
    }
    if (unique.length > 1) {
      const versions = new Set(unique.map((u) => u.version || ""));
      const sameVersion = versions.size === 1;
      const resolvedTo = unique[0].path;
      const alsoAt = unique.slice(1).map((u) => u.path);
      if (!sameVersion) {
        pathConflicts.push({ name: g.id, resolvedTo, alsoAt });
      }
      checks.push(makeCheck(`path.duplicate.${g.id}`, "conflict", sameVersion ? "info" : "warn", sameVersion ? `${g.id} has ${unique.length} launcher entries on PATH (all ${unique[0].version || "same version"}; no version conflict)` : `${g.id}: version ${unique[0].version} shadows ${[...versions].slice(1).join(", ")} on PATH`, sameVersion ? `active → ${resolvedTo}; also at: ${alsoAt.join(", ")} — identical version, harmless redundancy` : `active → ${resolvedTo}; shadowed (different version): ${alsoAt.join(", ")}`, unique.map((u) => u.path)));
    }
  }
  const seenDir = new Set;
  const uniqueDirs = [];
  for (const d of platform.pathDirs()) {
    const k = d.toLowerCase();
    if (seenDir.has(k))
      continue;
    seenDir.add(k);
    uniqueDirs.push(d);
  }
  const ghosts = platform.scanBrokenSymlinks(uniqueDirs);
  const dirFreq = new Map;
  for (const d of platform.pathDirs()) {
    const k = d.toLowerCase();
    dirFreq.set(k, (dirFreq.get(k) || 0) + 1);
  }
  const dupDirs = [...dirFreq.entries()].filter(([, c]) => c > 1).map(([d, c]) => ({ d, c }));
  if (dupDirs.length) {
    const redundant = dupDirs.reduce((s, x) => s + x.c - 1, 0);
    checks.push(makeCheck("path.duplicate-dir", "conflict", "info", `PATH contains ${dupDirs.length} duplicate directories (${redundant} redundant entries, amplifies shadowing)`, `Duplicates: ${dupDirs.map((x) => `${x.d} ×${x.c}`).join("; ")}`, dupDirs.map((x) => x.d)));
  }
  for (const gh of ghosts) {
    checks.push(makeCheck(`ghost.broken.${gh.path}`, "ghost", "warn", `Broken symlink found (ghost binary)`, `${gh.path} -- ${gh.reason}`, [gh.path]));
  }
  const filtered = disabled && disabled.size ? checks.filter((c) => !isDisabled(c.ID, disabled)) : checks;
  return { checks: filtered, multiVersionTools, pathConflicts, ghostBinaries: ghosts, offPathNotes };
}
function isDisabled(id, disabled) {
  for (const d of disabled)
    if (id === d || id.startsWith(d + ".") || id.startsWith(d))
      return true;
  return false;
}
function isCheckDisabled(id, disabled) {
  if (!disabled || !disabled.size)
    return false;
  return isDisabled(id, disabled);
}

// src/security/runtimeAdvisories.ts
var RUNTIME_ADVISORIES = {
  node: {
    eolByVersion: {
      "16": "2023-09-11",
      "18": "2025-04-30",
      "20": "2026-04-30",
      "22": "2027-04-30",
      "24": "2028-04-30",
      "26": "2029-04-30"
    }
  },
  python: {
    eolByVersion: {
      "3.7": "2023-06-27",
      "3.8": "2024-10-07",
      "3.9": "2025-10-31",
      "3.10": "2026-10-31",
      "3.11": "2027-10-31",
      "3.12": "2028-10-31",
      "3.13": "2029-10-31"
    }
  },
  go: {
    eolByVersion: {
      "1.20": "2024-02-06",
      "1.21": "2024-08-13",
      "1.22": "2025-02-11",
      "1.23": "2025-08-12",
      "1.24": "2026-02-11"
    }
  }
};

// src/security/scan.ts
function eolKeys(version) {
  const parts = version.split(".");
  const maj = parts[0];
  const min = parts[1] ?? "0";
  return [maj, `${maj}.${min}`];
}
function computeSecurity(byName) {
  const checks = [];
  const runtimes = byName.runtimes || [];
  const now = Date.now();
  for (const g of runtimes) {
    const adv = RUNTIME_ADVISORIES[g.id];
    if (!adv)
      continue;
    for (const inst of g.installs) {
      const v = inst.version;
      if (!v)
        continue;
      for (const key of eolKeys(v)) {
        const eol = adv.eolByVersion[key];
        if (eol) {
          const eolT = Date.parse(eol + "T00:00:00Z");
          if (!isNaN(eolT) && eolT < now) {
            checks.push(makeCheck(`security.eol.${g.id}`, "stale", "warn", `${g.id} ${v} is end-of-life (since ${eol})`, `${g.id} ${v} reached end-of-life on ${eol} and no longer receives security patches. Upgrade to a supported release. (${inst.path})`, [inst.path]));
          }
          break;
        }
      }
    }
  }
  return checks;
}

// src/security/sca.ts
import { spawnSync as spawnSync2 } from "child_process";
function whichTool(name) {
  const isWin = process.platform === "win32";
  const r = spawnSync2(isWin ? "where" : "command", isWin ? [name] : ["-v", name], { encoding: "utf-8" });
  if (r.error)
    return null;
  const out = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return out || null;
}
function getVersion(toolId) {
  const r = spawnSync2(toolId, ["--version"], { encoding: "utf-8", timeout: 15000 });
  if (r.error || !r.stdout)
    return null;
  const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}
function toSeverity(s) {
  const t = (s || "").toUpperCase();
  if (t === "CRITICAL" || t === "HIGH")
    return "error";
  return "warn";
}
var SCA_TOOLS = [
  {
    id: "osv-scanner",
    label: "OSV-Scanner",
    auditArgs: ["--format", "json", "."],
    parse: (json) => {
      const out = [];
      for (const res of json?.results || []) {
        for (const v of res?.vulnerabilities || []) {
          const pkg = v?.package || {};
          const sev = toSeverity(v?.severity || v?.database_specific?.severity);
          const vid = v?.id || "UNKNOWN";
          out.push(makeCheck(`security.deps.osv.${vid}`, "vuln", sev, `${pkg.name || "?"}@${pkg.version || "?"} affected by ${vid} (${sev === "error" ? "HIGH" : "MEDIUM"})`, `${vid}: ${v?.summary || v?.details || ""}. Package ${pkg.name}@${pkg.version}.`, [pkg.name || ""]));
        }
      }
      return out;
    }
  },
  {
    id: "pip-audit",
    label: "pip-audit",
    auditArgs: ["-f", "json"],
    parse: (json) => {
      const out = [];
      const sevOf = (s) => s ? toSeverity(s) : "error";
      const seen = new Set;
      const push = (name, vid, sev, title, detail) => {
        const key = `${name}|${vid}`;
        if (seen.has(key))
          return;
        seen.add(key);
        out.push(makeCheck(`security.deps.pipaudit.${vid}`, "vuln", sev, title, detail, [name]));
      };
      for (const dep of json?.dependencies || []) {
        for (const v of dep?.vulns || []) {
          const sev = sevOf(v?.severity);
          const vid = v?.id || "UNKNOWN";
          push(dep?.name || "?", vid, sev, `${dep?.name || "?"}@${dep?.version || "?"} affected by ${vid} (${sev === "error" ? "HIGH" : "MEDIUM"})`, `${vid}: ${v?.description || ""}. Fix versions: ${(v?.fix_versions || []).join(", ") || "n/a"}.`);
        }
      }
      for (const v of json?.vulnerabilities || []) {
        const sev = sevOf(v?.severity);
        const vid = v?.id || "UNKNOWN";
        push(v?.name || "?", vid, sev, `${v?.name || "?"} affected by ${vid}`, `${vid}: ${v?.description || ""}.`);
      }
      return out;
    }
  },
  {
    id: "govulncheck",
    label: "govulncheck",
    auditArgs: ["-json", "."],
    parse: (json) => {
      const out = [];
      for (const res of json?.Results || []) {
        for (const v of res?.Vulnerabilities || []) {
          const score = v?.Severity?.Score;
          const sev = typeof score === "number" && score >= 9 ? "error" : "warn";
          const vid = v?.OSV?.id || "UNKNOWN";
          const pkg = v?.Package?.Path || v?.Package?.Name || "?";
          out.push(makeCheck(`security.deps.govulncheck.${vid}`, "vuln", sev, `${pkg}@${v?.Version || "?"} affected by ${vid} (${sev === "error" ? "HIGH" : "MEDIUM"})`, `${vid}: ${v?.Details || ""}. Package ${pkg}@${v?.Version || "?"}.`, [pkg]));
        }
      }
      return out;
    }
  },
  {
    id: "trivy",
    label: "Trivy",
    auditArgs: ["fs", "--format", "json", "."],
    parse: (json) => {
      const out = [];
      for (const res of json?.Results || []) {
        for (const v of res?.Vulnerabilities || []) {
          const sev = toSeverity(v?.Severity);
          const vid = v?.VulnerabilityID || "UNKNOWN";
          out.push(makeCheck(`security.deps.trivy.${vid}`, "vuln", sev, `${v?.PkgName || "?"}@${v?.InstalledVersion || "?"} affected by ${vid} (${sev === "error" ? "HIGH" : "MEDIUM"})`, `${vid}: ${v?.Title || v?.Description || ""}. Fixed in ${v?.FixedVersion || "n/a"}.`, [v?.PkgName || ""]));
        }
      }
      return out;
    }
  }
];
function detectScaTools() {
  return SCA_TOOLS.map((t) => {
    const p = whichTool(t.id);
    return { id: t.id, label: t.label, path: p, version: p ? getVersion(t.id) : null };
  });
}
function computeScaInventory() {
  return detectScaTools().map((d) => {
    const id = `security.scanner.${d.id}`;
    if (d.path) {
      return makeCheck(id, "vuln", "info", `${d.label} available (${d.version || "?"})`, `${d.label} is installed at ${d.path}. devmap can shell out to it for dependency CVE audit with --audit-deps.`, [d.path || ""]);
    }
    return makeCheck(id, "vuln", "info", `${d.label} not installed`, `${d.label} not found on PATH. Install it to enable dependency CVE scanning via devmap --audit-deps (it fetches vuln DBs over the network).`, []);
  });
}
function runScaAudit(cwd) {
  const present = detectScaTools().filter((d) => d.path);
  if (present.length === 0) {
    return [
      makeCheck("security.deps.none", "vuln", "info", "no SCA tool installed — dependency CVE audit skipped", "Install osv-scanner / pip-audit / govulncheck / trivy to enable dependency CVE scanning via `devmap --audit-deps`.", [])
    ];
  }
  const checks = [];
  for (const d of present) {
    const tool = SCA_TOOLS.find((t) => t.id === d.id);
    const r = spawnSync2(d.id, tool.auditArgs, { cwd, encoding: "utf-8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    if (r.error || r.status === null) {
      checks.push(makeCheck(`security.deps.${d.id}.error`, "vuln", "info", `${d.label} audit failed to start`, `${d.label} could not be launched: ${r.error?.message || "unknown error"}.`, []));
      continue;
    }
    if (r.status !== 0 && !r.stdout.trim()) {
      checks.push(makeCheck(`security.deps.${d.id}.skip`, "vuln", "info", `${d.label} audit produced no output (exit ${r.status})`, `${d.label} returned no scannable result in ${cwd} (no project / no lockfile / no module).`, []));
      continue;
    }
    try {
      const json = JSON.parse(r.stdout);
      const parsed = tool.parse(json, d.label);
      checks.push(...parsed);
      if (parsed.length === 0) {
        checks.push(makeCheck(`security.deps.${d.id}.clean`, "vuln", "info", `${d.label} audit: no vulnerabilities found`, `${d.label} found no known vulnerabilities in ${cwd}.`, []));
      }
    } catch (e) {
      checks.push(makeCheck(`security.deps.${d.id}.parse`, "vuln", "info", `${d.label} audit output not JSON`, `${d.label} returned output that could not be parsed as JSON: ${e?.message || e}.`, []));
    }
  }
  return checks;
}

// src/security/secrets.ts
import { existsSync as existsSync2, readFileSync, statSync as statSync2, readdirSync as readdirSync2 } from "node:fs";
import { homedir } from "node:os";
import { join as join2, relative, isAbsolute } from "node:path";
var RULES = [
  { name: "AWS Access Key ID", re: /\b(AKIA[0-9A-Z]{16})\b/g, capture: true },
  { name: "AWS Secret Access Key", re: /aws_secret_access_key\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi, capture: true },
  { name: "GitHub Token", re: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/g, capture: true },
  { name: "GitLab Personal Access Token", re: /\bglpat-[A-Za-z0-9_-]{20}\b/g, capture: true },
  { name: "Slack Token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, capture: true },
  {
    name: "Slack Incoming Webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
    capture: false,
    mask: "https://hooks.slack.com/services/***"
  },
  { name: "Stripe Secret Key", re: /\bsk_live_[A-Za-z0-9]{24,}\b/g, capture: true },
  { name: "OpenAI API Key", re: /\bsk-[A-Za-z0-9]{20,}\b/g, capture: true },
  { name: "GCP API Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, capture: true },
  { name: "Google OAuth Client Secret", re: /"client_secret"\s*:\s*"([A-Za-z0-9-_]{20,})"/g, capture: true },
  {
    name: "Private Key Block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    capture: false,
    mask: "[PRIVATE KEY BLOCK]"
  },
  { name: "Bearer Token", re: /\bBearer\s+([A-Za-z0-9._-]{20,})\b/g, capture: true },
  { name: "Database URL with password", re: /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^:/\s]+:([^@\s]+)@/gi, capture: true },
  { name: "npm authToken", re: /\/\/registry\.npmjs\.org\/:_authToken=([A-Za-z0-9_]{36,})/g, capture: true },
  {
    name: "Git URL with embedded credentials",
    re: /[a-z]+:\/\/([^\s:@/]+):([^\s:@/]+)@/gi,
    capture: true,
    captureGroup: 2
  },
  {
    name: "Generic Secret Assignment",
    re: /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret|passwd|password|token)\s*[=:]\s*['"]?([A-Za-z0-9/+=_\-]{8,64})['"]?/gi,
    capture: true,
    generic: true
  }
];
function redactText(v) {
  if (v.length <= 4)
    return "*".repeat(v.length);
  return v.slice(0, 4) + "****" + (v.length > 8 ? " (len " + v.length + ")" : "");
}
function looksSecret(v) {
  if (v.length >= 32)
    return true;
  if (v.length < 12)
    return false;
  let classes = 0;
  if (/[a-z]/.test(v))
    classes++;
  if (/[A-Z]/.test(v))
    classes++;
  if (/[0-9]/.test(v))
    classes++;
  if (/[^A-Za-z0-9]/.test(v))
    classes++;
  return classes >= 3;
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function toRel(p) {
  const home = homedir();
  const lower = p.replace(/\\/g, "/");
  const homeLower = home.replace(/\\/g, "/");
  if (lower.startsWith(homeLower))
    return "~" + lower.slice(homeLower.length);
  try {
    const r = relative(process.cwd(), p).replace(/\\/g, "/");
    if (!r.startsWith("..") && !isAbsolute(r))
      return r;
  } catch {}
  return p;
}
function discoverFiles(projectRoots, includeHome) {
  const home = homedir();
  const out = [];
  const seen = new Set;
  const add = (p) => {
    try {
      if (existsSync2(p) && statSync2(p).isFile()) {
        const rp = p.replace(/\\/g, "/");
        if (!seen.has(rp)) {
          seen.add(rp);
          out.push(p);
        }
      }
    } catch {}
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
      ".envrc"
    ];
    for (const f of homeFiles)
      add(join2(home, f));
    try {
      for (const e of readdirSync2(home)) {
        if (e.startsWith(".env") && e !== ".env")
          add(join2(home, e));
      }
    } catch {}
  }
  const roots = [...new Set([process.cwd(), ...projectRoots])];
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync2(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e === ".env" || e.startsWith(".env.") || e === ".envrc" || e === ".npmrc" || e === ".pypirc" || e === ".netrc" || e === ".gitconfig" || e === "credentials.json" || e === "secrets.json" || e.endsWith(".pem") || e.endsWith(".key") || e.endsWith(".p12") || e.endsWith(".pfx") || /^service-?account.*\.json$/i.test(e)) {
        add(join2(root, e));
      }
    }
    add(join2(root, ".git", "config"));
  }
  return out;
}
function scanSecrets(projectRoots = [], includeHome = true) {
  const files = discoverFiles(projectRoots, includeHome);
  const checks = [];
  let scanned = 0;
  for (const f of files) {
    let content;
    try {
      const st = statSync2(f);
      if (!st.isFile() || st.size > 512 * 1024)
        continue;
      content = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    scanned++;
    const lines = content.split(/\r?\n/);
    for (let i = 0;i < lines.length; i++) {
      const line = lines[i];
      const accepted = [];
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(line)) !== null) {
          if (m.index === rule.re.lastIndex)
            rule.re.lastIndex++;
          const start = m.index;
          const end = start + m[0].length;
          if (rule.generic === true) {
            const val = (rule.captureGroup ? m[rule.captureGroup] : m[1]) || m[0];
            if (!looksSecret(val))
              continue;
            if (accepted.some(([s, e]) => start < e && end > s))
              continue;
          }
          const masked = redactValue(rule, m);
          const rel = toRel(f);
          const id = `security.secrets.${slug(rule.name)}.${checks.length + 1}`;
          checks.push(makeCheck(id, "secret", "warn", `${rule.name} in ${rel}:${i + 1} (${masked})`, `${rule.name} detected at ${f}:${i + 1}. The value is redacted (${masked}) and never printed in full. ` + `Rotate or remove the credential and prefer a secret manager or build-time env injection.`, [f]));
          accepted.push([start, end]);
        }
      }
    }
  }
  if (checks.length === 0) {
    checks.push(makeCheck("security.secrets.ok", "secret", "info", `No hardcoded secrets found in ${scanned} scanned config file(s)`, `Scanned ${scanned} credential/config file(s) under HOME and project roots (opt-in --scan-secrets). ` + `No known secret patterns matched.`, files.slice(0, 20)));
  }
  return checks;
}
function redactValue(rule, m) {
  if (rule.capture) {
    const g = m[rule.captureGroup ?? 1];
    if (g)
      return redactText(g);
  }
  return rule.mask ?? "[redacted]";
}

// src/health/parse.ts
function parsePipCheck(text) {
  const lines = (text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const clean = lines.some((l) => /^no broken requirements found/i.test(l));
  const conflicts = lines.filter((l) => !/^no broken requirements found/i.test(l));
  if (clean || conflicts.length === 0) {
    return { status: "ok", summary: "pip dependencies consistent" };
  }
  return {
    status: "warn",
    summary: `pip has ${conflicts.length} broken dependency requirement${conflicts.length === 1 ? "" : "s"}`,
    detail: conflicts.join(`
`)
  };
}
function parseNpmDoctor(text) {
  const t = (text || "").trim();
  if (!t)
    return { status: "skipped", summary: "npm doctor produced no output (timed out or silent)" };
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const NET_RE = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|EAI_|network request|registry\.npmjs\.org|request to https?:/i;
  const BOILER_RE = /complete log of this run|^\s+at\s|node:internal|file:\/\//i;
  const netLines = lines.filter((l) => NET_RE.test(l));
  const failLines = lines.filter((l) => /npm error|✗|✖/i.test(l) && !BOILER_RE.test(l));
  const realFails = failLines.filter((l) => !NET_RE.test(l));
  if (realFails.length) {
    return {
      status: "warn",
      summary: `npm doctor reported ${realFails.length} issue${realFails.length === 1 ? "" : "s"}`,
      detail: realFails.join(`
`)
    };
  }
  if (netLines.length) {
    return { status: "skipped", summary: "npm doctor skipped (registry/network unreachable)" };
  }
  return { status: "ok", summary: "npm doctor passed" };
}
function parseRustupCheck(text) {
  const t = (text || "").trim();
  if (!t)
    return { status: "skipped", summary: "rustup check produced no output (timed out or silent)" };
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const updates = lines.filter((l) => /update available/i.test(l));
  const upToDate = lines.filter((l) => /up to date/i.test(l));
  if (updates.length) {
    return {
      status: "info",
      summary: `rustup: ${updates.length} toolchain update${updates.length === 1 ? "" : "s"} available`,
      detail: updates.join(`
`)
    };
  }
  if (upToDate.length)
    return { status: "ok", summary: "rustup toolchains up to date" };
  return { status: "ok", summary: "rustup check passed" };
}
function parseCondaDoctor(text) {
  const t = (text || "").trim();
  if (!t)
    return { status: "skipped", summary: "conda doctor produced no output (timed out or silent)" };
  const lines = t.split(/\r?\n/).map((l) => l.trim());
  const problemSections = [];
  let cur = null;
  for (const line of lines) {
    if (!line)
      continue;
    const hdr = line.match(/^[❌✅]\s*(.+?)\s*:?\s*$/);
    if (hdr) {
      const name = hdr[1].replace(/:\s*$/, "").trim();
      cur = { name, items: 0 };
      if (line.startsWith("❌"))
        problemSections.push(cur);
      continue;
    }
    if (cur) {
      const m = line.match(/:\s*(\d+)\s*$/);
      if (m)
        cur.items += parseInt(m[1], 10);
    }
  }
  const real = problemSections.filter((p) => p.items > 0);
  if (real.length === 0) {
    return { status: "ok", summary: "conda environment healthy", detail: t };
  }
  const total = real.reduce((a, p) => a + p.items, 0);
  const tally = real.map((p) => `${p.name}: ${p.items}`).join(`
`);
  const raw = t.length > 4000 ? t.slice(0, 4000) + `
... (truncated)` : t;
  return {
    status: "warn",
    summary: `conda doctor: ${real.length} check${real.length === 1 ? "" : "s"} failed (${total} affected files)`,
    detail: `${tally}

${raw}`
  };
}

// src/health/scan.ts
var NETWORK_PROBES = [
  {
    id: "npm",
    label: "npm",
    kind: "mismatch",
    network: true,
    candidates: [["npm", ["doctor"]]],
    timeout: 20000,
    parse: parseNpmDoctor
  },
  {
    id: "rustup",
    label: "rustup",
    kind: "stale",
    network: true,
    candidates: [["rustup", ["check"]]],
    timeout: 15000,
    parse: parseRustupCheck
  }
];
var SEV_OF = {
  ok: "ok",
  warn: "warn",
  info: "info",
  skipped: "info"
};
function skippedCheck(prefix, kind, summary) {
  return makeCheck(`health.${prefix}.skipped`, kind, "info", summary, "");
}
function toCheckPerEnv(prefix, envLabel, r, kind, path) {
  if (r.status === "skipped") {
    return makeCheck(`health.${prefix}.${envLabel}.skipped`, kind, "info", `${prefix} doctor (${envLabel}) produced no output`, "");
  }
  const id = `health.${prefix}.${envLabel}.check`;
  const summary = r.status === "ok" ? `${prefix} check (${envLabel}): consistent` : r.summary;
  return makeCheck(id, kind, SEV_OF[r.status], summary, r.detail || "", path ? [path] : []);
}
function pickCandidate(p) {
  const dirs = pathDirs();
  for (const [cmd, args] of p.candidates) {
    if (whichInDirs(cmd, dirs).length > 0)
      return [cmd, args];
  }
  return null;
}
function toCheckNetwork(p, r) {
  const sev = SEV_OF[r.status];
  const id = r.status === "skipped" ? `health.${p.id}.skipped` : `health.${p.id}.check`;
  return makeCheck(id, p.kind, sev, r.summary, r.detail || "");
}
async function computeHealth(opts = {}) {
  const checks = [];
  const network = opts.healthNetwork === true;
  const pythons = opts.pythons || [];
  if (pythons.length === 0) {
    checks.push(skippedCheck("pip", "conflict", "no python interpreters detected (pip check skipped)"));
  } else {
    await Promise.all(pythons.map(async (py) => {
      const out = await runBinAsync(py.path, ["-m", "pip", "check"], 15000);
      const r = parsePipCheck(out);
      checks.push(toCheckPerEnv("pip", py.label, r, "conflict", py.path));
    }));
  }
  const condaEnvs = opts.condaEnvs || [];
  const condaOnPath = whichInDirs("conda", pathDirs()).length > 0;
  if (!condaOnPath) {
    checks.push(skippedCheck("conda", "stale", "conda not on PATH (conda doctor skipped)"));
  } else if (condaEnvs.length === 0) {
    checks.push(skippedCheck("conda", "stale", "no conda environments detected (conda doctor skipped)"));
  } else {
    await Promise.all(condaEnvs.map(async (e) => {
      const out = await runAsync("conda", ["doctor", "-n", e.name], 30000);
      const r = parseCondaDoctor(out);
      checks.push(toCheckPerEnv("conda", e.name, r, "stale", e.pythonPath || undefined));
    }));
  }
  for (const p of NETWORK_PROBES) {
    if (p.network && !network) {
      checks.push(makeCheck(`health.${p.id}.skipped`, p.kind, "info", `${p.label} doctor skipped (offline by default)`, `Run with --health-network to invoke ${p.label} self-checks (they require network).`));
      continue;
    }
    const picked = pickCandidate(p);
    if (!picked)
      continue;
    const [cmd, args] = picked;
    const out = await runAsync(cmd, args, p.timeout);
    const result = p.parse(out);
    checks.push(toCheckNetwork(p, result));
  }
  return checks;
}

// src/output/json.ts
function buildManifest(byName, conflicts, checks, environments, shells) {
  const sys = byName.system || {};
  const runtimes = byName.runtimes || [];
  const pkg = byName.packageManagers || [];
  const ides = byName.ides || [];
  const issueCountBySeverity = { error: 0, warn: 0, info: 0, missing: 0, ok: 0 };
  for (const c of checks)
    issueCountBySeverity[c.Severity] = (issueCountBySeverity[c.Severity] || 0) + 1;
  const totalInstallations = runtimes.reduce((a, g) => a + g.installs.length, 0) + pkg.reduce((a, g) => a + g.installs.length, 0) + ides.reduce((a, g) => a + g.installs.length, 0);
  const env = environments || {};
  const envSummary = {
    vcpkgPackages: env.vcpkg?.packages?.length || 0,
    pipInterpreters: env.pip?.perInterpreter?.length || 0,
    pipPackages: env.pip?.perInterpreter?.reduce((a, p) => a + p.packages.length, 0) || 0,
    pipOutdated: env.pip?.perInterpreter?.reduce((a, p) => a + p.outdated.length, 0) || 0,
    condaEnvs: env.condaEnvs?.envs?.length || 0,
    dockerInstalled: !!env.docker?.installed,
    wslDistros: env.wsl?.distros?.length || 0,
    vsShells: env.vsShells?.shells?.length || 0,
    projectEnvs: env.projectEnvs?.envs?.length || 0,
    mobileSdk: !!(env.sdks?.android || env.sdks?.flutter || env.sdks?.dart),
    windowsPreflight: !!env.windows?.windows
  };
  return {
    meta: { tool: "devmap", version: VERSION, generatedAt: new Date().toISOString(), schema: "devmap.manifest/1.0", shells },
    system: sys,
    runtimes,
    packageManagers: pkg,
    ides,
    environments: env,
    sdks: env.sdks || undefined,
    windows: env.windows || undefined,
    checks,
    conflicts: {
      multiVersionTools: conflicts.multiVersionTools,
      pathConflicts: conflicts.pathConflicts,
      ghostBinaries: conflicts.ghostBinaries
    },
    summary: {
      runtimeKinds: runtimes.length,
      packageManagerKinds: pkg.length,
      ideKinds: ides.length,
      totalInstallations,
      toolsWithMultipleVersions: conflicts.multiVersionTools.length,
      issueCountBySeverity,
      environments: envSummary
    }
  };
}

// src/glyphs.ts
var WIN = process.platform === "win32";
var G = {
  spinner: WIN ? ["|", "/", "-", "\\"] : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  dot: WIN ? "|" : "·",
  arrow: WIN ? "->" : "→",
  check: WIN ? "[+]" : "✓",
  cross: WIN ? "[x]" : "✗",
  play: WIN ? "*" : "▶",
  mdash: WIN ? "-" : "—",
  hrule: WIN ? "-" : "─",
  scale: WIN ? "vs" : "⚖"
};
var MAP = [
  [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, ""],
  [/🔍/g, ""],
  [/·/g, G.dot],
  [/→/g, G.arrow],
  [/—/g, G.mdash],
  [/─/g, G.hrule],
  [/⚖/g, G.scale],
  [/▶/g, G.play],
  [/✓/g, G.check],
  [/✗/g, G.cross]
];
function clean(s) {
  if (!WIN)
    return s;
  let out = s;
  for (const [re, rep] of MAP)
    out = out.replace(re, rep);
  return out;
}

// src/progress.ts
var SPINNERS = G.spinner;

class ScanProgress {
  tty;
  total;
  doneCount = 0;
  started = Date.now();
  inflight = new Set;
  timings = [];
  timer = null;
  extra = "";
  constructor(total, tty = !!process.stderr.isTTY) {
    this.total = total;
    this.tty = tty;
    if (this.tty)
      this.timer = setInterval(() => this.render(), 110);
  }
  setTotal(n) {
    this.total = n;
  }
  sub(msg) {
    if (!this.tty) {
      process.stderr.write("    " + clean(msg) + `
`);
      return;
    }
    this.extra = msg;
    this.render();
  }
  start(name) {
    this.inflight.add(name);
    if (!this.tty)
      process.stderr.write(`${G.play} ${clean(name)}
`);
    else
      this.render();
  }
  done(name, ms, err = false) {
    this.inflight.delete(name);
    this.doneCount++;
    this.timings.push({ name, ms, err });
    if (!this.tty)
      process.stderr.write(`${err ? G.cross : G.check} ${clean(name)} (${(ms / 1000).toFixed(1)}s)
`);
    else
      this.render();
  }
  availWidth() {
    const c = process.stderr.columns;
    return typeof c === "number" && c >= 40 ? c : 90;
  }
  render() {
    if (!this.tty)
      return;
    const t = ((Date.now() - this.started) / 1000).toFixed(1);
    const spin = SPINNERS[Math.floor(Date.now() / 110) % SPINNERS.length];
    const rawCur = [...this.inflight].join("+") + (this.extra ? G.dot + " " + this.extra : "") || G.mdash;
    let cur = clean(rawCur);
    const prefix = `${spin} scanning ${this.doneCount}/${this.total} ${G.dot} running: `;
    const suffix = ` ${G.dot} elapsed ${t}s`;
    const budget = this.availWidth() - prefix.length - suffix.length - 1;
    if (budget > 6 && cur.length > budget) {
      const ell = process.platform === "win32" ? "..." : "…";
      cur = cur.slice(0, Math.max(4, budget - ell.length)).trimEnd() + ell;
    }
    const msg = `${prefix}${cur}${suffix}`;
    process.stderr.write(`\r\x1B[K${msg}`);
  }
  finish() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tty)
      process.stderr.write(`\r\x1B[K`);
    if (this.timings.length) {
      const w = Math.max(1, ...this.timings.map((t) => t.name.length));
      for (const t of this.timings)
        process.stderr.write(`  ${t.err ? G.cross : G.check} ${clean(t.name).padEnd(w)}  ${t.ms >= 1000 ? (t.ms / 1000).toFixed(1) + "s" : t.ms + "ms"}
`);
      const total = ((Date.now() - this.started) / 1000).toFixed(1);
      process.stderr.write(`  \x1B[2mscan complete, took ${total}s\x1B[0m
`);
    }
  }
}

// src/scan.ts
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
function healthPythonLabel(path) {
  const lower = path.toLowerCase().replace(/\\/g, "/");
  const env = lower.match(/[\\/]envs[\\/]([^\\/]+)[\\/]/);
  if (env)
    return env[1];
  if (/miniconda3[\\/]python/i.test(lower) || /anaconda3[\\/]python/i.test(lower))
    return "base";
  if (lower.includes("workbuddy/binaries/python"))
    return "managed";
  if (lower.includes("/nvm") || lower.includes("\\nvm"))
    return "nvm";
  const parts = lower.split("/").filter(Boolean);
  const parent = parts[parts.length - 2] || "";
  return parent || "python";
}
function dedupePythons(raw) {
  const byDir = new Map;
  for (const p of raw) {
    let rp = p.pythonPath;
    try {
      rp = realpathSync(p.pythonPath);
    } catch {}
    const dir = dirname(rp);
    if (!byDir.has(dir))
      byDir.set(dir, p.pythonPath);
  }
  const out = [];
  const used = new Set;
  for (const path of byDir.values()) {
    let label = healthPythonLabel(path);
    let n = 2;
    while (used.has(label))
      label = `${healthPythonLabel(path)}#${n++}`;
    used.add(label);
    out.push({ path, label });
  }
  return out;
}
async function runScan(shells, disabled, opts = {}) {
  const progress = opts.silent ? undefined : new ScanProgress(0, process.stderr.isTTY);
  const ctx = {
    shells,
    disabled,
    projectRoots: opts.projectRoots,
    progress,
    checkOutdated: opts.checkOutdated,
    wslDeep: opts.wslDeep,
    auditDeps: opts.auditDeps,
    healthNetwork: opts.healthNetwork,
    fast: opts.fast
  };
  const { byName, allChecks } = await runDetectors(ctx, progress, opts.fast ? ["runtimes", "packageManagers", "ides", "sdks", "windows"] : undefined);
  const groups = [
    ...byName.runtimes || [],
    ...byName.packageManagers || [],
    ...byName.ides || []
  ];
  const conflicts = computeConflicts(groups, shells, disabled);
  let healthChecks = [];
  let securityChecks = [];
  if (!opts.fast) {
    const pythons = dedupePythons(byName.pip?.perInterpreter || []);
    const condaEnvs = (byName.condaenv?.envs || []).map((e) => ({
      name: e.name,
      pythonPath: e.pythonPath
    }));
    healthChecks = await computeHealth({ healthNetwork: opts.healthNetwork, pythons, condaEnvs });
    securityChecks = [
      ...computeSecurity(byName),
      ...computeScaInventory(),
      ...opts.auditDeps ? runScaAudit(process.cwd()) : [],
      ...opts.scanSecrets ? scanSecrets(opts.projectRoots) : []
    ];
  }
  const collected = [...allChecks, ...conflicts.checks, ...securityChecks, ...healthChecks].filter((c) => !isCheckDisabled(c.ID, disabled));
  const environments = {
    vcpkg: byName.vcpkg,
    pip: byName.pip,
    apt: byName.apt,
    condaEnvs: byName.condaenv,
    docker: byName.docker,
    wsl: byName.wsl,
    vsShells: byName.vsshells,
    projectEnvs: byName.projects,
    sdks: byName.sdks,
    windows: byName.windows
  };
  if (progress)
    progress.finish();
  return buildManifest(byName, conflicts, collected, environments, shells);
}

// src/query.ts
var CAT_ALIASES = {
  runtimes: "runtime",
  runtime: "runtime",
  rt: "runtime",
  packagemanagers: "packageManager",
  packagemanager: "packageManager",
  pkg: "packageManager",
  pm: "packageManager",
  ides: "ide",
  ide: "ide"
};
var CATEGORIES = [
  ["runtimes", "runtime"],
  ["packageManagers", "packageManager"],
  ["ides", "ide"]
];
function queryManifest(m, opts) {
  let groups = [];
  for (const [key, label] of CATEGORIES) {
    for (const g of m[key] || []) {
      groups.push({ id: g.id, category: label, installs: g.installs || [] });
    }
  }
  let catFilter = opts.kind || null;
  let idSub = (opts.selector || "").toLowerCase();
  if (opts.selector && opts.selector.includes(".")) {
    const dot = opts.selector.indexOf(".");
    const catPart = opts.selector.slice(0, dot).toLowerCase();
    const rest = opts.selector.slice(dot + 1).toLowerCase();
    if (catPart in CAT_ALIASES) {
      catFilter = CAT_ALIASES[catPart];
      idSub = rest;
    }
  }
  if (catFilter)
    groups = groups.filter((g) => g.category === catFilter);
  if (idSub)
    groups = groups.filter((g) => g.id.toLowerCase().includes(idSub));
  if (opts.where) {
    const w = opts.where.toLowerCase();
    groups = groups.map((g) => ({ ...g, installs: g.installs.filter((i) => (i.path || "").toLowerCase().includes(w)) })).filter((g) => g.installs.length > 0);
  }
  if (opts.offPath) {
    groups = groups.map((g) => ({ ...g, installs: g.installs.filter(isIsolated) })).filter((g) => g.installs.length > 0);
  }
  let checks = [];
  const matchesSelector = (c, s) => (c.ID || "").toLowerCase().includes(s) || (c.Label || "").toLowerCase().includes(s);
  if (opts.issues) {
    checks = m.checks || [];
    if (idSub)
      checks = checks.filter((c) => matchesSelector(c, idSub));
  } else if (idSub) {
    checks = (m.checks || []).filter((c) => matchesSelector(c, idSub));
  }
  const conflicts = opts.conflicts ? m.conflicts : undefined;
  if (opts.issues || opts.conflicts)
    groups = [];
  return { groups, checks, conflicts };
}

// src/mcp.ts
var ALL_SHELLS = ["current", "powershell", "gitbash", "wsl"];
function parseShells(v) {
  if (typeof v !== "string" || !v)
    return ["current"];
  const list = v.split(",").map((s) => s.trim());
  return list.includes("all") ? ALL_SHELLS : list.length ? list : ["current"];
}
function parseDisable(v) {
  if (typeof v !== "string" || !v)
    return new Set;
  return new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
}
function targetToShells(target) {
  if (typeof target === "string" && target) {
    const t = target.toLowerCase();
    if (t === "powershell")
      return ["powershell"];
    if (t === "cmd")
      return ["current"];
    if (t === "gitbash")
      return ["gitbash"];
    if (t === "wsl")
      return ["wsl"];
  }
  return ["current"];
}
function buildPreflight(manifest) {
  const win = manifest.windows || {};
  const sdks = manifest.sdks || {};
  const conflicts = manifest.conflicts || {};
  const pathConflicts = conflicts.pathConflicts || [];
  const checks = manifest.checks || [];
  const blockers = checks.filter((c) => c.Severity === "error").map((c) => c.ID);
  const warnings = checks.filter((c) => c.Severity === "warn").map((c) => c.ID);
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    executionPolicy: win.executionPolicy ?? null,
    languageMode: win.languageMode ?? null,
    codepage: win.codepage ?? null,
    schannelRevoke: win.schannelRevokeCheck ?? null,
    windows: {
      present: !!win.windows,
      appAliases: (win.appAliases || []).length,
      safeDelete: !!win.safeDeleteActive
    },
    sdk: {
      android: sdks.android ? { sdkHome: sdks.android.sdkHome, ndk: sdks.android.ndk || [], flutterChannel: sdks.flutter?.channel ?? null } : null,
      flutter: sdks.flutter ? { version: sdks.flutter.version, channel: sdks.flutter.channel } : null,
      dart: sdks.dart ? { version: sdks.dart.version } : null
    },
    pathConflicts: pathConflicts.length
  };
}
var TOOLS = [
  {
    name: "scan_environment",
    description: "Run a full devmap scan of the local development environment and return the structured manifest " + "(detected tools across runtimes/pkg-managers/IDEs, PATH conflicts & ghost binaries, per-env health " + "checks, and the security posture). Use this first to understand a machine before proposing changes.",
    inputSchema: {
      type: "object",
      properties: {
        shells: {
          type: "string",
          description: "Comma-separated shell views to reconstruct: current|powershell|gitbash|wsl|all (default current)"
        },
        disable: {
          type: "string",
          description: "Comma-separated check-rule prefixes to skip, e.g. 'path.duplicate,health.conda.base'"
        },
        auditDeps: {
          type: "boolean",
          description: "Opt-in dependency CVE audit via installed SCA tools (OSV-Scanner/pip-audit/govulncheck/Trivy). Uses network."
        },
        healthNetwork: {
          type: "boolean",
          description: "Also run network health probes (npm doctor / rustup check). Off by default to stay offline-fast."
        },
        scanSecrets: {
          type: "boolean",
          description: "Opt-in: scan a curated allowlist of HOME/project credential files for hardcoded secrets (offline)."
        }
      }
    }
  },
  {
    name: "query_tool",
    description: "Query a scan for a specific tool, semantic category, conflict, or issue — e.g. selector 'node', " + "'runtime.node', 'pkg.npm', 'git', or 'python'. Returns matching installs plus any related findings. " + "Cheaper than a full scan when you already know what you are looking for.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "Tool id substring or 'category.tool' dotted form (e.g. node / runtime.node / pkg.npm)"
        },
        issuesOnly: { type: "boolean", description: "Only return issues (warn/error/missing) for the match" },
        conflictsOnly: { type: "boolean", description: "Only return PATH/version/ghost conflicts for the match" },
        offPathOnly: { type: "boolean", description: "Only return isolated off-PATH installs (version-manager envs excluded)" },
        shells: { type: "string", description: "Shell views (see scan_environment)" },
        disable: { type: "string", description: "Check-rule prefixes to skip (see scan_environment)" }
      }
    }
  },
  {
    name: "preflight",
    description: "Agent pre-flight oracle: call this BEFORE running any shell command on the user's machine. " + "Returns a structured 'can this machine run my command cleanly right now' verdict -- Windows " + "constraints (execution policy, language mode, codepage, schannel revocation, app aliases, " + "safe-delete), mobile SDK state (Android/Flutter/Dart), and PATH conflict count. If 'blockers' " + "is non-empty the agent should fix (or ask the user to fix) those first, rather than discovering " + "failure mid-run (the gemini-cli #12519 'could not be parsed safely' class of failure).",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Shell the agent intends to drive: powershell | cmd | gitbash | wsl (default current)"
        },
        forAgent: {
          type: "boolean",
          description: "When true, emphasise agent-relevant constraints (language mode, execution policy, codepage)"
        }
      }
    }
  }
];
async function callTool(name, args) {
  if (name === "scan_environment") {
    const manifest = await runScan(parseShells(args.shells), parseDisable(args.disable), {
      silent: true,
      auditDeps: args.auditDeps === true,
      healthNetwork: args.healthNetwork === true,
      scanSecrets: args.scanSecrets === true
    });
    return { content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }], isError: false };
  }
  if (name === "query_tool") {
    const manifest = await runScan(parseShells(args.shells), parseDisable(args.disable), { silent: true });
    const result = queryManifest(manifest, {
      selector: typeof args.selector === "string" ? args.selector : undefined,
      issues: args.issuesOnly === true,
      conflicts: args.conflictsOnly === true,
      offPath: args.offPathOnly === true
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
  }
  if (name === "preflight") {
    const manifest = await runScan(targetToShells(args.target), parseDisable(args.disable), {
      silent: true,
      fast: true
    });
    return {
      content: [{ type: "text", text: JSON.stringify(buildPreflight(manifest), null, 2) }],
      isError: false
    };
  }
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
}
async function startMcpServer() {
  const toErr = (...a) => process.stderr.write(a.map((x) => typeof x === "string" ? x : String(x)).join(" ") + `
`);
  console.log = toErr;
  console.error = toErr;
  console.warn = toErr;
  console.info = toErr;
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + `
`);
  const log = toErr;
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf(`
`)) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line)
        continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log("[mcp] dropping malformed frame");
        continue;
      }
      const id = msg.id;
      const method = msg.method;
      log("[mcp] ->", method || "?", id ?? "");
      if (!method) {
        if (id !== undefined)
          write({ jsonrpc: "2.0", id, error: { code: -32600, message: "missing method" } });
        continue;
      }
      switch (method) {
        case "initialize":
          write({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: msg.params?.protocolVersion || "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "devmap", version: VERSION }
            }
          });
          break;
        case "notifications/initialized":
        case "initialized":
        case "notifications/cancelled":
          break;
        case "ping":
          write({ jsonrpc: "2.0", id, result: {} });
          break;
        case "tools/list":
          write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
          break;
        case "tools/call":
          try {
            const r = await callTool(msg.params?.name, msg.params?.arguments || {});
            write({ jsonrpc: "2.0", id, result: r });
          } catch (e) {
            write({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: "error: " + (e?.message || String(e)) }], isError: true }
            });
          }
          break;
        default:
          if (id !== undefined)
            write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    }
  }
  log("[mcp] stdin closed, shutting down");
}

// src/diff.ts
var CAT_KEYS = [
  ["runtimes", "runtime"],
  ["packageManagers", "packageManager"],
  ["ides", "ide"]
];
function normPath(p) {
  return (p || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}
function collectInstalls(m) {
  const map = new Map;
  for (const [key, label] of CAT_KEYS) {
    for (const g of m[key] || []) {
      for (const inst of g.installs || []) {
        map.set(normPath(inst.path), {
          id: g.id,
          category: label,
          path: inst.path,
          version: inst.version || null,
          install: inst
        });
      }
    }
  }
  return map;
}
function ensureTool(tools, id, cat) {
  const k = id + "|" + cat;
  let t = tools.get(k);
  if (!t) {
    t = { id, category: cat, added: [], removed: [], versionChanged: [] };
    tools.set(k, t);
  }
  return t;
}
function diffManifests(a, b) {
  const A = collectInstalls(a);
  const B = collectInstalls(b);
  const tools = new Map;
  for (const [np, v] of B) {
    const av = A.get(np);
    const t = ensureTool(tools, v.id, v.category);
    if (!av) {
      t.added.push(v.install);
    } else if (av.version !== v.version) {
      t.versionChanged.push({ path: v.path, from: av.version, to: v.version });
    }
  }
  for (const [np, v] of A) {
    if (!B.has(np)) {
      ensureTool(tools, v.id, v.category).removed.push(v.install);
    }
  }
  const toolList = [...tools.values()].filter((t) => t.added.length || t.removed.length || t.versionChanged.length);
  const aIssues = new Map((a.checks || []).map((c) => [c.ID, c]));
  const bIssues = new Map((b.checks || []).map((c) => [c.ID, c]));
  const issues = [];
  for (const [id, c] of bIssues)
    if (!aIssues.has(id))
      issues.push({ id, added: [c], resolved: [] });
  for (const [id, c] of aIssues)
    if (!bIssues.has(id))
      issues.push({ id, added: [], resolved: [c] });
  const summary = {
    installsAdded: toolList.reduce((s, t) => s + t.added.length, 0),
    installsRemoved: toolList.reduce((s, t) => s + t.removed.length, 0),
    versionChanges: toolList.reduce((s, t) => s + t.versionChanged.length, 0),
    issuesAdded: issues.reduce((s, i) => s + i.added.length, 0),
    issuesResolved: issues.reduce((s, i) => s + i.resolved.length, 0)
  };
  return { tools: toolList, issues, summary };
}

// src/output/card.ts
function windowsStatus(win) {
  if (!win || !win.windows)
    return { label: "n/a (not Windows)", level: "ok" };
  if (win.languageMode && /constrained/i.test(String(win.languageMode)))
    return { label: "BLOCK (Constrained Language Mode)", level: "block" };
  const policyBlocked = Array.isArray(win.executionPolicy) ? win.executionPolicy.some((r) => /^(Restricted|AllSigned)$/i.test(r.level)) : false;
  if (policyBlocked || win.schannelRevokeCheck === true || win.safeDeleteActive === true)
    return { label: "WARN (policy / revocation / safe-delete)", level: "warn" };
  return { label: "OK", level: "ok" };
}
function renderCard(m) {
  const meta = m.meta || {};
  const sys = m.system || {};
  const sum = m.summary || {};
  const env = m.environments || {};
  const win = m.windows || {};
  const sdks = m.sdks || {};
  const conflicts = m.conflicts || {};
  const ics = sum.issueCountBySeverity || {};
  const secrets = (m.checks || []).filter((c) => c.Kind === "secret" && (c.Severity === "warn" || c.Severity === "error" || c.Severity === "missing")).length;
  const ws = windowsStatus(win);
  const lines = [];
  lines.push(`# devmap ${meta.version || ""} - AI agent 的环境可靠性保险`);
  lines.push("");
  lines.push(`Host: ${sys.hostname || "?"}  ${sys.platform || "?"}/${sys.arch || "?"}  PATH dirs: ${sys.pathDirCount ?? "?"}`);
  lines.push("");
  lines.push(`- Tools: ${sum.totalInstallations ?? 0} across ${sum.runtimeKinds ?? 0} runtimes / ${sum.packageManagerKinds ?? 0} pkg-mgrs / ${sum.ideKinds ?? 0} IDEs`);
  lines.push(`- Conflicts: PATH ${conflicts.pathConflicts?.length ?? 0} · multi-version ${sum.toolsWithMultipleVersions ?? 0} · ghost ${conflicts.ghostBinaries?.length ?? 0}`);
  lines.push(`- Issues: ${ics.error ?? 0} error · ${ics.warn ?? 0} warn · ${ics.info ?? 0} info`);
  lines.push(`- Windows pre-flight: ${ws.label}`);
  const sdkBits = [];
  if (sdks.android)
    sdkBits.push(`Android ${sdks.android.sdkHome ? "home set" : "home MISSING"}${sdks.android.ndk?.length ? ` (NDK x${sdks.android.ndk.length})` : ""}`);
  if (sdks.flutter)
    sdkBits.push(`Flutter ${sdks.flutter.version || "?"}${sdks.flutter.channel ? "/" + sdks.flutter.channel : ""}`);
  if (sdks.dart)
    sdkBits.push(`Dart ${sdks.dart.version || "?"}`);
  lines.push(`- Mobile SDK: ${sdkBits.length ? sdkBits.join(" · ") : "none detected"}`);
  lines.push(`- Secrets: ${secrets} hit(s) (redacted)`);
  lines.push("");
  lines.push("Generated by `npx devmap` · github.com/StevenLOL/devmap");
  return clean(lines.join(`
`));
}

// src/detector/system.ts
import os from "node:os";
register({
  name: "system",
  scan() {
    const data = {
      platform: process.platform,
      arch: os.arch(),
      hostname: os.hostname(),
      release: os.release(),
      shell: process.env.SHELL || (IS_WIN ? process.env.ComSpec || "cmd.exe" : "sh"),
      totalMemGB: +(os.totalmem() / 1073741824).toFixed(1),
      cpuCount: os.cpus().length,
      pathDirCount: pathDirs().length
    };
    return { data, checks: [] };
  }
});

// src/detector/runtimes.ts
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
import { existsSync as existsSync3, readdirSync as readdirSync3 } from "node:fs";

// src/detector/util.ts
var CONCURRENCY = 12;
var GENERIC_FLAGS = ["--version", "version", "-v", "-V"];
function dedupe(paths, seen) {
  const out = [];
  for (const p of paths) {
    const k = p.toLowerCase();
    if (seen.has(k))
      continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}
async function detectRuntimeAsync(id, bin, flags, multiFn) {
  const seen = new Set;
  const onPathPaths = dedupe(whichInDirs(bin, pathDirs()), seen);
  const extras = [];
  if (multiFn) {
    for (const m of await multiFn()) {
      if (!m.path)
        continue;
      const k = m.path.toLowerCase();
      if (seen.has(k))
        continue;
      seen.add(k);
      extras.push({ ...m, onPath: false });
    }
  }
  const versions = await pool(onPathPaths, CONCURRENCY, (p) => versionOfAsync(p, flags));
  const installs = onPathPaths.map((p, i) => ({ path: p, onPath: true, version: versions[i] }));
  installs.push(...extras);
  return installs.length ? { id, installs } : null;
}
async function detectSimpleAsync(list, onProgress) {
  const dirs = pathDirs();
  const byName = new Map;
  const jobs = [];
  for (const name of list) {
    const paths = dedupe(whichInDirs(name, dirs), new Set);
    if (!paths.length)
      continue;
    byName.set(name, paths);
    for (const p of paths)
      jobs.push({ name, path: p });
  }
  let done = 0;
  const versions = await pool(jobs, CONCURRENCY, async (j) => {
    const v = await versionOfAsync(j.path, GENERIC_FLAGS);
    onProgress?.(++done, jobs.length);
    return v;
  });
  const vmap = new Map;
  jobs.forEach((j, i) => vmap.set(`${j.name}\x00${j.path}`, versions[i]));
  const out = [];
  for (const name of list) {
    const paths = byName.get(name);
    if (!paths)
      continue;
    out.push({
      id: name,
      installs: paths.map((p) => ({ path: p, onPath: true, version: vmap.get(`${name}\x00${p}`) ?? null }))
    });
  }
  return out;
}

// src/detector/runtimes.ts
var HOME = homedir2();
async function condaPythonPaths() {
  const found = [];
  const bases = new Set;
  const ci = await runAsync("conda", ["info", "--base"], 15000);
  if (ci)
    bases.add(ci.trim());
  bases.add(join3(HOME, "miniconda3"));
  bases.add(join3(HOME, "anaconda3"));
  bases.add("E:\\Users\\Administrator\\miniconda3");
  for (const base of bases) {
    if (!base || !existsSync3(base))
      continue;
    const basePy = IS_WIN ? join3(base, "python.exe") : join3(base, "bin", "python");
    if (existsSync3(basePy))
      found.push({ path: basePy, env: "base" });
    const envsDir = join3(base, "envs");
    if (existsSync3(envsDir)) {
      for (const e of readdirSync3(envsDir)) {
        const py = IS_WIN ? join3(envsDir, e, "python.exe") : join3(envsDir, e, "bin", "python");
        if (existsSync3(py))
          found.push({ path: py, env: e });
      }
    }
  }
  return found;
}
async function scanCondaPythons() {
  const paths = await condaPythonPaths();
  const versions = await pool(paths, 12, (p) => versionOfAsync(p.path, ["--version", "-V"]));
  return paths.map((p, i) => ({ path: p.path, onPath: false, version: versions[i], env: p.env }));
}
async function scanNvmNodes() {
  const cands = [join3(HOME, "AppData", "Roaming", "nvm"), join3(HOME, ".nvm", "versions", "node")];
  const found = [];
  for (const dir of cands) {
    if (!existsSync3(dir))
      continue;
    for (const v of readdirSync3(dir)) {
      const bin = IS_WIN ? join3(dir, v, "node.exe") : join3(dir, v, "bin", "node");
      if (existsSync3(bin))
        found.push({ path: bin, env: v });
    }
  }
  const versions = await pool(found, 12, (f) => versionOfAsync(f.path, ["--version"]));
  return found.map((f, i) => ({ path: f.path, onPath: false, version: versions[i], env: f.env }));
}
async function scanKnownBinary(cands, flags) {
  const hits = cands.filter((c) => existsSync3(c));
  const versions = await pool(hits, 12, (c) => versionOfAsync(c, flags));
  return hits.map((c, i) => ({ path: c, onPath: false, version: versions[i] }));
}
register({
  name: "runtimes",
  async scan(ctx) {
    ctx.progress?.sub("runtimes · probing 7 runtimes concurrently");
    const results = await Promise.all([
      detectRuntimeAsync("node", "node", ["--version"], scanNvmNodes),
      detectRuntimeAsync("python", "python", ["--version", "-V"], scanCondaPythons),
      detectRuntimeAsync("go", "go", ["version"]),
      detectRuntimeAsync("rustc", "rustc", ["--version"]),
      detectRuntimeAsync("java", "java", ["-version"]),
      detectRuntimeAsync("ruby", "ruby", ["--version"]),
      detectRuntimeAsync("bun", "bun", ["--version"], () => scanKnownBinary([join3(HOME, ".bun", "bin", "bun"), join3(HOME, ".bun", "bin", "bun.exe")], ["--version"]))
    ]);
    const groups = results.filter((g) => g !== null);
    return { data: groups, checks: [] };
  }
});

// src/detector/pkgmgrs.ts
var TOOLS2 = [
  "npm",
  "pip",
  "pip3",
  "conda",
  "cargo",
  "brew",
  "winget",
  "scoop",
  "docker",
  "kubectl",
  "git",
  "poetry",
  "yarn",
  "pnpm",
  "pyenv",
  "nvm"
];
register({
  name: "packageManagers",
  async scan(ctx) {
    const data = await detectSimpleAsync(TOOLS2, (done, total) => {
      ctx.progress?.sub(`packageManagers · ${done}/${total}`);
    });
    return { data, checks: [] };
  }
});

// src/detector/ides.ts
register({
  name: "ides",
  async scan(ctx) {
    const data = await detectSimpleAsync(["code", "cursor", "pycharm", "idea"], (done, total) => {
      ctx.progress?.sub(`ides · ${done}/${total}`);
    });
    return { data, checks: [] };
  }
});

// src/detector/vcpkg.ts
import { join as join4 } from "node:path";
var CANDIDATES = [
  "C:\\vcpkg\\vcpkg.exe",
  "C:\\src\\vcpkg\\vcpkg.exe",
  "C:\\tools\\vcpkg\\vcpkg.exe",
  "C:\\vcpkg\\vcpkg"
];
function parseVcpkgVersion(out) {
  if (!out)
    return null;
  const m = out.match(/version\s+(\d{4}-\d{2}-\d{2}(?:-[0-9a-f]+)?)/i);
  return m ? m[1] : null;
}
async function findVcpkg() {
  const cands = [];
  const seen = new Set;
  const add = (p, onPath) => {
    const k = p.toLowerCase();
    if (seen.has(k))
      return;
    seen.add(k);
    cands.push({ path: p, onPath });
  };
  for (const c of CANDIDATES)
    if (fileExists(c))
      add(c, false);
  if (process.env.VCPKG_ROOT) {
    const p = join4(process.env.VCPKG_ROOT, IS_WIN ? "vcpkg.exe" : "vcpkg");
    if (fileExists(p))
      add(p, false);
  }
  for (const p of whichInDirs("vcpkg", pathDirs()))
    add(p, true);
  const versions = await pool(cands, 8, (c) => runBinAsync(c.path, ["version"], 9000).then(parseVcpkgVersion));
  return cands.map((c, i) => ({ path: c.path, onPath: c.onPath, version: versions[i] }));
}
function parseList(out) {
  const pkgs = [];
  for (const line of out.split(`
`)) {
    const m = line.match(/^(\S+?):(\S+)\s+(\S+)/);
    if (m)
      pkgs.push({ name: m[1], triplet: m[2], version: m[3] });
  }
  return pkgs;
}
register({
  name: "vcpkg",
  async scan() {
    const installs = await findVcpkg();
    const checks = [];
    if (!installs.length)
      return { data: { installed: false, installs: [], packages: [] }, checks };
    const primary = installs[0].path;
    const raw = await runBinAsync(primary, ["list"], 15000);
    const fallback = raw ? "" : IS_WIN ? await runAsync("cmd", ["/c", primary, "list"], 15000) : await runAsync(primary, ["list"], 15000);
    const packages = parseList(raw || fallback);
    if (installs.length > 1) {
      checks.push(makeCheck("version.multi.vcpkg", "conflict", "warn", `vcpkg has ${installs.length} installed copies`, `Multiple vcpkg copies can mix different triplet libraries; active → ${installs[0].path}; others: ${installs.slice(1).map((i) => i.path).join(", ")}`, installs.map((i) => i.path)));
    }
    return { data: { installed: true, installs, packages }, checks };
  }
});

// src/detector/piputil.ts
function parseList2(raw) {
  if (!raw)
    return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((p) => ({ name: p.name, version: p.version || "?" })) : [];
  } catch {
    return [];
  }
}
function parseOutdated(raw) {
  if (!raw)
    return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((p) => ({ name: p.name, installed: p.version || "?", latest: p.latest_version || "?" })) : [];
  } catch {
    return [];
  }
}
async function pipPackagesAsync(pythonPath, timeout = 6000, withOutdated = false) {
  try {
    const packages = parseList2(await runBinAsync(pythonPath, ["-m", "pip", "list", "--format", "json"], timeout));
    let outdated = [];
    if (withOutdated) {
      outdated = parseOutdated(await runBinAsync(pythonPath, ["-m", "pip", "list", "--outdated", "--format", "json"], timeout));
    }
    return { packages, outdated };
  } catch {
    return { packages: [], outdated: [], error: "pip list failed" };
  }
}

// src/detector/pip.ts
import { basename as basename2 } from "node:path";
function shortName(pythonPath) {
  const lower = pythonPath.toLowerCase();
  const m = lower.match(/[\\/]envs[\\/]([^\\/]+)[\\/]/);
  if (m)
    return m[1];
  if (/miniconda3[\\/]python/i.test(lower) || /anaconda3[\\/]python/i.test(lower))
    return "base";
  return basename2(pythonPath).replace(/\.exe$/i, "").replace(/\.cmd$/i, "");
}
async function findPythons() {
  const found = [];
  const seen = new Set;
  const add = (p, onPath) => {
    const k = p.toLowerCase();
    if (seen.has(k))
      return;
    seen.add(k);
    found.push({ path: p, onPath });
  };
  for (const p of whichInDirs("python", pathDirs()))
    add(p, true);
  for (const p of whichInDirs("python3", pathDirs()))
    add(p, true);
  for (const inst of await condaPythonPaths())
    add(inst.path, false);
  return found;
}
register({
  name: "pip",
  async scan(ctx) {
    const pythons = await findPythons();
    const perInterpreter = [];
    const checks = [];
    const withOutdated = ctx.checkOutdated === true;
    let done = 0;
    const results = await pool(pythons, 6, async (py) => {
      const r = await pipPackagesAsync(py.path, withOutdated ? 20000 : 8000, withOutdated);
      ctx.progress?.sub(`pip · ${++done}/${pythons.length} interpreters`);
      return r;
    });
    pythons.forEach((py, i) => {
      const r = results[i];
      const short = shortName(py.path);
      perInterpreter.push({ pythonPath: py.path, version: null, packages: r.packages, outdated: r.outdated });
      if (r.outdated.length) {
        checks.push(makeCheck(`pip.outdated.${short}`, "stale", "info", `python(${short}) has ${r.outdated.length} upgradable packages`, `e.g.: ${r.outdated.slice(0, 5).map((o) => `${o.name} ${o.installed}→${o.latest}`).join(", ")}`, [py.path]));
      }
    });
    return { data: { perInterpreter }, checks };
  }
});

// src/detector/apt.ts
function parseApt(out) {
  const pkgs = [];
  for (const line of out.split(`
`)) {
    const m = line.match(/^([^:\s]+)(?::[^\s]+)?\S*\s+(\S+)\s/);
    if (m)
      pkgs.push({ name: m[1], version: m[2] });
  }
  return pkgs;
}
register({
  name: "apt",
  async scan() {
    const checks = [];
    if (IS_WIN)
      return { data: { available: false, count: 0, packages: [], upgradable: 0 }, checks };
    const [installedRaw, upRaw] = await Promise.all([
      runAsync("apt", ["list", "--installed"], 20000),
      runAsync("apt", ["list", "--upgradable"], 15000)
    ]);
    const packages = installedRaw ? parseApt(installedRaw) : [];
    const upgradable = upRaw ? parseApt(upRaw).length : 0;
    if (upgradable > 0) {
      checks.push(makeCheck("apt.upgradable", "stale", "info", `apt has ${upgradable} upgradable packages`, `Run sudo apt upgrade to update; or apt list --upgradable to view`, []));
    }
    return { data: { available: true, count: packages.length, packages, upgradable }, checks };
  }
});

// src/detector/condaenv.ts
import { join as join5 } from "node:path";
import { existsSync as existsSync4 } from "node:fs";
function pythonOf(envPath) {
  const py = IS_WIN ? join5(envPath, "python.exe") : join5(envPath, "bin", "python");
  return existsSync4(py) ? py : null;
}
register({
  name: "condaenv",
  async scan(ctx) {
    const out = await runAsync("conda", ["env", "list"], 15000);
    const checks = [];
    if (!out)
      return { data: { envs: [] }, checks };
    const parsed = [];
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#"))
        continue;
      const m = t.match(/^(\S+)\s+(\*?)\s*(.+)$/);
      if (!m)
        continue;
      parsed.push({ name: m[1], active: m[2] === "*", py: pythonOf(m[3].trim()) });
    }
    const withOutdated = ctx.checkOutdated === true;
    let done = 0;
    const results = await pool(parsed, 6, async (e) => {
      const r = e.py ? await pipPackagesAsync(e.py, withOutdated ? 20000 : 8000, withOutdated) : { packages: [], outdated: [] };
      ctx.progress?.sub(`conda env · ${++done}/${parsed.length}`);
      return r;
    });
    const envs = [];
    let anyOutdated = 0;
    parsed.forEach((e, i) => {
      const r = results[i];
      anyOutdated += r.outdated.length;
      envs.push({ name: e.name, pythonPath: e.py, active: e.active, packages: r.packages, outdated: r.outdated });
    });
    if (anyOutdated > 0) {
      checks.push(makeCheck("conda.env.outdated", "stale", "info", `conda envs have ${anyOutdated} upgradable packages`, `Use conda env export / pip list --outdated to view per-env details`, envs.map((e) => e.pythonPath || e.name)));
    }
    return { data: { envs }, checks };
  }
});

// src/detector/docker.ts
var DESKTOP = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
function findDocker() {
  for (const p of whichInDirs("docker", pathDirs()))
    return p;
  if (IS_WIN && fileExists(DESKTOP))
    return DESKTOP;
  return null;
}
function countLines(out) {
  if (!out)
    return 0;
  return out.split(`
`).filter((l) => l.trim().length).length;
}
register({
  name: "docker",
  async scan() {
    const checks = [];
    const bin = findDocker();
    if (!bin)
      return { data: { installed: false, daemonRunning: null, engineVersion: null, images: 0, containers: 0 }, checks };
    const [version, info] = await Promise.all([
      versionOfAsync(bin, ["--version"]),
      runBinAsync(bin, ["info", "--format", "{{.ServerVersion}}"], 8000)
    ]);
    const daemonRunning = !!info;
    const engineVersion = info || null;
    let images = 0;
    let containers = 0;
    if (daemonRunning) {
      const [imgRaw, psRaw] = await Promise.all([
        runBinAsync(bin, ["images", "-q"], 8000),
        runBinAsync(bin, ["ps", "-a", "-q"], 8000)
      ]);
      images = countLines(imgRaw);
      containers = countLines(psRaw);
    }
    if (!daemonRunning) {
      checks.push(makeCheck("docker.daemon.down", "missing", "warn", "docker installed but daemon not running", "Docker Desktop not started or dockerd not running; images/containers cannot be enumerated", [bin]));
    }
    return { data: { installed: true, daemonRunning, engineVersion, images, containers }, checks };
  }
});

// src/detector/wsl.ts
var PROBE_SCRIPT = "echo py3=$(command -v python3); echo py=$(command -v python); echo node=$(command -v node); " + "echo go=$(command -v go); echo rustc=$(command -v rustc); echo gcc=$(command -v gcc); " + "echo git=$(command -v git); echo docker=$(command -v docker)";
var TOOL_KEYS = ["py3", "py", "node", "go", "rustc", "gcc", "git", "docker"];
async function probeDistro(name) {
  const tools = {};
  for (const k of TOOL_KEYS)
    tools[k] = null;
  const out = await runAsync("wsl", ["-d", name, "--", "bash", "-lc", PROBE_SCRIPT], 20000);
  if (!out)
    return tools;
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\w+)=(.*)$/);
    if (m && m[1] in tools)
      tools[m[1]] = m[2].trim() || null;
  }
  return tools;
}
async function distroBasePaths() {
  const map = new Map;
  if (!IS_WIN)
    return map;
  const root = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
  const keysRaw = await runAsync("reg", ["query", root], 5000);
  if (!keysRaw)
    return map;
  const keys = keysRaw.split(/\r?\n/).map((l) => l.trim()).filter((k) => /\\\{[0-9a-fA-F-]+\}$/.test(k));
  const details = await pool(keys, 8, (k) => runAsync("reg", ["query", k], 5000));
  for (const detail of details) {
    if (!detail)
      continue;
    const nameM = detail.match(/DistributionName\s+REG_SZ\s+(.+)/);
    const baseM = detail.match(/BasePath\s+REG_SZ\s+(.+)/);
    if (nameM)
      map.set(nameM[1].trim(), baseM ? baseM[1].trim() : "");
  }
  return map;
}
function parseList3(raw) {
  const distros = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.replace(/\u0000/g, "").trimEnd();
    if (!t.trim())
      continue;
    if (/^\s*\*?\s*NAME\s+STATE\s+VERSION/i.test(t))
      continue;
    if (/^[\s-]+$/.test(t))
      continue;
    const m = t.match(/^(\*?)\s*(\S.*?)\s{2,}(\S+)\s+(\d+)\s*$/);
    if (!m)
      continue;
    distros.push({ name: m[2].trim(), state: m[3].trim(), version: m[4], default: m[1] === "*" });
  }
  return distros;
}
register({
  name: "wsl",
  async scan(ctx) {
    const checks = [];
    if (!IS_WIN)
      return { data: { available: false, distros: [] }, checks };
    const raw = await runAsync("wsl", ["-l", "-v"], 8000);
    if (!raw)
      return { data: { available: false, distros: [] }, checks };
    const distros = parseList3(raw);
    const bases = await distroBasePaths();
    for (const d of distros) {
      const bp = bases.get(d.name);
      if (bp)
        d.basePath = bp;
    }
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
    for (const d of distros)
      if (!d.probed)
        d.probed = false;
    if (distros.length && !distros.some((d) => d.default)) {
      checks.push(makeCheck("wsl.no-default", "mismatch", "info", "WSL has no default distro", "Set one with wsl --set-default <name>", distros.map((d) => d.name)));
    }
    const skipped = distros.filter((d) => !d.probed);
    if (skipped.length) {
      checks.push(makeCheck("wsl.not-probed", "mismatch", "info", `${skipped.length} WSL distros were not probed for internal tools (not running)`, "Stopped distros are not woken up by default, to keep the scan fast; pass --wsl-deep to probe them all", skipped.map((d) => `${d.name}(${d.state})`)));
    }
    return { data: { available: true, distros }, checks };
  }
});

// src/detector/vsshells.ts
import { readdirSync as readdirSync4, existsSync as existsSync5, statSync as statSync3 } from "node:fs";
import { join as join6 } from "node:path";
var VS_BASES = [
  "C:\\Program Files\\Microsoft Visual Studio",
  "C:\\Program Files (x86)\\Microsoft Visual Studio"
];
var START_MENU = [
  "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "C:\\Users\\Administrator\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs"
];
var EDITIONS = ["Community", "Professional", "Enterprise", "BuildTools"];
function vsRoots() {
  const roots = [];
  for (const b of VS_BASES) {
    if (!existsSync5(b))
      continue;
    for (const v of readdirSync4(b)) {
      const verDir = join6(b, v);
      if (!existsSync5(verDir) || !statSync3(verDir).isDirectory())
        continue;
      const hasEdition = EDITIONS.some((e) => {
        const ed = join6(verDir, e);
        return existsSync5(ed) && statSync3(ed).isDirectory();
      });
      if (hasEdition) {
        for (const e of EDITIONS) {
          const ed = join6(verDir, e);
          if (existsSync5(ed) && statSync3(ed).isDirectory())
            roots.push(ed);
        }
      } else {
        roots.push(verDir);
      }
    }
  }
  return roots;
}
function msvcVersionsDesc(msvc) {
  let vers = [];
  try {
    vers = readdirSync4(msvc);
  } catch {
    return [];
  }
  return vers.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}
function vsCl(root, arch) {
  const msvc = join6(root, "VC", "Tools", "MSVC");
  if (!existsSync5(msvc))
    return null;
  for (const v of msvcVersionsDesc(msvc)) {
    const p = join6(msvc, v, "bin", `Host${arch}`, arch, "cl.exe");
    if (existsSync5(p))
      return p;
  }
  return null;
}
function vsMsbuild(root) {
  const base = join6(root, "MSBuild");
  if (!existsSync5(base))
    return null;
  const cands = [join6(base, "Current", "Bin", "MSBuild.exe")];
  try {
    for (const v of readdirSync4(base))
      cands.push(join6(base, v, "Bin", "MSBuild.exe"));
  } catch {}
  return cands.find((c) => existsSync5(c)) || null;
}
function vsCMake(root) {
  const p = join6(root, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe");
  return existsSync5(p) ? p : null;
}
function vsDotnet() {
  return whichInDirs("dotnet", pathDirs())[0] || null;
}
function scanToolchain() {
  const out = { cl_x64: null, cl_x86: null, cl_arm64: null, msbuild: null, cmake: null, dotnet: vsDotnet() };
  for (const r of vsRoots()) {
    if (!out.cl_x64)
      out.cl_x64 = vsCl(r, "x64");
    if (!out.cl_x86)
      out.cl_x86 = vsCl(r, "x86");
    if (!out.cl_arm64)
      out.cl_arm64 = vsCl(r, "arm64");
    if (!out.msbuild)
      out.msbuild = vsMsbuild(r);
    if (!out.cmake)
      out.cmake = vsCMake(r);
  }
  return out;
}
function shortcutNames() {
  const names = [];
  const stack = [...START_MENU.filter((d) => existsSync5(d))];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync4(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join6(dir, e);
      try {
        if (statSync3(full).isDirectory())
          stack.push(full);
        else if (e.toLowerCase().endsWith(".lnk") && /developer|native tools|vs 20/i.test(e))
          names.push(e.replace(/\.lnk$/i, ""));
      } catch {}
    }
  }
  return names;
}
function inferKindArch(name) {
  const kind = /powershell/i.test(name) ? "powershell" : "command";
  const am = name.match(/x64|x86|arm64/i);
  const arch = am ? am[0].toLowerCase() : "auto";
  return { kind, arch };
}
function entryRef(kind) {
  const fn = kind === "powershell" ? "Launch-VsDevShell.ps1" : "VsDevCmd.bat";
  for (const r of vsRoots()) {
    const p = join6(r, "Common7", "Tools", fn);
    if (existsSync5(p))
      return p;
  }
  return null;
}
register({
  name: "vsshells",
  scan() {
    const checks = [];
    if (!IS_WIN)
      return { data: { shells: [] }, checks };
    const tc = scanToolchain();
    const names = shortcutNames();
    const shells = [];
    const seen = new Set;
    const anyCl = !!(tc.cl_x64 || tc.cl_x86 || tc.cl_arm64);
    for (const name of names) {
      const { kind, arch } = inferKindArch(name);
      const key = `${kind}:${arch}`;
      if (seen.has(key))
        continue;
      seen.add(key);
      const clPath = arch === "auto" ? tc.cl_x64 : tc[`cl_${arch}`];
      const tools = {
        cl: clPath,
        msbuild: tc.msbuild,
        cmake: tc.cmake,
        dotnet: tc.dotnet
      };
      shells.push({ name, kind, arch, entry: entryRef(kind), pathDirs: Object.values(tools).filter(Boolean).length, tools });
    }
    if (shells.length) {
      checks.push(makeCheck("vs.shells", "mismatch", "info", `Found ${shells.length} Visual Studio dev shells`, shells.map((s) => s.name).join("; "), shells.map((s) => s.entry || s.name)));
    }
    if (shells.length && !anyCl) {
      checks.push(makeCheck("vs.no-vc-tools", "missing", "warn", 'Visual Studio is installed but no cl.exe was found (the "Desktop development with C++" workload may be missing)', "Dev shells will have no MSVC toolchain; select the C++ workload in the Visual Studio Installer", vsRoots()));
    }
    return { data: { shells }, checks };
  }
});

// src/detector/projects.ts
import { readdirSync as readdirSync5, existsSync as existsSync6, statSync as statSync4 } from "node:fs";
import { join as join7, basename as basename3, dirname as dirname2 } from "node:path";
function isVenv(dir) {
  if (!existsSync6(join7(dir, "pyvenv.cfg")))
    return false;
  const child = IS_WIN_PYVENV(dir);
  return child;
}
function IS_WIN_PYVENV(dir) {
  return existsSync6(join7(dir, "Scripts", "activate")) || existsSync6(join7(dir, "Scripts", "activate.bat")) || existsSync6(join7(dir, "bin", "activate"));
}
function walk(root, maxDepth, out, seen) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries = [];
    try {
      entries = readdirSync5(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git" || e === "target" || e === "dist" || e === ".next" || e === "out") {
        if (e === "node_modules") {
          const p = join7(dir, e);
          if (!seen.has(p.toLowerCase())) {
            seen.add(p.toLowerCase());
            out.push({ project: basename3(dir), type: "node_modules", path: p });
          }
        }
        continue;
      }
      const full = join7(dir, e);
      let st;
      try {
        st = statSync4(full);
      } catch {
        continue;
      }
      if (!st.isDirectory())
        continue;
      if (e === ".venv" || e === "venv") {
        if (isVenv(full) && !seen.has(full.toLowerCase())) {
          seen.add(full.toLowerCase());
          out.push({ project: basename3(dirname2(full)), type: "venv", path: full });
        }
        continue;
      }
      if (depth < maxDepth)
        stack.push([full, depth + 1]);
    }
  }
}
register({
  name: "projects",
  scan(ctx) {
    const roots = ctx.projectRoots && ctx.projectRoots.length ? ctx.projectRoots : [process.cwd()];
    const envs = [];
    const seen = new Set;
    for (const r of roots) {
      if (existsSync6(r))
        walk(r, 4, envs, seen);
    }
    const checks = [];
    if (envs.length) {
      const venv = envs.filter((e) => e.type === "venv").length;
      const nm = envs.filter((e) => e.type === "node_modules").length;
      checks.push(makeCheck("project.envs", "mismatch", "info", `Found ${envs.length} project-local environment${envs.length === 1 ? "" : "s"} across ${roots.length} root director${roots.length === 1 ? "y" : "ies"} (venv×${venv} / node_modules×${nm})`, envs.slice(0, 10).map((e) => `${e.project}:${e.type}`).join(", "), envs.map((e) => e.path)));
    }
    return { data: { roots, envs }, checks };
  }
});

// src/detector/sdks.ts
import { existsSync as existsSync7, readdirSync as readdirSync6 } from "node:fs";
import { join as join8 } from "node:path";
var realProbe = {
  which: (n) => whichInDirs(n, pathDirs()),
  run: (c, a) => runAsync(c, a, 12000),
  env: (k) => process.env[k],
  listDir: (d) => {
    try {
      return readdirSync6(d);
    } catch {
      return [];
    }
  },
  exists: (p) => existsSync7(p)
};
var flutterCache = null;
var FLUTTER_CACHE_TTL = 60 * 60 * 1000;
async function detectSdks(plat = realProbe) {
  const checks = [];
  const data = {};
  const androidHome = plat.env("ANDROID_HOME") || plat.env("ANDROID_SDK_ROOT") || null;
  const sdkmanager = plat.which("sdkmanager");
  const adb = plat.which("adb");
  const hasAndroidTooling = adb.length > 0 || sdkmanager.length > 0;
  if (androidHome && plat.exists(androidHome)) {
    const ndkDir = join8(androidHome, "ndk");
    const btDir = join8(androidHome, "build-tools");
    const platDir = join8(androidHome, "platforms");
    const ndk = plat.listDir(ndkDir).sort();
    const buildTools = plat.listDir(btDir).sort();
    const platforms = plat.listDir(platDir).sort();
    let sdkVersion = null;
    if (sdkmanager.length) {
      const out = await plat.run(sdkmanager[0], ["--version"]);
      sdkVersion = extractVersion(out) || (out.trim() || null);
    }
    data.android = { sdkHome: androidHome, sdkVersion, ndk, buildTools, platforms };
    if (ndk.length > 1) {
      checks.push(makeCheck("sdk.ndk.multi", "mismatch", "info", `Multiple NDK versions installed (${ndk.length})`, `NDK versions present: ${ndk.join(", ")} -- gradle may silently pick an unexpected one. Pin ndkVersion in app/build.gradle to avoid surprises.`, ndk.map((v) => join8(ndkDir, v))));
    }
  } else if (hasAndroidTooling) {
    checks.push(makeCheck("sdk.android.home.missing", "missing", "warn", "Android tooling on PATH but ANDROID_HOME / ANDROID_SDK_ROOT is not set", `Found ${adb.length ? "adb" : ""}${adb.length && sdkmanager.length ? " + " : ""}${sdkmanager.length ? "sdkmanager" : ""} on PATH, but neither ANDROID_HOME nor ANDROID_SDK_ROOT is defined. Gradle / agents that resolve the SDK via the env var will fail to find it.`, [...adb, ...sdkmanager]));
  }
  if (adb.length) {
    const out = await plat.run(adb[0], ["version"]);
    data.adb = { version: extractVersion(out) };
  }
  const flutter = plat.which("flutter");
  if (flutter.length) {
    let version = null;
    let channel = null;
    let dartVersion = null;
    if (plat === realProbe && flutterCache && Date.now() - flutterCache.ts < FLUTTER_CACHE_TTL) {
      ({ version, channel, dartVersion } = flutterCache);
    } else {
      const out = await plat.run(flutter[0], ["--version"]);
      version = extractVersion(out);
      const chM = out.match(/channel\s+(\w+)/i);
      channel = chM ? chM[1].toLowerCase() : null;
      const dartM = out.match(/Dart\s+(\d+\.\d+\.\d+)/i) || out.match(/Dart SDK version:\s*(\d+\.\d+\.\d+)/i);
      dartVersion = dartM ? dartM[1] : extractVersion(out.split(/Dart/i).pop() || "");
      if (plat === realProbe)
        flutterCache = { version, channel, dartVersion, ts: Date.now() };
    }
    data.flutter = { version, channel, dartVersion };
    if (channel === "dev" || channel === "beta") {
      checks.push(makeCheck("sdk.flutter.channel", "mismatch", "info", `Flutter is on the '${channel}' channel`, `Flutter channel '${channel}' is a moving target -- package resolution (pub get) and engine behavior can change without notice, which is a common source of agent/build breakage. Prefer 'stable' for reproducible CI.`, [flutter[0]]));
    }
  }
  const dart = plat.which("dart");
  if (dart.length && !data.flutter) {
    const out = await plat.run(dart[0], ["--version"]);
    data.dart = { version: extractVersion(out) };
  }
  return { data, checks };
}
register({
  name: "sdks",
  async scan() {
    const { data, checks } = await detectSdks();
    return { data, checks };
  }
});

// src/detector/windows.ts
import { readdirSync as readdirSync7, lstatSync as lstatSync2 } from "node:fs";
import { join as join9 } from "node:path";
var realProbe2 = {
  isWin: IS_WIN,
  execPolicy: () => run("powershell", ["-NoProfile", "-Command", "Get-ExecutionPolicy -List"]),
  languageMode: () => {
    const out = run("powershell", [
      "-NoProfile",
      "-Command",
      "$ExecutionContext.SessionState.LanguageMode"
    ]);
    return out ? out.trim() : null;
  },
  codepage: () => {
    const out = run("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding.CodePage"]);
    const n = parseInt((out || "").trim(), 10);
    return Number.isFinite(n) ? n : null;
  },
  schannelRevokeEnabled: () => {
    const url = "https://github.com";
    const def = run("curl", ["-sS", "-o", "nul", "-w", "%{http_code}", "--max-time", "6", url]);
    if (def && /^2|3/.test(def.trim()))
      return false;
    const bypass = run("curl", [
      "-sS",
      "-o",
      "nul",
      "-w",
      "%{http_code}",
      "--ssl-no-revoke",
      "--max-time",
      "6",
      url
    ]);
    if (bypass && /^2|3/.test(bypass.trim()))
      return true;
    return null;
  },
  appAliases: () => {
    const found = [];
    if (!IS_WIN)
      return found;
    for (const dir of pathDirs()) {
      if (!/[\\/]microsoft[\\/]windowsapps[\\/]?$/i.test(dir))
        continue;
      let entries;
      try {
        entries = readdirSync7(dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = join9(dir, e);
        let st;
        try {
          st = lstatSync2(full);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) {
          found.push({ tool: e, target: "WindowsApps (App Execution Alias)" });
        }
      }
    }
    return found;
  },
  safeDeleteActive: () => {
    return !!process.env.CODEBUDDY_SAFE_DELETE_SANDBOX;
  }
};
var offlineProbe = { ...realProbe2, schannelRevokeEnabled: () => null };
function parseExecPolicy(out) {
  const rows = [];
  for (const raw of out.split(/\r?\n/)) {
    const m = raw.trim().match(/^([A-Za-z]+)\s+(\S+)$/);
    if (m && /policy/i.test(raw) === false && m[2] !== "Undefined") {
      if (/scope/i.test(m[1]))
        continue;
      rows.push({ scope: m[1], level: m[2] });
    }
  }
  return rows;
}
function detectWindows(plat = realProbe2) {
  if (!plat.isWin)
    return { data: { windows: false }, checks: [] };
  const checks = [];
  const data = { windows: true };
  const epOut = plat.execPolicy();
  const ep = parseExecPolicy(epOut);
  data.executionPolicy = ep;
  const EP_ORDER = ["MachinePolicy", "UserPolicy", "Process", "CurrentUser", "LocalMachine"];
  const defined = EP_ORDER.map((s) => ep.find((r) => r.scope === s)).filter(Boolean);
  const effective = defined.length ? defined[0].level : "Restricted";
  if (/^(Restricted|AllSigned)$/i.test(effective)) {
    checks.push(makeCheck("win.execpolicy", "mismatch", "warn", `PowerShell execution policy is '${effective}' (blocks script execution)`, `Agent-generated .ps1 scripts will be refused under policy '${effective}'. Set RemoteSigned (or Bypass for the agent session) so the agent can run commands.`, []));
  }
  const lm = plat.languageMode();
  data.languageMode = lm;
  if (lm && /constrained/i.test(lm)) {
    checks.push(makeCheck("win.langmode", "mismatch", "error", "PowerShell is in Constrained Language Mode (agent commands will be rejected)", "Constrained Language Mode (often enforced via WDAC / AppLocker / Device Guard) strips cmdlets and .NET calls agents rely on. This is a hard blocker -- the agent cannot operate until the policy is relaxed for its session.", []));
  }
  const cp = plat.codepage();
  data.codepage = cp;
  if (cp !== null && cp !== 65001) {
    checks.push(makeCheck("win.console.cp", "mismatch", "info", `Console code page is ${cp} (not UTF-8 65001)`, `Subprocess UTF-8 output will be decoded with the legacy code page (e.g. GBK) and mojibake. devmap emits ASCII-safe glyphs on Windows, but package managers / tool output may still corrupt. Run 'chcp 65001' or use Windows Terminal.`, []));
  }
  const revoke = plat.schannelRevokeEnabled();
  data.schannelRevokeCheck = revoke;
  if (revoke === true) {
    checks.push(makeCheck("win.schannel", "mismatch", "warn", "Schannel certificate revocation check is blocking network fetches", "curl/pip/git report CRYPT_E_NO_REVOCATION_CHECK because the revocation server is unreachable. Pass --ssl-no-revoke to curl (and the equivalent to git/Invoke-WebRequest) or disable revocation check in schannel.", []));
  }
  const aliases = plat.appAliases();
  data.appAliases = aliases;
  if (aliases.length) {
    checks.push(makeCheck("win.appalias", "mismatch", "info", `${aliases.length} App Execution Alias(es) shadow real tools on PATH`, `These resolve to the Microsoft Store stub rather than a real install: ${aliases.map((a) => a.tool).join(", ")}. If 'python'/'curl' behave oddly, disable the alias in Settings > Apps > Advanced app execution aliases.`, aliases.map((a) => a.tool)));
  }
  const sd = plat.safeDeleteActive();
  data.safeDeleteActive = sd;
  if (sd) {
    checks.push(makeCheck("win.safedelete", "mismatch", "warn", "Safe-delete shim is active (deletions fail closed)", "A sandbox safe-delete shim intercepts removals and fails them closed. Agent cleanup steps (rm / shutil) will silently no-op -- temp artifacts accumulate and 'did it delete?' checks are misleading.", []));
  }
  return { data, checks };
}
register({
  name: "windows",
  async scan(ctx) {
    const { data, checks } = detectWindows(ctx?.fast ? offlineProbe : realProbe2);
    return { data, checks };
  }
});

// src/cli.ts
import { writeFileSync, mkdirSync, readFileSync as readFileSync2, existsSync as existsSync8 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join10 } from "node:path";
import { execSync } from "node:child_process";
if (process.platform === "win32") {
  try {
    execSync("chcp 65001 > nul 2>&1", { stdio: "ignore" });
  } catch {}
}
if (process.platform === "win32") {
  const olog = console.log.bind(console);
  console.log = (...a) => olog(...a.map((x) => typeof x === "string" ? clean(x) : x));
  const oerr = console.error.bind(console);
  console.error = (...a) => oerr(...a.map((x) => typeof x === "string" ? clean(x) : x));
}
var ALL_SHELLS2 = ["current", "powershell", "gitbash", "wsl"];
var DEFAULT_MANIFEST = join10(homedir3(), ".devmap", "devmap.json");
function emitText(text, withBom = false) {
  const prefix = withBom && !process.stdout.isTTY ? "\uFEFF" : "";
  process.stdout.write(prefix + text + `
`);
}
function tokenize(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith("--")) {
        opts[key] = opts[key] !== undefined ? `${opts[key]},${nxt}` : nxt;
        i++;
      } else
        opts[key] = true;
    } else if (a.startsWith("-") && a.length > 1) {
      opts[a.slice(1)] = true;
    } else
      pos.push(a);
  }
  return { pos, opts };
}
function toShells(v) {
  if (typeof v !== "string")
    return ["current"];
  const list = v.split(",").map((s) => s.trim());
  return list.includes("all") ? ALL_SHELLS2 : list.length ? list : ["current"];
}
function toSet(v) {
  if (typeof v !== "string")
    return new Set;
  return new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
}
function toRoots(v) {
  if (typeof v !== "string")
    return;
  const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
}
function readManifestFile(path) {
  if (!existsSync8(path))
    throw new Error(`manifest file not found: ${path}`);
  try {
    const raw = readFileSync2(path, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`manifest parse failed (${path}): ${e.message}`);
  }
}
async function resolveManifest(explicitPath, shells, disabled, label, roots) {
  if (explicitPath)
    return { manifest: readManifestFile(explicitPath), source: explicitPath };
  if (existsSync8(DEFAULT_MANIFEST))
    return { manifest: readManifestFile(DEFAULT_MANIFEST), source: DEFAULT_MANIFEST };
  const manifest = await runScan(shells, disabled, { projectRoots: roots });
  return { manifest, source: label + "(live scan)" };
}
async function cmdScan(opts, pos) {
  const shells = toShells(opts.shell);
  const disabled = toSet(opts.disable);
  const roots = toRoots(opts["scan-root"]);
  const manifest = await runScan(shells, disabled, {
    projectRoots: roots,
    silent: opts.quiet === true,
    checkOutdated: opts.outdated === true,
    wslDeep: opts["wsl-deep"] === true,
    auditDeps: opts["audit-deps"] === true,
    healthNetwork: opts["health-network"] === true,
    scanSecrets: opts["scan-secrets"] === true
  });
  if (opts.card || opts.share) {
    const card = renderCard(manifest);
    if (opts.share) {
      const out = join10(process.cwd(), "devmap-card.md");
      try {
        writeFileSync(out, card + `
`);
        console.log(`  card -> ${out}`);
      } catch {
        console.log(card);
      }
    } else {
      console.log(card);
    }
    if (opts["no-manifest"] !== true) {
      try {
        mkdirSync(join10(DEFAULT_MANIFEST, ".."), { recursive: true });
        writeFileSync(DEFAULT_MANIFEST, JSON.stringify(manifest, null, 2));
        console.log(`  ${"\x1B[2m"}manifest -> ${DEFAULT_MANIFEST}\x1B[0m`);
      } catch {}
    }
    return 0;
  }
  if (opts.json) {
    emitText(JSON.stringify(manifest, null, 2), opts.bom === true);
  } else if (opts.report) {
    emitText(clean(renderMarkdownLite(manifest)), opts.bom === true);
  } else {
    renderPrettyFromManifest(manifest);
    if (opts["no-manifest"] !== true) {
      try {
        mkdirSync(join10(DEFAULT_MANIFEST, ".."), { recursive: true });
        writeFileSync(DEFAULT_MANIFEST, JSON.stringify(manifest, null, 2));
        console.log(`  ${"\x1B[2m"}manifest → ${DEFAULT_MANIFEST}${"\x1B[0m"}`);
      } catch {}
    }
  }
  if (opts.ci) {
    const hasError = (manifest.checks || []).some((c) => c.Severity === "error");
    if (hasError)
      return 1;
    const hasWarn = (manifest.checks || []).some((c) => c.Severity === "warn");
    if (hasWarn)
      return 2;
    return 0;
  }
  return 0;
}
async function cmdQuery(opts, pos) {
  const selector = pos[1];
  const shells = toShells(opts.shell);
  const disabled = toSet(opts.disable);
  const { manifest, source } = await resolveManifest(opts.manifest, shells, disabled, "query", toRoots(opts["scan-root"]));
  const result = queryManifest(manifest, {
    selector,
    issues: opts.issues === true,
    conflicts: opts.conflicts === true,
    offPath: opts["off-path"] === true || opts.offpath === true,
    kind: opts.kind,
    where: opts.where
  });
  if (opts.json) {
    emitText(JSON.stringify({ source, ...result }, null, 2), opts.bom === true);
    return 0;
  }
  console.log(`\x1B[1m\uD83D\uDD0D query:\x1B[0m ${selector || "(all)"}  \x1B[2m(source: ${source})\x1B[0m`);
  for (const g of result.groups) {
    console.log(`  \x1B[36m${catLabel(g.id, g.category)}\x1B[0m ${g.id}  \x1B[2m(${g.installs.length})\x1B[0m`);
    for (const inst of g.installs) {
      const loc = locationOf(inst);
      const tag = loc === "PATH" ? "\x1B[32m[onPath]\x1B[0m" : loc === "env" ? `\x1B[36m[env: ${inst.env}]\x1B[0m` : "\x1B[33m[off-path]\x1B[0m";
      console.log(`    ${inst.path}  \x1B[2m${inst.version || "?"}\x1B[0m  ${tag}`);
    }
  }
  if (result.conflicts) {
    const c = result.conflicts;
    console.log(`  \x1B[1mconflicts\x1B[0m  multiVersion=${c.multiVersionTools?.length || 0}  path=${c.pathConflicts?.length || 0}  ghost=${c.ghostBinaries?.length || 0}`);
  }
  const allChecks = result.checks || [];
  const issues = allChecks.filter((c) => bucketOf(c.Severity) === "issue");
  const infos = allChecks.filter((c) => bucketOf(c.Severity) === "info");
  const oks = allChecks.filter((c) => bucketOf(c.Severity) === "ok");
  if (issues.length) {
    console.log(`  \x1B[1missues (${issues.length})\x1B[0m`);
    for (const c of issues) {
      const sev = sevColor(c.Severity);
      console.log(`    ${sev}${c.Severity}\x1B[0m  ${c.ID}  ${c.Label}`);
    }
  }
  if (infos.length) {
    console.log(`  \x1B[1minfo (${infos.length})\x1B[0m`);
    for (const c of infos)
      console.log(`    ${sevColor(c.Severity)}${c.Severity}\x1B[0m  ${c.ID}  ${c.Label}`);
  }
  if (oks.length) {
    console.log(`  \x1B[32m✓ ${oks.length} checks passed\x1B[0m`);
  }
  if (!result.groups.length && !result.checks.length && !result.conflicts) {
    console.log("  (no match)");
  }
  return 0;
}
async function cmdDevdiff(opts, pos) {
  const shells = toShells(opts.shell);
  const disabled = toSet(opts.disable);
  const files = pos.slice(1).filter((p) => !p.startsWith("-"));
  let A, labelA;
  let B, labelB;
  if (files.length >= 2) {
    A = readManifestFile(files[0]);
    labelA = files[0];
    B = readManifestFile(files[1]);
    labelB = files[1];
  } else if (files.length === 1) {
    const before = await resolveManifest(opts.manifest, shells, disabled, "devdiff-before", toRoots(opts["scan-root"]));
    A = before.manifest;
    labelA = before.source;
    B = readManifestFile(files[0]);
    labelB = files[0];
  } else {
    const before = await resolveManifest(opts.manifest, shells, disabled, "devdiff-before", toRoots(opts["scan-root"]));
    A = before.manifest;
    labelA = before.source;
    B = await runScan(shells, disabled, { projectRoots: toRoots(opts["scan-root"]), scanSecrets: opts["scan-secrets"] === true });
    labelB = "current live scan";
  }
  const diff = diffManifests(A, B);
  if (opts.json) {
    emitText(JSON.stringify({ before: labelA, after: labelB, ...diff }, null, 2), opts.bom === true);
    return 0;
  }
  console.log(`\x1B[1m⚖ devdiff\x1B[0m  before: \x1B[2m${labelA}\x1B[0m  →  after: \x1B[2m${labelB}\x1B[0m`);
  for (const t of diff.tools) {
    for (const inst of t.added)
      console.log(`  \x1B[32m+ ${t.category} ${t.id}\x1B[0m  ${inst.path}  ${inst.version || "?"}`);
    for (const inst of t.removed)
      console.log(`  \x1B[31m- ${t.category} ${t.id}\x1B[0m  ${inst.path}  ${inst.version || "?"}`);
    for (const vc of t.versionChanged)
      console.log(`  \x1B[33m~ ${t.category} ${t.id}\x1B[0m  ${vc.path}  ${vc.from || "?"} → ${vc.to || "?"}`);
  }
  for (const iss of diff.issues) {
    for (const c of iss.added)
      console.log(`  \x1B[31m+ issue\x1B[0m  ${sevColor(c.Severity)}${c.Severity}\x1B[0m  ${c.ID}  ${c.Label}`);
    for (const c of iss.resolved)
      console.log(`  \x1B[32m- issue\x1B[0m  ${sevColor(c.Severity)}${c.Severity}\x1B[0m  ${c.ID}  ${c.Label}`);
  }
  const s = diff.summary;
  console.log(`  \x1B[2m→ +${s.installsAdded} installs / -${s.installsRemoved} installs / ~${s.versionChanges} version changes / +${s.issuesAdded} issues / -${s.issuesResolved} resolved\x1B[0m`);
  if (!diff.tools.length && !diff.issues.length)
    console.log("  \x1B[32mno diff\x1B[0m");
  return 0;
}
function sevColor(sev) {
  switch (sev) {
    case "error":
      return "\x1B[31m";
    case "warn":
      return "\x1B[33m";
    case "info":
      return "\x1B[36m";
    case "ok":
      return "\x1B[32m";
    default:
      return "\x1B[0m";
  }
}
function bucketOf(sev) {
  if (sev === "error" || sev === "warn" || sev === "missing")
    return "issue";
  if (sev === "info")
    return "info";
  return "ok";
}
var CATEGORY = {
  node: "runtime",
  python: "runtime",
  ruby: "runtime",
  java: "runtime",
  bun: "runtime",
  go: "toolchain",
  rustc: "toolchain",
  npm: "pkg",
  pip: "pkg",
  pip3: "pkg",
  conda: "pkg",
  cargo: "pkg",
  brew: "pkg",
  winget: "pkg",
  scoop: "pkg",
  poetry: "pkg",
  yarn: "pkg",
  pnpm: "pkg",
  nvm: "vermgr",
  pyenv: "vermgr",
  git: "tool",
  docker: "tool",
  kubectl: "tool"
};
function catLabel(id, fallbackKey) {
  if (CATEGORY[id])
    return CATEGORY[id];
  if (fallbackKey === "runtimes")
    return "runtime";
  if (fallbackKey === "packageManagers")
    return "pkg";
  if (fallbackKey === "ides")
    return "ide";
  return fallbackKey;
}
function renderPrettyFromManifest(m) {
  const sys = m.system || {};
  console.log(`\x1B[1mdevmap\x1B[0m v${m.meta?.version || VERSION}  \x1B[2m${sys.hostname || "?"}\x1B[0m  ${sys.platform}/${sys.arch}`);
  console.log(`  shell=${sys.shell || "?"}  pathDirs=${sys.pathDirCount ?? "?"}`);
  console.log("  " + "─".repeat(40));
  for (const key of ["runtimes", "packageManagers", "ides"]) {
    for (const g of m[key] || []) {
      console.log(`  \x1B[36m${catLabel(g.id, key)}\x1B[0m ${g.id}  \x1B[2m(${g.installs.length})\x1B[0m`);
      for (const inst of g.installs.slice(0, 6)) {
        const tag = inst.onPath ? "" : inst.env ? ` \x1B[36m[env: ${inst.env}]\x1B[0m` : " \x1B[33m[off-path]\x1B[0m";
        console.log(`    ${inst.path}  \x1B[2m${inst.version || "?"}\x1B[0m${tag}`);
      }
    }
  }
  const allChecks = m.checks || [];
  const issues = allChecks.filter((c) => bucketOf(c.Severity) === "issue");
  const infos = allChecks.filter((c) => bucketOf(c.Severity) === "info");
  const oks = allChecks.filter((c) => bucketOf(c.Severity) === "ok");
  renderEnvironments(m.environments);
  if (issues.length || infos.length || oks.length) {
    console.log("  " + "─".repeat(40));
    if (issues.length) {
      console.log(`  \x1B[1missues (${issues.length})\x1B[0m`);
      for (const c of issues)
        console.log(`    ${sevColor(c.Severity)}${c.Severity}\x1B[0m  ${c.ID}  ${c.Label}`);
    }
    if (infos.length) {
      console.log(`  \x1B[1minfo (${infos.length})\x1B[0m`);
      for (const c of infos)
        console.log(`    ${sevColor(c.Severity)}${c.Severity}\x1B[0m  ${c.ID}  ${c.Label}`);
    }
    if (oks.length) {
      console.log(`  \x1B[32m✓ ${oks.length} checks passed\x1B[0m`);
    }
  }
}
var plur = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
function renderEnvironments(env) {
  if (!env)
    return;
  const rule = "  " + "─".repeat(40);
  if (env.vcpkg?.installed) {
    console.log(rule);
    console.log(`  \x1B[1mvcpkg\x1B[0m  ${plur(env.vcpkg.packages.length, "package")}  (\x1B[33m${plur(env.vcpkg.installs.length, "vcpkg copy", "vcpkg copies")}\x1B[0m)`);
    for (const p of env.vcpkg.packages.slice(0, 6))
      console.log(`    ${p.name}@${p.version}  \x1B[2m${p.triplet}\x1B[0m`);
  }
  if (env.pip?.perInterpreter?.length) {
    console.log(rule);
    console.log(`  \x1B[1mpip\x1B[0m  ${plur(env.pip.perInterpreter.length, "interpreter")}`);
    for (const pi of env.pip.perInterpreter) {
      const short = pi.pythonPath.split(/[\\/]/).slice(-2).join("/").replace(/\.exe$/i, "");
      console.log(`    ${short}  \x1B[2m${plur(pi.packages.length, "package")}${pi.outdated.length ? " · " + pi.outdated.length + " upgradable" : ""}\x1B[0m`);
    }
  }
  if (env.apt?.available) {
    console.log(rule);
    console.log(`  \x1B[1mapt\x1B[0m  ${plur(env.apt.count, "package")}  ·  ${env.apt.upgradable} upgradable`);
  }
  if (env.condaEnvs?.envs?.length) {
    console.log(rule);
    console.log(`  \x1B[1mconda envs\x1B[0m  (${env.condaEnvs.envs.length})`);
    for (const e of env.condaEnvs.envs)
      console.log(`    ${e.active ? "*" : " "} ${e.name}  \x1B[2m${plur(e.packages.length, "package")}${e.outdated.length ? " · " + e.outdated.length + " upgradable" : ""}\x1B[0m`);
  }
  if (env.docker?.installed) {
    console.log(rule);
    console.log(`  \x1B[1mdocker\x1B[0m  daemon=${env.docker.daemonRunning ? "\x1B[32mrunning\x1B[0m" : "\x1B[31mnot running\x1B[0m"}  images=${env.docker.images}  containers=${env.docker.containers}`);
  }
  if (env.wsl?.available && env.wsl.distros.length) {
    console.log(rule);
    console.log(`  \x1B[1mWSL\x1B[0m  (${plur(env.wsl.distros.length, "distro")})`);
    for (const d of env.wsl.distros) {
      const running = /running/i.test(d.state);
      const state = running ? `\x1B[32m${d.state}\x1B[0m` : `\x1B[2m${d.state}\x1B[0m`;
      console.log(`    ${d.default ? "*" : " "} ${d.name}  ${state} \x1B[2m· WSL${d.version}\x1B[0m`);
      if (d.basePath)
        console.log(`        \x1B[2mlocation: ${d.basePath}\x1B[0m`);
      if (d.probed && d.tools) {
        const have = Object.entries(d.tools).filter(([, v]) => v);
        console.log(have.length ? `        \x1B[2mtools:\x1B[0m ${have.map(([k, v]) => `${k}=${v}`).join("  ")}` : `        \x1B[2mtools: (not detected)\x1B[0m`);
      } else {
        console.log(`        \x1B[2mtools: not probed (distro not running; add --wsl-deep to probe)\x1B[0m`);
      }
    }
  }
  if (env.vsShells?.shells?.length) {
    console.log(rule);
    console.log(`  \x1B[1mVisual Studio dev shells\x1B[0m  (${env.vsShells.shells.length})`);
    for (const s of env.vsShells.shells) {
      const present = Object.entries(s.tools).filter(([, v]) => v).map(([k]) => k);
      const tag = present.length ? `\x1B[32m${present.join("/")}\x1B[0m` : `\x1B[33mno C++ toolchain\x1B[0m`;
      console.log(`    ${s.name}  \x1B[2m[${s.kind}/${s.arch}]\x1B[0m  ${tag}`);
    }
  }
  if (env.projectEnvs?.envs?.length) {
    console.log(rule);
    console.log(`  \x1B[1mproject-local environments\x1B[0m  (${env.projectEnvs.envs.length})`);
    for (const e of env.projectEnvs.envs.slice(0, 12))
      console.log(`    ${e.project}  \x1B[2m${e.type}\x1B[0m  ${e.path}`);
  }
  if (env.sdks) {
    console.log(rule);
    console.log(`  \x1B[1mmobile SDKs\x1B[0m`);
    const s = env.sdks;
    if (s.android) {
      const a = s.android;
      console.log(`    Android SDK  home=${a.sdkHome || "(unset)"}  ndk=${a.ndk?.length || 0}  build-tools=${a.buildTools?.length || 0}  platforms=${a.platforms?.length || 0}`);
    }
    if (s.flutter)
      console.log(`    Flutter ${s.flutter.version || "?"}${s.flutter.channel ? " (" + s.flutter.channel + ")" : ""}${s.flutter.dartVersion ? "  dart " + s.flutter.dartVersion : ""}`);
    if (s.dart)
      console.log(`    Dart ${s.dart.version || "?"}`);
    if (!s.android && !s.flutter && !s.dart)
      console.log(`    (none detected)`);
  }
  if (env.windows?.windows) {
    console.log(rule);
    console.log(`  \x1B[1mWindows pre-flight\x1B[0m`);
    const w = env.windows;
    if (w.languageMode)
      console.log(`    language mode: ${w.languageMode}`);
    if (w.executionPolicy?.length)
      console.log(`    exec policy: ${w.executionPolicy.map((r) => r.scope + "=" + r.level).join(", ")}`);
    if (w.codepage != null)
      console.log(`    codepage: ${w.codepage}`);
    if (w.schannelRevokeCheck != null)
      console.log(`    schannel revocation check: ${w.schannelRevokeCheck ? "ON (blocks fetches)" : "off"}`);
    if (w.appAliases?.length)
      console.log(`    app aliases: ${w.appAliases.map((a) => a.tool).join(", ")}`);
    if (w.safeDeleteActive)
      console.log(`    safe-delete shim: ACTIVE (deletes fail closed)`);
  }
}
function renderMarkdownLite(m) {
  const lines = [`# devmap report`, "", `> host: ${m.system?.hostname} · ${m.system?.platform}/${m.system?.arch} · pathDirs=${m.system?.pathDirCount}`, ""];
  for (const key of ["runtimes", "packageManagers", "ides"]) {
    lines.push(`## ${key}`);
    for (const g of m[key] || []) {
      lines.push(`- **${g.id}** _${catLabel(g.id, key)}_ (${g.installs.length})`);
      for (const inst of g.installs) {
        const tag = locationTag(inst);
        lines.push(`  - ${inst.path} — ${inst.version || "?"}${tag ? ` (${tag})` : ""}`);
      }
    }
    lines.push("");
  }
  const allChecks = m.checks || [];
  const issues = allChecks.filter((c) => bucketOf(c.Severity) === "issue");
  const infos = allChecks.filter((c) => bucketOf(c.Severity) === "info");
  const oks = allChecks.filter((c) => bucketOf(c.Severity) === "ok");
  if (issues.length) {
    lines.push(`## issues (${issues.length})`);
    for (const c of issues)
      lines.push(`- [${c.Severity}] \`${c.ID}\` ${c.Label} — ${c.Detail}`);
  }
  if (infos.length) {
    lines.push(`## info (${infos.length})`);
    for (const c of infos)
      lines.push(`- [${c.Severity}] \`${c.ID}\` ${c.Label} — ${c.Detail}`);
  }
  if (oks.length) {
    lines.push(`## checks passed (${oks.length})`);
    for (const c of oks)
      lines.push(`- [${c.Severity}] \`${c.ID}\` ${c.Label}`);
  }
  const env = m.environments || {};
  const envLines = [];
  if (env.vcpkg?.installed)
    envLines.push(`- vcpkg: ${plur(env.vcpkg.packages.length, "package")} / ${plur(env.vcpkg.installs.length, "vcpkg copy", "vcpkg copies")}`);
  if (env.pip?.perInterpreter?.length)
    envLines.push(`- pip: ${plur(env.pip.perInterpreter.length, "interpreter")} / ${plur(env.pip.perInterpreter.reduce((a, p) => a + p.packages.length, 0), "package")}`);
  if (env.apt?.available)
    envLines.push(`- apt: ${plur(env.apt.count, "package")} / ${env.apt.upgradable} upgradable`);
  if (env.condaEnvs?.envs?.length)
    envLines.push(`- conda envs: ${env.condaEnvs.envs.length}`);
  if (env.docker?.installed)
    envLines.push(`- docker: daemon=${env.docker.daemonRunning} images=${env.docker.images} containers=${env.docker.containers}`);
  if (env.wsl?.available)
    envLines.push(`- WSL: ${plur(env.wsl.distros?.length || 0, "distro")}`);
  if (env.vsShells?.shells?.length)
    envLines.push(`- Visual Studio dev shells: ${env.vsShells.shells.length}`);
  if (env.projectEnvs?.envs?.length)
    envLines.push(`- project-local environments: ${env.projectEnvs.envs.length}`);
  if (env.sdks) {
    const s = env.sdks;
    const bits = [];
    if (s.android)
      bits.push(`Android home=${s.android.sdkHome || "(unset)"}, ndk=${s.android.ndk?.length || 0}`);
    if (s.flutter)
      bits.push(`Flutter ${s.flutter.version || "?"}${s.flutter.channel ? "/" + s.flutter.channel : ""}`);
    if (s.dart)
      bits.push(`Dart ${s.dart.version || "?"}`);
    if (bits.length)
      envLines.push(`- mobile SDKs: ${bits.join("; ")}`);
  }
  if (env.windows?.windows)
    envLines.push(`- Windows pre-flight: langmode=${env.windows.languageMode || "?"}, codepage=${env.windows.codepage ?? "?"}, safeDelete=${!!env.windows.safeDeleteActive}`);
  if (envLines.length) {
    lines.push("", `## environments (Phase 2)`);
    lines.push(...envLines);
  }
  return lines.join(`
`);
}
function printHelp() {
  console.log(`devmap v${VERSION} — machine dev-environment source of truth

Usage:
  devmap [scan] [options]    scan and render nicely (scan is the DEFAULT — 'devmap' alone is enough)
  devmap query <tool>        query a generated manifest (devmap.json)
  devmap devdiff [a] [b]     compare two manifests (environment drift / cross-machine consistency)

  Tip: every 'devmap scan ...' also works as just 'devmap ...' (the 'scan' word is optional).

scan options:
  --json            emit machine-readable JSON (devmap.json schema)
  --report          emit full markdown report
  --card            print a screenshot-friendly share card (pure ASCII/Markdown)
  --share           write the share card to ./devmap-card.md (and print the path)
  --no-manifest     do not persist the manifest to disk
  --manifest <p>    specify the manifest location (default ~/.devmap/devmap.json)
  --disable <r1,r2> disable check rules (prefix match, e.g. path.duplicate / pip.outdated)
  --shell <list>    which shell views to reconstruct (current|powershell|gitbash|wsl|all)
  --scan-root <dir> project-local environment scan root (comma-separated; default cwd). e.g. --scan-root C:\\src
  --outdated        check pip/conda upgradable packages online (off by default: requires PyPI access and slows the scan)
  --wsl-deep        probe inside stopped WSL distros (default probes only running ones to avoid waking distros)
  --ci              CI gate: clean → exit 0; any warn → exit 2; any error → exit 1
  --audit-deps      dependency CVE audit via OSV-Scanner/pip-audit/govulncheck/Trivy (opt-in, uses network)
  --scan-secrets    scan a curated allowlist of HOME/project credential files for hardcoded secrets (opt-in, offline)
  --health-network  run network health probes too (npm doctor / rustup check; off by default to stay offline-fast)
  --quiet           suppress scan progress feedback (for scripts/CI)
  --bom             prepend UTF-8 BOM for viewing in Notepad etc. (only on redirect/pipe)
  --mcp             run as an MCP server (stdio JSON-RPC) for AI IDE agents (Cursor/Cline/Claude Desktop)
  --version / --help

Phase 2 environment layer (covered by this scan):
  vcpkg pkgs / per-python-interpreter pip packages (incl. upgradable) / apt packages (Linux) / conda env packages /
  docker (binary+daemon+images/containers) / WSL distros / Visual Studio dev shells / project-local environments (venv, node_modules)

Encoding note: output is plain UTF-8. Opening BOM-less UTF-8 in Windows Notepad may show mojibake,
  use VS Code / Windows Terminal cat / an IDE to open it; or add --bom then redirect.
  When reading a BOM file in Python use open(p, encoding="utf-8-sig").

query options:
  <tool>            tool id substring (e.g. node), or "category.tool" dotted form (e.g. runtime.node / pkg.npm)
  --issues          list issues only
  --conflicts       list conflicts only (multiVersion/path/ghost)
  --off-path        list isolated off-PATH installs only (version-manager envs excluded)
  --kind <runtime|packageManager|ide>   filter by category
  --where <substr>  filter by install-path substring
  --manifest <p>    manifest to query (default ~/.devmap/devmap.json; live scan if absent)
  --json            emit JSON

devdiff options:
  (no args)         compare "stored manifest" vs "current live scan"
  <file>            compare "stored/specified before" vs <file>
  <a> <b>           compare manifests a and b
  --json            emit JSON
`);
}
async function main() {
  const { pos, opts } = tokenize(process.argv.slice(2));
  if (opts.help || opts.h) {
    printHelp();
    process.exit(0);
  }
  if (opts.version || opts.v) {
    console.log(VERSION);
    process.exit(0);
  }
  if (opts.mcp) {
    await startMcpServer();
    process.exit(0);
  }
  const sub = pos[0] || "scan";
  let code = 0;
  try {
    if (sub === "query")
      code = await cmdQuery(opts, pos);
    else if (sub === "devdiff")
      code = await cmdDevdiff(opts, pos);
    else
      code = await cmdScan(opts, pos);
  } catch (e) {
    console.error(`\x1B[31merror:\x1B[0m ${e.message}`);
    process.exit(2);
  }
  process.exit(code);
}
main();
