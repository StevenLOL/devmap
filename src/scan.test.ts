import { describe, it, expect } from "bun:test";
import { buildManifest } from "./output/json";
import { computeConflicts, isCheckDisabled, type ConflictPlatform } from "./detector/conflicts";
import { makeCheck } from "./check/model";
import type { Check } from "./types";

function mockPlatform(): ConflictPlatform {
  return {
    pathDirs: () => [],
    whichInDirs: () => [],
    scanBrokenSymlinks: () => [],
    shellPathDirs: () => [],
    shellName: (s) => String(s),
  };
}

describe("scan layer: manifest assembly", () => {
  it("aggregates checks into issueCountBySeverity and wires the conflict report", () => {
    const conflicts = computeConflicts([], ["current"], undefined, mockPlatform());
    const checks: Check[] = [
      makeCheck("a", "conflict", "warn", "w", "d"),
      makeCheck("b", "conflict", "info", "i", "d"),
      makeCheck("c", "ghost", "warn", "g", "d"),
    ];
    const m = buildManifest({ runtimes: [], packageManagers: [], ides: [] }, conflicts, checks, {}, ["current"]);
    expect(m.meta.tool).toBe("devmap");
    expect(m.summary.issueCountBySeverity).toEqual({ error: 0, warn: 2, info: 1, missing: 0, ok: 0 });
    expect(m.conflicts.pathConflicts).toEqual([]);
    expect(m.checks.length).toBe(3);
    // The conflict report is surfaced verbatim, never re-derived.
    expect(m.conflicts.multiVersionTools).toEqual([]);
  });

  it("counts installations across runtimes/packageManagers/ides", () => {
    const conflicts = computeConflicts([], ["current"], undefined, mockPlatform());
    const byName = {
      runtimes: [{ id: "node", installs: [{ path: "/a", onPath: true, version: "20" }] }],
      packageManagers: [{ id: "npm", installs: [{ path: "/b", onPath: true, version: "10" }] }],
      ides: [{ id: "code", installs: [{ path: "/c", onPath: true, version: "1" }] }],
    };
    const m = buildManifest(byName, conflicts, [], {}, ["current"]);
    expect(m.summary.totalInstallations).toBe(3);
    expect(m.summary.runtimeKinds).toBe(1);
  });
});

describe("scan layer: --disable rule (shared across every detector)", () => {
  it("undefined / empty set never disables", () => {
    expect(isCheckDisabled("path.off.python", undefined)).toBe(false);
    expect(isCheckDisabled("path.off.python", new Set())).toBe(false);
  });

  it("prefix match disables the whole subtree", () => {
    expect(isCheckDisabled("path.off.python", new Set(["path.off"]))).toBe(true);
    expect(isCheckDisabled("path.off.python", new Set(["path"]))).toBe(true);
    expect(isCheckDisabled("version.multi.node", new Set(["path.off"]))).toBe(false);
  });
});
