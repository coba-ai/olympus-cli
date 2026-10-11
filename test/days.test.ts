import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, type Exit } from "../src/core";
import { EventEmitter } from "node:events";
import { lineAsker, processIo, run } from "../src/cli";
import { startFake, TOKENS } from "./fake-api";

const fake = startFake();
const TZ = process.env.TZ;
afterAll(() => { fake.stop(); if (TZ === undefined) delete process.env.TZ; else process.env.TZ = TZ; });
const NOW = Date.parse("2026-10-07T14:00:00Z");
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  fake.state.today = "2026-10-07";
  fake.state.now = () => NOW;
  fake.state.days = {};
});

type Ask = (prompt: string) => Promise<string | null>;
async function cli(args: string[], o: { env?: Record<string, string>; tty?: boolean; ask?: Ask; now?: number; home?: string } = {}) {
  const home = o.home ?? (await mkdtemp(join(tmpdir(), "oly-")));
  let out = "", err = "", stdinCalls = 0;
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, ...o.env }, home, stdin: async () => { stdinCalls++; throw new Error("stdin must not be read"); },
    out: (s) => { out += s; }, err: (s) => { err += s; }, now: () => o.now ?? NOW, tty: o.tty ?? false, ...(o.ask ? { ask: o.ask } : {}),
  });
  return { code, out, err, stdinCalls };
}
const owner = { OLYMPUS_API_KEY: TOKENS.owner };
const reqs = () => fake.state.requests;
const last = () => reqs()[reqs().length - 1]!;
const run1 = (args: string[], tty = false, ask?: Ask) => cli([...args, "--org", "acme"], { env: owner, tty, ask });
const noCtl = (s: string) => expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s.replace(/\n/g, ""))).toBe(false);
const EVIL = "x\x1b]52;c;ZZ\x07\x9by";
const j = (r: { out: string }) => JSON.parse(r.out);
const script = (answers: (string | null)[]) => {
  const prompts: string[] = [];
  const ask: Ask = async (p) => { prompts.push(p); return answers.shift() ?? null; };
  return { ask, prompts };
};
const next = (status: number, body?: unknown) => { fake.state.next = { status, body } as any; };

test("AC16 routing: day, day DATE, day show, day list", async () => {
  for (const a of [["day", "2026-10-07"], ["day", "show", "2026-10-07"], ["day", "show"], ["day"]]) {
    fake.state.requests.length = 0;
    expect((await run1(a)).code).toBe(0);
    expect(reqs()).toHaveLength(1);
    expect(last().method).toBe("GET");
    expect(last().path).toBe("/api/v1/orgs/acme/days/2026-10-07");
    expect(last().search).toBe("");
  }
  await run1(["day", "list"]);
  expect(last().path).toBe("/api/v1/orgs/acme/days");
  expect(last().search).toBe("");
  await run1(["day", "list", "--week", "2026-10-12"]);
  expect(last().search).toBe("?week=2026-10-12");
});

test("AC16 default date is the local date, not UTC", async () => {
  process.env.TZ = "America/Mexico_City";
  const at = Date.parse("2026-10-08T03:00:00Z");
  expect(new Date(at).getTimezoneOffset()).toBe(360);
  await cli(["day", "--org", "acme"], { env: owner, now: at });
  expect(last().path).toBe("/api/v1/orgs/acme/days/2026-10-07");
});

