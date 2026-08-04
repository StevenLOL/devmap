// System information detector.
import os from "node:os";
import { register } from "./registry";
import { IS_WIN, pathDirs } from "../platform/exec";

register({
  name: "system",
  scan() {
    const data = {
      platform: process.platform,
      arch: os.arch(),
      hostname: os.hostname(),
      release: os.release(),
      shell: process.env.SHELL || (IS_WIN ? process.env.ComSpec || "cmd.exe" : "sh"),
      totalMemGB: +(os.totalmem() / 1073741824).toFixed(1),
      cpuCount: os.cpus().length,
      pathDirCount: pathDirs().length, // number of PATH dirs used in this scan (environment drift traceability, PRD §17)
    };
    return { data, checks: [] };
  },
});
