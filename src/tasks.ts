import { CliError, print, usage, type Api, type Io } from "./core";
import { clean, keyValue, table, when } from "./format";

const enc = encodeURIComponent;
type Opts = Record<string, unknown>;
export type Ctx = { pos: string[]; v: Opts; io: Io; json: boolean; now: () => number };
export type Plan = (call: Api, org: () => Promise<string>) => Promise<void>;

// Flags every command accepts; the rest are per subcommand.
const GLOBAL = ["json", "host", "org", "help"];
// Flags that take a value: a non-string here is a usage error (parseArgs cannot produce one today; this is the net).
const STRINGS = ["week", "who", "text", "desc", "assign", "section"];

// Wave 3 sets `build` on the write commands; a command with no `build` is recognised but not available yet.
type Spec = { flags: string[]; n: number; build?: (c: Ctx) => Plan };
const W = ["week"];
const SPECS: Record<string, Spec> = {
  people: { flags: [], n: 1 },
  list: { flags: [...W, "mine", "who", "open", "done", "today"], n: 2 },
  get: { flags: W, n: 3 },
  add: { flags: [...W, "desc", "assign", "backlog", "today", "star", "tag"], n: 3 },
  update: { flags: [...W, "text", "desc", "assign", "unassign", "section", "tag", "tags"], n: 3 },
  done: { flags: W, n: 3 }, undone: { flags: W, n: 3 },
  today: { flags: [...W, "off"], n: 3 }, star: { flags: [...W, "off"], n: 3 },
  delete: { flags: [...W, "yes"], n: 3 },
  "sub add": { flags: [...W, "assign"], n: 5 },
  "sub done": { flags: [...W, "undo"], n: 5 },
  "sub delete": { flags: [...W, "yes"], n: 5 },
};

// Validates everything synchronously (so usage errors exit 1 before credentials are read), then returns the closure.
export function taskPlan(pos: string[], v: Opts, io: Io, json: boolean, now: () => number): Plan {
  const [cmd, a, b] = pos;
  const key = cmd === "people" ? "people" : cmd === "tasks" ? "list" : a === "sub" ? (b ? `sub ${b}` : "sub") : (a ?? "");
  const spec = SPECS[key];
  if (!spec || key === "people" !== (cmd === "people")) throw usage(`unknown task command: ${pos.slice(1).join(" ")}`);
  const n = cmd === "tasks" ? 1 : spec.n;
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || GLOBAL.includes(k)) continue;
    if (!spec.flags.includes(k)) throw usage(`unknown option '--${k}' for ${cmd === "task" ? "task " + key : cmd}`);
    if (STRINGS.includes(k) && typeof x !== "string") throw usage(`--${k} needs a value`);
  }
  if (pos.length !== n) throw usage(`expected ${n} argument(s) in: ${pos.join(" ")}`);
  if (v.mine && v.who !== undefined) throw usage("give only one of --mine / --who");
  if (v.open && v.done) throw usage("give only one of --open / --done");
  if (v.tags === true) throw usage("--tags is only valid as --no-tags");
  const c: Ctx = { pos, v, io, json, now };
  if (key === "people") return people(c);
  if (key === "list") return list(c);
  if (key === "get") return get(c);
  if (!spec.build) throw usage(`unknown task command: ${pos.slice(1).join(" ")}`);
  return spec.build(c);
}

// ---- shared helpers (wave 3 reuses these)
export const weekQuery = (c: Ctx) => (typeof c.v.week === "string" ? `?week=${enc(c.v.week)}` : "");
export const tasksPath = async (c: Ctx, org: () => Promise<string>, rest = "") => `/orgs/${enc(await org())}/tasks${rest}${weekQuery(c)}`;
const dash = (x: unknown) => (x === null || x === undefined || x === "" || (Array.isArray(x) && !x.length) ? "-" : clean(Array.isArray(x) ? x.join(",") : x));
const aid = (x: any) => (x?.assignee?.id == null ? "-" : clean(x.assignee.id));
export const who = (a: any): string | null => (a ? (a.name == null ? `${clean(a.id)} (unknown)` : `${clean(a.name)}${a.kind ? ` (${clean(a.kind)})` : ""}`) : null);

// Piped item form: fixed lines, null/""/[] print "-", every server string cleaned.
export function detail(t: any): string {
  return [
    `id: ${dash(t.id)}`, `text: ${dash(t.text)}`, `description: ${dash(t.description)}`, `section: ${dash(t.section)}`,
    `order: ${dash(t.order)}`, `done: ${t.done === true}`, `done_at: ${dash(t.done_at)}`, `assignee: ${aid(t)}`,
    `tags: ${dash(t.tags)}`, `today: ${t.today === true}`, `one_thing: ${t.one_thing === true}`, `added_on: ${dash(t.added_on)}`,
    `delegated_to: ${dash(t.delegated_to)}`, `delegated_at: ${dash(t.delegated_at)}`,
    ...(t.subtasks ?? []).map((s: any) => `subtask: ${dash(s.id)}\t${s.done ? "done" : "open"}\t${aid(s)}\t${s.today ? "today" : "-"}\t${clean(s.text)}`),
  ].join("\n");
}

