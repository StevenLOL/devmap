// Package manager detector. Version probing for all tools runs concurrently (see util.detectSimpleAsync perf notes).
import { register } from "./registry";
import { detectSimpleAsync } from "./util";

const TOOLS = [
  "npm", "pip", "pip3", "conda", "cargo", "brew", "winget", "scoop",
  "docker", "kubectl", "git", "poetry", "yarn", "pnpm", "pyenv", "nvm",
];

register({
  name: "packageManagers",
  async scan(ctx) {
    const data = await detectSimpleAsync(TOOLS, (done, total) => {
      ctx.progress?.sub(`packageManagers · ${done}/${total}`);
    });
    return { data, checks: [] };
  },
});
