import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { startFake, TOKENS } from "./fake-api";
import type { Io } from "../src/core";

const fake = startFake();
afterAll(() => fake.stop());
const NOW = Date.parse("2026-11-07T14:00:00Z");
const P = "/api/v1/orgs/acme/crons";

const RUN = {
  id: 7, cron_id: "c1", profile_name: "hermes", state: "ok", trigger: "manual", actor: "Ada",
  started_at: "2026-11-07T12:00:00Z", finished_at: "2026-11-07T12:01:00Z", receipt: { output: "done" }, error: null,
};
const FAIL = {
  ...RUN, id: 3, state: "error", error: "boom", receipt: {}, finished_at: "2026-11-06T12:01:00Z", started_at: "2026-11-06T12:00:00Z",
};
const CRON = {
  id: "c1", name: "Morning", profile_name: "hermes", schedule: "weekdays at 7:00", state: "live", paused: false, paused_note: null,
  owner: { id: 12, name: "Ada" }, prompt: "Read the board", script: null, last_run_at: "2026-11-07T12:00:00Z", last_result: "ok",
  last_error: null, last_delivery_error: null, latest_receipt: RUN, recent_failures: [FAIL],
};
const running = (id: number) => ({ ...RUN, id, state: "running", finished_at: null, error: null, receipt: {} });

beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  delete fake.state.onRequest;
});

async function cli(args: string[], o: { env?: Record<string, string>; tty?: boolean; stdin?: string; creds?: string; sleep?: Io["sleep"]; now?: () => number; signal?: AbortSignal } = {}) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  if (o.creds !== undefined) {
    await mkdir(join(home, ".config/olympus"), { recursive: true });
    await writeFile(join(home, ".config/olympus/credentials.json"), o.creds);
  }
  let out = "", err = "";
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, ...o.env }, home, stdin: async () => o.stdin ?? "",
    out: (s) => { out += s; }, err: (s) => { err += s; }, now: o.now ?? (() => NOW), tty: o.tty ?? false,
    ...(o.sleep ? { sleep: o.sleep } : {}), ...(o.signal ? { signal: o.signal } : {}),
  });
  return { code, out, err };
}

const owner = { OLYMPUS_API_KEY: TOKENS.owner };
const reqs = () => fake.state.requests;
const last = () => reqs()[reqs().length - 1]!;
const cron = (args: string[], o: Parameters<typeof cli>[1] = {}) => cli(["crons", ...args, "--org", "acme"], { env: owner, ...o });
const err = (status: number, code: string, message = "m", extra: Record<string, unknown> = {}) =>
  ({ status, body: { error: { code, message, ...extra } } });

function answer(r: { method: string; path: string }) {
  if (r.path.endsWith("/runs")) return { status: 200, body: { data: [], page: 1, per: 10, more: false } };
  if (r.path.endsWith("/run")) return { status: 202, body: { data: { run: RUN } } };
  if (r.method === "DELETE") return { status: 204, body: "" };
  const created = r.method === "POST" && r.path.endsWith("/crons");
  return { status: created ? 201 : 200, body: { data: CRON } };
}

test("requests: method, path, body, query, no idempotency key", async () => {
  fake.state.onRequest = (r) => { fake.state.next = answer(r); };
  const hit = async (a: string[], method: string, path: string, body: unknown, search = "") => {
    const r = await cron(a);
    expect([a.join(" "), r.code, r.err]).toEqual([a.join(" "), 0, ""]);
    expect([last().method, last().path, last().body, last().search, last().idem, last().auth]).toEqual([
      method, path, body, search, null, `Bearer ${TOKENS.owner}`,
    ]);
  };
  await hit(["list"], "GET", P, undefined);
  await hit(["get", "c1"], "GET", `${P}/c1`, undefined);
  await hit(["get", "c1", "--page", "3"], "GET", `${P}/c1`, undefined, "?page=3");
  await hit(["create", "--name", "Morning", "--schedule", "0 8 * * *", "--instructions", "Read the board"], "POST", P,
    { name: "Morning", schedule: "0 8 * * *", prompt: "Read the board" });
  await hit(["create", "--name", "Morning", "--schedule", "0 8 * * *", "--instructions", "Read the board", "--profile", "hermes"], "POST", P,
    { name: "Morning", schedule: "0 8 * * *", prompt: "Read the board", profile: "hermes" });
  await hit(["update", "c1", "--name", "Evening"], "PATCH", `${P}/c1`, { name: "Evening" });
  await hit(["update", "c1", "--schedule", "0 9 * * 1", "--instructions", "New", "--script", "echo hi"], "PATCH", `${P}/c1`,
    { schedule: "0 9 * * 1", prompt: "New", script: "echo hi" });
  await hit(["pause", "c1"], "POST", `${P}/c1/pause`, {});
  await hit(["pause", "c1", "--note", "away"], "POST", `${P}/c1/pause`, { note: "away" });
  await hit(["resume", "c1"], "POST", `${P}/c1/resume`, {});
  await hit(["delete", "c1", "--yes"], "DELETE", `${P}/c1`, undefined);
  await hit(["run", "c1"], "POST", `${P}/c1/run`, {});
  await hit(["runs", "c1"], "GET", `${P}/c1/runs`, undefined);
  await hit(["runs", "c1", "--page", "2"], "GET", `${P}/c1/runs`, undefined, "?page=2");
  for (const a of [["get", "a/b"], ["update", "a/b", "--name", "N"], ["delete", "a/b", "--yes"], ["pause", "a/b"], ["resume", "a/b"], ["run", "a/b"], ["runs", "a/b"]]) {
    await cron(a);
    expect(last().path).toContain("/a%2Fb");
  }
});

