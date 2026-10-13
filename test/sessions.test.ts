import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { appendMessage, seedSessions, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
const NOW = Date.parse("2026-10-12T14:00:00Z");
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  delete fake.state.onRequest;
  fake.state.now = () => NOW;
  fake.state.sessions = seedSessions(NOW);
  fake.state.turns = [];
  fake.state.machine = undefined;
  fake.state.sessionsPer = undefined;
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
const go = (args: string[], tty = false) => cli([...args, "--org", "acme"], { env: owner, tty });
const noCtl = (s: string) => expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s.replace(/\n/g, ""))).toBe(false);
const EVIL = "a\x1b[31mb\x1b]0;t\x07c\x9b2Jd\re\nf\tg";
const P = "/api/v1/orgs/acme/sessions";

test("sessions builds its query from the flags", async () => {
  for (const [args, search] of [
    [[], ""], [["--closed"], "?state=closed"], [["--all"], "?state=all"], [["--agent", "hermes"], "?agent=hermes"], [["--page", "2"], "?page=2"],
    [["--all", "--agent", "hermes", "--page", "1"], "?state=all&agent=hermes&page=1"],
  ] as [string[], string][]) {
    reqs().length = 0;
    expect((await go(["sessions", ...args])).code).toBe(0);
    expect([last().method, last().path, last().search]).toEqual(["GET", P, search]);
  }
});

test("sessions and session usage errors send nothing", async () => {
  for (const args of [
    ["sessions", "--closed", "--all"], ["sessions", "--page", "0"], ["sessions", "--page", "x"], ["sessions", "--page", "-1"], ["sessions", "--no-closed"], ["sessions", "--no-all"],
    ["sessions", "extra"], ["sessions", "--after", "1"], ["sessions", "--day", "2026-10-12"],
    ["session"], ["session", "get"], ["session", "get", "1", "2"], ["session", "nope", "1"], ["session", "close"], ["session", "close", "1", "2"],
    ["session", "get", "1", "--closed"], ["session", "close", "1", "--after", "2"], ["session", "get", "1", "--no-after"],
    ["session", "get", ".."], ["session", "get", "."], ["session", "get", ""], ["session", "close", ".."], ["session", "close", "."], ["session", "close", ""],
  ]) {
    const r = await go(args);
    expect([args.join(" "), r.code]).toEqual([args.join(" "), 1]);
    expect(reqs().length).toBe(0);
  }
});

test("sessions piped lines, newest activity first", async () => {
  const r = await go(["sessions", "--all"]);
  expect(r.out).toBe(
    "102\topen\thermes\tidle\t-\t-\n" +
    "101\topen\thermes\tidle\t2026-10-12T13:31:00.000Z\tPricing questions\n" +
    "103\tclosed\thermes\tidle\t2026-10-11T23:00:00.000Z\tOld thread\n");
  expect((await go(["sessions"])).out).toBe(r.out.split("\n").slice(0, 2).join("\n") + "\n");
  expect((await go(["sessions", "--closed"])).out).toBe(r.out.split("\n")[2] + "\n");
});

test("sessions on a terminal", async () => {
  const r = await go(["sessions"], true);
  expect(r.out).toBe(
    "ID   AGENT   STATE  TURN  LAST ACTIVITY  TITLE\n" +
    "102  Hermes  open   idle  10m ago        -\n" +
    "101  Hermes  open   idle  29m ago        Pricing questions\n");
  fake.state.sessionsPer = 1;
  expect((await go(["sessions", "--all"], true)).out).toEndWith("\n\nPage 1 · showing 1 of 3. Next: --page 2\n");
  expect((await go(["sessions", "--all", "--page", "2"], true)).out).toEndWith("\n\nPage 2 · showing 1 of 3. Next: --page 3\n");
  expect((await go(["sessions", "--all", "--page", "3"], true)).out).toEndWith("\n\nPage 3 · showing 1 of 3.\n");
});

