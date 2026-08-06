// Minimal MCP (Model Context Protocol) server over stdio — zero external dependencies.
//
// Strategy (see docs/mcp-integration.md): devmap stays a single CLI *engine*; the MCP server is a
// thin adapter that wraps the existing scan/query engine and exposes it to AI IDE agents
// (Cursor / Cline / Claude Desktop / Windsurf) as tools. No detection logic is duplicated here,
// and no third code tree is introduced — this file is the only MCP-specific surface.
//
// Protocol: JSON-RPC 2.0, newline-delimited, on stdin/stdout. stdout is reserved exclusively for
// protocol frames; everything else (diagnostics) goes to stderr so it never corrupts the stream.
import { runScan } from "./scan";
import { queryManifest } from "./query";
import { VERSION } from "./version";
import type { ShellId } from "./types";

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

// Tool catalogue exposed to agents. Keep this the single source of truth for the adapter surface.
const TOOLS = [
  {
    name: "scan_environment",
    description:
      "Run a full devmap scan of the local development environment and return the structured manifest " +
      "(detected tools across runtimes/pkg-managers/IDEs, PATH conflicts & ghost binaries, per-env health " +
      "checks, and the security posture). Use this first to understand a machine before proposing changes.",
    inputSchema: {
      type: "object",
      properties: {
        shells: {
          type: "string",
          description: "Comma-separated shell views to reconstruct: current|powershell|gitbash|wsl|all (default current)",
        },
        disable: {
          type: "string",
          description: "Comma-separated check-rule prefixes to skip, e.g. 'path.duplicate,health.conda.base'",
        },
        auditDeps: {
          type: "boolean",
          description: "Opt-in dependency CVE audit via installed SCA tools (OSV-Scanner/pip-audit/govulncheck/Trivy). Uses network.",
        },
        healthNetwork: {
          type: "boolean",
          description: "Also run network health probes (npm doctor / rustup check). Off by default to stay offline-fast.",
        },
        scanSecrets: {
          type: "boolean",
          description: "Opt-in: scan a curated allowlist of HOME/project credential files for hardcoded secrets (offline).",
        },
      },
    },
  },
  {
    name: "query_tool",
    description:
      "Query a scan for a specific tool, semantic category, conflict, or issue — e.g. selector 'node', " +
      "'runtime.node', 'pkg.npm', 'git', or 'python'. Returns matching installs plus any related findings. " +
      "Cheaper than a full scan when you already know what you are looking for.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "Tool id substring or 'category.tool' dotted form (e.g. node / runtime.node / pkg.npm)",
        },
        issuesOnly: { type: "boolean", description: "Only return issues (warn/error/missing) for the match" },
        conflictsOnly: { type: "boolean", description: "Only return PATH/version/ghost conflicts for the match" },
        offPathOnly: { type: "boolean", description: "Only return isolated off-PATH installs (version-manager envs excluded)" },
        shells: { type: "string", description: "Shell views (see scan_environment)" },
        disable: { type: "string", description: "Check-rule prefixes to skip (see scan_environment)" },
      },
    },
  },
] as const;

type ToolCallResult = { content: { type: "text"; text: string }[]; isError: boolean };

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  if (name === "scan_environment") {
    const manifest = await runScan(parseShells(args.shells), parseDisable(args.disable), {
      silent: true,
      auditDeps: args.auditDeps === true,
      healthNetwork: args.healthNetwork === true,
      scanSecrets: args.scanSecrets === true,
    });
    return { content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }], isError: false };
  }
  if (name === "query_tool") {
    const manifest = await runScan(parseShells(args.shells), parseDisable(args.disable), { silent: true });
    const result = queryManifest(manifest, {
      selector: typeof args.selector === "string" ? args.selector : undefined,
      issues: args.issuesOnly === true,
      conflicts: args.conflictsOnly === true,
      offPath: args.offPathOnly === true,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
  }
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
}

/**
 * Start the MCP stdio server. Reads newline-delimited JSON-RPC frames from stdin, writes responses
 * to stdout. Resolves only when stdin reaches EOF (e.g. the client disconnects).
 */
export async function startMcpServer(): Promise<void> {
  // Reserve stdout strictly for protocol frames; redirect any stray console output to stderr.
  const toErr = (...a: unknown[]) => process.stderr.write(a.map((x) => (typeof x === "string" ? x : String(x))).join(" ") + "\n");
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
      const id = msg.id;
      const method: string | undefined = msg.method;
      log("[mcp] ->", method || "?", id ?? "");
      if (!method) {
        if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32600, message: "missing method" } });
        continue;
      }
      switch (method) {
        case "initialize":
          write({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: msg.params?.protocolVersion || "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "devmap", version: VERSION },
            },
          });
          break;
        case "notifications/initialized":
        case "initialized":
        case "notifications/cancelled":
          // notifications need no response
          break;
        case "ping":
          write({ jsonrpc: "2.0", id, result: {} });
          break;
        case "tools/list":
          write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
          break;
        case "tools/call":
          try {
            const r = await callTool(msg.params?.name, msg.params?.arguments || {});
            write({ jsonrpc: "2.0", id, result: r });
          } catch (e: any) {
            write({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: "error: " + (e?.message || String(e)) }], isError: true },
            });
          }
          break;
        default:
          if (id !== undefined)
            write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    }
  }
  log("[mcp] stdin closed, shutting down");
}
