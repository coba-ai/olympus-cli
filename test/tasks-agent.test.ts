import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import type { Io } from "../src/core";
import { taskPlan } from "../src/tasks";
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
  fake.state.days = {};
  fake.state.breakdowns = {};
  delete fake.state.breakdownSteps;
  delete fake.state.onRequest;
});

async function cli(args: string[], o: { env?: Record<string, string>; tty?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "";
  let clock = NOW; // breakdown polls: each sleep moves the clock instead of waiting
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, ...o.env }, home, stdin: async () => "",
    out: (s) => { out += s; }, err: (s) => { err += s; }, now: () => clock, tty: o.tty ?? false, sleep: async (ms) => { clock += ms; },
  });
  return { code, out, err };
}
const owner = { OLYMPUS_API_KEY: TOKENS.owner };
const reqs = () => fake.state.requests;
const last = () => reqs()[reqs().length - 1]!;
const run1 = (args: string[], tty = false) => cli([...args, "--org", "acme"], { env: owner, tty });
const noCtl = (s: string) => expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s.replace(/\n$/, "").replace(/\n/g, ""))).toBe(false);
const EVIL = "x\x1b]52;c;ZZ\x07\x9by";
const SID = "w[0-9a-z]{14}";
const err = (status: number, code: string, message = "m", details?: unknown) => ({ status, body: { error: { code, message, details } } });
const BD = /^\/api\/v1\/orgs\/acme\/breakdowns\/bd_[0-9a-z]{20}$/;
// Answers every breakdown status read with `data` (the handle filled in from the path).
const onGet = (data: (h: string) => Record<string, unknown>) => {
  fake.state.onRequest = (r) => {
    if (r.method === "GET" && r.path.includes("/breakdowns/")) fake.state.next = { status: 200, body: { data: { id: r.path.split("/").pop(), ...data(r.path.split("/").pop()!) } } };
  };
};
const done = (added: unknown[], agent: unknown = "Hermes") => onGet(() => ({ status: "succeeded", task_id: "tback001", agent, task: {}, added_ids: [], added }));

test("AC9 delegate: request, piped golden, TTY sentence, json body", async () => {
  const r = await run1(["task", "delegate", "tback001"]);
  expect(r.code).toBe(0);
  expect(last().method).toBe("POST");
  expect(last().path).toBe("/api/v1/orgs/acme/tasks/tback001/delegate");
  expect(last().body).toEqual({});
  expect(r.out).toMatch(new RegExp(`^agent: hermes\\nsession: ${SID}\\ntitle: -\\nurl: ${fake.url}/acme/sessions/${SID}\\n$`));
  await run1(["task", "delegate", "tback001", "--to", "hera", "--week", "2026-10-05"]);
  expect(last().body).toEqual({ agent: "hera" });
  expect(last().search).toBe("?week=2026-10-05");
  const t = await run1(["task", "delegate", "tback001", "--to", "hera"], true);
  expect(t.out).toMatch(new RegExp(`^Delegated task tback001 to hera\\.\\nSession: ${fake.url}/acme/sessions/${SID}\\n$`));
  fake.state.next = { status: 201, body: { data: { task: {}, session: { id: "w1", title: "Plan it", agent: "Hermes", url: "https://x/y" } } } };
  expect((await run1(["task", "delegate", "tback001"], true)).out).toBe("Delegated task tback001 to Hermes.\nTitle: Plan it\nSession: https://x/y\n");
  fake.state.next = { status: 201, body: { data: { task: {}, session: { id: "w1", title: "Plan it", agent: "Hermes", url: "https://x/y" } } } };
  expect((await run1(["task", "delegate", "tback001"])).out).toBe("agent: Hermes\nsession: w1\ntitle: Plan it\nurl: https://x/y\n");
  const jr = await run1(["task", "delegate", "tback001", "--json"]);
  const body = JSON.parse(jr.out);
  expect(jr.out).toBe(JSON.stringify(body) + "\n");
  expect(body.data.session.agent).toBe("hermes");
});