const put = (day: string, body: unknown) => fetch(`${fake.url.replace(/\/$/, "")}/api/v1/orgs/acme/days/${day}`, {
  method: "PUT", headers: { Authorization: `Bearer ${TOKENS.owner}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("AC17 day show: piped golden with an entry and with entry:null, --json as-is", async () => {
  await put("2026-10-07", { shipped: "Shipped it", blockers: ["wait", "tab\there"], learnings: ["l one"], reflection: "line1\nline2" });
  fake.state.requests.length = 0;
  const r = await run1(["day", "2026-10-07"]);
  expect(r.out).toBe(
    "day: 2026-10-07\nclosed: true\nclosed_at: 2026-10-07T14:00:00.000Z\nscore: -\nshipped: Shipped it\nreflection: line1 line2\nagent_note: -\n" +
    "blocker: b1\twait\nblocker: b2\ttab here\nlearning: l1\tl one\n");
  expect(r.err).toBe("");
  const empty = await run1(["day", "show", "2026-10-06"]);
  expect(empty.out).toBe("day: 2026-10-06\nclosed: false\nclosed_at: -\nscore: -\nshipped: -\nreflection: -\nagent_note: -\n");
  const raw = await run1(["day", "2026-10-07", "--json"]);
  expect(raw.out).toBe(JSON.stringify(j(raw)) + "\n");
  expect(j(raw).data.entry.summary).toBeDefined();
});

test("AC17 day show: TTY block", async () => {
  await put("2026-10-07", { shipped: "Shipped it", blockers: ["wait"], learnings: ["l one"], reflection: "line1\nline2" });
  const r = await run1(["day", "2026-10-07"], true);
  expect(r.out).toBe(
    "day      2026-10-07\nstatus   closed, just now (2026-10-07 14:00 UTC)\nscore    -\nshipped  Shipped it\n\nblockers:\n  - wait\n\nlearnings:\n  - l one\n\n" +
    "reflection:\n  line1\n  line2\n\nsummary  0 created, 0 done\n");
  await put("2026-10-06", { shipped: "d", close: false });
  expect((await run1(["day", "2026-10-06"], true)).out).toContain("status   draft");
  expect((await run1(["day", "2026-10-02"], true)).out).toBe("Nothing saved for 2026-10-02 yet. Close it with: olympus day close 2026-10-02\n");
});

test("AC18 day list: piped 5 rows, TTY table, --json", async () => {
  await put("2026-10-06", { shipped: "a b", close: false });
  await put("2026-10-07", { shipped: "done it" });
  const r = await run1(["day", "list"]);
  expect(r.out).toBe("2026-10-05\t-\t-\t-\n2026-10-06\tdraft\t-\ta b\n2026-10-07\tclosed\t-\tdone it\n2026-10-08\t-\t-\t-\n2026-10-09\t-\t-\t-\n");
  const t = await run1(["day", "list"], true);
  expect(t.out).toBe(
    "Week of 2026-10-05\n\nDAY         STATUS  SCORE  SHIPPED\n2026-10-05  -       -      -\n2026-10-06  draft   -      a b\n2026-10-07  closed  -      done it\n2026-10-08  -       -      -\n2026-10-09  -       -      -\n");
  const raw = await run1(["day", "list", "--json"]);
  expect(raw.out).toBe(JSON.stringify(j(raw)) + "\n");
  expect(j(raw).data.days).toHaveLength(5);
});

test("AC19 day close: body has only the given fields", async () => {
  const body = async (a: string[]) => { await run1(["day", "close", "2026-10-07", ...a]); return last().body; };
  expect(await body(["--shipped", "S"])).toEqual({ shipped: "S" });
  expect(last().method).toBe("PUT");
  expect(last().path).toBe("/api/v1/orgs/acme/days/2026-10-07");
  expect(await body(["--blocker", "a", "--blocker", "b", "--learning", "l", "--reflection", "R"])).toEqual({ blockers: ["a", "b"], learnings: ["l"], reflection: "R" });
  expect(await body(["--shipped", "S", "--draft"])).toEqual({ shipped: "S", close: false });
  expect(await body(["--blocker", ""])).toEqual({ blockers: [""] });
  expect(await body(["--shipped", "S", "--no-draft"])).toEqual({ shipped: "S" });
  await cli(["day", "close", "--shipped", "T", "--org", "acme"], { env: owner });
  expect(last().path).toBe("/api/v1/orgs/acme/days/2026-10-07");
});

test("AC19 day close output: piped, TTY sentences from the response, --json", async () => {
  const p = await run1(["day", "close", "2026-10-07", "--shipped", "S"]);
  expect(p.out.startsWith("day: 2026-10-07\nclosed: true\n")).toBe(true);
  expect(p.out).toContain("shipped: S\n");
  const t = await run1(["day", "close", "2026-10-08", "--shipped", "S"], true);
  expect(t.out.startsWith("Closed 2026-10-08.\n\nday      2026-10-08\n")).toBe(true);
  const d = await run1(["day", "close", "2026-10-09", "--shipped", "S", "--draft"], true);
  expect(d.out.startsWith("Saved a draft for 2026-10-09.\n\n")).toBe(true);
  // --draft on an already-closed day: the server keeps it closed, so the sentence says so
  const again = await run1(["day", "close", "2026-10-08", "--reflection", "R", "--draft"], true);
  expect(again.out.startsWith("Closed 2026-10-08.\n")).toBe(true);
  const raw = await run1(["day", "close", "2026-10-07", "--shipped", "S", "--json"]);
  expect(raw.out).toBe(JSON.stringify(j(raw)) + "\n");
});

test("AC20 never block a script: no content flags without a prompt is a usage error", async () => {
  for (const a of [[], ["--draft"], ["--json"], ["--json", "--draft"]]) {
    const r = await run1(["day", "close", "2026-10-07", ...a], true);
    expect(r.code).toBe(1);
    expect(r.err).toContain("day close needs --shipped");
    expect(r.stdinCalls).toBe(0);
    // an ask is present but --json never prompts
    if (a.includes("--json")) {
      const s = script(["x"]);
      expect((await run1(["day", "close", "2026-10-07", ...a], true, s.ask)).code).toBe(1);
      expect(s.prompts).toEqual([]);
    }
  }
  expect((await cli(["day", "close", "--org", "acme"])).code).toBe(1);
  expect(reqs()).toHaveLength(0);
  const e = await run1(["day", "close", "--json"]);
  expect(JSON.parse(e.err).error.code).toBe("usage");
});

test("AC21 prompt flow: exact script, GET then PUT, empty answers omitted", async () => {
  const s = script(["shipped it", "b1", "b2", "", "l1", "", "my reflection"]);
  const r = await run1(["day", "close", "2026-10-07"], true, s.ask);
  expect(r.code).toBe(0);
  expect(s.prompts).toEqual(["Shipped: ", "> ", "> ", "> ", "> ", "> ", "Reflection: "]);
  expect(r.err).toBe(
    "Close of day for 2026-10-07. Press Enter to skip; Ctrl-D cancels.\nBlockers, one per line (empty line to finish):\nLearnings, one per line (empty line to finish):\n");
  expect(reqs().map((x) => x.method + " " + x.path)).toEqual(["GET /api/v1/orgs/acme/days/2026-10-07", "PUT /api/v1/orgs/acme/days/2026-10-07"]);
  expect(last().body).toEqual({ shipped: "shipped it", blockers: ["b1", "b2"], learnings: ["l1"], reflection: "my reflection" });
  expect(r.out).toContain("Closed 2026-10-07.");
  // everything empty, no entry yet: nothing to send
  fake.state.requests.length = 0;
  const e = script(["", "", "", ""]);
  const n = await run1(["day", "close", "2026-10-06"], true, e.ask);
  expect(n.code).toBe(130);
  expect(n.err).toContain("nothing entered; nothing was saved");
  expect(reqs().map((x) => x.method)).toEqual(["GET"]);
  // everything empty over an existing entry: {} closes it
  await put("2026-10-08", { shipped: "x", close: false });
  fake.state.requests.length = 0;
  const c = script(["", "", "", ""]);
  expect((await run1(["day", "close", "2026-10-08"], false, c.ask)).code).toBe(0);
  expect(last().body).toEqual({});
  // --draft with prompts
  const d = script(["x", "", "", ""]);
  await run1(["day", "close", "2026-10-09", "--draft"], false, d.ask);
  expect(last().body).toEqual({ shipped: "x", close: false });
});

test("AC21 prompt flow: cancel, errors before the first question, content flags skip prompts", async () => {
  for (const at of [0, 1, 2, 3, 4]) {
    fake.state.requests.length = 0;
    const answers: (string | null)[] = ["s", "b", "", "l", ""].slice(0, at);
    const s = script(answers);
    const r = await run1(["day", "close", "2026-10-07"], true, s.ask);
    expect(r.code).toBe(130);
    expect(JSON.stringify(r.err)).toContain("cancelled; nothing was saved");
    expect(reqs().map((x) => x.method)).toEqual(["GET"]);
  }
  const thrower: Ask = async () => { throw new CliError(130, { error: { code: "cancelled", message: "cancelled; nothing was saved" } }); };
  fake.state.requests.length = 0;
  const t = await run1(["day", "close", "2026-10-07"], true, thrower);
  expect(t.code).toBe(130);
  expect(t.err).toContain("cancelled; nothing was saved");
  expect(reqs().map((x) => x.method)).toEqual(["GET"]);
  fake.state.requests.length = 0;
  const j2 = await cli(["day", "close", "2026-10-07", "--org", "acme", "--json"], { env: owner, ask: thrower });
  expect(j2.code).toBe(1);
  // no token: exit 2, ask never called
  const s = script(["x"]);
  const nt = await cli(["day", "close", "2026-10-07", "--org", "acme"], { ask: s.ask });
  expect(nt.code).toBe(2);
  expect(s.prompts).toEqual([]);
  // 401 / 404 / 422 on the GET: exit 2/3/6, ask never called
  for (const [status, code] of [[401, 2], [404, 3], [422, 6]] as const) {
    const q = script(["x"]);
    next(status, { error: { code: "x", message: "no", details: { fields: { day: ["bad"] } } } });
    expect((await run1(["day", "close", "2026-10-07"], true, q.ask)).code).toBe(code);
    expect(q.prompts).toEqual([]);
  }
  const bad = script(["x"]);
  expect((await cli(["day", "close", "2026-10-07", "--org", "nope"], { env: owner, ask: bad.ask })).code).toBe(3);
  expect(bad.prompts).toEqual([]);
  // a content flag on a terminal: no prompting
  fake.state.requests.length = 0;
  const f = script(["x"]);
  await run1(["day", "close", "2026-10-07", "--shipped", "S"], true, f.ask);
  expect(f.prompts).toEqual([]);
  expect(reqs().map((x) => x.method)).toEqual(["PUT"]);
});

test("AC21 intro uses the returned day, cleaned", async () => {
  next(200, { data: { day: EVIL, closed: false, closed_at: null, score: null, entry: null } });
  const s = script(["", "", "", ""]);
  const r = await run1(["day", "close", "2026-10-07"], true, s.ask);
  noCtl(r.err);
  expect(r.err).toContain("Close of day for x]52;c;ZZy");
});

test("AC22 usage errors: exit 1, zero requests, also without a token", async () => {
  const cases = [
    ["day", "show", ".."], ["day", "close", "."], ["day", "lsit"], ["day", "constructor"], ["day", "__proto__"], ["day", "2026-1-7"],
    ["day", "--week", "2026-10-05"], ["day", "show", "--week", "2026-10-05"], ["day", "close", "--week", "x", "--shipped", "s"],
    ["day", "--mine"], ["day", "list", "--tag", "x"], ["day", "show", "--agent", "h"], ["day", "close", "--yes", "--shipped", "s"],
    ["day", "--shipped", "x"], ["day", "list", "--draft"], ["day", "show", "--blocker", "x"],
    ["day", "show", "2026-10-07", "2026-10-08"], ["day", "2026-10-07", "x"], ["day", "list", "2026-10-07"], ["day", "close", "2026-10-07", "2026-10-08", "--shipped", "s"],
    ["task", "get", "tback001", "--draft"], ["task", "list", "--shipped", "x"], ["tasks", "--reflection", "x"], ["whoami", "--shipped", "x"],
    ["webhook", "list", "--blocker", "x"], ["agents", "list", "--learning", "x"], ["whoami", "--draft"],
  ];
  for (const withToken of [true, false])
    for (const c of cases) {
      const r = await cli([...c, "--org", "acme"], { env: withToken ? owner : {} });
      expect([c.join(" "), r.code]).toEqual([c.join(" "), 1]);
    }
  expect(reqs()).toHaveLength(0);
});

test("AC23 422 names the field; 404 keeps the stored-org hint", async () => {
  const r = await run1(["day", "show", "2026-10-10"]);
  expect(r.code).toBe(6);
  expect(r.err).toContain("day:");
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  await mkdir(join(home, ".config", "olympus"), { recursive: true });
  await writeFile(join(home, ".config", "olympus", "credentials.json"), JSON.stringify({ host: fake.url.replace(/\/$/, ""), token: TOKENS.owner, org: "gone" }));
  const h = await cli(["day", "2026-10-07"], { home });
  expect(h.code).toBe(3);
  expect(h.err).toContain('org "gone" from credentials.json');
});

test("AC23 hostile strings never reach stdout", async () => {
  const day = { day: EVIL, closed: true, closed_at: EVIL, score: EVIL, entry: {
    shipped: EVIL, reflection: EVIL, agent_note: EVIL, blockers: [{ id: EVIL, text: EVIL }], learnings: [{ id: EVIL, text: EVIL }],
    summary: { tasks_created: EVIL, tasks_done: EVIL, learnings: 0, one_thing_progress: 0, allocation: [] }, week_close: false } };
  for (const tty of [false, true])
    for (const a of [["day", "2026-10-07"], ["day", "close", "2026-10-07", "--shipped", "s"]]) {
      next(200, { data: day });
      const r = await run1(a, tty);
      expect(r.code).toBe(0);
      noCtl(r.out);
      expect(r.out).toContain("x]52;c;ZZy");
    }
  for (const tty of [false, true]) {
    next(200, { data: { week: EVIL, days: [day.day, EVIL].map(() => day) } });
    const r = await run1(["day", "list"], tty);
    noCtl(r.out);
    expect(r.out).toContain("x]52;c;ZZy");
  }
});

test("AC23 token sweep: day commands x 401/403/404/422/503 x TTY x --json, plus the prompt path", async () => {
  const T = TOKENS.owner;
  const cmds: string[][] = [["day"], ["day", "show", "2026-10-07"], ["day", "list"], ["day", "close", "2026-10-07", "--shipped", "s"], ["day", "close", "2026-10-07"]];
  const statuses = [401, 403, 404, 422, 503];
  const want: Record<number, Exit> = { 401: 2, 403: 4, 404: 3, 422: 6, 503: 5 };
  for (const tty of [false, true])
    for (const json of [[], ["--json"]])
      for (const c of cmds)
        for (const status of statuses) {
          const prompting = c[1] === "close" && c.length === 3;
          if (prompting && json.length) continue; // --json never prompts: a usage error, covered by AC20
          const s = script(["x"]);
          next(status, { error: { code: "e", message: "no", details: { fields: { day: ["bad"] } } } });
          const r = await cli([...c, "--org", "acme", ...json], { env: { OLYMPUS_API_KEY: T }, tty, ask: prompting ? s.ask : undefined });
          expect(r.out).not.toContain(T);
          expect(r.err).not.toContain(T);
          expect(r.code).toBe(want[status]!);
          if (prompting) expect(s.prompts).toEqual([]);
        }
});

test("AC24 help lists the day lines; processIo offers ask only on a terminal", async () => {
  const r = await cli(["--help"]);
  for (const l of [
    "  day [DATE] | day show [DATE] | day list [--week D]   (DATE: YYYY-MM-DD, default today)",
    "  task delegate <id> [--to AGENT] | task breakdown <id> [--agent AGENT]   (both accept --week D)",
    "  day close [DATE] [--shipped T] [--blocker T]... [--learning T]... [--reflection T] [--draft]",
  ]) expect(r.out).toContain(l + "\n");
  const io = processIo();
  expect(typeof io.ask === "function").toBe(process.stdin.isTTY === true && process.stderr.isTTY === true);
  expect(typeof io.close).toBe("function");
  io.close!();
});

test("Ctrl-C in the same burst as queued answers cancels: exit 130, no PUT", async () => {
  const rl: any = new EventEmitter();
  rl.setPrompt = () => {};
  rl.close = () => rl.emit("close");
  let first = true;
  rl.prompt = () => {
    if (!first) return;
    first = false;
    queueMicrotask(() => { // input arrives after the question is pending, as with a real tty
      for (const l of ["a", "", "", "r"]) rl.emit("line", l);
      rl.emit("SIGINT");
    });
  };
  const r = await run1(["day", "close", "2026-10-07"], true, lineAsker(rl));
  expect(r.code).toBe(130);
  expect(reqs().map((q) => q.method)).toEqual(["GET"]);
});

function burst(lines: string[], end: "close" | "SIGINT") {
  const rl: any = new EventEmitter();
  rl.setPrompt = () => {};
  rl.close = () => rl.emit("close");
  let first = true;
  rl.prompt = () => {
    if (!first) return;
    first = false;
    queueMicrotask(() => {
      for (const l of lines) rl.emit("line", l);
      rl.emit(end);
    });
  };
  return lineAsker(rl);
}

test("Ctrl-D after the last answer in the same burst still saves", async () => {
  const r = await run1(["day", "close", "2026-10-07"], true, burst(["a", "", "", "r"], "close"));
  expect(r.code).toBe(0);
  expect(reqs().map((q) => q.method)).toEqual(["GET", "PUT"]);
  const b: any = reqs()[1]!.body;
  expect(b.shipped).toBe("a");
  expect(b.reflection).toBe("r");
});

test("Ctrl-D at a question that still needs an answer cancels: exit 130, no PUT", async () => {
  const r = await run1(["day", "close", "2026-10-07"], true, burst(["a"], "close"));
  expect(r.code).toBe(130);
  expect(r.err + r.out).toContain("cancelled");
  expect(reqs().map((q) => q.method)).toEqual(["GET"]);
});
