// docker detector (Phase 2): detect the docker binary (incl. common Docker Desktop paths) + daemon status + image/container counts.
// On a host with no docker installed -> installed:false, skip gracefully. Daemon must be running to count images/containers.
import { register } from "./registry";
import { whichInDirs, versionOfAsync, fileExists, pathDirs, IS_WIN } from "../platform/exec";
import { runBinAsync } from "../platform/exec";
import { makeCheck } from "../check/model";
import type { Check, DockerInfo } from "../types";

const DESKTOP = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";

function findDocker(): string | null {
  for (const p of whichInDirs("docker", pathDirs())) return p;
  if (IS_WIN && fileExists(DESKTOP)) return DESKTOP;
  return null;
}

function countLines(out: string): number {
  if (!out) return 0;
  return out.split("\n").filter((l) => l.trim().length).length;
}

register({
  name: "docker",
  async scan() {
    const checks: Check[] = [];
    const bin = findDocker();
    if (!bin) return { data: { installed: false, daemonRunning: null, engineVersion: null, images: 0, containers: 0 }, checks };

    // Version and daemon probing are independent; run them concurrently
    const [version, info] = await Promise.all([
      versionOfAsync(bin, ["--version"]),
      // daemon probe: docker info succeeds => running; fails/times out => not running (binary present but daemon not started)
      runBinAsync(bin, ["info", "--format", "{{.ServerVersion}}"], 8000),
    ]);
    const daemonRunning = !!info;
    const engineVersion = info || null;

    let images = 0;
    let containers = 0;
    if (daemonRunning) {
      const [imgRaw, psRaw] = await Promise.all([
        runBinAsync(bin, ["images", "-q"], 8000),
        runBinAsync(bin, ["ps", "-a", "-q"], 8000),
      ]);
      images = countLines(imgRaw);
      containers = countLines(psRaw);
    }

    if (!daemonRunning) {
      checks.push(
        makeCheck(
          "docker.daemon.down",
          "missing",
          "warn",
          "docker installed but daemon not running",
          "Docker Desktop not started or dockerd not running; images/containers cannot be enumerated",
          [bin],
        ),
      );
    }

    return { data: { installed: true, daemonRunning, engineVersion, images, containers }, checks };
  },
});