test("schedule and instructions come from a file or stdin, one trailing newline stripped", async () => {
  fake.state.onRequest = (r) => { fake.state.next = answer(r); };
  const dir = await mkdtemp(join(tmpdir(), "oly-cron-"));
  await writeFile(join(dir, "when.txt"), "0 8 * * 1-5\n");
  await writeFile(join(dir, "what.txt"), "Do the thing\n");
  await writeFile(join(dir, "sh.txt"), "echo hi\n");
  let r = await cron(["create", "--name", "Morning", "--schedule-file", join(dir, "when.txt"), "--instructions-file", join(dir, "what.txt")]);
  expect(r.code).toBe(0);
  expect(last().body).toEqual({ name: "Morning", schedule: "0 8 * * 1-5", prompt: "Do the thing" });
  r = await cron(["create", "--name", "Morning", "--schedule", "daily", "--instructions-file", "-"], { stdin: "from stdin\n" });
  expect(last().body).toEqual({ name: "Morning", schedule: "daily", prompt: "from stdin" });
  r = await cron(["update", "c1", "--script-file", join(dir, "sh.txt"), "--schedule-file", "-"], { stdin: "hourly\n" });
  expect(last().body).toEqual({ script: "echo hi", schedule: "hourly" });
  expect(last().body).not.toHaveProperty("prompt");
});

test("usage errors exit 1 with zero requests, before credentials", async () => {
  const bad = [
    ["list", "extra"], ["get"], ["get", "c1", "x"], ["nope"], ["create"], ["create", "--name", "N"],
    ["create", "--name", "N", "--schedule", "daily"], ["create", "--name", " ", "--schedule", "daily", "--instructions", "x"],
    ["create", "--name", "N", "--schedule", " ", "--instructions", "x"], ["create", "--name", "N", "--schedule", "daily", "--instructions", " "],
    ["create", "--name", "N", "--schedule", "daily", "--instructions", "x", "--schedule-file", "f"],
    ["create", "--name", "N", "--schedule", "daily", "--instructions", "x", "--instructions-file", "f"],
    ["create", "--name", "N", "--schedule-file", "-", "--instructions-file", "-", "--profile", "p"],
    ["create", "--name", "N", "--schedule", "daily", "--instructions", "x", "--script", "echo"],
    ["create", "--name", "N", "--schedule", "daily", "--instructions", "x", "--profile", " "],
    ["update", "c1"], ["update", "c1", "--script", " "], ["update", "c1", "--script-file", "-"],
    ["pause", "c1", "--yes"], ["resume", "c1", "--note", "x"], ["delete", "c1"], ["delete", "c1", "--note", "x"],
    ["run", "c1", "--page", "2"], ["run", "c1", "--no-wait"], ["run", "c1", "--timeout", "5"], ["run", "c1", "--wait", "--timeout", "0"],
    ["run", "c1", "--wait", "--timeout", "86401"], ["run", "c1", "--wait", "--timeout", "soon"],
    ["runs", "c1", "--page", "0"], ["runs", "c1", "--page", "01"], ["get", "c1", "--page", "x"],
    ["get", ".."], ["get", "."], ["get", ""], ["delete", "..", "--yes"], ["run", ".."], ["update", "", "--name", "N"],
    ["list", "--page", "2"], ["list", "--wait"], ["get", "c1", "--name", "N"],
  ];
  for (const a of bad) {
    reqs().length = 0;
    const r = await cron(a);
    expect([a.join(" "), r.code, reqs().length]).toEqual([a.join(" "), 1, 0]);
  }
  expect((await cli(["crons", "create", "--name", "N"], { env: {} })).code).toBe(1);
  expect((await cli(["crons", "delete", "c1"])).code).toBe(1);
  const missing = await cron(["create", "--name", "N", "--schedule-file", join(tmpdir(), "no-such-cron-file"), "--instructions", "x"]);
  expect([missing.code, reqs().length]).toEqual([1, 0]);
  expect((await cron(["delete", "c1"])).err).toBe("error: cron delete needs --yes\n");
  expect((await cron(["create", "--name", "N"])).err).toBe("error: cron create needs --name, --schedule or --schedule-file, and --instructions or --instructions-file\n");
  expect((await cron(["update", "c1"])).err).toBe("error: cron update needs at least one field to change\n");
  expect((await cron(["get", ".."])).err).toBe('error: invalid id: ".."\n');
  expect((await cron(["nope"])).err).toBe("error: unknown cron command: nope\n");
  expect((await cron(["run", "c1", "--timeout", "5"])).err).toBe("error: --timeout needs --wait\n");
  const j = await cron(["delete", "c1", "--json"]);
  expect(JSON.parse(j.err).error.code).toBe("usage");
});

