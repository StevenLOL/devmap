import { describe, expect, it } from "bun:test";
import { parsePipCheck, parseNpmDoctor, parseRustupCheck } from "./parse";
import { computeHealth } from "./scan";

describe("parsePipCheck", () => {
  it("clean: 'No broken requirements found.' -> ok", () => {
    const r = parsePipCheck("No broken requirements found.");
    expect(r.status).toBe("ok");
    expect(r.detail).toBeUndefined();
  });

  it("conflict lines -> warn with count + detail", () => {
    const out = [
      "PyYAML 6.0.2 requires markupsafe>=2.0, but you have markupsafe 1.1.1.",
      "requests 2.32.3 has requirement charset-normalizer<4,>=2, but you have charset-normalizer 4.1.0.",
    ].join("\n");
    const r = parsePipCheck(out);
    expect(r.status).toBe("warn");
    expect(r.summary).toContain("2 broken dependency");
    expect(r.detail).toContain("markupsafe 1.1.1");
    expect(r.detail).toContain("charset-normalizer 4.1.0");
  });

  it("empty output -> treated as ok (no conflicts)", () => {
    expect(parsePipCheck("").status).toBe("ok");
    expect(parsePipCheck("   \n  ").status).toBe("ok");
  });

  it("does not count the clean marker as a conflict", () => {
    const r = parsePipCheck("foo requires bar, but you have baz.\nNo broken requirements found.");
    expect(r.status).toBe("ok");
  });
});

describe("parseNpmDoctor", () => {
  it("empty output -> skipped (timed out / silent)", () => {
    const r = parseNpmDoctor("");
    expect(r.status).toBe("skipped");
  });

  it("network failure -> skipped (not warn)", () => {
    const out = [
      "npm error code ECONNREFUSED",
      "npm error request to https://registry.npmjs.org/ failed, reason: connect ECONNREFUSED",
      "npm error A complete log of this run can be found in: ...",
    ].join("\n");
    const r = parseNpmDoctor(out);
    expect(r.status).toBe("skipped");
  });

  it("real (non-network) failure -> warn", () => {
    const out = [
      "npm error code EPERM",
      "npm error Missing write access to /usr/local/lib/node_modules",
      "✗ verify cache contents failed",
    ].join("\n");
    const r = parseNpmDoctor(out);
    expect(r.status).toBe("warn");
    expect(r.summary).toContain("issue");
  });

  it("clean passing output -> ok", () => {
    const out = ["npm notice using npm@10.2.4", "it worked!", "All checks passed"].join("\n");
    const r = parseNpmDoctor(out);
    expect(r.status).toBe("ok");
  });
});

describe("parseRustupCheck", () => {
  it("empty output -> skipped", () => {
    expect(parseRustupCheck("").status).toBe("skipped");
  });

  it("update available -> info with count", () => {
    const out = [
      "stable-x86_64-pc-windows-msvc - update available: 1.96.1 (31fca3adb 2026-06-26) -> 1.97.1 (8bab26f4f 2026-07-14)",
      "rustup - up to date : 1.29.0",
    ].join("\n");
    const r = parseRustupCheck(out);
    expect(r.status).toBe("info");
    expect(r.summary).toContain("1 toolchain update");
    expect(r.detail).toContain("update available");
  });

  it("all up to date -> ok", () => {
    const out = "rustup - up to date : 1.29.0";
    const r = parseRustupCheck(out);
    expect(r.status).toBe("ok");
  });
});

describe("computeHealth (integration smoke)", () => {
  it("resolves to an array of checks without throwing and severities are valid", async () => {
    const checks = await computeHealth({});
    expect(Array.isArray(checks)).toBe(true);
    const valid = new Set(["ok", "info", "warn", "error", "missing"]);
    for (const c of checks) {
      expect(valid.has(c.Severity)).toBe(true);
      expect(c.ID.startsWith("health.")).toBe(true);
    }
  });

  it("network probes are skipped (info) when --health-network is off", async () => {
    // npm is essentially always on PATH in a node dev env; with healthNetwork=false it must
    // surface as health.npm.skipped (info), never as a warn/error.
    const checks = await computeHealth({});
    const npm = checks.find((c) => c.ID.startsWith("health.npm."));
    if (npm) {
      expect(npm.ID).toBe("health.npm.skipped");
      expect(npm.Severity).toBe("info");
    }
  });
});
