import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { seedTasks, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
const NOW = Date.parse("2026-10-07T14:00:00Z");
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  fake.state.today = "2026-10-07";
  fake.state.now = () => NOW;
  fake.state.tasks = seedTasks(fake.state.today);
});

async function cli(args: string[], o: { env?: Record<string, string>; tty?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "";
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, ...o.env }, home, stdin: async () => "",
    out: (s) => { out += s; }, err: (s) => { err += s; }, now: () => NOW, tty: o.tty ?? false,
  });
  return { code, out, err };
}
const owner = { OLYMPUS_API_KEY: TOKENS.owner };
const reqs = () => fake.state.requests;
const last = () => reqs()[reqs().length - 1]!;
const run1 = (args: string[], tty = false) => cli([...args, "--org", "acme"], { env: owner, tty });
const noCtl = (s: string) => expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s.replace(/\n$/, "").replace(/\n/g, ""))).toBe(false);
const EVIL = "x\x1b]52;c;ZZ\x07\x9by";

test("AC8 people: piped golden, json byte-for-byte, tty table", async () => {
  expect((await run1(["people"])).out).toBe(
    "u_1\tuser\tAbe Owner\towner@acme.test\tme\nu_4\tuser\tMax Multi\tmulti@acme.test\t-\nu_2\tuser\tMia Mate\tmate@acme.test\t-\n" +
    "u_3\tuser\tPat Pinned\tpinned@acme.test\t-\nhermes\tagent\tHermes\t-\t-\nhera\tagent\tHera\t-\tpaused\n");
  const j = await run1(["people", "--json"]);
  const body = await (await fetch(`${fake.url}/api/v1/orgs/acme/people`, { headers: { Authorization: `Bearer ${TOKENS.owner}` } })).json();
  expect(j.out).toBe(JSON.stringify(body) + "\n");
  const t = (await run1(["people"], true)).out;
  expect(t.split("\n")[0]).toBe("ID      NAME             KIND   EMAIL             STATUS");
  expect(t).toContain("Abe Owner (you)");
  expect(reqs().filter((r) => r.path.endsWith("/people")).every((r) => r.search === "")).toBe(true);
});

const LIST =
  "tstar001\topen\tthe_rest\tstar\tu_1\t-\tStar task\n" +
  "trest001\topen\tthe_rest\t-\tu_2\tpricing,web\tShip the pricing page\n" +
  "s0000001\topen\tsub:trest001\ttoday\tu_1\t-\tDraft copy\n" +
  "s0000002\topen\tsub:trest001\t-\t-\t-\tReview\n" +
  "tdone001\tdone\tthe_rest\t-\tu_1\t-\tFinished task\n" +
  "tback001\topen\tbacklog\t-\t-\t-\tBacklog task\n" +
  "tunk0001\topen\tthe_rest\t-\tu_9\t-\tOrphaned assignee\n" +
  "tlegacy1\topen\tone_thing\tstar\t-\t-\tLegacy one thing\n";

test("AC9 tasks / task list: identical piped golden, json, tty", async () => {
  expect((await run1(["tasks"])).out).toBe(LIST);
  expect((await run1(["task", "list"])).out).toBe(LIST);
  const j = await run1(["tasks", "--json"]);
  const body = await (await fetch(`${fake.url}/api/v1/orgs/acme/tasks`, { headers: { Authorization: `Bearer ${TOKENS.owner}` } })).json();
  expect(j.out).toBe(JSON.stringify(body) + "\n");
  const t = (await run1(["tasks"], true)).out;
  expect(t.startsWith("Week of 2026-10-05\n\nID ")).toBe(true);
  expect(t).toContain("u_9 (unknown)");
  expect(t).toContain("  s0000001");
  expect((await run1(["tasks"], true)).out).toBe((await run1(["task", "list"], true)).out);
  const nc = (await run1(["tasks", "--week", "2026-10-19"], true)).out;
  expect(nc).toBe("No tasks for the week of 2026-10-19.\n");
  expect((await run1(["tasks", "--week", "2026-10-19"])).out).toBe("");
  fake.state.tasks.acme!["2026-10-12"] = { version: 1, tasks: [] };
  expect((await run1(["tasks", "--week=2026-10-12"], true)).out).toBe("No tasks for the week of 2026-10-12.\n");
  expect((await run1(["tasks", "--done", "--mine", "--today"], true)).out).toBe("No tasks match.\n");
});

