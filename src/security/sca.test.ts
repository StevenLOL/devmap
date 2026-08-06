// Unit tests for the SCA ADAPTER parsers (security/sca.ts).
// These cover the JSON-shape contracts devmap relies on when shelling out to
// osv-scanner / pip-audit / govulncheck / trivy via --audit-deps. They do NOT
// invoke the external tools, so they run fully offline and deterministic.
import { describe, test, expect } from "bun:test";
import { SCA_TOOLS, toSeverity } from "./sca";

const tool = (id: string) => SCA_TOOLS.find((t) => t.id === id)!;

describe("toSeverity", () => {
  test("CRITICAL -> error", () => expect(toSeverity("CRITICAL")).toBe("error"));
  test("HIGH -> error", () => expect(toSeverity("HIGH")).toBe("error"));
  test("MEDIUM -> warn", () => expect(toSeverity("MEDIUM")).toBe("warn"));
  test("LOW -> warn", () => expect(toSeverity("LOW")).toBe("warn"));
  test("undefined -> warn", () => expect(toSeverity(undefined)).toBe("warn"));
  test("case-insensitive", () => expect(toSeverity("critical")).toBe("error"));
});

describe("osv-scanner parser", () => {
  const fixture = {
    results: [
      {
        vulnerabilities: [
          {
            package: { name: "log4j", version: "2.0" },
            id: "CVE-2021-44228",
            severity: "CRITICAL",
            summary: "Remote code execution",
          },
          {
            package: { name: "commons-text", version: "1.9" },
            id: "CVE-2022-42889",
            severity: "HIGH",
            details: "Text4shell",
          },
        ],
      },
    ],
  };
  const out = tool("osv-scanner").parse(fixture, "OSV-Scanner");
  test("emits one check per vulnerability", () => expect(out.length).toBe(2));
  test("id is namespaced", () => expect(out[0].ID).toBe("security.deps.osv.CVE-2021-44228"));
  test("severity maps from CRITICAL", () => expect(out[0].Severity).toBe("error"));
  test("label names pkg@version", () => expect(out[0].Label).toContain("log4j@2.0"));
  test("label names the advisory id", () => expect(out[0].Label).toContain("CVE-2021-44228"));
  test("high -> error", () => expect(out[1].Severity).toBe("error"));
});

describe("pip-audit parser (new schema: dependencies[].vulns[])", () => {
  const fixture = {
    dependencies: [
      {
        name: "flask",
        version: "2.0.0",
        vulns: [
          { id: "PYSEC-1", severity: "HIGH", description: "xss", fix_versions: ["2.0.1"] },
        ],
      },
    ],
  };
  const out = tool("pip-audit").parse(fixture, "pip-audit");
  test("one check per vuln", () => expect(out.length).toBe(1));
  test("id namespaced", () => expect(out[0].ID).toBe("security.deps.pipaudit.PYSEC-1"));
  test("severity HIGH -> error", () => expect(out[0].Severity).toBe("error"));
  test("label has pkg@version", () => expect(out[0].Label).toContain("flask@2.0.0"));
  test("detail carries fix version", () => expect(out[0].Detail).toContain("2.0.1"));
});

describe("pip-audit parser (legacy schema: top-level vulnerabilities[])", () => {
  const fixture = {
    vulnerabilities: [{ name: "django", id: "CVE-2022-0001", severity: "MODERATE", description: "y" }],
  };
  const out = tool("pip-audit").parse(fixture, "pip-audit");
  test("falls back to legacy array", () => expect(out.length).toBe(1));
  test("id namespaced", () => expect(out[0].ID).toBe("security.deps.pipaudit.CVE-2022-0001"));
  test("MODERATE -> warn", () => expect(out[0].Severity).toBe("warn"));
});

describe("govulncheck parser", () => {
  const fixture = {
    Results: [
      {
        Vulnerabilities: [
          {
            OSV: { id: "GO-2022-0001" },
            Package: { Path: "example.com/mod/x", Name: "x" },
            Version: "v1.0.0",
            Details: "d",
            Severity: { Score: 9.1 },
          },
          {
            OSV: { id: "GO-2022-0002" },
            Package: { Path: "example.com/mod/y", Name: "y" },
            Version: "v0.5.0",
            Details: "d",
            Severity: { Score: 5.0 },
          },
        ],
      },
    ],
  };
  const out = tool("govulncheck").parse(fixture, "govulncheck");
  test("two checks", () => expect(out.length).toBe(2));
  test("score >= 9 -> error", () => expect(out[0].Severity).toBe("error"));
  test("score < 9 -> warn", () => expect(out[1].Severity).toBe("warn"));
  test("label has pkg path@version", () => expect(out[0].Label).toContain("example.com/mod/x@v1.0.0"));
  test("id namespaced", () => expect(out[0].ID).toBe("security.deps.govulncheck.GO-2022-0001"));
});

describe("trivy parser", () => {
  const fixture = {
    Results: [
      {
        Vulnerabilities: [
          {
            VulnerabilityID: "CVE-2023-0003",
            PkgName: "openssl",
            InstalledVersion: "1.1.1",
            Severity: "CRITICAL",
            Title: "t",
            FixedVersion: "1.1.2",
          },
        ],
      },
    ],
  };
  const out = tool("trivy").parse(fixture, "Trivy");
  test("one check", () => expect(out.length).toBe(1));
  test("id namespaced", () => expect(out[0].ID).toBe("security.deps.trivy.CVE-2023-0003"));
  test("CRITICAL -> error", () => expect(out[0].Severity).toBe("error"));
  test("label has pkg@version", () => expect(out[0].Label).toContain("openssl@1.1.1"));
  test("detail names fixed version", () => expect(out[0].Detail).toContain("1.1.2"));
});
