import { describe, it, expect } from "bun:test";
import { isIsolated, locationOf, locationTag } from "./install";

// Install semantics -- the single source of truth for "is this install a problem?"
// and "how should its location be labelled?". These are pure functions; the output
// layer must never re-derive them (that is how diagnostics and rendered tags drift).

describe("isIsolated", () => {
  it("off-PATH and not a version-manager env -> isolated (a real problem)", () => {
    expect(isIsolated({ onPath: false, env: undefined })).toBe(true);
  });

  it("on PATH -> not isolated", () => {
    expect(isIsolated({ onPath: true, env: undefined })).toBe(false);
  });

  it("off-PATH but owned by a version manager (conda env / nvm) -> NOT isolated by design", () => {
    // For a version manager, being off-PATH is expected; it joins PATH only after
    // `conda activate` / `nvm use`. Flagging it would be a false positive.
    expect(isIsolated({ onPath: false, env: "base" })).toBe(false);
    expect(isIsolated({ onPath: false, env: "ctf" })).toBe(false);
  });
});

describe("locationOf", () => {
  it("maps the three states correctly", () => {
    expect(locationOf({ onPath: true, env: undefined })).toBe("PATH");
    expect(locationOf({ onPath: false, env: "base" })).toBe("env");
    expect(locationOf({ onPath: false, env: undefined })).toBe("off-path");
  });
});

describe("locationTag", () => {
  it("empty on PATH (resolvable is the unremarkable default)", () => {
    expect(locationTag({ onPath: true, env: undefined })).toBe("");
  });

  it("'env: <name>' for version-manager environments", () => {
    expect(locationTag({ onPath: false, env: "ctf" })).toBe("env: ctf");
  });

  it("'off-path' for genuinely isolated installs", () => {
    expect(locationTag({ onPath: false, env: undefined })).toBe("off-path");
  });
});
