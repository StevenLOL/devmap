// query subcommand: structured queries over an already-generated manifest (devmap.json) (PRD L2 source of truth).
// Zero-dependency; supports filtering by tool name / category / install path / off-path / issue / conflict.
import { isIsolated } from "./install";

export interface QueryOpts {
  selector?: string; // tool id substring, or "category.tool" dot notation (e.g. runtime.node / pkg.npm)
  issues?: boolean; // list only issues
  conflicts?: boolean; // list only conflicts
  offPath?: boolean; // list only isolated off-PATH installs (version-manager envs excluded)
  kind?: "runtime" | "packageManager" | "ide"; // filter by category
  where?: string; // install path substring
}

// category aliases -> internal category labels
const CAT_ALIASES: Record<string, "runtime" | "packageManager" | "ide"> = {
  runtimes: "runtime",
  runtime: "runtime",
  rt: "runtime",
  packagemanagers: "packageManager",
  packagemanager: "packageManager",
  pkg: "packageManager",
  pm: "packageManager",
  ides: "ide",
  ide: "ide",
};

export interface QueryResult {
  groups: { id: string; category: string; installs: any[] }[];
  checks: any[];
  conflicts?: any;
}

const CATEGORIES: [string, "runtime" | "packageManager" | "ide"][] = [
  ["runtimes", "runtime"],
  ["packageManagers", "packageManager"],
  ["ides", "ide"],
];

export function queryManifest(m: any, opts: QueryOpts): QueryResult {
  let groups: { id: string; category: string; installs: any[] }[] = [];
  for (const [key, label] of CATEGORIES) {
    for (const g of m[key] || []) {
      groups.push({ id: g.id, category: label, installs: g.installs || [] });
    }
  }

  // Resolve selector: supports "category.tool" dot notation (e.g. runtime.node) and plain id substring (e.g. node).
  // Dot form: the first part filters by category alias, the rest is a tool id substring; plain substring: matches across categories by tool id.
  let catFilter: "runtime" | "packageManager" | "ide" | null = opts.kind || null;
  let idSub = (opts.selector || "").toLowerCase();
  if (opts.selector && opts.selector.includes(".")) {
    const dot = opts.selector.indexOf(".");
    const catPart = opts.selector.slice(0, dot).toLowerCase();
    const rest = opts.selector.slice(dot + 1).toLowerCase();
    if (catPart in CAT_ALIASES) {
      catFilter = CAT_ALIASES[catPart];
      idSub = rest;
    }
    // unknown category prefix: fall back to whole-string id substring match
  }

  if (catFilter) groups = groups.filter((g) => g.category === catFilter);

  if (idSub) groups = groups.filter((g) => g.id.toLowerCase().includes(idSub));

  if (opts.where) {
    const w = opts.where.toLowerCase();
    groups = groups
      .map((g) => ({ ...g, installs: g.installs.filter((i: any) => (i.path || "").toLowerCase().includes(w)) }))
      .filter((g) => g.installs.length > 0);
  }

  if (opts.offPath) {
    // Isolated only: version-manager environments (conda/nvm) are off-PATH by design.
    groups = groups
      .map((g) => ({ ...g, installs: g.installs.filter(isIsolated) }))
      .filter((g) => g.installs.length > 0);
  }

  // Issues view. With --issues we list issues (narrowed by the selector, if any);
  // otherwise a selector also pulls in the issues whose ID or label mentions that tool
  // (the dotted form uses the second half).
  let checks: any[] = [];
  const matchesSelector = (c: any, s: string) =>
    (c.ID || "").toLowerCase().includes(s) || (c.Label || "").toLowerCase().includes(s);
  if (opts.issues) {
    checks = m.checks || [];
    if (idSub) checks = checks.filter((c: any) => matchesSelector(c, idSub));
  } else if (idSub) {
    checks = (m.checks || []).filter((c: any) => matchesSelector(c, idSub));
  }

  const conflicts = opts.conflicts ? m.conflicts : undefined;

  // --issues and --conflicts are "only this section" views, as promised by --help.
  // Without this the install listing is still printed and drowns out the answer.
  if (opts.issues || opts.conflicts) groups = [];

  return { groups, checks, conflicts };
}