test("AC10 breakdown: one start, polled to the committed result; piped golden, TTY, 0/1/2 subtasks, json", async () => {
  const r = await run1(["task", "breakdown", "tback001"]);
  expect(r.code).toBe(0);
  expect(reqs()[0]!.method).toBe("POST");
  expect(reqs()[0]!.path).toBe("/api/v1/orgs/acme/tasks/tback001/breakdowns");
  expect(reqs()[0]!.body).toEqual({});
  expect(reqs().slice(1).map((q) => q.method)).toEqual(["GET", "GET", "GET"]);
  for (const q of reqs().slice(1)) expect([q.path.match(BD) !== null, q.search]).toEqual([true, ""]);
  expect(r.out).toMatch(/^agent: hermes\nadded: s[0-9a-z]{7}\tFirst step\nadded: s[0-9a-z]{7}\tSecond step\n$/);
  reqs().length = 0;
  fake.state.breakdowns = {};
  await run1(["task", "breakdown", "tback001", "--agent", "hera", "--week", "2026-10-05"]);
  expect(reqs()[0]!.body).toEqual({ agent: "hera" });
  expect(reqs()[0]!.search).toBe("?week=2026-10-05");
  expect(reqs().slice(1).every((q) => q.search === "")).toBe(true);
  fake.state.breakdowns = {};
  const t = await run1(["task", "breakdown", "tback001"], true);
  expect(t.out).toMatch(/^hermes added 2 subtasks to task tback001:\n  s[0-9a-z]{7}  First step\n  s[0-9a-z]{7}  Second step\n$/);
  done([{ id: "s1", text: "Only" }]);
  expect((await run1(["task", "breakdown", "tback001"], true)).out).toBe("Hermes added 1 subtask to task tback001:\n  s1  Only\n");
  expect((await run1(["task", "breakdown", "tback001"])).out).toBe("agent: Hermes\nadded: s1\tOnly\n");
  done([]);
  expect((await run1(["task", "breakdown", "tback001"], true)).out).toBe("Hermes added no subtasks to task tback001.\n");
  expect((await run1(["task", "breakdown", "tback001"])).out).toBe("agent: Hermes\n");
  done([], null);
  expect((await run1(["task", "breakdown", "tback001"], true)).out).toBe("The agent added no subtasks to task tback001.\n");
  delete fake.state.onRequest;
  fake.state.breakdowns = {};
  const jr = await run1(["task", "breakdown", "tback001", "--json"]);
  expect(jr.out).toBe(JSON.stringify(JSON.parse(jr.out)) + "\n");
  expect(JSON.parse(jr.out).data).toMatchObject({ status: "succeeded", task_id: "tback001", agent: "hermes" });
  expect(reqs().some((q) => q.path.endsWith("/breakdown"))).toBe(false); // never the synchronous route
});

test("AC11 the start uses the default per-call timeout; status reads pass a bounded one", async () => {
  const io = { tty: false, out: () => {}, err: () => {}, sleep: async () => {} } as unknown as Io;
  const seen: Record<string, unknown[][]> = {};
  const stub = (name: string) => async (...a: unknown[]) => {
    (seen[name] ??= []).push(a);
    if (a[0] === "GET" && String(a[1]).includes("/breakdowns/")) return { data: { id: "bd_x", status: "succeeded", added: [] } };
    return { data: { id: "bd_x", status: "queued", session: {}, added: [], tags: [] } };
  };
  const org = async () => "acme";
  const go = async (name: string, pos: string[]) => taskPlan(pos, {}, io, false, () => NOW)(stub(name) as any, org);
  await go("breakdown", ["task", "breakdown", "t1"]);
  await go("delegate", ["task", "delegate", "t1"]);
  await go("get", ["task", "get", "t1"]);
  expect(seen.breakdown!.map((a) => a.slice(0, 2))).toEqual([["POST", "/orgs/acme/tasks/t1/breakdowns"], ["GET", "/orgs/acme/breakdowns/bd_x"]]);
  expect(seen.breakdown![0]).toHaveLength(3);
  expect(seen.breakdown![1]![3]).toBe(30_000);
  expect(seen.delegate![0]).toHaveLength(3);
  expect(seen.get![0]).toHaveLength(2);
});

test("AC12 progress line only on a TTY without --json", async () => {
  const started = (who: string) => new RegExp(`^Asking ${who} to break down task tback001\\.\\.\\.\\nStarted breakdown bd_[0-9a-z]{20}; waiting up to 300s\\.\\.\\.\\n$`);
  expect((await run1(["task", "breakdown", "tback001"], true)).err).toMatch(started("the agent"));
  fake.state.breakdowns = {};
  expect((await run1(["task", "breakdown", "tback001", "--agent", "hera"], true)).err).toMatch(started("hera"));
  expect((await run1(["task", "breakdown", "tback001", "--json"], true)).err).toBe("");
  expect((await run1(["task", "breakdown", "tback001"])).err).toBe("");
  expect((await run1(["task", "breakdown", "tback001", "--json"])).err).toBe("");
  const e = await run1(["task", "breakdown", "tback001", "--agent", EVIL], true);
  expect(e.err).not.toContain("\x1b");
  noCtl(e.err);
});