test("sessions empty lists", async () => {
  fake.state.sessions = { acme: [] };
  for (const [args, text] of [[[], "No open sessions."], [["--closed"], "No closed sessions."], [["--all"], "No sessions."]] as [string[], string][]) {
    expect((await go(["sessions", ...args], true)).out).toBe(text + "\n");
    expect((await go(["sessions", ...args])).out).toBe("");
  }
});

test("sessions --json is the body as-is", async () => {
  fake.state.next = { status: 200, body: { data: { sessions: [], total: 0, page: 1, per: 20, extra: [1] } } };
  expect((await go(["sessions", "--json"], true)).out).toBe('{"data":{"sessions":[],"total":0,"page":1,"per":20,"extra":[1]}}\n');
});

test("session get piped lines", async () => {
  const r = await go(["session", "get", "101"]);
  expect([last().method, last().path, last().search]).toEqual(["GET", `${P}/101`, ""]);
  expect(r.out).toBe("user u_1: What should we charge for the pro plan?\nassistant: Start from the plan you sell most and test a 10% step up.\n");
  expect((await go(["session", "get", "102"])).out).toBe("");
});

test("session get --after passes the id and prints only newer messages", async () => {
  const r = await go(["session", "get", "101", "--after", "1001"]);
  expect(last().search).toBe("?after=1001");
  expect(r.out).toBe("assistant: Start from the plan you sell most and test a 10% step up.\n");
  expect((await go(["session", "get", "101", "--after", "1002"])).out).toBe("");
});

test("session get on a terminal", async () => {
  expect((await go(["session", "get", "101"], true)).out).toBe(
    "id             101\n" +
    "agent          Hermes (hermes)\n" +
    "title          Pricing questions\n" +
    "state          open\n" +
    "turn           idle\n" +
    "opened by      Abe Owner\n" +
    "created        1h ago (2026-10-12 13:00 UTC)\n" +
    "last activity  29m ago (2026-10-12 13:31 UTC)\n\n" +
    "Abe Owner · 30m ago\n  What should we charge for the pro plan?\n\n" +
    "Hermes · 29m ago\n  Start from the plan you sell most and test a 10% step up.\n");
  expect((await go(["session", "get", "102"], true)).out).toEndWith("last activity  never\n\nNo messages yet.\n");
  expect((await go(["session", "get", "101", "--after", "1002"], true)).out).toEndWith("\n\nNo new messages.\n");
});

test("session get shows the turn, a working note and the message cap", async () => {
  const turn = async (t: object) => { fake.state.sessions.acme![1]!.turn = t; return (await go(["session", "get", "102"], true)).out; };
  const queued = await turn({ state: "queued", started_at: null, error: null });
  expect(queued).toContain("turn           queued\n");
  expect(queued).toEndWith("\n\nNo messages yet.\n\nHermes is still working; run this again to see the reply.\n");
  expect(await turn({ state: "running", started_at: "2026-10-12T13:55:00Z", error: null })).toContain("turn           running, started 5m ago\n");
  const failed = await turn({ state: "failed", started_at: null, error: "The model is not connected." });
  expect(failed).toContain("turn           failed: The model is not connected.\n");
  expect(failed).not.toContain("still working");
  expect(await turn({ state: "thinking", started_at: null, error: null })).toContain("still working");
  fake.state.sessions.acme![1]!.turn = { state: "idle", started_at: null, error: null };
  for (let i = 0; i < 210; i++) appendMessage(fake.state, "acme", "102", "user", `m${i}`);
  const big = (await go(["session", "get", "102"], true)).out;
  expect(big).toContain("\n\nShowing the last 200 messages.\n\n");
  expect(big).not.toContain("  m9\n");
  expect((await go(["session", "get", "102", "--after", "1004"], true)).out).not.toContain("Showing the last");
});

test("session get --json is the body as-is", async () => {
  const body = { data: { session: { id: "9" }, messages: [], turn: { state: "idle" }, extra: 1 } };
  fake.state.next = { status: 200, body };
  expect((await go(["session", "get", "9", "--json"], true)).out).toBe(JSON.stringify(body) + "\n");
});

