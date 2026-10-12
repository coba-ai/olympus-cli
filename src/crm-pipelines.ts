import { print, seg } from "./core";
import { display, table } from "./format";
import { dash, type Plan } from "./tasks";
import type { Ctx, Spec } from "./crm";

// ponytail: arr and the crm path builder repeat crm.ts one-liners so this module needs no runtime import from it; merge if the module moves.
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const crm = async (org: () => Promise<string>, rest: string) => `/orgs/${seg(await org())}/crm${rest}`;

function pipelines(c: Ctx): Plan {
  return async (call, org) => {
    const b = await call("GET", await crm(org, "/pipelines"));
    const ps = arr(b.data);
    print(c.io, c.json, b, () => ps.flatMap((p) => [
      [dash(p?.id), "pipeline", dash(p?.currencies), dash(p?.name)].join("\t"),
      ...arr(p?.stages).map((s) => [dash(s?.id), `stage:${dash(p?.id)}`, dash(s?.kind), dash(s?.name)].join("\t")),
    ]).join("\n"), () => ps.length ? table(["ID", "NAME", "INFO"], ps.flatMap((p) => [
      [display(p?.id), display(p?.name), display(p?.currencies)], ...arr(p?.stages).map((s) => ["  " + display(s?.id), "  " + display(s?.name), display(s?.kind)]),
    ])) : "No pipelines.");
  };
}

export const PIPELINE_SPECS: Record<string, Spec> = {
  pipelines: { flags: [], n: 2, build: pipelines },
};
