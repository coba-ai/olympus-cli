import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { seedBriefings, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
const NOW = Date.parse("2026-10-12T14:00:00Z");
const DAY = "2026-10-12";
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  delete fake.state.machine;
  fake.state.today = DAY;
  fake.state.now = () => NOW;
  fake.state.briefings = seedBriefings(DAY);
});

async function cli(args: string[], o: { token?: string; tty?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "";
  const code = await run([...args, "--org", "acme"], {
    env: { OLYMPUS_HOST: fake.url, OLYMPUS_API_KEY: o.token ?? TOKENS.owner }, home, stdin: async () => "",
    out: (s) => { out += s; }, err: (s) => { err += s; }, now: () => NOW, tty: o.tty ?? false,
  });
  return { code, out, err };
}
const reqs = () => fake.state.requests;
const last = () => reqs()[reqs().length - 1]!;
const EVIL = "x\x1b]52;c;ZZ\x07\x9by";
const noCtl = (s: string) => expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s.replace(/\n/g, ""))).toBe(false);
const mine = () => fake.state.briefings.acme!.u_1!;
const put = (b: Record<string, unknown>, day = DAY) => { mine()[day] = { day, session_id: null, requested_at: null, document: null, ...b }; };
const ERR = (status: number, code: string, details?: unknown) => ({ status, body: { error: { code, message: "m", details } } });

test("reads today's briefing, a named day, and sends no body", async () => {
  expect((await cli(["briefing"])).code).toBe(0);
  expect(last().method).toBe("GET");
  expect(last().path).toBe("/api/v1/orgs/acme/briefings/today");
  await cli(["briefing", "--day", "2026-10-11"]);
  expect(last().path).toBe("/api/v1/orgs/acme/briefings/2026-10-11");
});

test("requesting posts to today without a body; a repeat returns the same row", async () => {
  delete mine()[DAY];
  const a = await cli(["briefing", "--request"]);
  expect(a.code).toBe(0);
  expect(last().method).toBe("POST");
  expect(last().path).toBe("/api/v1/orgs/acme/briefings/today");
  expect(last().body ?? null).toBeNull();
  const b = await cli(["briefing", "--request", "--json"]);
  expect(JSON.parse(b.out).data.state).toBe("pending");
  expect(a.out).toContain("state: pending\n");
});

test("ready: piped golden", async () => {
  expect((await cli(["briefing"])).out).toBe(
    `day: ${DAY}\nstate: ready\nsession_id: 101\nrequested_at: ${DAY}T07:00:00Z\n` +
    "document.headline: A quiet day with two things to decide\n" +
    "document.summary: Two meetings are on the calendar. The pricing review is the one that needs preparation.\n" +
    "document.items.0.title: Pricing review\ndocument.items.0.detail: Bring the draft tiers.\n" +
    "document.items.1.title: Inbox\ndocument.items.1.detail: Nothing urgent is waiting.\n");
});

test("ready: TTY golden", async () => {
  expect((await cli(["briefing"], { tty: true })).out).toBe(
    `Briefing for ${DAY}\n\n` +
    "headline  A quiet day with two things to decide\n" +
    "summary   Two meetings are on the calendar.\n          The pricing review is the one that needs preparation.\n\n" +
    "items:\n  - Pricing review  Bring the draft tiers.\n  - Inbox  Nothing urgent is waiting.\n");
});

test("none, pending and failed: piped and TTY", async () => {
  delete mine()[DAY];
  expect((await cli(["briefing"])).out).toBe(`day: ${DAY}\nstate: none\nsession_id: -\nrequested_at: -\n`);
  expect((await cli(["briefing"], { tty: true })).out).toBe(`No briefing for ${DAY}.\nAsk for one: olympus briefing --request\n`);
  expect((await cli(["briefing", "--day", "2026-01-01"], { tty: true })).out).toBe("No briefing for 2026-01-01.\n");

  put({ state: "pending", session_id: "55", requested_at: "2026-10-12T13:50:00Z" });
  expect((await cli(["briefing"])).out).toBe(`day: ${DAY}\nstate: pending\nsession_id: 55\nrequested_at: 2026-10-12T13:50:00Z\n`);
  expect((await cli(["briefing"], { tty: true })).out).toBe(`Your briefing for ${DAY} is being written (asked 10m ago). Check again in a few minutes.\n`);
  expect((await cli(["briefing", "--request"], { tty: true })).out).toBe(`Asked your agent to write your briefing for ${DAY}. Check back in a few minutes: olympus briefing\n`);

  put({ state: "failed" });
  expect((await cli(["briefing"])).out).toBe(`day: ${DAY}\nstate: failed\nsession_id: -\nrequested_at: -\n`);
  expect((await cli(["briefing"], { tty: true })).out).toBe(`The briefing for ${DAY} could not be written.\nAsk for one: olympus briefing --request\n`);
  expect((await cli(["briefing", "--day", DAY], { tty: true })).out).toBe(`The briefing for ${DAY} could not be written.\n`);
});

test("an unknown state prints as-is, with the document when there is one", async () => {
  put({ state: "archived", document: { note: "kept" } });
  expect((await cli(["briefing"])).out).toBe(`day: ${DAY}\nstate: archived\nsession_id: -\nrequested_at: -\ndocument.note: kept\n`);
  expect((await cli(["briefing"], { tty: true })).out).toBe(`Briefing for ${DAY}: archived\n\nnote  kept\n`);
  put({ state: "archived" });
  expect((await cli(["briefing"], { tty: true })).out).toBe(`Briefing for ${DAY}: archived\n`);
});

