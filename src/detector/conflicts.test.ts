import { describe, it, expect } from "bun:test";
import { computeConflicts, type ConflictPlatform } from "./conflicts";
import type { ToolGroup, Install, ShellId } from "../types";

// Build a deterministic platform. By default PATH is empty (no ghosts, no dup dirs)
// and cross-shell `which` returns nothing, so each scenario below isolates exactly
// the behaviour under test.
function mockPlatform(over: Partial<ConflictPlatform> = {}): ConflictPlatform {
  return {
    pathDirs: () => [],
    whichInDirs: () => [],
    scanBrokenSymlinks: () => [],
    shellPathDirs: () => [],
    shellName: (s) => String(s),
    ...over,
  };
}

function group(id: string, installs: Install[]): ToolGroup {
  return { id, installs };
}

describe("computeConflicts: multi-version (H1)", () => {
  it("flags a tool with >=2 distinct versions as a warn + multiVersionTool", () => {
    const g = group("node", [
      { path: "/a/node", onPath: true, version: "18.0.0" },
      { path: "/b/node", onPath: true, version: "20.0.0" },
    ]);
    const rep = computeConflicts([g], ["current"], undefined, mockPlatform());
    const mv = rep.multiVersionTools.find((m) => m.id === "node");
    expect(mv).toBeDefined();
    expect(mv!.count).toBe(2);
    expect(rep.checks.some((c) => c.ID === "version.multi.node" && c.Severity === "warn")).toBe(true);
  });

  it("does NOT flag several launcher entries of the SAME version (PRD AC1 boundary)", () => {
    // conda ships conda.bat / conda.exe / condabin\conda.bat all for one install.
    const g = group("conda", [
      { path: "/c/conda.exe", onPath: true, version: "26.1.1" },
      { path: "/c/condabin/conda.bat", onPath: true, version: "26.1.1" },
    ]);
    const rep = computeConflicts([g], ["current"], undefined, mockPlatform());
    expect(rep.multiVersionTools.find((m) => m.id === "conda")).toBeUndefined();
    expect(rep.checks.some((c) => c.ID === "version.multi.conda")).toBe(false);
  });

  it("does NOT flag a single install", () => {
    const g = group("python", [{ path: "/p/python", onPath: true, version: "3.12" }]);
    const rep = computeConflicts([g], ["current"], undefined, mockPlatform());
    expect(rep.multiVersionTools.length).toBe(0);
  });
});

describe("computeConflicts: off-PATH notice (H2)", () => {
  it("raises an info when an isolated install exists", () => {
    const g = group("ripgrep", [{ path: "/opt/rg", onPath: false, version: "13.0" }]);
    const rep = computeConflicts([g], ["current"], undefined, mockPlatform());
    expect(rep.checks.some((c) => c.ID === "path.off.ripgrep" && c.Severity === "info")).toBe(true);
  });

  it("does NOT raise an off-PATH notice for a version-manager env (by design)", () => {
    const g = group("python", [{ path: "/envs/ctf/python", onPath: false, version: "3.11", env: "ctf" }]);
    const rep = computeConflicts([g], ["current"], undefined, mockPlatform());
    expect(rep.checks.some((c) => c.ID === "path.off.python")).toBe(false);
  });
});

describe("computeConflicts: version-aware PATH duplicate (H1)", () => {
  it("same version across entries -> harmless redundancy, info, not a pathConflict", () => {
    const g = group("conda", [
      { path: "/c/conda.exe", onPath: true, version: "26.1.1" },
      { path: "/c/condabin/conda.bat", onPath: true, version: "26.1.1" },
    ]);
    const rep = computeConflicts([g], ["current"], undefined, mockPlatform());
    const chk = rep.checks.find((c) => c.ID === "path.duplicate.conda");
    expect(chk).toBeDefined();
    expect(chk!.Severity).toBe("info");
    expect(rep.pathConflicts.find((p) => p.name === "conda")).toBeUndefined();
  });

  it("different versions -> warn shadowing + recorded as a pathConflict", () => {
    const g = group("node", [
      { path: "/a/node", onPath: true, version: "18.0.0" },
      { path: "/b/node", onPath: true, version: "20.0.0" },
    ]);
    const rep = computeConflicts([g], ["current"], undefined, mockPlatform());
    const chk = rep.checks.find((c) => c.ID === "path.duplicate.node");
    expect(chk).toBeDefined();
    expect(chk!.Severity).toBe("warn");
    const pc = rep.pathConflicts.find((p) => p.name === "node");
    expect(pc).toBeDefined();
    expect(pc!.resolvedTo).toBe("/a/node");
    expect(pc!.alsoAt).toEqual(["/b/node"]);
  });
});

