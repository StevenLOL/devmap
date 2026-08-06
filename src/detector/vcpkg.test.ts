import { describe, test, expect } from "bun:test";
import { parseVcpkgVersion } from "./vcpkg";

describe("parseVcpkgVersion", () => {
  test("date + full commit hash", () => {
    const out = "vcpkg package management program version 2026-07-13-bf04c909169fdbb30821c02c6eb01f1cd1295d05\n\nSee LICENSE.txt";
    expect(parseVcpkgVersion(out)).toBe("2026-07-13-bf04c909169fdbb30821c02c6eb01f1cd1295d05");
  });
  test("date only (no hash)", () => {
    const out = "vcpkg package management program version 2024-01-12";
    expect(parseVcpkgVersion(out)).toBe("2024-01-12");
  });
  test("null/empty input -> null", () => {
    expect(parseVcpkgVersion(null)).toBe(null);
    expect(parseVcpkgVersion("")).toBe(null);
  });
  test("x.y.z style is NOT matched (vcpkg never uses it, but guard anyway)", () => {
    // generic extractVersion would catch this; parseVcpkgVersion only matches date form
    const out = "vcpkg version 1.2.3";
    expect(parseVcpkgVersion(out)).toBe(null);
  });
});