test("AC13 errors: exit codes, cleaning, json stderr, no creds hint", async () => {
  onGet(() => ({ status: "failed", task_id: "tback001", error: { code: "agent_failed", message: EVIL } }));
  const a = await run1(["task", "breakdown", "tback001"]);
  expect(a.code).toBe(5);
  expect(a.err).toMatch(/^error: /);
  noCtl(a.err);
  expect(a.err).not.toContain("\x1b");
  expect(a.out).toBe("");
  const aj = await run1(["task", "breakdown", "tback001", "--json"]);
  expect(aj.code).toBe(5);
  const body = JSON.parse(aj.err);
  expect(body.error.code).toBe("agent_failed");
  expect(body.error.message.startsWith(EVIL)).toBe(true);
  expect(body.error.details).toEqual({ breakdown_id: expect.stringMatching(/^bd_/), org: "acme" });
  delete fake.state.onRequest;
  fake.state.next = err(503, "machine_not_ready", "later");
  expect((await run1(["task", "delegate", "tback001"])).code).toBe(5);
  fake.state.next = err(422, "invalid", "bad", { fields: { agent: ["is paused"] } });
  const p = await run1(["task", "delegate", "tback001", "--to", "hera"]);
  expect(p.code).toBe(6);
  expect(p.err).toContain("agent: is paused");
  fake.state.next = err(422, "invalid", "bad", { fields: { subtasks: ["too many"] } });
  const s = await run1(["task", "breakdown", "tback001"]);
  expect(s.code).toBe(6);
  expect(s.err).toContain("subtasks: too many");
  for (const c of ["delegate", "breakdown"]) {
    const r = await run1(["task", c, "tnope001"]);
    expect(r.code).toBe(3);
    expect(r.err).not.toContain("credentials.json");
  }
});

test("AC14 usage errors: exit 1, zero requests, with or without a token", async () => {
  const bad = [
    ["task", "delegate"], ["task", "delegate", "a", "b"], ["task", "breakdown"], ["task", "breakdown", "a", "b"],
    ["task", "delegate", ".."], ["task", "delegate", "."], ["task", "delegate", ""],
    ["task", "breakdown", ".."], ["task", "breakdown", "."], ["task", "breakdown", ""],
    ["task", "delegate", "tback001", "--agent", "hermes"], ["task", "breakdown", "tback001", "--to", "hermes"],
    ["task", "delegate", "tback001", "--text", "x"], ["task", "breakdown", "tback001", "--today"], ["task", "delegate", "tback001", "--yes"],
    ["whoami", "--to", "x"],
  ];
  for (const a of bad) {
    for (const env of [owner, {}]) {
      const r = await cli([...a, "--org", "acme"], { env });
      expect(r.code).toBe(1);
    }
  }
  expect(reqs()).toHaveLength(0);
  const w = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "x", "--json"], { env: owner });
  expect(w.code).toBe(0);
});

test("AC15 hostile server strings never reach stdout", async () => {
  const session = { id: EVIL, title: EVIL, agent: EVIL, url: EVIL };
  for (const tty of [false, true]) {
    fake.state.next = { status: 201, body: { data: { task: {}, session } } };
    const d = await run1(["task", "delegate", "tback001"], tty);
    done([{ id: EVIL, text: EVIL }], EVIL);
    const b = await run1(["task", "breakdown", "tback001"], tty);
    delete fake.state.onRequest;
    for (const r of [d, b]) {
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("\x1b");
      expect(r.out).not.toContain("\x9b");
      noCtl(r.out);
    }
  }
});

test("AC15 token sweep: delegate and breakdown", async () => {
  const T = TOKENS.owner;
  const nexts = [
    err(401, "unauthorized"), err(403, "forbidden"), err(404, "not_found"), err(422, "invalid", "bad", { fields: { agent: ["blank"] } }),
    err(502, "agent_failed"), err(503, "machine_not_ready"),
  ];
  let failures = 0, total = 0;
  for (const tty of [false, true])
    for (const json of [[], ["--json"]])
      for (const c of ["delegate", "breakdown"])
        for (const next of nexts) {
          fake.state.next = next as any;
          const r = await cli(["task", c, "tback001", "--org", "acme", ...json], { env: { OLYMPUS_API_KEY: T }, tty });
          expect(r.out).not.toContain(T);
          expect(r.err).not.toContain(T);
          total++;
          if (r.code !== 0) failures++;
          if (next.status === 403) expect(r.code).toBe(4);
        }
  expect(failures).toBe(total);
});
