// Minimal MCP (Model Context Protocol) server over stdio — zero external dependencies.
//
// Strategy (see docs/mcp-integration.md): devmap stays a single CLI *engine*; the MCP server is a
// thin adapter that wraps the existing scan/query engine and exposes it to AI IDE agents
// (Cursor / Cline / Claude Desktop / Windsurf) as tools. No detection logic is duplicated here,
// and no third code tree is introduced — this file is the only MCP-specific surface.
//
// Protocol: JSON-RPC 2.0, newline-delimited, on stdin/stdout. stdout is reserved exclusively for
// protocol frames; everything else (diagnostics) goes to stderr so it never corrupts the stream.
//
// Spec coverage
// -------------
// 2026-07-28 (current revision) — stateless request/response core:
//   * the `initialize` / `initialized` handshake and `Mcp-Session-Id` were retired, so every
//     request is self-contained. We answer `tools/*` without requiring a prior handshake, and
//     serve the optional `server/discover` RPC for clients that still want capabilities up front.
//   * tool descriptors carry `annotations` (readOnlyHint / openWorldHint) so clients can apply
//     consent rules, plus a full JSON Schema 2020-12 `outputSchema`.
//   * tool results carry `structuredContent` next to the text rendering.
//   * `tools/list` returns cache hints (`ttlMs` + `cacheScope`) in a deterministic order.
//   * an unknown tool answers `-32602 Invalid Params` (the MCP-custom `-32002` is gone).
// 2024-11-05 … 2025-11-25 — the legacy handshake is still answered so older clients keep working;
// the client's version is echoed back verbatim when it is one we know.
import { runScan } from "./scan";
import { queryManifest } from "./query";
import { VERSION } from "./version";
import type { ShellId } from "./types";

// ---- protocol constants -----------------------------------------------------

/** Every MCP revision devmap has been validated against, oldest → newest. */
export const SUPPORTED_PROTOCOLS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
] as const;

/** Advertised when the client asks for a revision we do not know (or omits one entirely). */
export const PREFERRED_PROTOCOL = "2026-07-28";

/** The tool catalogue only changes when the server version changes — safe to cache hard. */
export const TOOLS_TTL_MS = 300_000;
export const TOOLS_CACHE_SCOPE = "public";

export const SERVER_INFO = { name: "devmap", version: VERSION } as const;

// ---- shared schemas ---------------------------------------------------------

const CHECK_SCHEMA = {
  type: "object",
  description: "One finding: a missing tool, a PATH conflict, a ghost binary, a health or security issue.",
  required: ["ID", "Kind", "Severity", "Label", "Detail"],
  properties: {
    ID: { type: "string", description: "Stable rule id; pass a prefix to --disable to silence it." },
    Kind: {
      type: "string",
      enum: ["missing", "conflict", "ghost", "mismatch", "stale", "vuln", "secret"],
    },
    Severity: { type: "string", enum: ["ok", "info", "warn", "error", "missing"] },
    Label: { type: "string" },
    Detail: { type: "string" },
    Path: { type: "array", items: { type: "string" } },
  },
  additionalProperties: true,
};

const MANIFEST_SCHEMA = {
  type: "object",
  description: "The full devmap manifest (schema devmap.manifest/1.0).",
  required: ["meta", "summary", "checks"],
  properties: {
    meta: {
      type: "object",
      required: ["tool", "version", "generatedAt", "schema"],
      properties: {
        tool: { type: "string", const: "devmap" },
        version: { type: "string" },
        generatedAt: { type: "string", format: "date-time" },
        schema: { type: "string" },
        shells: { type: "array", items: { type: "string" } },
      },
      additionalProperties: true,
    },
    summary: {
      type: "object",
      description:
        "Aggregates: tool/installation counts, multi-version tools, issueCountBySeverity, per-layer environment sizes.",
      additionalProperties: true,
    },
    checks: { type: "array", items: CHECK_SCHEMA },
    conflicts: {
      type: "object",
      description: "The PATH conflict graph: multi-version groups, shadowed binaries, broken symlinks.",
      additionalProperties: true,
    },
    runtimes: { type: "array", items: { type: "object", additionalProperties: true } },
    packageManagers: { type: "array", items: { type: "object", additionalProperties: true } },
    ides: { type: "array", items: { type: "object", additionalProperties: true } },
    environments: { type: "object", additionalProperties: true },
    sdks: { type: "object", description: "Android / Flutter / Dart / NDK state.", additionalProperties: true },
    windows: { type: "object", description: "Windows pre-flight state.", additionalProperties: true },
    system: { type: "object", additionalProperties: true },
  },
  additionalProperties: true,
};