test("AC10 filters", async () => {
  const ids = async (a: string[]) => (await run1(a)).out.split("\n").filter((l) => /^t/.test(l)).map((l) => l.split("\t")[0]);
  expect(await ids(["tasks", "--mine"])).toEqual(["tstar001", "trest001", "tdone001"]); // trest001 via subtask
  expect(await ids(["tasks", "--who", "me"])).toEqual(["tstar001", "trest001", "tdone001"]);
  expect(reqs().some((r) => r.path.endsWith("/people"))).toBe(false);
  expect(await ids(["tasks", "--who", "u_2"])).toEqual(["trest001"]);
  expect(await ids(["tasks", "--who", "MATE@acme.test"])).toEqual(["trest001"]);
  expect(await ids(["tasks", "--who", "u_9"])).toEqual(["tunk0001"]);
  expect(await ids(["tasks", "--today"])).toEqual(["trest001"]);
  expect(await ids(["tasks", "--done"])).toEqual(["tdone001"]);
  expect((await ids(["tasks", "--open"]))).not.toContain("tdone001");
  const bad = await run1(["tasks", "--who", "nobody"]);
  expect(bad.code).toBe(6);
  expect(bad.err).toContain("who:");
  expect(JSON.parse((await run1(["tasks", "--who", "nobody", "--json"])).err).error.details.fields.who).toBeArray();
  const f = JSON.parse((await run1(["tasks", "--done", "--json"])).out);
  const full: any = await (await fetch(`${fake.url}/api/v1/orgs/acme/tasks`, { headers: { Authorization: `Bearer ${TOKENS.owner}` } })).json();
  expect(f.data.tasks.map((t: any) => t.id)).toEqual(["tdone001"]);
  const { tasks: _a, ...rest } = f.data;
  const { tasks: _b, ...rest2 } = full.data;
  expect(rest).toEqual(rest2);
});

test("AC11 usage errors send no request, even with no token", async () => {
  const bads = [
    ["tasks", "--mine", "--who", "me"], ["tasks", "--open", "--done"], ["tasks", "extra"], ["people", "extra"], ["task", "get"],
    ["task", "get", "a", "b"], ["people", "--week", "x"], ["task", "get", "x", "--mine"], ["task", "list", "--tag", "x"],
    ["task", "get", "x", "--yes"], ["task", "update", "x", "--tags"], ["task"], ["task", "nope"], ["task", "sub"], ["task", "sub", "nope"],
    ["task", "people"], ["tasks", "--name", "n"], ["task", "add", "t"], ["task", "delete", "x", "--yes"], ["task", "sub", "add", "t", "x"],
    ["webhook", "list", "--week", "x"], ["webhook", "list", "--week", "x", "--help"], ["whoami", "--mine"], ["login", "--tag", "a"],
    ["tasks", "--help-me"],
  ];
  for (const a of bads) {
    const r = await cli(a, { env: {} });
    expect([a.join(" "), r.code]).toEqual([a.join(" "), 1]);
  }
  expect(reqs()).toHaveLength(0);
  expect(JSON.parse((await cli(["webhook", "list", "--week", "x", "--json"], { env: owner })).err).error).toMatchObject({ code: "usage", message: "unknown option '--week'" });
  expect((await cli(["tasks"], { env: {} })).code).toBe(2);
  expect((await cli(["task", "list", "--help"], { env: {} })).code).toBe(0);
});

test("AC12 --week on every tasks route, never /people; server 422 exits 6", async () => {
  await run1(["tasks", "--week", "2026-10-05&x=1"]);
  expect(last().search).toBe("?week=2026-10-05%26x%3D1");
  await run1(["tasks", "--week", "2026-10-05", "--who", "u_2"]);
  expect(reqs().find((r) => r.path.endsWith("/people"))!.search).toBe("");
  const g = await run1(["task", "get", "tstar001", "--week", "2026-10-07"]);
  expect(last().search).toBe("?week=2026-10-07");
  expect(g.code).toBe(0);
  const bad = await run1(["tasks", "--week", "nope"]);
  expect([bad.code, bad.err.includes("week")]).toEqual([6, true]);
});

const GET_REST =
  "id: trest001\ntext: Ship the pricing page\ndescription: Line one\nsection: the_rest\norder: 1\ndone: false\ndone_at: -\nassignee: u_2\n" +
  "tags: pricing,web\ntoday: false\none_thing: false\nadded_on: 2026-10-07\ndelegated_to: -\ndelegated_at: -\n" +
  "subtask: s0000001\topen\tu_1\ttoday\tDraft copy\nsubtask: s0000002\topen\t-\t-\tReview\n";

