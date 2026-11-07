import { create, idempotencyKey, print, seg, usage } from "./core";
import { clean, display, keyValue, table } from "./format";
import { dash, type Plan } from "./tasks";
import type { Ctx, Spec } from "./crm";

// ponytail: arr and the crm path builder repeat crm.ts one-liners so this module needs no runtime import from it; merge if the module moves.
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const crm = async (org: () => Promise<string>, rest: string) => `/orgs/${seg(await org())}/crm${rest}`;
const flagList = (c: Ctx, name: string): string[] => arr(c.v[name]).map(String);
// Splits at the LAST separator so a name may contain it; both sides must be non-empty.
const splitLast = (text: string, sep: string): [string, string] | null => {
  const at = text.lastIndexOf(sep);
  return at > 0 && at < text.length - 1 ? [text.slice(0, at), text.slice(at + 1)] : null;
};

function parseStage(text: string, allowId: boolean) {
  const parts = splitLast(text, ":");
  if (!parts) throw usage("--stage must be NAME:KIND");
  const [label, kind] = parts;
  const eq = allowId ? label.indexOf("=") : -1;
  const id = eq > 0 ? label.slice(0, eq) : undefined;
  const name = eq < 0 ? label : label.slice(eq + 1);
  if (!name) throw usage("--stage must be NAME:KIND");
  return id === undefined ? { name, kind } : { id, name, kind };
}

function parseRemoval(text: string) {
  const parts = splitLast(text, ":");
  if (!parts) throw usage("--remove must be STAGE_ID:MOVE_TO_ID");
  return { stage: parts[0], move_to: parts[1] };
}

const pipelinePath = (c: Ctx, rest = "") => `/pipelines/${seg(c.pos[3]!)}${rest}`;
const cronOf = (a: any) => (a?.cron && typeof a.cron === "object" && !Array.isArray(a.cron) ? a.cron : null);
const liveCell = (cron: any) => (cron?.live === true ? "true" : cron?.live === false ? "false" : "-");
// Documented cells, in order: start, state, name, cron id, cron live, schedule, next run. key and stage id are added by the caller.
const autoTail = (a: any) => {
  const cron = cronOf(a);
  return [dash(a?.start), dash(a?.state), dash(a?.name), dash(cron?.id), liveCell(cron), dash(cron?.schedule), dash(cron?.next_run_at)];
};
const stageLines = (label: string, stages: unknown) => arr(stages).flatMap((s) => [
  `${label}: ${[dash(s?.id), dash(s?.kind), dash(s?.name)].join("\t")}`,
  ...arr(s?.automations).map((a) => `automation: ${[dash(s?.id), dash(a?.key), ...autoTail(a)].join("\t")}`),
]);
const listAutos = (s: any) => arr(s?.automations).map((a) => [dash(a?.key), `automation:${dash(s?.id)}`, ...autoTail(a)].join("\t"));

const detailPiped = (d: any) => [
  `id: ${dash(d.id)}`, `name: ${dash(d.name)}`, `currencies: ${dash(d.currencies)}`, `archived: ${String(d.archived === true)}`, `version: ${dash(d.version)}`,
  ...stageLines("stage", d.stages), ...stageLines("archived_stage", d.archived_stages),
].join("\n");

function automationsTty(title: string, stages: unknown): string {
  const lines = arr(stages).flatMap((s) => arr(s?.automations).map((a) => {
    const cron = cronOf(a);
    const live = cron?.live === true ? "cron live" : cron?.live === false ? "cron paused" : "-";
    return "  " + [s?.id, a?.key, a?.start, a?.state, a?.name, live, cron?.schedule].map((x) => clean(x ?? "-")).join("  ");
  }));
  return lines.length ? `\n\n${title}:\n${lines.join("\n")}` : "";
}

function detailTty(d: any): string {
  const section = (title: string, stages: unknown) => arr(stages).length
    ? `\n\n${title}:\n` + arr(stages).map((s) => "  " + [s?.id, s?.kind, s?.name].map((x) => clean(display(x) ?? "-")).join("  ")).join("\n") : "";
  return keyValue([
    ["id", display(d.id)], ["name", display(d.name)], ["currencies", display(d.currencies)], ["archived", d.archived === true ? "yes" : "no"], ["version", display(d.version)],
  ])
    + section("stages", d.stages) + automationsTty("automations", d.stages)
    + section("archived stages", d.archived_stages) + automationsTty("archived automations", d.archived_stages);
}

