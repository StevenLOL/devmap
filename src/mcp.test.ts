import { describe, it, expect } from "bun:test";
import {
  handleMessage,
  callTool,
  negotiateProtocol,
  TOOLS,
  TOOL_NAMES,
  SUPPORTED_PROTOCOLS,
  PREFERRED_PROTOCOL,
  TOOLS_TTL_MS,
  TOOLS_CACHE_SCOPE,
  SERVER_INFO,
  type McpDeps,
} from "./mcp";

// A manifest shaped exactly like the real one, so the preflight projection is exercised end to end.
function fakeManifest(overrides: any = {}) {
  return {
    meta: {
      tool: "devmap",
      version: "0.0.0-test",
      generatedAt: "2026-01-01T00:00:00.000Z",
      schema: "devmap.manifest/1.0",
      shells: ["current"],
    },
    summary: { totalInstallations: 1, issueCountBySeverity: { error: 1, warn: 1, info: 0, missing: 0, ok: 0 } },
    checks: [
      { ID: "win.langmode", Kind: "mismatch", Severity: "error", Label: "ConstrainedLanguage", Detail: "blocked" },
      { ID: "win.execpolicy", Kind: "mismatch", Severity: "warn", Label: "Restricted", Detail: "policy" },
      { ID: "path.ok", Kind: "missing", Severity: "ok", Label: "fine", Detail: "ok" },
    ],
    conflicts: { pathConflicts: [{ id: "python" }] },
    windows: {
      windows: true,
      executionPolicy: "Restricted",
      languageMode: "ConstrainedLanguage",
      codepage: 936,
      schannelRevokeCheck: true,
      appAliases: [{}, {}],
      safeDeleteActive: false,
    },
    sdks: { android: null, flutter: { version: "3.24.0", channel: "stable" }, dart: null },
    ...overrides,
  };
}

/** Records how the tool layer called the scan engine, then returns a canned manifest. */
function spyDeps(manifest: any = fakeManifest()) {
  const calls: { shells: string[]; disabled: Set<string>; opts: any }[] = [];
  const deps: McpDeps = {
    scan: async (shells, disabled, opts) => {
      calls.push({ shells: shells as unknown as string[], disabled, opts });
      return manifest;
    },
    query: (m: any, opts: any) => ({ groups: [{ id: "node", category: "runtime", installs: [] }], checks: [], opts }),
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------
// version negotiation
// ---------------------------------------------------------------------------

describe("mcp protocol: version negotiation", () => {
  it("echoes every protocol revision we claim to support", () => {
    for (const v of SUPPORTED_PROTOCOLS) {
      expect(negotiateProtocol(v)).toBe(v);
    }
  });

  it("falls back to the preferred revision for unknown input", () => {
    expect(negotiateProtocol("2019-01-01")).toBe(PREFERRED_PROTOCOL);
    expect(negotiateProtocol(undefined)).toBe(PREFERRED_PROTOCOL);
    expect(negotiateProtocol(42)).toBe(PREFERRED_PROTOCOL);
  });

  it("initialize echoes a known client version and advertises serverInfo", async () => {
    const res = await handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(res!.result.protocolVersion).toBe("2025-06-18");
    expect(res!.result.serverInfo).toEqual(SERVER_INFO);
    expect(res!.result.capabilities).toEqual({ tools: {} });
  });

  it("initialize without a client version advertises the preferred revision", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res!.result.protocolVersion).toBe(PREFERRED_PROTOCOL);
  });

  it("server/discover serves the 2026-07-28 capability summary", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 7, method: "server/discover", params: {} });
    expect(res!.id).toBe(7);
    expect(res!.result.protocolVersion).toBe(PREFERRED_PROTOCOL);
    expect(res!.result.serverInfo).toEqual(SERVER_INFO);
    expect(res!.result.capabilities).toEqual({ tools: {} });
  });

  it("injected serverInfo overrides the built-in one", async () => {
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { serverInfo: { name: "devmap", version: "9.9.9" } },
    );
    expect(res!.result.serverInfo.version).toBe("9.9.9");
  });
});

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