test("piped goldens: list, get, run, runs, delete", async () => {
  const cells = "7\tok\tmanual\tAda\t2026-11-07T12:00:00Z\t2026-11-07T12:01:00Z\t-";
  const fail = "3\terror\tmanual\tAda\t2026-11-06T12:00:00Z\t2026-11-06T12:01:00Z\tboom";
  fake.state.next = { status: 200, body: { data: [CRON] } };
  const list = await cron(["list"]);
  expect(list.out).toBe(`c1\tlive\thermes\t12\t2026-11-07T12:00:00Z\tok\t1\tweekdays at 7:00\tMorning\tRead the board\n`);
  fake.state.next = { status: 200, body: { data: [], page: 1, per: 10, more: false } };
  expect((await cron(["list"])).out).toBe("");
  fake.state.next = { status: 200, body: { data: CRON, runs: [RUN], page: 1, per: 10, more: false } };
  const got = await cron(["get", "c1"]);
  expect(got.out).toBe([
    "id: c1", "name: Morning", "profile_name: hermes", "schedule: weekdays at 7:00", "state: live", "paused: false",
    "paused_note: -", "owner: 12", "prompt: Read the board", "script: -", "last_run_at: 2026-11-07T12:00:00Z", "last_result: ok",
    "last_error: -", "last_delivery_error: -", `latest_receipt: ${cells}`, `failure: ${fail}`, `run: ${cells}`, "",
  ].join("\n"));
  fake.state.next = { status: 202, body: { data: { run: RUN } } };
  const triggered = await cron(["run", "c1"]);
  expect(triggered.out).toBe([
    "id: 7", "cron_id: c1", "profile_name: hermes", "state: ok", "trigger: manual", "actor: Ada",
    "started_at: 2026-11-07T12:00:00Z", "finished_at: 2026-11-07T12:01:00Z", "error: -", "",
  ].join("\n"));
  fake.state.next = { status: 200, body: { data: [RUN, FAIL], page: 2, per: 10, more: true } };
  expect((await cron(["runs", "c1", "--page", "2"])).out).toBe(`${cells}\n${fail}\n`);
  fake.state.next = { status: 204 };
  const del = await cron(["delete", "c1", "--yes"]);
  expect(del.out).toBe("deleted c1\n");
  const evil = { ...CRON, prompt: "x\x1b]52;c;ZZ\x07\x9by", name: "a\tb\nc" };
  fake.state.next = { status: 200, body: { data: [evil] } };
  const safe = await cron(["list"]);
  expect(safe.out).not.toContain("\x1b");
  expect(safe.out).not.toContain("\x9b");
  expect(safe.out.startsWith("c1\tlive\thermes\t")).toBe(true);
});