test("odd documents render without throwing", async () => {
  put({ state: "ready", document: { n: 3, ok: false, gone: null, empty_list: [], empty_obj: {}, nested: { a: { b: "deep" }, c: 1 }, rows: [{ t: "x", k: null }, "plain", 7, [1], { z: { y: 1 } }], text: "a\nb" } });
  const p = await cli(["briefing"]);
  expect(p.code).toBe(0);
  expect(p.out).toBe(
    `day: ${DAY}\nstate: ready\nsession_id: -\nrequested_at: -\n` +
    "document.n: 3\ndocument.ok: false\ndocument.gone: -\ndocument.empty_list: -\ndocument.empty_obj: -\ndocument.nested.a.b: deep\ndocument.nested.c: 1\n" +
    "document.rows.0.t: x\ndocument.rows.0.k: -\ndocument.rows.1: plain\ndocument.rows.2: 7\ndocument.rows.3.0: 1\ndocument.rows.4.z.y: 1\ndocument.text: a b\n");
  const t = await cli(["briefing"], { tty: true });
  expect(t.code).toBe(0);
  expect(t.out).toBe(
    `Briefing for ${DAY}\n\nn     3\nok    false\ngone  -\ntext  a\n      b\n\n` +
    "empty list: -\n\nempty obj: -\n\nnested:\n  c: 1\n\nrows:\n  - x  -\n  - plain\n  - 7\n  - -\n  - -\n");
  for (const doc of ["just text", 5, ["a", { b: 1 }], [], {}, true]) {
    put({ state: "ready", document: doc });
    for (const tty of [false, true]) expect((await cli(["briefing"], { tty })).code).toBe(0);
  }
  put({ state: "ready", document: "just text" });
  expect((await cli(["briefing"])).out).toContain("\ndocument: just text\n");
  put({ state: "ready", document: [] });
  expect((await cli(["briefing"])).out).toContain("\ndocument: -\n");
});

test("hostile strings in keys and values never reach the terminal", async () => {
  put({ state: `ready`, session_id: EVIL, requested_at: EVIL, document: { [EVIL]: EVIL, list: [EVIL, { [EVIL]: EVIL }], [`k${EVIL}`]: [{ [EVIL]: EVIL }] } });
  for (const tty of [false, true]) {
    const r = await cli(["briefing"], { tty });
    expect(r.code).toBe(0);
    noCtl(r.out);
    expect(r.out).toContain("x]52;c;ZZy");
  }
  put({ state: EVIL, document: { a: "b\nc\x1b[2J" } });
  for (const tty of [false, true]) noCtl((await cli(["briefing"], { tty })).out);
  put({ state: "pending", requested_at: EVIL });
  noCtl((await cli(["briefing"], { tty: true })).out);
});

test("--json prints the body as-is", async () => {
  const r = await cli(["briefing", "--json"], { tty: true });
  expect(JSON.parse(r.out)).toEqual({ data: mine()[DAY] });
  expect(r.out).toBe(JSON.stringify(JSON.parse(r.out)) + "\n");
});

test("server errors map to exit codes", async () => {
  const mate = { token: TOKENS.teammate };
  expect((await cli(["briefing", "--request"], mate)).code).toBe(6);
  expect((await cli(["briefing", "--request"], mate)).err).toContain("error:");
  fake.state.machine = "no_agent";
  expect((await cli(["briefing", "--request"])).code).toBe(6);
  fake.state.machine = "none";
  expect((await cli(["briefing", "--request"])).code).toBe(5);
  delete fake.state.machine;
  const bad = await cli(["briefing", "--day", "nope"]);
  expect(bad.code).toBe(6);
  expect(bad.err).toContain("day: is not a valid date");
  fake.state.next = ERR(503, "machine_not_ready");
  expect((await cli(["briefing"])).code).toBe(5);
  const j = await cli(["briefing", "--request", "--json"], mate);
  expect(j.out).toBe("");
});

test("usage errors exit 1 with zero requests", async () => {
  for (const a of [["--request", "--day", DAY], ["--no-request"], ["--day", ""], ["--day", ".."], ["extra"], ["--week", "x"], ["--session", "1"], ["--all"]]) {
    reqs().length = 0;
    const r = await cli(["briefing", ...a]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(reqs().length).toBe(0);
  }
});

test("token sweep: every state x error x tty x json never prints the token", async () => {
  const T = TOKENS.owner;
  const nexts = [ERR(401, "unauthorized"), ERR(404, "not_found"), ERR(409, "briefing_not_set_up"), ERR(422, "invalid", { fields: { day: ["bad"] } }), ERR(503, "machine_not_ready")];
  for (const tty of [false, true])
    for (const json of [[], ["--json"]])
      for (const args of [[], ["--request"], ["--day", DAY]])
        for (const next of nexts) {
          fake.state.next = next as any;
          const r = await cli(["briefing", ...args, ...json], { tty });
          expect(r.code).not.toBe(0);
          expect(r.out + r.err).not.toContain(T);
        }
}, 60_000);
