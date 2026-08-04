// Cross-shell PATH reconstruction (PRD H2). The same tool may point to a different path under PowerShell / Git Bash / WSL.
import { run } from "./exec";
import { pathDirs, IS_WIN } from "./exec";
import type { ShellId } from "../types";

export function shellName(s: ShellId): string {
  return { current: "current", powershell: "PowerShell", gitbash: "Git Bash", wsl: "WSL" }[s];
}

/** Return the PATH directory list for the given shell view. On non-Windows only current is meaningful. */
export function shellPathDirs(shell: ShellId): string[] {
  if (shell === "current" || !IS_WIN) return pathDirs();
  try {
    if (shell === "powershell") {
      const out = run("powershell", [
        "-NoProfile",
        "-Command",
        "$p=[Environment]::GetEnvironmentVariable('PATH','Process');$u=[Environment]::GetEnvironmentVariable('PATH','User');$m=[Environment]::GetEnvironmentVariable('PATH','Machine'); ($p,$u,$m) -join ';'",
      ]);
      return (out || "").split(";").map((s) => s.trim()).filter(Boolean);
    }
    if (shell === "gitbash") {
      const out = run("bash", ["-lc", "echo \"$PATH\""]);
      return (out || "").split(":").map((s) => s.trim()).filter(Boolean);
    }
    if (shell === "wsl") {
      const out = run("wsl", ["bash", "-lc", "echo \"$PATH\""]);
      return (out || "").split(":").map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    return pathDirs();
  }
  return pathDirs();
}