const QUERY_SCHEMA = {
  type: "object",
  description: "A filtered view of a scan: matching tool groups, related checks, and optional conflicts.",
  required: ["groups", "checks"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "category", "installs"],
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: ["runtime", "packageManager", "ide"] },
          installs: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        additionalProperties: true,
      },
    },
    checks: { type: "array", items: CHECK_SCHEMA },
    conflicts: { type: "object", additionalProperties: true },
  },
  additionalProperties: true,
};

const PREFLIGHT_SCHEMA = {
  type: "object",
  description: "The pre-flight verdict: can this machine run the intended command cleanly right now?",
  required: ["ok", "blockers", "warnings"],
  properties: {
    ok: { type: "boolean", description: "True when `blockers` is empty — the agent may proceed." },
    blockers: {
      type: "array",
      items: { type: "string" },
      description: "Rule ids at error severity. Non-empty ⇒ fix these before running anything.",
    },
    warnings: { type: "array", items: { type: "string" }, description: "Rule ids at warn severity." },
    executionPolicy: { type: ["string", "null"], description: "PowerShell execution policy, if applicable." },
    languageMode: {
      type: ["string", "null"],
      description: "PowerShell language mode (ConstrainedLanguage blocks agents).",
    },
    codepage: { type: ["integer", "null"], description: "Active console code page (936 = GBK)." },
    schannelRevoke: { type: ["boolean", "null"], description: "Whether schannel does cert-revocation checks." },
    windows: {
      type: "object",
      properties: {
        present: { type: "boolean" },
        appAliases: { type: "integer", description: "App Execution Aliases that can shadow a real binary." },
        safeDelete: { type: "boolean", description: "Whether a safe-delete shim makes deletions fail closed." },
      },
      additionalProperties: true,
    },
    sdk: {
      type: "object",
      description: "Android / Flutter / Dart state, or null when the toolchain is absent.",
      additionalProperties: true,
    },
    pathConflicts: {
      type: "integer",
      description: "Number of PATH conflicts that could change which binary runs.",
    },
  },
  additionalProperties: true,
};

// ---- tool catalogue ---------------------------------------------------------

// devmap never mutates the machine it inspects — that is the product's core promise, so every tool
// declares readOnlyHint. Only scan_environment can reach the network (opt-in auditDeps /
// healthNetwork probes), hence openWorldHint there and nowhere else.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

/**
 * Tool catalogue exposed to agents. This is the single source of truth for the adapter surface.
 * Order is fixed and intentional: `tools/list` must be deterministic so client-side caches stay
 * stable across reconnects (2026-07-28 §cacheable list results).
 */
export const TOOLS = [
  {
    name: "scan_environment",
    description:
      "Run a full devmap scan of the local development environment and return the structured manifest " +
      "(detected tools across runtimes/pkg-managers/IDEs, PATH conflicts & ghost binaries, per-env health " +
      "checks, and the security posture). Use this first to understand a machine before proposing changes.",
    annotations: { ...READ_ONLY, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        shells: {
          type: "string",
          description:
            "Comma-separated shell views to reconstruct: current|powershell|gitbash|wsl|all (default current)",
        },
        disable: {
          type: "string",
          description: "Comma-separated check-rule prefixes to skip, e.g. 'path.duplicate,health.conda.base'",
        },
        auditDeps: {
          type: "boolean",
          description:
            "Opt-in dependency CVE audit via installed SCA tools (OSV-Scanner/pip-audit/govulncheck/Trivy). Uses network.",
        },
        healthNetwork: {
          type: "boolean",
          description:
            "Also run network health probes (npm doctor / rustup check). Off by default to stay offline-fast.",
        },
        scanSecrets: {
          type: "boolean",
          description:
            "Opt-in: scan a curated allowlist of HOME/project credential files for hardcoded secrets (offline).",
        },
      },
    },
    outputSchema: MANIFEST_SCHEMA,
  },
  {
    name: "query_tool",
    description:
      "Query a scan for a specific tool, semantic category, conflict, or issue — e.g. selector 'node', " +
      "'runtime.node', 'pkg.npm', 'git', or 'python'. Returns matching installs plus any related findings. " +
      "Cheaper than a full scan when you already know what you are looking for.",
    annotations: { ...READ_ONLY, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "Tool id substring or 'category.tool' dotted form (e.g. node / runtime.node / pkg.npm)",
        },
        issuesOnly: { type: "boolean", description: "Only return issues (warn/error/missing) for the match" },
        conflictsOnly: { type: "boolean", description: "Only return PATH/version/ghost conflicts for the match" },
        offPathOnly: {
          type: "boolean",
          description: "Only return isolated off-PATH installs (version-manager envs excluded)",
        },
        shells: { type: "string", description: "Shell views (see scan_environment)" },
        disable: { type: "string", description: "Check-rule prefixes to skip (see scan_environment)" },
      },
      required: ["selector"],
    },
    outputSchema: QUERY_SCHEMA,
  },
  {
    name: "preflight",
    description:
      "Agent pre-flight oracle: call this BEFORE running any shell command on the user's machine. " +
      "Returns a structured 'can this machine run my command cleanly right now' verdict -- Windows " +
      "constraints (execution policy, language mode, codepage, schannel revocation, app aliases, " +
      "safe-delete), mobile SDK state (Android/Flutter/Dart), and PATH conflict count. If 'blockers' " +
      "is non-empty the agent should fix (or ask the user to fix) those first, rather than discovering " +
      "failure mid-run (the gemini-cli #12519 'could not be parsed safely' class of failure).",
    annotations: { ...READ_ONLY, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Shell the agent intends to drive: powershell | cmd | gitbash | wsl (default current)",
        },
        forAgent: {
          type: "boolean",
          description: "When true, emphasise agent-relevant constraints (language mode, execution policy, codepage)",
        },
        disable: {
          type: "string",
          description: "Comma-separated check-rule prefixes to skip, e.g. 'health.conda' to keep preflight fast",
        },
      },
    },
    outputSchema: PREFLIGHT_SCHEMA,
  },
];

