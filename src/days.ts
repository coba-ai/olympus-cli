import { CliError, print, seg, usage, type Io } from "./core";
import { clean, keyValue, table, when } from "./format";
import { dash, GLOBAL, type Plan } from "./tasks";

type Opts = Record<string, unknown>;
type Ctx = { date: string; v: Opts; io: Io; json: boolean; now: () => number };

export const DAY_FLAGS = ["shipped", "blocker", "learning", "reflection", "draft"];
const CONTENT = ["shipped", "blocker", "learning", "reflection"];

const dayPath = async (c: Ctx, org: () => Promise<string>) => `/orgs/${seg(await org())}/days/${seg(c.date)}`;
const list = (c: Ctx, k: string) => (c.v[k] as string[] | undefined) ?? [];
const isEmpty = (s: string) => s.trim() === "";

// ---- rendering. Piped lines are a stability promise; the TTY block is not. Every server string is cleaned.
function detail(d: any): string {
  const e = d.entry;
  return [
    `day: ${dash(d.day)}`, `closed: ${d.closed === true}`, `closed_at: ${dash(d.closed_at)}`, `score: ${dash(d.score)}`,
    `shipped: ${dash(e?.shipped)}`, `reflection: ${dash(e?.reflection)}`, `agent_note: ${dash(e?.agent_note)}`,
    ...(e?.blockers ?? []).map((b: any) => `blocker: ${dash(b.id)}\t${clean(b.text)}`),
    ...(e?.learnings ?? []).map((l: any) => `learning: ${dash(l.id)}\t${clean(l.text)}`),
  ].join("\n");
}

function block(d: any, now: number): string {
  const e = d.entry;
  const day = clean(d.day);
  if (!e) return `Nothing saved for ${day} yet. Close it with: olympus day close ${day}`;
  const status = d.closed ? `closed, ${when(d.closed_at, now)}` : "draft";
  const ind = (s: string) => s.split("\n").map((l) => ("  " + l).trimEnd()).join("\n");
  const items = (name: string, xs: any[]) => (xs?.length ? `\n\n${name}:\n${xs.map((x) => `  - ${clean(x.text)}`).join("\n")}` : "");
  const s = e.summary ?? {};
  return keyValue([["day", day], ["status", status], ["score", d.score == null ? null : clean(d.score)], ["shipped", e.shipped ? clean(e.shipped) : null]])
    + items("blockers", e.blockers) + items("learnings", e.learnings)
    + (e.reflection ? `\n\nreflection:\n${ind(clean(e.reflection, true))}` : "")
    + (e.agent_note ? `\n\nagent note:\n${ind(clean(e.agent_note, true))}` : "")
    + `\n\nsummary  ${clean(s.tasks_created ?? 0)} created, ${clean(s.tasks_done ?? 0)} done`;
}

const show = (c: Ctx, b: any, sentence?: string) =>
  print(c.io, c.json, b, () => detail(b.data), () => (sentence ? `${sentence}\n\n` : "") + block(b.data, c.now()));

// ---- subcommands
const showPlan = (c: Ctx): Plan => async (call, org) => show(c, await call("GET", await dayPath(c, org)));

function listPlan(c: Ctx): Plan {
  const q = typeof c.v.week === "string" ? `?week=${encodeURIComponent(c.v.week)}` : "";
  return async (call, org) => {
    const b = await call("GET", `/orgs/${seg(await org())}/days${q}`);
    const days: any[] = b.data.days ?? [];
    const status = (d: any) => (d.closed ? "closed" : d.entry ? "draft" : "-");
    print(c.io, c.json, b, () => days.map((d) => [dash(d.day), status(d), dash(d.score), dash(d.entry?.shipped)].join("\t")).join("\n"),
      () => `Week of ${clean(b.data.week)}\n\n` + table(["DAY", "STATUS", "SCORE", "SHIPPED"],
        days.map((d) => [d.day, status(d), d.score == null ? null : String(d.score), d.entry?.shipped || null])));
  };
}