test("session get errors map to exit codes", async () => {
  const bad = await go(["session", "get", "101", "--after", "nope"]);
  expect(bad.code).toBe(6);
  expect(bad.err).toContain("  after: is not a message of this session");
  fake.state.next = { status: 503, body: { error: { code: "machine_not_ready", message: "The agent machine is not ready." } } };
  expect((await go(["session", "get", "101"])).code).toBe(5);
  const other = await go(["session", "get", "201"]);
  expect(other.code).toBe(3);
  expect(other.err).not.toContain("credentials.json");
  expect((await cli(["session", "get", "201", "--org", "acme"], { env: { OLYMPUS_API_KEY: TOKENS.teammate } })).code).toBe(0);
});

test("session close", async () => {
  const r = await go(["session", "close", "101"]);
  expect([last().method, last().path]).toEqual(["DELETE", `${P}/101`]);
  expect(r.out).toBe("closed 101\n");
  expect(fake.state.sessions.acme![0]!.state).toBe("closed");
  expect((await go(["session", "close", "102"], true)).out).toBe("Closed session 102. Its transcript is kept.\n");
  const j = await go(["session", "close", "102", "--json"]);
  expect(JSON.parse(j.out).data).toMatchObject({ id: "102", state: "closed" });
  expect(j.out.trimEnd().split("\n").length).toBe(1);
  expect((await go(["session", "close", "999"])).code).toBe(3);
});

test("hostile text never reaches the terminal raw", async () => {
  const evil = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, " ");
  const s = fake.state.sessions.acme![1]!;
  Object.assign(s, { title: EVIL, agent: { slug: EVIL, name: EVIL }, opened_by: { id: "u_1", name: EVIL }, turn: { state: "failed", started_at: null, error: EVIL } });
  appendMessage(fake.state, "acme", "102", "user", EVIL, { id: EVIL, name: EVIL });
  appendMessage(fake.state, "acme", "102", "assistant", EVIL);
  s.last_activity_at = EVIL;
  for (const args of [["sessions"], ["session", "get", "102"]]) for (const tty of [false, true]) {
    const r = await go(args, tty);
    expect([args.join(" "), tty, r.code]).toEqual([args.join(" "), tty, 0]);
    noCtl(r.out);
    expect(r.out).toContain("a[31mb");
  }
  const piped = (await go(["session", "get", "102"])).out;
  expect(piped).toBe(`user ${evil(EVIL).replace(/\n/g, " ")}: ${evil(EVIL).replace(/\n/g, " ")}\nassistant: ${evil(EVIL).replace(/\n/g, " ")}\n`);
  const tty = (await go(["session", "get", "102"], true)).out;
  expect(tty).toContain("  a[31mb]0;tc2Jde\n  f g\n");
  const lines = (await go(["sessions"])).out.trimEnd().split("\n");
  expect(lines.every((l) => l.split("\t").length === 6)).toBe(true);
  s.state = "open";
  fake.state.next = { status: 409, body: { error: { code: "session_closed", message: EVIL } } };
  const e = await go(["session", "get", "102"], true);
  expect(e.code).toBe(6);
  noCtl(e.err);
  fake.state.next = { status: 409, body: { error: { code: "session_closed", message: "x" } } };
  const c = await cli(["session", "close", "a\x1bb", "--org", "acme"], { env: owner, tty: true });
  noCtl(c.out + c.err);
});

test("the token never appears in output", async () => {
  for (const status of [401, 404, 409, 422, 503]) for (const args of [["sessions"], ["session", "get", "101"], ["session", "close", "101"]]) for (const flag of [[], ["--json"]]) {
    fake.state.next = { status, body: { error: { code: status === 409 ? "session_closed" : "x", message: "bad" } } };
    const r = await go([...args, ...flag], true);
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).not.toContain(TOKENS.owner);
    expect(last().auth).toBe(`Bearer ${TOKENS.owner}`);
  }
}, 60_000);