describe("computeConflicts: duplicate PATH directories (hygiene)", () => {
  it("reports a single duplicated dir with the right redundant count", () => {
    const rep = computeConflicts(
      [],
      ["current"],
      undefined,
      mockPlatform({ pathDirs: () => ["/x", "/x", "/y"] }),
    );
    const chk = rep.checks.find((c) => c.ID === "path.duplicate-dir");
    expect(chk).toBeDefined();
    expect(chk!.Severity).toBe("info");
    expect(chk!.Label).toContain("1 duplicate directories");
    expect(chk!.Label).toContain("1 redundant");
  });

  it("no duplicate dirs -> no duplicate-dir check", () => {
    const rep = computeConflicts([], ["current"], undefined, mockPlatform({ pathDirs: () => ["/x", "/y"] }));
    expect(rep.checks.some((c) => c.ID === "path.duplicate-dir")).toBe(false);
  });
});

describe("computeConflicts: cross-shell mismatch (H2)", () => {
  it("raises an info when the same binary resolves to different paths per shell", () => {
    const shells: ShellId[] = ["pwsh", "gitbash"];
    const dirsByShell: Record<string, string[]> = { pwsh: ["/pwsh"], gitbash: ["/gitbash"] };
    const platform = mockPlatform({
      shellPathDirs: (s) => dirsByShell[s] ?? [],
      whichInDirs: (_name, dirs) => (dirs.length ? [dirs[0] + "/python"] : []),
      shellName: (s) => (s === "pwsh" ? "PowerShell" : "Git Bash"),
    });
    const g = group("python", [{ path: "/pwsh/python", onPath: true, version: "3.12" }]);
    const rep = computeConflicts([g], shells, undefined, platform);
    const chk = rep.checks.find((c) => c.ID === "shell.mismatch.python");
    expect(chk).toBeDefined();
    expect(chk!.Severity).toBe("info");
    expect(chk!.Detail).toContain("PowerShell");
    expect(chk!.Detail).toContain("Git Bash");
  });

  it("single shell -> no mismatch checks", () => {
    const rep = computeConflicts(
      [group("python", [{ path: "/p/python", onPath: true, version: "3.12" }])],
      ["current"],
      undefined,
      mockPlatform(),
    );
    expect(rep.checks.some((c) => c.ID.startsWith("shell.mismatch."))).toBe(false);
  });
});

describe("computeConflicts: --disable filtering", () => {
  it("removes a check whose ID matches a disabled prefix", () => {
    const g = group("ripgrep", [{ path: "/opt/rg", onPath: false, version: "13.0" }]);
    const rep = computeConflicts([g], ["current"], new Set(["path.off"]), mockPlatform());
    expect(rep.checks.some((c) => c.ID === "path.off.ripgrep")).toBe(false);
  });

  it("only removes the matching subtree, not unrelated checks", () => {
    const g = group("node", [
      { path: "/a/node", onPath: true, version: "18.0.0" },
      { path: "/b/node", onPath: false, version: "20.0.0" }, // off-PATH too
    ]);
    const rep = computeConflicts([g], ["current"], new Set(["path.off"]), mockPlatform());
    expect(rep.checks.some((c) => c.ID === "path.off.node")).toBe(false);
    expect(rep.checks.some((c) => c.ID === "version.multi.node")).toBe(true);
  });
});