export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));

// ---- argument helpers -------------------------------------------------------

const ALL_SHELLS: ShellId[] = ["current", "powershell", "gitbash", "wsl"];

function parseShells(v: unknown): ShellId[] {
  if (typeof v !== "string" || !v) return ["current"];
  const list = v.split(",").map((s) => s.trim()) as ShellId[];
  return list.includes("all" as ShellId) ? ALL_SHELLS : list.length ? list : ["current"];
}
function parseDisable(v: unknown): Set<string> {
  if (typeof v !== "string" || !v) return new Set();
  return new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
}

// Map a preflight `target` to the shell view the scan should reconstruct.
function targetToShells(target: unknown): ShellId[] {
  if (typeof target === "string" && target) {
    const t = target.toLowerCase();
    if (t === "powershell") return ["powershell"];
    if (t === "cmd") return ["current"];
    if (t === "gitbash") return ["gitbash"];
    if (t === "wsl") return ["wsl"];
  }
  return ["current"];
}

// Build the agent-facing pre-flight verdict from a full manifest. Reuses the scan output -- no new
// probing logic (the Windows / SDK detectors already produced the relevant checks & data).
function buildPreflight(manifest: any): any {
  const win = manifest.windows || {};
  const sdks = manifest.sdks || {};
  const conflicts = manifest.conflicts || {};
  const pathConflicts: any[] = conflicts.pathConflicts || [];
  const checks: any[] = manifest.checks || [];
  const blockers = checks.filter((c: any) => c.Severity === "error").map((c: any) => c.ID);
  const warnings = checks.filter((c: any) => c.Severity === "warn").map((c: any) => c.ID);
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    executionPolicy: win.executionPolicy ?? null,
    languageMode: win.languageMode ?? null,
    codepage: win.codepage ?? null,
    schannelRevoke: win.schannelRevokeCheck ?? null,
    windows: {
      present: !!win.windows,
      appAliases: (win.appAliases || []).length,
      safeDelete: !!win.safeDeleteActive,
    },
    sdk: {
      android: sdks.android
        ? { sdkHome: sdks.android.sdkHome, ndk: sdks.android.ndk || [], flutterChannel: sdks.flutter?.channel ?? null }
        : null,
      flutter: sdks.flutter ? { version: sdks.flutter.version, channel: sdks.flutter.channel } : null,
      dart: sdks.dart ? { version: sdks.dart.version } : null,
    },
    pathConflicts: pathConflicts.length,
  };
}

// ---- tool execution ---------------------------------------------------------

export type ToolCallResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError: boolean;
};

/** Injectable seams so the protocol layer can be tested without touching a real machine. */
export interface McpDeps {
  scan?: (shells: ShellId[], disabled: Set<string>, opts: any) => Promise<any>;
  query?: (manifest: any, opts: any) => any;
  serverInfo?: { name: string; version: string };
}

function wrap(structured: unknown): ToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: false,
  };
}

