import { CliError, print, seg, usage, type Api, type Io } from "./core";
import { clean, keyValue, table, when } from "./format";

const enc = encodeURIComponent;
type Opts = Record<string, unknown>;
type Ctx = { pos: string[]; v: Opts; io: Io; json: boolean; now: () => number };
export type Plan = (call: Api, org: () => Promise<string>) => Promise<void>;

// Flags every command accepts; the rest are per subcommand.
const GLOBAL = ["json", "host", "org", "help"];
// Rejects any flag outside `allowed` (+ GLOBAL), in the order typed; a negated boolean (value false) is named as typed, `--no-x`.
export function checkFlags(v: Opts, allowed: string[], where?: string): void {
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || GLOBAL.includes(k) || allowed.includes(k)) continue;
    throw usage(`unknown option '--${x === false ? "no-" : ""}${k}'${where ? " for " + where : ""}`);
  }
}

// ---- write commands: each build() throws its usage errors synchronously, before the closure exists.
const item = (c: Ctx, b: any, sentence: string) => print(c.io, c.json, b, () => detail(b.data), () => `${sentence}\n\n${block(b.data, c.now())}`);
const need = (c: Ctx, name: string) => { if (!c.v.yes) throw usage(`${name} needs --yes`); };
const tagList = (c: Ctx, k: string) => (c.v[k] as string[] | undefined) ?? [];

function patch(c: Ctx, body: Record<string, unknown>, sentence: (id: string) => string): Plan {
  const id = c.pos[2]!;
  return async (call, org) => item(c, await call("PATCH", await tasksPath(c, org, `/${seg(id)}`), body), sentence(clean(id)));
}

function add(c: Ctx): Plan {
  const { v } = c;
  const body: Record<string, unknown> = { text: c.pos[2] };
  if (v.desc !== undefined) body.description = v.desc;
  if (v.assign !== undefined) body.assignee = v.assign;
  if (v.backlog) body.section = "backlog";
  if (v.today) body.today = true;
  if (v.star) body.one_thing = true;
  if (tagList(c, "tag").length) body.tags = tagList(c, "tag");
  return async (call, org) => {
    const b = await call("POST", await tasksPath(c, org), body);
    item(c, b, `Added task ${clean(b.data.id)}.`);
  };
}

function update(c: Ctx): Plan {
  const { v } = c;
  if (v.assign !== undefined && v.unassign) throw usage("give only one of --assign / --unassign");
  const set = tagList(c, "tag").length > 0;
  if (set && v.tags === false) throw usage("give only one of --tag / --no-tags");
  const addT = tagList(c, "add-tag"), rem = tagList(c, "remove-tag");
  if ((addT.length || rem.length) && (set || v.tags === false)) throw usage("--add-tag / --remove-tag cannot be combined with --tag or --no-tags");
  const body: Record<string, unknown> = {};
  if (v.text !== undefined) body.text = v.text;
  if (v.desc !== undefined) body.description = v.desc;
  if (v.section !== undefined) body.section = v.section;
  if (v.assign !== undefined) body.assignee = v.assign;
  if (v.unassign) body.assignee = null;
  if (set) body.tags = tagList(c, "tag");
  if (v.tags === false) body.tags = [];
  if (addT.length) body.add_tags = addT;
  if (rem.length) body.remove_tags = rem;
  if (!Object.keys(body).length) throw usage("task update needs at least one field to change");
  return patch(c, body, (id) => `Updated task ${id}.`);
}

function del(c: Ctx): Plan {
  need(c, "task delete");
  const id = c.pos[2]!;
  return async (call, org) => {
    await call("DELETE", await tasksPath(c, org, `/${seg(id)}`));
    print(c.io, c.json, { data: { id, deleted: true } }, () => `deleted ${clean(id)}`, () => `Deleted task ${clean(id)}.`);
  };
}

const subPath = (c: Ctx, org: () => Promise<string>, sid?: string) =>
  tasksPath(c, org, `/${seg(c.pos[3]!)}/subtasks${sid === undefined ? "" : `/${seg(sid)}`}`);

function subAdd(c: Ctx): Plan {
  const body: Record<string, unknown> = { text: c.pos[4] };
  if (c.v.assign !== undefined) body.assignee = c.v.assign;
  return async (call, org) => {
    const b = await call("POST", await subPath(c, org), body);
    const subs: any[] = b.data.subtasks ?? [];
    item(c, b, `Added subtask ${clean(subs[subs.length - 1]?.id)} to ${clean(c.pos[3])}.`);
  };
}

const subDone = (c: Ctx): Plan => async (call, org) =>
  item(c, await call("PATCH", await subPath(c, org, c.pos[4]!), { done: !c.v.undo }), `Marked subtask ${clean(c.pos[4])} ${c.v.undo ? "not done" : "done"}.`);

function subDelete(c: Ctx): Plan {
  need(c, "task sub delete");
  return async (call, org) =>
    item(c, await call("DELETE", await subPath(c, org, c.pos[4]!)), `Deleted subtask ${clean(c.pos[4])} from ${clean(c.pos[3])}.`);
}

