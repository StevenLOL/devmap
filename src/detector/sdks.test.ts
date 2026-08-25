import { describe, it, expect } from "bun:test";
import { detectSdks, type SdkProbe } from "./sdks";

// Deterministic probe. Defaults: nothing installed, empty env. Each scenario overrides only what it needs.
function mockProbe(over: Partial<SdkProbe> = {}): SdkProbe {
  return {
    which: () => [],
    run: async () => "",
    env: () => undefined,
    listDir: () => [],
    exists: () => false,
    ...over,
  };
}

describe("detectSdks: android home missing (warn)", () => {
  it("flags a warn when adb is on PATH but ANDROID_HOME/ANDROID_SDK_ROOT unset", async () => {
    const probe = mockProbe({
      which: (n) => (n === "adb" ? ["/sdk/platform-tools/adb"] : []),
      // run is invoked with the FULL path (e.g. "/sdk/platform-tools/adb"), not the bare "adb"
      run: async (cmd) => (cmd.includes("adb") ? "Android Debug Bridge version 1.0.41" : ""),
    });
    const { data, checks } = await detectSdks(probe);
    expect(checks.some((c) => c.ID === "sdk.android.home.missing" && c.Severity === "warn")).toBe(true);
    expect(data.adb?.version).toBe("1.0.41");
  });

  it("does NOT flag home.missing when ANDROID_HOME is set even if tools also on PATH", async () => {
    const probe = mockProbe({
      env: (k) => (k === "ANDROID_HOME" ? "/sdk" : undefined),
      exists: () => true,
      which: (n) => (n === "adb" ? ["/sdk/platform-tools/adb"] : []),
    });
    const { checks } = await detectSdks(probe);
    expect(checks.some((c) => c.ID === "sdk.android.home.missing")).toBe(false);
  });
});

describe("detectSdks: flutter channel (info)", () => {
  it("flags an info when channel is dev/beta", async () => {
    const probe = mockProbe({
      which: (n) => (n === "flutter" ? ["/f/flutter"] : []),
      run: async () =>
        "Flutter 3.22.0 • channel dev • https://github.com/flutter/flutter.git\nTools • Dart 3.4.0 • DevTools 2.34.1",
    });
    const { data, checks } = await detectSdks(probe);
    expect(data.flutter?.channel).toBe("dev");
    expect(data.flutter?.dartVersion).toBe("3.4.0");
    expect(checks.some((c) => c.ID === "sdk.flutter.channel" && c.Severity === "info")).toBe(true);
  });

  it("does NOT flag a stable channel", async () => {
    const probe = mockProbe({
      which: (n) => (n === "flutter" ? ["/f/flutter"] : []),
      run: async () => "Flutter 3.22.0 • channel stable • https://github.com/flutter/flutter.git",
    });
    const { checks } = await detectSdks(probe);
    expect(checks.some((c) => c.ID === "sdk.flutter.channel")).toBe(false);
  });
});

describe("detectSdks: multiple NDK (info)", () => {
  it("flags an info when >=2 NDK versions are present", async () => {
    const probe = mockProbe({
      env: (k) => (k === "ANDROID_HOME" ? "/sdk" : undefined),
      exists: () => true,
      listDir: (d) => (d.endsWith("ndk") ? ["21.4.7075529", "25.1.8937393"] : []),
    });
    const { data, checks } = await detectSdks(probe);
    expect(data.android?.ndk).toEqual(["21.4.7075529", "25.1.8937393"]);
    expect(checks.some((c) => c.ID === "sdk.ndk.multi" && c.Severity === "info")).toBe(true);
  });

  it("does NOT flag a single NDK", async () => {
    const probe = mockProbe({
      env: (k) => (k === "ANDROID_HOME" ? "/sdk" : undefined),
      exists: () => true,
      listDir: (d) => (d.endsWith("ndk") ? ["25.1.8937393"] : []),
    });
    const { checks } = await detectSdks(probe);
    expect(checks.some((c) => c.ID.startsWith("sdk.ndk"))).toBe(false);
  });
});

describe("detectSdks: nothing installed", () => {
  it("returns empty data and no checks", async () => {
    const { data, checks } = await detectSdks(mockProbe());
    expect(Object.keys(data).length).toBe(0);
    expect(checks.length).toBe(0);
  });
});