export async function callTool(name: string, rawArgs: unknown, deps: McpDeps = {}): Promise<ToolCallResult> {
  const scan = deps.scan ?? runScan;
  const query = deps.query ?? queryManifest;
  const args: Record<string, unknown> =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};

  if (name === "scan_environment") {
    const manifest = await scan(parseShells(args.shells), parseDisable(args.disable), {
      silent: true,
      auditDeps: args.auditDeps === true,
      healthNetwork: args.healthNetwork === true,
      scanSecrets: args.scanSecrets === true,
    });
    return wrap(manifest);
  }
  if (name === "query_tool") {
    const manifest = await scan(parseShells(args.shells), parseDisable(args.disable), { silent: true });
    const result = query(manifest, {
      selector: typeof args.selector === "string" ? args.selector : undefined,
      issues: args.issuesOnly === true,
      conflicts: args.conflictsOnly === true,
      offPath: args.offPathOnly === true,
    });
    return wrap(result);
  }
  if (name === "preflight") {
    // Fast path: moat + conflict detectors only (~seconds), skipping the slow health/security layers.
    const manifest = await scan(targetToShells(args.target), parseDisable(args.disable), {
      silent: true,
      fast: true,
    });
    return wrap(buildPreflight(manifest));
  }
  throw new Error(`unknown tool: ${name}`);
}

// ---- JSON-RPC dispatch ------------------------------------------------------

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Echo a client version we know; otherwise advertise ours (the client decides what to do). */
export function negotiateProtocol(requested: unknown): string {
  if (typeof requested === "string" && (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)) {
    return requested;
  }
  return PREFERRED_PROTOCOL;
}

function discoverResult(deps: McpDeps) {
  return {
    protocolVersion: PREFERRED_PROTOCOL,
    capabilities: { tools: {} },
    serverInfo: deps.serverInfo ?? SERVER_INFO,
  };
}

/**
 * Handle a single decoded JSON-RPC frame and return the response object, or `null` when the message
 * is a notification that must not be answered. Pure apart from the injected scan/query seams, which
 * is what makes the protocol layer unit-testable without spawning the stdio loop.
 */
export async function handleMessage(msg: any, deps: McpDeps = {}): Promise<any | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return fail(null, -32600, "invalid request");

  const id = msg.id;
  const method: unknown = msg.method;
  if (typeof method !== "string" || !method) {
    // A notification without a method is meaningless; only answer when the client expects a reply.
    return id === undefined ? null : fail(id, -32600, "missing method");
  }
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};

  switch (method) {
    // Legacy handshake (2024-11-05 … 2025-11-25). Retired in 2026-07-28 but kept for older clients.
    case "initialize":
      return ok(id, {
        protocolVersion: negotiateProtocol(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: deps.serverInfo ?? SERVER_INFO,
        instructions:
          "devmap is a read-only environment oracle. Call `preflight` before running shell commands; " +
          "call `scan_environment` when you need the full manifest.",
      });

    // 2026-07-28 replacement for the handshake: optional, stateless capability discovery.
    case "server/discover":
      return ok(id, discoverResult(deps));

    case "notifications/initialized":
    case "initialized":
    case "notifications/cancelled":
      return null; // notifications take no response

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS, ttlMs: TOOLS_TTL_MS, cacheScope: TOOLS_CACHE_SCOPE });

    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !name) return fail(id, -32602, "missing tool name");
      // 2026-07-28: an unknown tool is Invalid Params (-32602); the MCP-custom -32002 no longer exists.
      if (!TOOL_NAMES.has(name)) return fail(id, -32602, `unknown tool: ${name}`);
      try {
        return ok(id, await callTool(name, params.arguments, deps));
      } catch (e: any) {
        // Tool-level failure stays inside a successful protocol result (spec §tool errors).
        return ok(id, {
          content: [{ type: "text", text: "error: " + (e?.message || String(e)) }],
          isError: true,
        });
      }
    }

    default:
      return id === undefined ? null : fail(id, -32601, `method not found: ${method}`);
  }
}

/**
 * Start the MCP stdio server. Reads newline-delimited JSON-RPC frames from stdin, writes responses
 * to stdout. Resolves only when stdin reaches EOF (e.g. the client disconnects).
 */
export async function startMcpServer(): Promise<void> {
  // Reserve stdout strictly for protocol frames; redirect any stray console output to stderr.
  const toErr = (...a: unknown[]) =>
    process.stderr.write(a.map((x) => (typeof x === "string" ? x : String(x))).join(" ") + "\n");
  console.log = toErr;
  console.error = toErr;
  console.warn = toErr;
  console.info = toErr;

  const write = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
  const log = toErr;

  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk as string;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        log("[mcp] dropping malformed frame");
        continue;
      }
      log("[mcp] ->", msg.method || "?", msg.id ?? "");
      const res = await handleMessage(msg);
      if (res !== null) write(res);
    }
  }
  log("[mcp] stdin closed, shutting down");
}