const showPipeline = (c: Ctx, body: any, sentence?: string) =>
  print(c.io, c.json, body, () => detailPiped(body.data ?? {}), () => (sentence ? `${sentence}\n\n` : "") + detailTty(body.data ?? {}));

function pipelines(c: Ctx): Plan {
  return async (call, org) => {
    const b = await call("GET", await crm(org, `/pipelines${c.v.archived ? "?archived=include" : ""}`));
    const ps = arr(b.data);
    print(c.io, c.json, b, () => ps.flatMap((p) => [
      [dash(p?.id), p?.archived === true ? "pipeline:archived" : "pipeline", dash(p?.currencies), dash(p?.name)].join("\t"),
      ...arr(p?.stages).flatMap((s) => [
        [dash(s?.id), `stage:${dash(p?.id)}`, dash(s?.kind), dash(s?.name)].join("\t"),
        ...listAutos(s),
      ]),
    ]).join("\n"), () => ps.length ? table(["ID", "NAME", "INFO"], ps.flatMap((p) => [
      [display(p?.id), (display(p?.name) ?? "-") + (p?.archived === true ? " (archived)" : ""), display(p?.currencies)],
      ...arr(p?.stages).flatMap((s) => [
        ["  " + display(s?.id), "  " + display(s?.name), display(s?.kind)],
        ...arr(s?.automations).map((a) => {
          const cron = cronOf(a);
          const live = cron?.live === true ? "cron live" : cron?.live === false ? "cron paused" : null;
          const info = [a?.state, live, cron?.schedule].filter((x) => x != null && x !== "").map((x) => clean(x)).join(" · ");
          return ["    " + clean(a?.key ?? "-"), "    " + clean(a?.name ?? "-"), info || null];
        }),
      ]),
    ])) : "No pipelines.");
  };
}

function pipelineAdd(c: Ctx): Plan {
  const key = idempotencyKey(c.v["idempotency-key"] as string | undefined);
  const stages = flagList(c, "stage").map((s) => parseStage(s, false));
  if (!stages.length) throw usage("crm pipeline add needs at least one --stage");
  const currencies = flagList(c, "currency");
  const body = { name: c.pos[3], stages, ...(currencies.length ? { currencies } : {}) };
  return async (call, org) => {
    const b = await create(call, await crm(org, "/pipelines"), body, key);
    showPipeline(c, b, `Added pipeline ${dash(b.data?.id)}.`);
  };
}

function pipelineUpdate(c: Ctx): Plan {
  const body: Record<string, unknown> = {};
  if (c.v.name !== undefined) body.name = c.v.name;
  const lists: [string, string, (s: string) => unknown][] = [
    ["stage", "stages", (s) => parseStage(s, true)], ["remove", "removals", parseRemoval], ["restore", "restores", (s) => s], ["currency", "currencies", (s) => s],
  ];
  for (const [flag, key, parse] of lists) if (flagList(c, flag).length) body[key] = flagList(c, flag).map(parse);
  if (!Object.keys(body).length) throw usage("crm pipeline update needs at least one field to change");
  if (c.v.version !== undefined) body.version = c.v.version;
  const rel = pipelinePath(c);
  return async (call, org) => showPipeline(c, await call("PATCH", await crm(org, rel), body), `Updated pipeline ${clean(c.pos[3])}.`);
}

export const PIPELINE_SPECS: Record<string, Spec> = {
  pipelines: { flags: ["archived"], n: 2, build: pipelines },
  "pipeline get": { flags: [], n: 4, build: (c) => { const rel = pipelinePath(c); return async (call, org) => showPipeline(c, await call("GET", await crm(org, rel))); } },
  "pipeline add": { flags: ["stage", "currency", "idempotency-key"], n: 4, build: pipelineAdd },
  "pipeline update": { flags: ["name", "stage", "remove", "restore", "currency", "version"], n: 4, build: pipelineUpdate },
  "pipeline archive": {
    flags: ["undo"], n: 4,
    build: (c) => {
      const rel = pipelinePath(c, "/archive");
      const sentence = `${c.v.undo ? "Restored" : "Archived"} pipeline ${clean(c.pos[3])}.`;
      return async (call, org) => showPipeline(c, await call("POST", await crm(org, rel), { archived: !c.v.undo }), sentence);
    },
  },
};