test("TTY forms and --json", async () => {
  fake.state.next = { status: 200, body: { data: [CRON] } };
  const list = await cron(["list"], { tty: true });
  for (const s of ["Morning", "live", "weekdays at 7:00", "hermes", "Ada", "ok"]) expect(list.out).toContain(s);
  fake.state.next = { status: 200, body: { data: [] } };
  expect((await cron(["list"], { tty: true })).out).toBe("No crons in acme yet.\n");
  fake.state.next = { status: 200, body: { data: CRON, runs: [RUN], page: 1, per: 10, more: true } };
  const detail = await cron(["get", "c1"], { tty: true });
  for (const s of ["Morning", "Read the board", "Ada", "recent failures:", "boom", "runs:", "Next: --page 2"]) expect(detail.out).toContain(s);
  fake.state.next = { status: 201, body: { data: CRON } };
  expect((await cron(["create", "--name", "Morning", "--schedule", "daily", "--instructions", "x"], { tty: true })).out).toMatch(/^Created cron c1\.\n\n/);
  fake.state.next = { status: 200, body: { data: { ...CRON, state: "paused", paused: true, paused_note: "away" } } };
  expect((await cron(["pause", "c1", "--note", "away"], { tty: true })).out).toMatch(/^Paused cron c1\.\n\n/);
  fake.state.next = { status: 202, body: { data: { run: RUN } } };
  const trig = await cron(["run", "c1"], { tty: true });
  expect(trig.out).toMatch(/^Triggered cron c1\.\n\n/);
  expect(trig.out).toContain("done");
  fake.state.next = { status: 200, body: { data: CRON, runs: [], page: 1, per: 10, more: false } };
  const body = JSON.parse((await cron(["get", "c1", "--json"])).out);
  expect(body.data.id).toBe("c1");
  expect(body.data.prompt).toBe("Read the board");
  fake.state.next = { status: 204 };
  expect(JSON.parse((await cron(["delete", "c1", "--yes", "--json"])).out)).toEqual({ data: { id: "c1", deleted: true } });
});

test("role and server errors keep the envelope; a redirect is not followed", async () => {
  fake.state.next = err(403, "forbidden", "Only an owner can do that.");
  let r = await cron(["update", "c1", "--name", "N"]);
  expect([r.code, r.err, reqs().length]).toEqual([4, "error: Only an owner can do that.\n", 1]);
  fake.state.next = err(404, "not_found", "Not found");
  r = await cron(["get", "missing"]);
  expect(r.code).toBe(3);
  fake.state.next = err(422, "invalid", "Validation failed.", { details: { fields: { schedule: ["is not valid"] } } });
  r = await cron(["create", "--name", "N", "--schedule", "nope", "--instructions", "x"]);
  expect(r.code).toBe(6);
  expect(r.err).toContain("schedule: is not valid");
  fake.state.next = err(503, "machine_not_ready", "Couldn't reach your agent's machine.");
  r = await cron(["list"]);
  expect(r.code).toBe(5);
  fake.state.next = err(409, "machine_needs_update", "Your agent's machine needs an update.");
  expect((await cron(["list"])).code).toBe(5);
  fake.state.next = err(409, "already_running", "That cron is already running.");
  r = await cron(["run", "c1", "--json"]);
  expect(r.code).toBe(5);
  expect(JSON.parse(r.err).error.code).toBe("already_running");
  fake.state.next = err(409, "not_queued", "The run could not be queued.", { details: { run: { ...RUN, state: "error", error: "queue down" } } });
  r = await cron(["run", "c1", "--json"]);
  expect(r.code).toBe(5);
  expect(JSON.parse(r.err).error.details.run.error).toBe("queue down");
  fake.state.next = { status: 302, headers: { location: "https://evil.example/steal" }, body: "" };
  reqs().length = 0;
  r = await cron(["list"]);
  expect([r.code, reqs().length]).toEqual([5, 1]);
  expect(r.err).toContain("redirect");
  expect(r.out).toBe("");
  const homeCreds = JSON.stringify({ host: fake.url, token: TOKENS.owner, org: "acme" });
  r = await cli(["crons", "get", "c1"], { creds: homeCreds });
  expect(r.code).toBe(3);
  expect(r.err).not.toContain("credentials.json");
  r = await cli(["crons", "list"], { creds: homeCreds });
  expect(r.code).toBe(3);
  expect(r.err).toContain('org "acme" from credentials.json');
  expect(r.out + r.err).not.toContain(TOKENS.owner);
});

