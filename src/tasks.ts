import { CliError, print, realSleep, seg, usage, type Api, type Exit, type Io } from "./core";
import { clean, keyValue, table, when } from "./format";

const enc = encodeURIComponent;
type Opts = Record<string, unknown>;
type Ctx = { pos: string[]; v: Opts; io: Io; json: boolean; now: () => number; signal: AbortSignal };
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

// ---- breakdown: POST /tasks/:id/breakdowns answers at once with a handle; GET /breakdowns/:handle is polled.
// The 202 says Retry-After: 3, but api() does not expose success headers, so the documented 3 s is used.
const POLL_MS = 3000;
const BREAKDOWN_WAIT_S = 300;
const HANDLE = /^bd_[A-Za-z0-9_-]{1,120}$/;
const isObj = (x: unknown): x is Record<string, any> => typeof x === "object" && x !== null && !Array.isArray(x);

function waitSecs(t: unknown): number {
  if (t === undefined) return BREAKDOWN_WAIT_S;
  const n = /^\d+$/.test(String(t)) ? Number(t) : 0;
  if (n < 1 || n > 86400) throw usage("--timeout must be a whole number of seconds from 1 to 86400");
  return n;
}

// Printed commands must paste back into a shell: plain words as they are, anything else single-quoted.
const sh = (x: unknown) => { const s = clean(x); return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`; };
// The org (resolved) and an explicit --host, so the command reads from the same place the start went to.
const target = (c: Ctx, org: string) => ` --org ${sh(org)}${typeof c.v.host === "string" && c.v.host ? ` --host ${sh(c.v.host)}` : ""}`;
// The read-only command that picks a breakdown up again; the handle is HANDLE-checked, so it is safe to print.
const resumeCmd = (c: Ctx, org: string, h: string) => `olympus task breakdown-status ${h}${target(c, org)} --wait`;
const taskGet = (c: Ctx, org: string, id: unknown) =>
  `olympus task get ${sh(id)}${typeof c.v.week === "string" ? ` --week ${sh(c.v.week)}` : ""}${target(c, org)}`;

function breakdown(c: Ctx): Plan {
  const { v } = c;
  if (v.wait === true) throw usage("waiting is the default; use --no-wait to skip it");
  if (v.wait === false && v.timeout !== undefined) throw usage("--timeout cannot be combined with --no-wait");
  const secs = v.wait === false ? 0 : waitSecs(v.timeout);
  const body = v.agent === undefined ? {} : { agent: v.agent };
  const id = c.pos[2]!, tid = clean(id);
  return async (call, org) => {
    const slug = await org();
    const path = `/orgs/${seg(slug)}/tasks/${seg(id)}/breakdowns${weekQuery(c)}`;
    const check = `check the task before running it again: ${taskGet(c, slug, id)}`;
    if (c.signal.aborted) throw new CliError(130, { error: { code: "cancelled", message: "cancelled; nothing was started" } });
    if (c.io.tty && !c.json) c.io.err(`Asking ${v.agent === undefined ? "the agent" : clean(v.agent)} to break down task ${tid}...\n`);
    let b: any;
    try {
      b = await call("POST", path, body);
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      if (e.exit === 130) throw new CliError(130, { error: { code: "cancelled", message: `cancelled; the breakdown may have started; ${check}` } });
      // No answer, a non-JSON or redirected answer, or a 5xx that is not a known refusal: the start may have been
      // accepted. It is never sent again, and never falls back to the synchronous route.
      const st = e.status, code = e.body.error.code;
      const unknown = st === undefined || st < 400 || (st >= 500 && code !== "not_queued" && code !== "machine_not_ready");
      if (!unknown) throw e;
      throw new CliError(e.exit, { error: { ...e.body.error, message: `${e.body.error.message}; the breakdown may have started; ${check}` } }, e.retryAfter, e.location, st);
    }
    const h = b?.data?.id;
    if (typeof h !== "string" || !HANDLE.test(h))
      throw new CliError(5, { error: { code: "bad_response", message: `the server accepted the breakdown but sent no usable handle; ${check}` } });
    const resume = resumeCmd(c, slug, h);
    if (!secs) {
      const st = dash(b.data.status);
      return print(c.io, c.json, b, () => `id: ${h}\nstatus: ${st}`, () => `Started breakdown ${h} of task ${tid} (${st}). Check it: ${resume}`);
    }
    if (c.io.tty && !c.json) c.io.err(`Started breakdown ${h}; waiting up to ${secs}s...\n`);
    await follow(c, call, slug, h, secs, id);
  };
}

function breakdownStatus(c: Ctx): Plan {
  const { v } = c;
  if (v.wait === false) throw usage("waiting is off unless you pass --wait");
  if (v.wait !== true && v.timeout !== undefined) throw usage("--timeout needs --wait");
  const secs = v.wait === true ? waitSecs(v.timeout) : 0;
  const h = c.pos[2]!;
  if (!HANDLE.test(h)) throw usage(`invalid breakdown handle: "${clean(h)}" (it starts with bd_)`);
  return async (call, org) => follow(c, call, await org(), h, secs);
}

// Reads the handle until it is terminal (secs > 0) or once (secs 0). Paths are built from the org and the checked
// handle, never from the server's status_url. Every error carries the handle and org. GET only: nothing is started here.
async function follow(c: Ctx, call: Api, org: string, h: string, secs: number, taskId?: string): Promise<void> {
  const path = `/orgs/${seg(org)}/breakdowns/${seg(h)}`;
  const resume = resumeCmd(c, org, h);
  const mk = (exit: Exit, code: string, message: string) => new CliError(exit, { error: { code, message, details: { breakdown_id: h, org } } });
  const giveUp = () => mk(5, "timeout", `no result within ${secs}s; breakdown ${h} may still be running. Check it: ${resume}`);
  const cancelled = () => mk(130, "cancelled", `cancelled; breakdown ${h} may still be running. Check it: ${resume}`);
  const bad = (why: string) => mk(5, "bad_response", `${why}; breakdown ${h} may still be running. Check it: ${resume}`);
  const deadline = c.now() + secs * 1000;
  let gap = taskId === undefined ? 0 : POLL_MS, errs = 0; // a fresh start is not read before the first interval
  for (let reads = 0; ; reads++) {
    if (c.signal.aborted) throw cancelled();
    // reads: a clock that does not move cannot keep this going; each pass sleeps at least POLL_MS otherwise.
    if (secs && (reads > secs || c.now() >= deadline)) throw giveUp();
    if (gap) {
      await (c.io.sleep ?? realSleep)(Math.min(gap, Math.max(0, deadline - c.now())), c.signal);
      if (c.signal.aborted) throw cancelled();
      if (c.now() >= deadline) throw giveUp();
    }
    gap = POLL_MS;
    let b: any;
    try {
      b = await call("GET", path, undefined, secs ? Math.max(1000, Math.min(30_000, deadline - c.now())) : undefined);
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      if (e.exit === 130 || c.signal.aborted) throw cancelled();
      const transient = e.status === undefined ? e.body.error.code === "network_error" : e.status === 429 || e.status >= 500;
      if (!secs || !transient) throw withHandle(c, e, h, org);
      const ra = e.retryAfter && /^\d+$/.test(e.retryAfter) ? Number(e.retryAfter) * 1000 : undefined;
      gap = ra === undefined ? Math.min(POLL_MS * 2 ** ++errs, 30_000) : Math.max(POLL_MS, ra); // clamped to the deadline above
      continue;
    }
    errs = 0;
    const d = b?.data;
    // The answer must be about this handle (and, after a start, this task), or it proves nothing.
    if (!isObj(d) || d.id !== h || (taskId !== undefined && d.task_id !== undefined && d.task_id !== taskId)) throw bad("unexpected breakdown status");
    const tid = d.task_id ?? taskId;
    if (d.status === "queued" || d.status === "running") {
      if (secs) continue;
      return print(c.io, c.json, b, () => `id: ${h}\nstatus: ${d.status}`, () => `Breakdown ${h} of task ${clean(tid)} is ${d.status}. Check it: ${resume}`);
    }
    if (d.status === "succeeded") {
      if (!Array.isArray(d.added) || !d.added.every(isObj)) throw bad("the breakdown succeeded but its result was unreadable");
      return breakdownDone(c, b, d, clean(tid));
    }
    if (d.status === "failed") {
      const raw = isObj(d.error) ? d.error : {};
      const code = typeof raw.code === "string" && /^[a-z0-9_]{1,40}$/.test(raw.code) ? raw.code : "breakdown_failed";
      const exit: Exit = code === "full" || code === "no_agent" ? 6 : code === "task_gone" ? 3 : 5;
      const why = typeof raw.message === "string" && raw.message ? raw.message : "the breakdown failed";
      throw mk(exit, code, `${why} (breakdown ${h})`); // fail() cleans it on stderr
    }
    if (d.status === "expired")
      throw mk(3, "expired", `breakdown ${h} has expired and its result is no longer kept; read the task to see what was added`);
    throw bad("unexpected breakdown status");
  }
}

// The added subtasks are exactly those the server committed; a task deleted since is said so, never "added none".
function breakdownDone(c: Ctx, b: any, d: any, tid: string): void {
  const added: any[] = d.added;
  const name = d.agent == null || d.agent === "" ? "The agent" : clean(d.agent);
  const gone = d.task === null;
  const n = gone && Array.isArray(d.added_ids) ? d.added_ids.length : added.length;
  const count = `${n} ${n === 1 ? "subtask" : "subtasks"}`;
  print(c.io, c.json, b,
    () => [`agent: ${dash(d.agent)}`, ...added.map((x) => `added: ${dash(x.id)}\t${dash(x.text)}`)].join("\n"),
    () => gone ? `${name} added ${count} to task ${tid}, which has since been deleted.`
      : added.length ? [`${name} added ${count} to task ${tid}:`, ...added.map((x) => `  ${dash(x.id)}  ${dash(x.text)}`)].join("\n")
      : `${name} added no subtasks to task ${tid}.`);
  if (gone && !c.json && !c.io.tty) c.io.err(`note: task ${tid} has since been deleted\n`);
}

// A server error read after the start: tagged with the handle and org so a script can pick it up again.
function withHandle(c: Ctx, e: CliError, h: string, org: string): CliError {
  const b: any = e.body.error;
  const d = isObj(b.details) ? b.details : {};
  if (d.breakdown_id === undefined) {
    b.details = { ...d, breakdown_id: h, org };
    if (!c.json && typeof b.message === "string") b.message += ` (breakdown ${h})`;
  }
  return e;
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
  breakdown: { flags: [...W, "agent", "wait", "timeout"], n: 3, build: breakdown },
  "breakdown-status": { flags: ["wait", "timeout"], n: 3, build: breakdownStatus },
  "sub add": { flags: [...W, "assign"], n: 5, build: subAdd },
  "sub done": { flags: [...W, "undo"], n: 5, build: subDone },
  "sub delete": { flags: [...W, "yes"], n: 5, build: subDelete },
};

// Positionals that become path segments, by spec key.
const ID_POS: Record<string, number[]> = {
  get: [2], update: [2], done: [2], undone: [2], today: [2], star: [2], delete: [2], delegate: [2], breakdown: [2], "breakdown-status": [2],
  "sub add": [3], "sub done": [3, 4], "sub delete": [3, 4],
};

// Validates everything synchronously (so usage errors exit 1 before credentials are read), then returns the closure.
// `signal` (Ctrl-C) is read by breakdown and breakdown-status only.
export function taskPlan(pos: string[], v: Opts, io: Io, json: boolean, now: () => number, signal: AbortSignal = new AbortController().signal): Plan {
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
  return spec.build({ pos, v, io, json, now, signal });
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