// breakdown waits on the agent; the server may take up to ~90 s, so this overrides the default timeout for that call only.
export const BREAKDOWN_TIMEOUT_MS = 100_000;

function delegate(c: Ctx): Plan {
  const body = c.v.to === undefined ? {} : { agent: c.v.to };
  return async (call, org) => {
    const b = await call("POST", await tasksPath(c, org, `/${seg(c.pos[2]!)}/delegate`), body);
    const s = b.data?.session ?? {};
    print(c.io, c.json, b,
      () => [`agent: ${dash(s.agent)}`, `session: ${dash(s.id)}`, `title: ${dash(s.title)}`, `url: ${dash(s.url)}`].join("\n"),
      () => [`Delegated task ${clean(c.pos[2])} to ${dash(s.agent)}.`, ...(s.title ? [`Title: ${clean(s.title)}`] : []), `Session: ${dash(s.url)}`].join("\n"));
  };
}

function breakdown(c: Ctx): Plan {
  const body = c.v.agent === undefined ? {} : { agent: c.v.agent };
  return async (call, org) => {
    const path = await tasksPath(c, org, `/${seg(c.pos[2]!)}/breakdown`);
    if (c.io.tty && !c.json) c.io.err(`Asking ${c.v.agent === undefined ? "the agent" : clean(c.v.agent)} to break down task ${clean(c.pos[2])}...\n`);
    const b = await call("POST", path, body, BREAKDOWN_TIMEOUT_MS);
    const added: any[] = b.data?.added ?? [];
    const id = clean(c.pos[2]);
    print(c.io, c.json, b,
      () => [`agent: ${dash(b.data?.agent)}`, ...added.map((x) => `added: ${dash(x.id)}\t${dash(x.text)}`)].join("\n"),
      () => added.length
        ? [`${dash(b.data?.agent)} added ${added.length} ${added.length === 1 ? "subtask" : "subtasks"} to task ${id}:`, ...added.map((x) => `  ${dash(x.id)}  ${dash(x.text)}`)].join("\n")
        : `${dash(b.data?.agent)} added no subtasks to task ${id}.`);
  };
}

// n = expected positionals (including the command word).
type Spec = { flags: string[]; n: number; build: (c: Ctx) => Plan };
const W = ["week"];
const SPECS: Record<string, Spec> = {
  people: { flags: [], n: 1, build: people }, tags: { flags: [], n: 1, build: tags },
  list: { flags: [...W, "mine", "who", "open", "done", "today", "tag", "backlog"], n: 2, build: list },
  get: { flags: W, n: 3, build: get },
  add: { flags: [...W, "desc", "assign", "backlog", "today", "star", "tag"], n: 3, build: add },
  update: { flags: [...W, "text", "desc", "assign", "unassign", "section", "tag", "tags", "add-tag", "remove-tag"], n: 3, build: update },
  done: { flags: W, n: 3, build: (c) => patch(c, { done: true }, (id) => `Marked ${id} done.`) },
  undone: { flags: W, n: 3, build: (c) => patch(c, { done: false }, (id) => `Marked ${id} not done.`) },
  today: { flags: [...W, "off"], n: 3, build: (c) => patch(c, { today: !c.v.off }, (id) => (c.v.off ? `Removed ${id} from today.` : `Marked ${id} for today.`)) },
  star: { flags: [...W, "off"], n: 3, build: (c) => patch(c, { one_thing: !c.v.off }, (id) => (c.v.off ? `Unstarred ${id}.` : `Starred ${id}.`)) },
  delete: { flags: [...W, "yes"], n: 3, build: del },
  delegate: { flags: [...W, "to"], n: 3, build: delegate },
  breakdown: { flags: [...W, "agent"], n: 3, build: breakdown },
  "sub add": { flags: [...W, "assign"], n: 5, build: subAdd },
  "sub done": { flags: [...W, "undo"], n: 5, build: subDone },
  "sub delete": { flags: [...W, "yes"], n: 5, build: subDelete },
};

// Positionals that become path segments, by spec key.
const ID_POS: Record<string, number[]> = {
  get: [2], update: [2], done: [2], undone: [2], today: [2], star: [2], delete: [2], delegate: [2], breakdown: [2],
  "sub add": [3], "sub done": [3, 4], "sub delete": [3, 4],
};

// Validates everything synchronously (so usage errors exit 1 before credentials are read), then returns the closure.
export function taskPlan(pos: string[], v: Opts, io: Io, json: boolean, now: () => number): Plan {
  const [cmd, a, b] = pos;
  const isSub = cmd === "task" && a === "sub";
  const key = cmd === "people" || cmd === "tags" ? cmd : cmd === "tasks" ? "list" : isSub ? (b ? `sub ${b}` : "sub") : (a ?? "");
  // hasOwn: a plain lookup would find Object.prototype keys (constructor, __proto__, ...).
  // A lone positional with a space ("sub add") must not reach a two-word spec; "people"/"tags" are not task subcommands.
  const spec = Object.hasOwn(SPECS, key) && (isSub || !key.includes(" ")) && !(cmd === "task" && (key === "people" || key === "tags")) ? SPECS[key] : undefined;
  if (!spec) throw usage(`unknown task command: ${pos.slice(1).join(" ")}`);
  const n = cmd === "tasks" ? 1 : spec.n;
  checkFlags(v, spec.flags, cmd === "task" ? "task " + key : cmd);
  if (pos.length !== n) throw usage(`expected ${n} argument(s) in: ${pos.join(" ")}`);
  for (const i of ID_POS[key] ?? []) seg(pos[i]!);
  if (v.mine && v.who !== undefined) throw usage("give only one of --mine / --who");
  if (v.open && v.done) throw usage("give only one of --open / --done");
  if (v.tags === true) throw usage("--tags is only valid as --no-tags");
  return spec.build({ pos, v, io, json, now });
}

