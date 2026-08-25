// Mobile / SDK detector -- the "dirtiest" environment moat (optimization doc §2.A).
//
// Why this exists: Android / Flutter / Dart / NDK setup is the single most error-prone dev
// environment, yet it is completely absent from every competitor we surveyed (see
// docs/competitive-analysis.md -- 14 source-available rivals have zero mobile-SDK coverage).
// devmap turns that blind spot into a unique wedge: it reports not just "is flutter installed"
// but the *structural* hazards agents and CI hit -- a flutter that resolves on PATH but whose
// ANDROID_HOME is unset (so gradle can't find the SDK), a dev/beta Flutter channel (agent `pub get`
// breakage), or three NDK versions silently shadowing each other.
//
// All probes are injected through `SdkProbe` so the detector is unit-testable without touching a
// real machine (same DI pattern as detector/conflicts.ts). The real implementations wrap the shared
// platform primitives (whichInDirs / runAsync / extractVersion).
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { register } from "./registry";
import { makeCheck } from "../check/model";
import { whichInDirs, pathDirs, runAsync, extractVersion } from "../platform/exec";

/** Probe surface the detector depends on. Injected so tests are deterministic. */
export interface SdkProbe {
  which: (name: string) => string[]; // resolved absolute paths (empty if not on PATH)
  run: (cmd: string, args: string[]) => Promise<string>; // combined stdout/stderr; "" on failure
  env: (key: string) => string | undefined;
  listDir: (dir: string) => string[]; // entry basenames; [] if missing
  exists: (p: string) => boolean;
}

const realProbe: SdkProbe = {
  which: (n) => whichInDirs(n, pathDirs()),
  run: (c, a) => runAsync(c, a, 12000),
  env: (k) => process.env[k],
  listDir: (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  },
  exists: (p) => existsSync(p),
};

export interface AndroidSdkInfo {
  sdkHome: string | null;
  sdkVersion: string | null;
  ndk: string[];
  buildTools: string[];
  platforms: string[];
}
export interface SdkInfo {
  android?: AndroidSdkInfo;
  adb?: { version: string | null };
  flutter?: { version: string | null; channel: string | null; dartVersion: string | null };
  dart?: { version: string | null };
}

/**
 * Flutter's CLI cold-starts in ~15s on first invocation. The MCP server (and any long-lived devmap
 * process) calls the SDK detector many times per session, so memoize the flutter probe result in
 * this module with a 1h TTL. The first preflight of a session pays the cost once; every subsequent
 * call is instant. Only the REAL probe is cached -- injected test probes always re-run, so unit
 * tests stay deterministic.
 */
let flutterCache: { version: string | null; channel: string | null; dartVersion: string | null; ts: number } | null = null;
const FLUTTER_CACHE_TTL = 60 * 60 * 1000;

/**
 * Pure detection logic. `plat` defaults to the real machine probes.
 * Returns `{ data, checks }` exactly as a Detector expects.
 */
export async function detectSdks(plat: SdkProbe = realProbe): Promise<{ data: SdkInfo; checks: any[] }> {
  const checks: any[] = [];
  const data: SdkInfo = {};

  const androidHome = plat.env("ANDROID_HOME") || plat.env("ANDROID_SDK_ROOT") || null;
  const sdkmanager = plat.which("sdkmanager");
  const adb = plat.which("adb");
  const hasAndroidTooling = adb.length > 0 || sdkmanager.length > 0;

  // --- Android SDK home + subdirs ---
  if (androidHome && plat.exists(androidHome)) {
    const ndkDir = join(androidHome, "ndk");
    const btDir = join(androidHome, "build-tools");
    const platDir = join(androidHome, "platforms");
    const ndk = plat.listDir(ndkDir).sort();
    const buildTools = plat.listDir(btDir).sort();
    const platforms = plat.listDir(platDir).sort();
    let sdkVersion: string | null = null;
    if (sdkmanager.length) {
      // sdkmanager --version prints a bare number on success; do not fail the whole probe if it errors.
      const out = await plat.run(sdkmanager[0], ["--version"]);
      sdkVersion = extractVersion(out) || (out.trim() || null);
    }
    data.android = { sdkHome: androidHome, sdkVersion, ndk, buildTools, platforms };

    if (ndk.length > 1) {
      checks.push(
        makeCheck(
          "sdk.ndk.multi",
          "mismatch",
          "info",
          `Multiple NDK versions installed (${ndk.length})`,
          `NDK versions present: ${ndk.join(", ")} -- gradle may silently pick an unexpected one. Pin ndkVersion in app/build.gradle to avoid surprises.`,
          ndk.map((v) => join(ndkDir, v)),
        ),
      );
    }
  } else if (hasAndroidTooling) {
    // Tools resolve on PATH but the SDK root is undefined -> agents / CI / gradle cannot locate it.
    checks.push(
      makeCheck(
        "sdk.android.home.missing",
        "missing",
        "warn",
        "Android tooling on PATH but ANDROID_HOME / ANDROID_SDK_ROOT is not set",
        `Found ${adb.length ? "adb" : ""}${adb.length && sdkmanager.length ? " + " : ""}${sdkmanager.length ? "sdkmanager" : ""} on PATH, but neither ANDROID_HOME nor ANDROID_SDK_ROOT is defined. Gradle / agents that resolve the SDK via the env var will fail to find it.`,
        [...adb, ...sdkmanager],
      ),
    );
  }

  // --- adb ---
  if (adb.length) {
    const out = await plat.run(adb[0], ["version"]);
    data.adb = { version: extractVersion(out) };
  }

  // --- Flutter (bundles its own Dart) ---
  const flutter = plat.which("flutter");
  if (flutter.length) {
    let version: string | null = null;
    let channel: string | null = null;
    let dartVersion: string | null = null;
    if (plat === realProbe && flutterCache && Date.now() - flutterCache.ts < FLUTTER_CACHE_TTL) {
      ({ version, channel, dartVersion } = flutterCache);
    } else {
      const out = await plat.run(flutter[0], ["--version"]);
      version = extractVersion(out);
      const chM = out.match(/channel\s+(\w+)/i);
      channel = chM ? chM[1].toLowerCase() : null;
      const dartM = out.match(/Dart\s+(\d+\.\d+\.\d+)/i) || out.match(/Dart SDK version:\s*(\d+\.\d+\.\d+)/i);
      dartVersion = dartM ? dartM[1] : extractVersion(out.split(/Dart/i).pop() || "");
      if (plat === realProbe) flutterCache = { version, channel, dartVersion, ts: Date.now() };
    }
    data.flutter = { version, channel, dartVersion };
    if (channel === "dev" || channel === "beta") {
      checks.push(
        makeCheck(
          "sdk.flutter.channel",
          "mismatch",
          "info",
          `Flutter is on the '${channel}' channel`,
          `Flutter channel '${channel}' is a moving target -- package resolution (pub get) and engine behavior can change without notice, which is a common source of agent/build breakage. Prefer 'stable' for reproducible CI.`,
          [flutter[0]],
        ),
      );
    }
  }

  // --- Standalone Dart SDK (non-Flutter scenarios) ---
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
  },
});
