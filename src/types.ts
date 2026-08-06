// devmap core types -- single contract, reused end-to-end by detector -> CLI -> L2 manifest -> L3 MCP (PRD §9)
// Hard rule: Check / Install / ToolGroup / manifest are defined in one place; no per-layer redefinition allowed.

export type Severity = "ok" | "info" | "warn" | "error" | "missing";
export type Kind = "missing" | "conflict" | "ghost" | "mismatch" | "stale" | "vuln" | "secret";

export interface Check {
  ID: string;            // dot-separated unique id, e.g. "path.duplicate.node"
  Kind: Kind;            // issue category (merges curato+zenvo+devscan)
  Severity: Severity;
  Label: string;         // human-readable title
  Detail: string;
  Path: string[];        // related paths (may be empty)
  Fix?: { Type: string; Command: string };  // optional remediation suggestion (MVP: display only, no execution)
}

export interface Install {
  path: string;
  onPath: boolean;       // whether the current shell's which can resolve it
  version: string | null;
  env?: string;          // version manager environment name (conda env / nvm alias)
  note?: string;         // source note
  shell?: string;        // which shell view discovered it
}

export interface ToolGroup {
  id: string;
  installs: Install[];
  shellResolution?: Record<string, string | null>;  // cross-shell resolution results (H2)
}

export interface DetectorResult {
  data: any;
  checks: Check[];
}

export type ShellId = "current" | "powershell" | "gitbash" | "wsl";

// ============ Phase 2: package contents / environments / dev shell layer types ============
export interface PkgInfo {
  name: string;
  version: string;
  arch?: string;
  features?: string;
}
export interface PipOutdatedInfo {
  name: string;
  installed: string;
  latest: string;
}
export interface PythonPkgReport {
  pythonPath: string;
  version: string | null;
  packages: PkgInfo[];
  outdated: PipOutdatedInfo[];
}
export interface CondaEnvInfo {
  name: string;
  pythonPath: string | null;
  active: boolean;
  packages: PkgInfo[];
  outdated: PipOutdatedInfo[];
}
export interface VcpkgInfo {
  installed: boolean;
  installs: Install[];
  packages: (PkgInfo & { triplet: string })[];
}
export interface AptInfo {
  available: boolean;
  count: number;
  packages: PkgInfo[];
  upgradable: number;
}
export interface DockerInfo {
  installed: boolean;
  daemonRunning: boolean | null;
  engineVersion: string | null;
  images: number;
  containers: number;
}
export interface WslDistro {
  name: string;
  state: string;
  version: string;
  default: boolean;
  basePath?: string; // rootfs install location (registry Lxss\{guid}\BasePath)
  probed?: boolean; // whether tools inside the distro were probed (Stopped ones are not woken by default)
  tools?: Record<string, string | null>;
}
export interface WslInfo {
  available: boolean;
  distros: WslDistro[];
}
export interface VsShellInfo {
  name: string;
  kind: "command" | "powershell";
  arch: string;
  entry: string | null;
  pathDirs: number;
  tools: Record<string, string | null>;
}
export interface ProjectEnvInfo {
  project: string;
  type: "venv" | "conda" | "node_modules";
  path: string;
}
export interface Environments {
  vcpkg?: VcpkgInfo;
  pip?: { perInterpreter: PythonPkgReport[] };
  apt?: AptInfo;
  condaEnvs?: { envs: CondaEnvInfo[] };
  docker?: DockerInfo;
  wsl?: WslInfo;
  vsShells?: { shells: VsShellInfo[] };
  projectEnvs?: { roots: string[]; envs: ProjectEnvInfo[] };
}