function closePlan(c: Ctx): Plan {
  const { v } = c;
  const body: Record<string, unknown> = {};
  if (v.shipped !== undefined) body.shipped = v.shipped;
  if (list(c, "blocker").length) body.blockers = list(c, "blocker");
  if (list(c, "learning").length) body.learnings = list(c, "learning");
  if (v.reflection !== undefined) body.reflection = v.reflection;
  if (v.draft) body.close = false;
  const flagged = CONTENT.some((k) => v[k] !== undefined);
  const ask = c.io.ask;
  if (!flagged && !(ask && !c.json)) throw usage("day close needs --shipped, --blocker, --learning or --reflection (or a terminal to answer questions)");
  const send = async (call: Parameters<Plan>[0], org: () => Promise<string>, b: Record<string, unknown>) => {
    const r = await call("PUT", await dayPath(c, org), b);
    show(c, r, r.data.closed ? `Closed ${clean(r.data.day)}.` : `Saved a draft for ${clean(r.data.day)}.`);
  };
  if (flagged) return (call, org) => send(call, org, body);
  return async (call, org) => {
    // The GET checks auth, org and day before the first question.
    const cur = await call("GET", await dayPath(c, org));
    const stop = (message: string) => new CliError(130, { error: { code: "cancelled", message } });
    const q = async (prompt: string) => {
      const a = await ask!(prompt);
      if (a === null) throw stop("cancelled; nothing was saved");
      return a;
    };
    const lines = async (title: string) => {
      c.io.err(`${title}, one per line (empty line to finish):\n`);
      const out: string[] = [];
      for (let a = await q("> "); !isEmpty(a); a = await q("> ")) out.push(a);
      return out;
    };
    c.io.err(`Close of day for ${clean(cur.data.day)}. Press Enter to skip; Ctrl-D cancels.\n`);
    const shipped = await q("Shipped: ");
    const blockers = await lines("Blockers");
    const learnings = await lines("Learnings");
    const reflection = await q("Reflection: ");
    if (!isEmpty(shipped)) body.shipped = shipped;
    if (blockers.length) body.blockers = blockers;
    if (learnings.length) body.learnings = learnings;
    c.io.close?.(); // leave raw mode so Ctrl-C during the PUT takes the default signal
    if (!isEmpty(reflection)) body.reflection = reflection;
    if (cur.data.entry === null && !Object.keys(body).some((k) => k !== "close")) throw stop("nothing entered; nothing was saved");
    await send(call, org, body);
  };
}

// ---- dispatch. Usage errors are thrown here, synchronously, so they exit 1 before credentials are read.
// n = allowed positional counts [min, max] including the word "day".
const SUBS: Record<string, { flags: string[]; n: [number, number]; build: (c: Ctx) => Plan }> = {
  show: { flags: [], n: [2, 3], build: showPlan },
  list: { flags: ["week"], n: [2, 2], build: listPlan },
  close: { flags: DAY_FLAGS, n: [2, 3], build: closePlan },
};

const localDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function dayPlan(pos: string[], v: Opts, io: Io, json: boolean, now: () => number): Plan {
  const word = pos[1];
  const named = word !== undefined && Object.hasOwn(SUBS, word);
  if (word !== undefined && !named && !/^\d{4}-\d{2}-\d{2}$/.test(word)) throw usage(`unknown day command: ${word}`);
  const key = named ? word! : "show";
  const spec = SUBS[key]!;
  const [min, max] = named ? spec.n : [1, 2];
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || GLOBAL.includes(k)) continue;
    if (!spec.flags.includes(k)) throw usage(`unknown option '--${k}' for day${named ? " " + key : ""}`);
  }
  if (pos.length < min || pos.length > max) throw usage(`expected ${min === max ? min : `${min}-${max}`} argument(s) in: ${pos.join(" ")}`);
  const date = (named ? pos[2] : pos[1]) ?? localDate(now());
  if (key !== "list") seg(date);
  return spec.build({ date, v, io, json, now });
}