describe("mcp protocol: JSON-RPC envelope", () => {
  it("rejects non-object frames with -32600", async () => {
    for (const bad of [null, undefined, 42, "x", []]) {
      const res = await handleMessage(bad);
      expect(res!.error.code).toBe(-32600);
      expect(res!.id).toBeNull();
    }
  });

  it("rejects a request with no method (-32600) but stays silent for a methodless notification", async () => {
    expect((await handleMessage({ jsonrpc: "2.0", id: 3 }))!.error.code).toBe(-32600);
    expect(await handleMessage({ jsonrpc: "2.0" })).toBeNull();
  });

  it("answers unknown methods with -32601, and ignores unknown notifications", async () => {
    expect((await handleMessage({ jsonrpc: "2.0", id: 4, method: "resources/list" }))!.error.code).toBe(-32601);
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/progress" })).toBeNull();
  });

  it("treats notifications as no-response", async () => {
    for (const m of ["notifications/initialized", "initialized", "notifications/cancelled"]) {
      expect(await handleMessage({ jsonrpc: "2.0", method: m })).toBeNull();
    }
  });

  it("answers ping with an empty result", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 5, method: "ping" });
    expect(res).toEqual({ jsonrpc: "2.0", id: 5, result: {} });
  });
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe("mcp protocol: tools/list", () => {
  it("returns the three tools in a deterministic order", async () => {
    const a = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const b = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(a!.result.tools.map((t: any) => t.name)).toEqual(["scan_environment", "query_tool", "preflight"]);
    // Deterministic ordering keeps client-side caches stable across reconnects.
    expect(a!.result.tools).toEqual(b!.result.tools);
  });

  it("carries cache hints required by the 2026-07-28 list contract", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res!.result.ttlMs).toBe(TOOLS_TTL_MS);
    expect(res!.result.cacheScope).toBe(TOOLS_CACHE_SCOPE);
  });

  it("declares read-only annotations on every tool", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    for (const t of res!.result.tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
      expect(t.annotations.idempotentHint).toBe(true);
      expect(typeof t.annotations.openWorldHint).toBe("boolean");
    }
  });

  it("marks only scan_environment as open-world (it can reach the network)", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const byName = Object.fromEntries(res!.result.tools.map((t: any) => [t.name, t]));
    expect(byName.scan_environment.annotations.openWorldHint).toBe(true);
    expect(byName.query_tool.annotations.openWorldHint).toBe(false);
    expect(byName.preflight.annotations.openWorldHint).toBe(false);
  });

  it("gives every tool a full JSON Schema input and output contract", async () => {
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema.type).toBe("object");
      expect(Object.keys(t.outputSchema.properties).length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(40);
    }
    // Spot-check that the preflight contract matches what buildPreflight actually returns.
    expect(TOOLS[2].outputSchema.required).toEqual(["ok", "blockers", "warnings"]);
  });
});

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

