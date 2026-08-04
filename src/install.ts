// Install semantics -- the single source of truth for "is this install a problem?"
// and "how should its location be labelled?". Shared by detectors and every output
// layer so the diagnostic and the rendered tag can never drift apart.
import type { Install } from "./types";

/**
 * True only for installs that are genuinely hard to invoke: present on disk, not
 * resolvable by the current shell, and NOT owned by a version manager.
 *
 * Installs carrying an `env` tag (conda envs, nvm versions) are deliberately
 * excluded: for a version manager, being off-PATH is by design -- they join PATH
 * only after `conda activate <env>` / `nvm use <version>`. Flagging those as
 * off-PATH is a false positive, so they are inventory, never an issue.
 */
export function isIsolated(i: Pick<Install, "onPath" | "env">): boolean {
  return !i.onPath && !i.env;
}

/** Three-state location of an install, for display. */
export type Location = "PATH" | "env" | "off-path";

export function locationOf(i: Pick<Install, "onPath" | "env">): Location {
  if (i.onPath) return "PATH";
  if (i.env) return "env";
  return "off-path";
}

/**
 * Human-readable location tag, e.g. `env: ctf`. Returns an empty string for
 * installs on PATH, since "resolvable" is the unremarkable default.
 */
export function locationTag(i: Pick<Install, "onPath" | "env">): string {
  if (i.onPath) return "";
  return i.env ? `env: ${i.env}` : "off-path";
}
