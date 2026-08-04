// IDE detector. Version probing runs concurrently (pycharm/idea .bat wrappers start slowly, so serial is costly).
import { register } from "./registry";
import { detectSimpleAsync } from "./util";

register({
  name: "ides",
  async scan(ctx) {
    const data = await detectSimpleAsync(["code", "cursor", "pycharm", "idea"], (done, total) => {
      ctx.progress?.sub(`ides · ${done}/${total}`);
    });
    return { data, checks: [] };
  },
});