test("AC13 task get: piped golden, tty block, 404 without credentials hint", async () => {
  expect((await run1(["task", "get", "trest001"])).out).toBe(GET_REST);
  const b = (await run1(["task", "get", "trest001"], true)).out;
  expect(b).toContain("assignee   Mia Mate (user)");
  expect(b).toContain("tags       pricing, web");
  expect(b).toContain("\n\ndescription:\n  Line one\n\nsubtasks:\n  [ ] s0000001  Draft copy  (Abe Owner (user))\n  [ ] s0000002  Review");
  expect((await run1(["task", "get", "tdone001"], true)).out).toContain("status     done, 6h ago");
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  await Bun.write(join(home, ".config/olympus/credentials.json"), JSON.stringify({ host: fake.url, token: TOKENS.owner, org: "acme" }));
  const run2 = async (a: string[]) => { let err = ""; const code = await run(a, { env: { OLYMPUS_HOST: fake.url }, home, stdin: async () => "", out: () => {}, err: (s) => { err += s; }, now: () => NOW }); return { code, err }; };
  const nf = await run2(["task", "get", "nope"]);
  expect([nf.code, nf.err.includes("credentials.json")]).toEqual([3, false]);
  expect((await run2(["tasks", "--org", "zzz"])).err).not.toContain("credentials.json");
  fake.state.requests.length = 0;
  const h = await run2(["people"]);
  expect(h.code).toBe(0);
});

test("AC14 hostile server strings never reach stdout, piped or tty", async () => {
  const t = fake.state.tasks.acme!["2026-10-05"]!.tasks[0]!;
  Object.assign(t, { text: `a\tb\nc${EVIL}`, description: `d\ne${EVIL}`, tags: [EVIL, "t\tg"], section: EVIL, assignee: { id: EVIL, name: EVIL, kind: EVIL } });
  t.subtasks = [{ id: EVIL, text: `s\n${EVIL}`, done: false, assignee: { id: EVIL, name: EVIL, kind: EVIL }, today: true, order: 0 }];
  for (const tty of [false, true]) {
    for (const a of [["tasks"], ["task", "get", "tstar001"]]) {
      const r = await run1(a, tty);
      expect(r.code).toBe(0);
      noCtl(r.out);
    }
  }
  const piped = (await run1(["tasks"])).out.split("\n");
  expect(piped[0]!.split("\t")).toHaveLength(7);
  expect(piped[1]!.split("\t")).toHaveLength(7);
  fake.state.next = { status: 200, body: { data: [{ id: EVIL, kind: EVIL, name: EVIL, email: EVIL, me: true }] } };
  noCtl((await run1(["people"])).out);
  fake.state.next = { status: 200, body: { data: [{ id: EVIL, kind: EVIL, name: EVIL, email: EVIL, me: true }] } };
  noCtl((await run1(["people"], true)).out);
  fake.state.next = { status: 200, body: { data: { week: EVIL, current: false, version: 1, me: "u_1", tasks: [] } } };
  noCtl((await run1(["tasks"], true)).out);
});

test("AC14b stderr is cleaned in plain mode, untouched with --json", async () => {
  const body = { error: { code: "invalid", message: `m${EVIL}`, details: { fields: { [`k${EVIL}`]: [`v${EVIL}`], one_thing: `o${EVIL}` } } } };
  for (const tty of [false, true]) {
    fake.state.next = { status: 422, body };
    const r = await run1(["tasks"], tty);
    expect(r.code).toBe(6);
    noCtl(r.err);
    expect(r.err).toContain("one_thing: o");
  }
  fake.state.next = { status: 422, body };
  expect(JSON.parse((await run1(["tasks", "--json"])).err)).toEqual(body);
});

test("AC15 help lists the family; unknown --who/flag guard; token never printed", async () => {
  const h = (await run1(["--help"])).out;
  for (const w of ["people", "tasks", "task get", "sub add", "sub done", "sub delete", "star <id>"]) expect(h).toContain(w);
  const set = [["people"], ["tasks"], ["task", "list"], ["task", "get", "tstar001"]];
  const resp: [number, unknown][] = [[401, { error: { code: "unauthorized", message: "no" } }], [404, { error: { code: "not_found", message: "Not found" } }],
    [422, { error: { code: "invalid", message: "bad", details: { fields: { week: ["bad"] } } } }], [503, { error: { code: "unavailable", message: "down" } }]];
  for (const a of set) for (const [status, body] of resp) for (const tty of [false, true]) for (const j of [false, true]) {
    fake.state.next = { status, body };
    const r = await run1([...a, ...(j ? ["--json"] : [])], tty);
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).not.toContain(TOKENS.owner);
  }
});