test("run --wait polls until the receipt closes, and stops on a timeout", async () => {
  let clock = NOW;
  const sleeps: number[] = [];
  const sleep: Io["sleep"] = async (ms) => { sleeps.push(ms); clock += ms; };
  const reset = () => { clock = NOW; sleeps.length = 0; reqs().length = 0; };
  const wait = (extra: string[] = [], tty = false) => {
    reset();
    return cron(["run", "c1", "--wait", "--timeout", "5", ...extra], { sleep, now: () => clock, tty });
  };
  const script = (bodies: { status: number; body: unknown }[]) => {
    fake.state.onRequest = () => {
      const n = bodies.shift();
      if (n) fake.state.next = n;
    };
  };
  const page = (run: object) => ({ status: 200, body: { data: [run], page: 1, per: 10, more: false } });
  script([{ status: 202, body: { data: { run: RUN } } }]);
  let r = await wait();
  expect([r.code, sleeps.length, reqs().length]).toEqual([0, 0, 1]);
  expect(r.out).toContain("state: ok\n");

  script([
    { status: 202, body: { data: { run: running(9) } } },
    page(running(9)),
    page({ ...RUN, id: 9 }),
  ]);
  r = await wait();
  expect(r.code).toBe(0);
  expect(sleeps).toEqual([2000]);
  expect(reqs().map((q) => `${q.method} ${q.path}${q.search}`)).toEqual([
    `POST ${P}/c1/run`, `GET ${P}/c1/runs?page=1`, `GET ${P}/c1/runs?page=1`,
  ]);
  expect(r.out).toContain("state: ok\n");

  script([
    { status: 202, body: { data: { run: running(9) } } },
    page({ ...RUN, id: 9, state: "error", error: "nope" }),
  ]);
  r = await wait(["--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).data.run).toMatchObject({ id: 9, state: "error", error: "nope" });

  fake.state.onRequest = () => {
    const path = reqs()[reqs().length - 1]!.path;
    fake.state.next = path.endsWith("/run")
      ? { status: 202, body: { data: { run: running(4) } } }
      : page(running(4));
  };
  r = await wait([], true);
  expect(r.code).toBe(5);
  expect(r.err).toContain("timed out after 5s");
  expect(r.err).toContain("olympus crons runs c1");
  expect(reqs().filter((q) => q.method === "GET").length).toBe(3);
  expect(sleeps).toEqual([2000, 2000, 1000]);

  script([
    { status: 202, body: { data: { run: running(8) } } },
    { status: 503, body: { error: { code: "machine_not_ready", message: "Couldn't reach your agent's machine." } } },
  ]);
  r = await wait();
  expect([r.code, reqs().length, sleeps.length]).toEqual([5, 2, 0]);
  expect(r.err).toContain("Couldn't reach your agent's machine.");

  script([
    { status: 202, body: { data: { run: running(8) } } },
    { status: 500, body: { error: { code: "server_error", message: "down" } } },
    page({ ...RUN, id: 8 }),
  ]);
  r = await wait();
  expect(r.code).toBe(0);
  expect(reqs().filter((q) => q.method === "GET").length).toBe(2);
});

test("run --wait stops when cancelled, and a missing receipt is not a success", async () => {
  const ac = new AbortController();
  fake.state.onRequest = () => {
    fake.state.next = reqs().length === 1
      ? { status: 202, body: { data: { run: running(5) } } }
      : { status: 200, body: { data: [running(5)], page: 1, per: 10, more: false } };
  };
  const r = await cron(["run", "c1", "--wait", "--timeout", "30"], {
    signal: ac.signal,
    sleep: async () => { ac.abort(); },
    now: () => NOW,
  });
  expect(r.code).toBe(130);
  expect(r.err).toContain("the run was started");
  expect(reqs().some((q) => q.method === "POST")).toBe(true);
  expect(r.out + r.err).not.toContain("login cancelled");

  const early = new AbortController();
  early.abort();
  reqs().length = 0;
  delete fake.state.onRequest;
  const before = await cron(["run", "c1", "--wait", "--timeout", "5"], { signal: early.signal, now: () => NOW });
  expect(before.code).toBe(130);
  expect(before.err).toContain("the run was not started");
  expect(reqs().some((q) => q.method === "POST" && q.path.endsWith("/run"))).toBe(false);

  fake.state.next = { status: 202, body: { data: {} } };
  const bad = await cron(["run", "c1", "--json"]);
  expect(bad.code).toBe(5);
  expect(JSON.parse(bad.err).error.code).toBe("bad_response");
});

test("help lists the cron commands", async () => {
  const r = await cli(["-h"]);
  expect(r.out).toContain("  crons list | get <id> [--page N] | runs <id> [--page N]\n");
  expect(r.out).toContain("  crons pause <id> [--note T] | resume <id> | delete <id> --yes | run <id> [--wait] [--timeout SECONDS]\n");
  expect((await cli(["crons", "list", "--help"])).code).toBe(0);
});