describe("mcp protocol: tools/call", () => {
  it("works without a prior initialize handshake (stateless 2026-07-28 core)", async () => {
    const { deps } = spyDeps();
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "preflight", arguments: {} } },
      deps,
    );
    expect(res!.error).toBeUndefined();
    expect(res!.result.structuredContent.ok).toBe(false);
  });

  it("rejects a missing tool name with -32602", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    expect(res!.error.code).toBe(-32602);
  });

  it("rejects an unknown tool with -32602 (not the retired -32002)", async () => {
    const res = await handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "rm_rf", arguments: {} },
    });
    expect(res!.error.code).toBe(-32602);
    expect(res!.error.message).toContain("unknown tool");
  });

  it("scan_environment returns the manifest as structured content", async () => {
    const manifest = fakeManifest();
    const { deps, calls } = spyDeps(manifest);
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "scan_environment", arguments: {} } },
      deps,
    );
    expect(res!.result.isError).toBe(false);
    expect(res!.result.structuredContent).toEqual(manifest as any);
    expect(res!.result.content[0].type).toBe("text");
    // The text rendering must be the same JSON the structured form carries.
    expect(JSON.parse(res!.result.content[0].text)).toEqual(manifest as any);
    expect(calls[0].shells).toEqual(["current"]);
    expect(calls[0].opts.silent).toBe(true);
  });

  it("scan_environment forwards the opt-in flags verbatim", async () => {
    const { deps, calls } = spyDeps();
    await handleMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "scan_environment",
          arguments: { shells: "powershell,gitbash", disable: "health.conda,path.duplicate", auditDeps: true, scanSecrets: true },
        },
      },
      deps,
    );
    expect(calls[0].shells).toEqual(["powershell", "gitbash"]);
    expect([...calls[0].disabled]).toEqual(["health.conda", "path.duplicate"]);
    expect(calls[0].opts.auditDeps).toBe(true);
    expect(calls[0].opts.scanSecrets).toBe(true);
    expect(calls[0].opts.healthNetwork).toBe(false);
  });

  it("preflight projects blockers/warnings and the Windows constraints", async () => {
    const { deps, calls } = spyDeps();
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "preflight", arguments: { target: "powershell" } } },
      deps,
    );
    const verdict = res!.result.structuredContent;
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers).toEqual(["win.langmode"]);
    expect(verdict.warnings).toEqual(["win.execpolicy"]);
    expect(verdict.languageMode).toBe("ConstrainedLanguage");
    expect(verdict.codepage).toBe(936);
    expect(verdict.windows.appAliases).toBe(2);
    expect(verdict.windows.safeDelete).toBe(false);
    expect(verdict.pathConflicts).toBe(1);
    // preflight must use the fast detector path and honour the shell target.
    expect(calls[0].shells).toEqual(["powershell"]);
    expect(calls[0].opts.fast).toBe(true);
  });

  it("preflight reports ok when nothing is at error severity", async () => {
    const { deps } = spyDeps(fakeManifest({ checks: [{ ID: "x", Kind: "missing", Severity: "warn", Label: "w", Detail: "d" }] }));
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "preflight", arguments: {} } },
      deps,
    );
    expect(res!.result.structuredContent.ok).toBe(true);
    expect(res!.result.structuredContent.blockers).toEqual([]);
  });

  it("query_tool routes through the query seam", async () => {
    const { deps } = spyDeps();
    const res = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "query_tool", arguments: { selector: "runtime.node", issuesOnly: true } },
      },
      deps,
    );
    expect(res!.result.structuredContent.groups[0].id).toBe("node");
    expect(res!.result.structuredContent.opts).toEqual({
      selector: "runtime.node",
      issues: true,
      conflicts: false,
      offPath: false,
    });
  });

  it("treats non-object arguments as an empty object", async () => {
    const { deps, calls } = spyDeps();
    await handleMessage(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "scan_environment", arguments: "oops" } },
      deps,
    );
    expect(calls[0].shells).toEqual(["current"]);
    expect(calls[0].opts.auditDeps).toBe(false);
  });

  it("keeps a tool-level failure inside a successful protocol result", async () => {
    const deps: McpDeps = {
      scan: async () => {
        throw new Error("scan exploded");
      },
    };
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "preflight", arguments: {} } },
      deps,
    );
    expect(res!.error).toBeUndefined();
    expect(res!.result.isError).toBe(true);
    expect(res!.result.content[0].text).toContain("scan exploded");
  });

  it("exports a tool-name set matching the catalogue", () => {
    expect([...TOOL_NAMES].sort()).toEqual(["preflight", "query_tool", "scan_environment"]);
  });

  it("callTool is usable directly and throws on an unknown tool", async () => {
    const { deps } = spyDeps();
    const direct = await callTool("preflight", {}, deps);
    expect(direct.isError).toBe(false);
    await expect(callTool("nope", {}, deps)).rejects.toThrow("unknown tool");
  });
});