// ---- shared helpers
const weekQuery = (c: Ctx) => (typeof c.v.week === "string" ? `?week=${enc(c.v.week)}` : "");
const tasksPath = async (c: Ctx, org: () => Promise<string>, rest = "") => `/orgs/${seg(await org())}/tasks${rest}${weekQuery(c)}`;
export const dash = (x: unknown) => (x === null || x === undefined || x === "" || (Array.isArray(x) && !x.length) ? "-" : clean(Array.isArray(x) ? x.join(",") : x));
const aid = (x: any) => (x?.assignee?.id == null ? "-" : clean(x.assignee.id));
const who = (a: any): string | null => (a ? (a.name == null ? `${clean(a.id)} (unknown)` : `${clean(a.name)}${a.kind ? ` (${clean(a.kind)})` : ""}`) : null);

// Piped item form: fixed lines, null/""/[] print "-", every server string cleaned.
function detail(t: any): string {
  return [
    `id: ${dash(t.id)}`, `text: ${dash(t.text)}`, `description: ${dash(t.description)}`, `section: ${dash(t.section)}`,
    `order: ${dash(t.order)}`, `done: ${t.done === true}`, `done_at: ${dash(t.done_at)}`, `assignee: ${aid(t)}`,
    `tags: ${dash(t.tags)}`, `today: ${t.today === true}`, `one_thing: ${t.one_thing === true}`, `added_on: ${dash(t.added_on)}`,
    `delegated_to: ${dash(t.delegated_to)}`, `delegated_at: ${dash(t.delegated_at)}`,
    ...(t.subtasks ?? []).map((s: any) => `subtask: ${dash(s.id)}\t${s.done ? "done" : "open"}\t${aid(s)}\t${s.today ? "today" : "-"}\t${clean(s.text)}`),
  ].join("\n");
}

function block(t: any, now: number): string {
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
    const b = await call("GET", `/orgs/${seg(await org())}/people`);
    const rows: any[] = b.data;
    const status = (p: any) => (p.me ? "me" : p.paused ? "paused" : "-");
    print(c.io, c.json, b, () => rows.map((p) => [dash(p.id), dash(p.kind), dash(p.name), dash(p.email), status(p)].join("\t")).join("\n"),
      () => rows.length ? table(["ID", "NAME", "KIND", "EMAIL", "STATUS"],
        rows.map((p) => [p.id, `${clean(p.name)}${p.me ? " (you)" : ""}`, p.kind, p.email, p.paused ? "paused" : null])) : "No people.");
  };
}

function tags(c: Ctx): Plan {
  return async (call, org) => {
    const slug = await org();
    const b = await call("GET", `/orgs/${seg(slug)}/tags`);
    const rows: unknown[] = b.data;
    print(c.io, c.json, b, () => rows.map((x) => clean(x)).join("\n"),
      () => (rows.length ? rows.map((x) => clean(x)).join("\n") : `No tags in ${clean(slug)} yet.`));
  };
}

const involves = (t: any, f: (x: any) => boolean) => f(t) || (t.subtasks ?? []).some(f);

function list(c: Ctx): Plan {
  const { v } = c;
  const filtered = !!(v.mine || v.who !== undefined || v.open || v.done || v.today || v.backlog || (v.tag as string[] | undefined)?.length);
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
    if (v.backlog) tasks = tasks.filter((t) => t.section === "backlog");
    const want = (v.tag as string[] | undefined) ?? [];
    if (want.length) tasks = tasks.filter((t) => want.every((g) => (t.tags ?? []).includes(g)));
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
  const ps: any[] = (await call("GET", `/orgs/${seg(await org())}/people`)).data;
  const p = ps.find((x) => x.id === w || (typeof x.email === "string" && x.email.toLowerCase() === w.toLowerCase()));
  if (p) return p.id;
  const ids = new Set<string>();
  for (const t of d.tasks) for (const x of [t, ...(t.subtasks ?? [])]) if (x.assignee?.id != null) ids.add(x.assignee.id);
  if (ids.has(w)) return w;
  throw new CliError(6, { error: { code: "invalid", message: "unknown person", details: { fields: { who: [`no member or agent matches "${w}"`] } } } });
}

function get(c: Ctx): Plan {
  return async (call, org) => {
    const b = await call("GET", await tasksPath(c, org, `/${seg(c.pos[2]!)}`));
    print(c.io, c.json, b, () => detail(b.data), () => block(b.data, c.now()));
  };
}
