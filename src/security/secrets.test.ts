import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSecrets } from "./secrets";

function makeEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "devmap-secrets-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, contents, "utf8");
  return dir;
}

describe("scanSecrets", () => {
  it("detects a well-known AWS key and redacts it", () => {
    const dir = makeEnv("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\naws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n");
    try {
      const checks = scanSecrets([dir], false);
      const aws = checks.find((c) => c.ID.includes("aws-access-key-id"));
      const sec = checks.find((c) => c.ID.includes("aws-secret-access-key"));
      expect(aws).toBeDefined();
      expect(sec).toBeDefined();
      expect(aws!.Severity).toBe("warn");
      // redaction: full key never appears
      expect(aws!.Label).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(aws!.Detail).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(aws!.Label).toContain("AKIA****");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a GitHub token", () => {
    // ghp_ personal tokens have exactly 36 chars after the prefix
    const token = "ghp_" + "a".repeat(36);
    const dir = makeEnv(`GH_TOKEN=${token}\n`);
    try {
      const checks = scanSecrets([dir], false);
      const gh = checks.find((c) => c.ID.includes("github-token"));
      expect(gh).toBeDefined();
      expect(gh!.Label).not.toContain(token);
      expect(gh!.Label).toContain("ghp_****");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a private key block (static mask)", () => {
    const dir = makeEnv("-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n");
    try {
      const checks = scanSecrets([dir], false);
      const pk = checks.find((c) => c.ID.includes("private-key-block"));
      expect(pk).toBeDefined();
      expect(pk!.Label).toContain("[PRIVATE KEY BLOCK]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips trivial low-entropy assignments (noise gate)", () => {
    const dir = makeEnv("debug = true\ntoken = abc\npassword = admin\n");
    try {
      const checks = scanSecrets([dir], false);
      // should NOT flag the trivial values; only the ok summary remains
      expect(checks.every((c) => c.Severity !== "warn")).toBe(true);
      expect(checks.some((c) => c.ID === "security.secrets.ok")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a high-entropy generic assignment", () => {
    const secret = "A7b9cD2eF4gH6jK8lM0nP1qR3sT5uV7wX9yZ";
    const dir = makeEnv(`api_key = ${secret}\n`);
    try {
      const checks = scanSecrets([dir], false);
      const g = checks.find((c) => c.ID.includes("generic-secret-assignment"));
      expect(g).toBeDefined();
      expect(g!.Label).not.toContain(secret);
      expect(g!.Label).toContain("A7b9****");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an ok check when no candidate files exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "devmap-secrets-empty-"));
    try {
      const checks = scanSecrets([dir], false);
      expect(checks.length).toBe(1);
      expect(checks[0].ID).toBe("security.secrets.ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