export function block(t: any, now: number): string {
  const pairs: [string, string | null][] = [
    ["id", clean(t.id)], ["text", clean(t.text)], ["section", clean(t.section)],
    ["status", t.done ? `done, ${when(t.done_at, now)}` : "open"], ["assignee", who(t.assignee)],
    ["tags", t.tags?.length ? t.tags.map((x: unknown) => clean(x)).join(", ") : null],
    ["today", t.today ? "yes" : "no"], ["one thing", t.one_thing ? "yes" : "no"], ["added", t.added_on == null ? null : clean(t.added_on)],
  ];
  if (t.delegated_to) pairs.push(["delegated", clean(t.delegated_to)]);
  const ind = (s: string) => s.split("\n").map((l) => ("  " + l).trimEnd()).join("\n");
  const desc = t.description ? `\n\ndescription:\n${ind(clean(t.description, true))}` : "";
  const subs = t.subtasks?.length
    ? "\n\nsubtasks:\n" + t.subtasks.map((s: any) => `  [${s.done ? "x" : " "}] ${clean(s.id)}  ${clean(s.text)}${s.assignee ? `  (${who(s.assignee)})` : ""}`).join("\n")
    : "";
  return keyValue(pairs) + desc + subs;
}

// ---- read commands
function people(c: Ctx): Plan {
  return async (call, org) => {
    const b = await call("GET", `/orgs/${enc(await org())}/people`);
    const rows: any[] = b.data;
    const status = (p: any) => (p.me ? "me" : p.paused ? "paused" : "-");
    print(c.io, c.json, b, () => rows.map((p) => [dash(p.id), dash(p.kind), dash(p.name), dash(p.email), status(p)].join("\t")).join("\n"),
      () => rows.length ? table(["ID", "NAME", "KIND", "EMAIL", "STATUS"],
        rows.map((p) => [p.id, `${clean(p.name)}${p.me ? " (you)" : ""}`, p.kind, p.email, p.paused ? "paused" : null])) : "No people.");
  };
}

const involves = (t: any, f: (x: any) => boolean) => f(t) || (t.subtasks ?? []).some(f);

function list(c: Ctx): Plan {
  const { v } = c;
  const filtered = !!(v.mine || v.who !== undefined || v.open || v.done || v.today);
  return async (call, org) => {
    const b = await call("GET", await tasksPath(c, org));
    const d = b.data;
    let tasks: any[] = d.tasks;
    if (v.mine) tasks = tasks.filter((t) => involves(t, (x) => x.assignee?.id === d.me));
    if (v.who !== undefined) {
      const w = await resolveWho(call, org, d, v.who as string);
      tasks = tasks.filter((t) => involves(t, (x) => x.assignee?.id === w));
    }
    if (v.today) tasks = tasks.filter((t) => involves(t, (x) => x.today === true));
    if (v.open) tasks = tasks.filter((t) => !t.done);
    if (v.done) tasks = tasks.filter((t) => t.done);
    // Filters narrow data.tasks only; every other key stays as the server sent it.
    const out = filtered ? { ...b, data: { ...d, tasks } } : b;
    print(c.io, c.json, out, () => tasks.flatMap((t) => [
      [dash(t.id), t.done ? "done" : "open", dash(t.section), [t.one_thing && "star", t.today && "today"].filter(Boolean).join(",") || "-", aid(t), dash(t.tags), clean(t.text)].join("\t"),
      ...(t.subtasks ?? []).map((s: any) => [dash(s.id), s.done ? "done" : "open", `sub:${clean(t.id)}`, s.today ? "today" : "-", aid(s), "-", clean(s.text)].join("\t")),
    ]).join("\n"), () => {
      const wk = clean(d.week);
      if (!tasks.length) return d.tasks.length ? "No tasks match." : `No tasks for the week of ${wk}.`;
      const head = `Week of ${wk}${d.current === false ? " (not the current week)" : ""}\n\n`;
      const flags = (x: any) => [x.one_thing && "star", x.today && "today"].filter(Boolean).join(",") || null;
      return head + table(["ID", "DONE", "FLAGS", "SECTION", "ASSIGNEE", "TAGS", "TEXT"], tasks.flatMap((t) => [
        [t.id, t.done ? "[x]" : "[ ]", flags(t), t.section, who(t.assignee), t.tags?.length ? t.tags.join(",") : null, t.text],
        ...(t.subtasks ?? []).map((s: any) => [`  ${clean(s.id)}`, s.done ? "[x]" : "[ ]", s.today ? "today" : null, "", who(s.assignee), null, s.text]),
      ]));
    });
  };
}

// me -> data.me; otherwise /people by exact id or email, else an assignee id already in this list (revoked members).
async function resolveWho(call: Api, org: () => Promise<string>, d: any, w: string): Promise<string> {
  if (w === "me") return d.me;
  const ps: any[] = (await call("GET", `/orgs/${enc(await org())}/people`)).data;
  const p = ps.find((x) => x.id === w || (typeof x.email === "string" && x.email.toLowerCase() === w.toLowerCase()));
  if (p) return p.id;
  const ids = new Set<string>();
  for (const t of d.tasks) for (const x of [t, ...(t.subtasks ?? [])]) if (x.assignee?.id != null) ids.add(x.assignee.id);
  if (ids.has(w)) return w;
  throw new CliError(6, { error: { code: "invalid", message: "unknown person", details: { fields: { who: [`no member or agent matches "${w}"`] } } } });
}

function get(c: Ctx): Plan {
  return async (call, org) => {
    const b = await call("GET", await tasksPath(c, org, `/${enc(c.pos[2]!)}`));
    print(c.io, c.json, b, () => detail(b.data), () => block(b.data, c.now()));
  };
}
