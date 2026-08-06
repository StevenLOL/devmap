import { describe, expect, it } from "bun:test";
import { parsePipCheck, parseNpmDoctor, parseRustupCheck, parseCondaDoctor } from "./parse";
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

describe("parseCondaDoctor", () => {
  it("all ok (no problems) -> ok", () => {
    const out = [
      "Environment Health Report for: E:\\miniconda3",
      "✅ The environment is consistent.",
      "✅ The environment is listed in environments.txt file.",
      "✅ File locking is supported.",
      "✅ No pinned specs found in E:\\miniconda3\\conda-meta\\pinned.",
    ].join("\n");
    const r = parseCondaDoctor(out);
    expect(r.status).toBe("ok");
  });

  it("altered + missing files -> warn with aggregated file count (real format has blank lines between sections)", () => {
    // Real `conda doctor -n <env>` output separates each section header from its item list
    // AND adjacent sections with BLANK LINES. The parser MUST keep the current section across
    // blanks (regression: an earlier version reset `cur` on blank lines and undercounted to 0,
    // silently reporting a broken env as healthy).
    const out = [
      "Environment Health Report for: E:\\miniconda3",
      "❌ Altered Files:",
      "gdk-pixbuf-2.44.6-hd37cd66_1: 1",
      "yaml-cpp-0.8.0-hd77b12b_1: 4",
      "",
      "✅ The environment is consistent.",
      "",
      "❌ Missing Files:",
      "pip-25.2-pyhc872135_1: 61",
      "setuptools-80.9.0-py313haa95532_0: 143",
      "",
    ].join("\n");
    const r = parseCondaDoctor(out);
    expect(r.status).toBe("warn");
    expect(r.summary).toContain("2 checks failed");
    expect(r.summary).toContain("209 affected files"); // 1+4+61+143
    expect(r.detail).toContain("Altered Files: 5");
    expect(r.detail).toContain("Missing Files: 204");
  });

  it("empty output -> skipped", () => {
    expect(parseCondaDoctor("").status).toBe("skipped");
    expect(parseCondaDoctor("   \n  ").status).toBe("skipped");
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

  it("emits one per-interpreter pip check when pythons passed", async () => {
    // fake interpreter paths are not spawnable -> pip check yields "" -> parsePipCheck("") -> ok.
    // This verifies the per-env wiring (one health.pip.<label>.check per interpreter) deterministically.
    const checks = await computeHealth({
      pythons: [
        { path: "C:\\nope\\python.exe", label: "fake" },
        { path: "C:\\nope2\\python3.exe", label: "fake2" },
      ],
    });
    const pip = checks.filter((c) => c.ID.startsWith("health.pip."));
    expect(pip.length).toBe(2);
    expect(pip.every((c) => c.ID.startsWith("health.pip.") && c.ID.endsWith(".check"))).toBe(true);
    expect(pip.some((c) => c.ID === "health.pip.fake.check")).toBe(true);
    expect(pip.some((c) => c.ID === "health.pip.fake2.check")).toBe(true);
  });
});

