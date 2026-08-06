// Unit tests for version extraction (platform/exec.ts).
// Guards against regressions in how `--version` blobs are parsed into clean x.y.z,
// including git's dot-suffixed build tag (e.g. `2.53.0.windows.1`).
import { describe, test, expect } from "bun:test";
import { extractVersion } from "./exec";

describe("extractVersion", () => {
  test("git dot-suffixed build tag", () =>
    expect(extractVersion("git version 2.53.0.windows.1", "C:\\Program Files\\Git\\cmd\\git.exe")).toBe(
      "2.53.0.windows.1",
    ));
  test("git plain version", () => expect(extractVersion("git version 2.45.1")).toBe("2.45.1"));
  test("node with leading v", () => expect(extractVersion("node v22.22.2")).toBe("22.22.2"));
  test("npm bare version", () => expect(extractVersion("11.8.0")).toBe("11.8.0"));
  test("python", () => expect(extractVersion("Python 3.13.9")).toBe("3.13.9"));
  test("rustc with suffix", () => expect(extractVersion("rustc 1.96.1 (abc123)")).toBe("1.96.1"));
  test("openjdk quoted", () => expect(extractVersion('openjdk version "26.0.1"')).toBe("26.0.1"));
  test("bun bare", () => expect(extractVersion("1.3.14")).toBe("1.3.14"));
  test("pip loose x.y", () => expect(extractVersion("pip 26.2 from /x")).toBe("26.2"));
  test("go version goX.Y.Z", () => expect(extractVersion("go version go1.22.5")).toBe("1.22.5"));
  test("semver with -rc suffix", () => expect(extractVersion("tool 1.2.3-rc1")).toBe("1.2.3-rc1"));
  test("semver with +build suffix", () => expect(extractVersion("tool 1.2.3+build.5")).toBe("1.2.3+build.5"));
  test("filters bracketed JVM log line, prefers own key", () =>
    expect(extractVersion('[0.022s][warning] something\npycharm: 2025.2.4', "pycharm.exe")).toBe("2025.2.4"));
  test("no version -> null", () => expect(extractVersion("no version here")).toBe(null));
});
