// devdiff subcommand: compare two manifests (devmap.json), reporting install add/remove / version changes / issue add/resolve (PRD L2 source of truth + drift detection).
// Typical use: current scan vs a previously saved manifest (has the environment drifted?); or two machine manifests (cross-machine consistency).

export interface InstallDelta {
  id: string;
  category: string;
  added: any[];
  removed: any[];
  versionChanged: { path: string; from: string | null; to: string | null }[];
}

export interface IssueDelta {
  id: string;
  added: any[];
  resolved: any[];
}

export interface DevmapDiff {
  tools: InstallDelta[];
  issues: IssueDelta[];
  summary: {
    installsAdded: number;
    installsRemoved: number;
    versionChanges: number;
    issuesAdded: number;
    issuesResolved: number;
  };
}

const CAT_KEYS: [string, "runtime" | "packageManager" | "ide"][] = [
  ["runtimes", "runtime"],
  ["packageManagers", "packageManager"],
  ["ides", "ide"],
];

function normPath(p: string): string {
  return (p || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

function collectInstalls(m: any): Map<string, { id: string; category: string; path: string; version: string | null; install: any }> {
  const map = new Map<string, { id: string; category: string; path: string; version: string | null; install: any }>();
  for (const [key, label] of CAT_KEYS) {
    for (const g of m[key] || []) {
      for (const inst of g.installs || []) {
        map.set(normPath(inst.path), {
          id: g.id,
          category: label,
          path: inst.path,
          version: inst.version || null,
          install: inst,
        });
      }
    }
  }
  return map;
}

function ensureTool(tools: Map<string, InstallDelta>, id: string, cat: string): InstallDelta {
  const k = id + "|" + cat;
  let t = tools.get(k);
  if (!t) {
    t = { id, category: cat, added: [], removed: [], versionChanged: [] };
    tools.set(k, t);
  }
  return t;
}

export function diffManifests(a: any, b: any): DevmapDiff {
  const A = collectInstalls(a);
  const B = collectInstalls(b);
  const tools = new Map<string, InstallDelta>();

  // Present in B: added or version changed
  for (const [np, v] of B) {
    const av = A.get(np);
    const t = ensureTool(tools, v.id, v.category);
    if (!av) {
      t.added.push(v.install);
    } else if (av.version !== v.version) {
      t.versionChanged.push({ path: v.path, from: av.version, to: v.version });
    }
  }
  // Present only in A: removed
  for (const [np, v] of A) {
    if (!B.has(np)) {
      ensureTool(tools, v.id, v.category).removed.push(v.install);
    }
  }

  const toolList = [...tools.values()].filter((t) => t.added.length || t.removed.length || t.versionChanged.length);

  // Compare issues by ID
  const aIssues = new Map((a.checks || []).map((c: any) => [c.ID, c]));
  const bIssues = new Map((b.checks || []).map((c: any) => [c.ID, c]));
  const issues: IssueDelta[] = [];
  for (const [id, c] of bIssues) if (!aIssues.has(id)) issues.push({ id, added: [c], resolved: [] });
  for (const [id, c] of aIssues) if (!bIssues.has(id)) issues.push({ id, added: [], resolved: [c] });

  const summary = {
    installsAdded: toolList.reduce((s, t) => s + t.added.length, 0),
    installsRemoved: toolList.reduce((s, t) => s + t.removed.length, 0),
    versionChanges: toolList.reduce((s, t) => s + t.versionChanged.length, 0),
    issuesAdded: issues.reduce((s, i) => s + i.added.length, 0),
    issuesResolved: issues.reduce((s, i) => s + i.resolved.length, 0),
  };
  return { tools: toolList, issues, summary };
}
