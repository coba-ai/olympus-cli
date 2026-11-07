import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { startFake, TOKENS } from "./fake-api";
import type { Io } from "../src/core";

const fake = startFake();
afterAll(() => fake.stop());
const NOW = Date.parse("2026-11-07T14:00:00Z");
const P = "/api/v1/orgs/acme/crm/deals/d_renewal";
const RUNS = "/api/v1/orgs/acme/crons/c1/runs?page=1";

const RUN = {
  id: 7, cron_id: "c1", profile_name: "hermes", state: "ok", trigger: "manual", actor: "Ada",
  started_at: "2026-11-07T12:00:00Z", finished_at: "2026-11-07T12:01:00Z", receipt: { output: "done" }, error: null,
};
const running = (id: number) => ({ ...RUN, id, state: "running", finished_at: null, error: null, receipt: {} });

beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  delete fake.state.onRequest;
});

async function cli(args: string[], o: { env?: Record<string, string>; tty?: boolean; sleep?: Io["sleep"]; now?: () => number; signal?: AbortSignal } = {}) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "";
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, ...o.env }, home, stdin: async () => "",
    out: (s) => { out += s; }, err: (s) => { err += s; }, now: o.now ?? (() => NOW), tty: o.tty ?? false,
    ...(o.sleep ? { sleep: o.sleep } : {}), ...(o.signal ? { signal: o.signal } : {}),
  });
  return { code, out, err };
}

const owner = { OLYMPUS_API_KEY: TOKENS.owner };
const reqs = () => fake.state.requests;
const last = () => reqs()[reqs().length - 1]!;
const auto = (args: string[], o: Parameters<typeof cli>[1] = {}) => cli(["crm", "automation", ...args, "--org", "acme"], { env: owner, ...o });
const err = (status: number, code: string, message = "m", extra: Record<string, unknown> = {}) =>
  ({ status, body: { error: { code, message, ...extra } } });
const ok = (state: string) => ({ status: 200, body: { data: { state } } });

test("requests: method, path, body; a note is never sent", async () => {
  const hit = async (a: string[], path: string, body: unknown) => {
    fake.state.next = path.endsWith("/automation_run")
      ? { status: 202, body: { data: { state: "triggered", run: RUN } } }
      : ok(path.endsWith("pause") ? "paused" : "waiting");
    const r = await auto(a);
    expect([a.join(" "), r.code, r.err]).toEqual([a.join(" "), 0, ""]);
    expect([last().method, last().path, last().body, last().search, last().idem, last().auth]).toEqual([
      "POST", path, body, "", null, `Bearer ${TOKENS.owner}`,
    ]);
    expect(JSON.stringify(last().body)).not.toContain("note");
  };
  await hit(["pause", "d_renewal"], `${P}/automation_pause`, {});
  await hit(["pause", "d_renewal", "--automation", "inbound-emails"], `${P}/automation_pause`, { automation: "inbound-emails" });
  await hit(["pause", "d_renewal", "--all"], `${P}/automation_pause`, { all: true });
  await hit(["resume", "d_renewal"], `${P}/automation_resume`, {});
  await hit(["resume", "d_renewal", "--automation", "a1"], `${P}/automation_resume`, { automation: "a1" });
  await hit(["resume", "d_renewal", "--all"], `${P}/automation_resume`, { all: true });
  await hit(["run", "d_renewal"], `${P}/automation_run`, {});
  await hit(["run", "d_renewal", "--automation", "inbound-emails"], `${P}/automation_run`, { automation: "inbound-emails" });
  const key = "a" + "b".repeat(63);
  await hit(["pause", "d_renewal", "--automation", key], `${P}/automation_pause`, { automation: key });
  await auto(["pause", "a/b"]);
  expect(last().path).toBe("/api/v1/orgs/acme/crm/deals/a%2Fb/automation_pause");
  await auto(["run", "a/b"]);
  expect(last().path).toBe("/api/v1/orgs/acme/crm/deals/a%2Fb/automation_run");
});

test("usage errors exit 1 with zero requests, before credentials", async () => {
  const bad = [
    ["pause"], ["pause", "d_renewal", "extra"], ["resume"], ["run"], ["nope", "d_renewal"],
    ["pause", ".."], ["pause", "."], ["pause", ""], ["run", ".."],
    ["pause", "d_renewal", "--note", "away"], ["resume", "d_renewal", "--note", "x"], ["run", "d_renewal", "--note", "x"],
    ["pause", "d_renewal", "--wait"], ["pause", "d_renewal", "--automation", "k", "--all"],
    ["resume", "d_renewal", "--no-all"], ["run", "d_renewal", "--all"], ["run", "d_renewal", "--no-all"],
    ["run", "d_renewal", "--no-wait"], ["run", "d_renewal", "--timeout", "5"],
    ["run", "d_renewal", "--wait", "--timeout", "0"], ["run", "d_renewal", "--wait", "--timeout", "86401"],
    ["pause", "d_renewal", "--automation", ""], ["pause", "d_renewal", "--automation", "Has Space"],
    ["pause", "d_renewal", "--automation", "-lead"], ["pause", "d_renewal", "--automation", "A"],
    ["pause", "d_renewal", "--automation", "a".repeat(65)],
    ["run", "d_renewal", "--yes"], ["pause", "d_renewal", "--page", "2"],
  ];
  for (const a of bad) {
    reqs().length = 0;
    const r = await auto(a);
    expect([a.join(" "), r.code, reqs().length]).toEqual([a.join(" "), 1, 0]);
  }
  expect((await cli(["crm", "automation", "pause"], { env: {} })).code).toBe(1);
  expect((await cli(["crm", "automation", "pause", "d_renewal", "--note", "x"], { env: {} })).code).toBe(1);
  expect((await auto(["pause", "d_renewal", "--note", "away"])).err).toBe("error: unknown option '--note' for crm automation pause\n");
  expect((await auto(["run", "d_renewal", "--all"])).err).toBe("error: unknown option '--all' for crm automation run\n");
  expect((await auto(["pause", "d_renewal", "--automation", "k", "--all"])).err).toBe("error: --automation and --all cannot be combined\n");
  expect((await auto(["pause", ".."])).err).toBe('error: invalid id: ".."\n');
  expect((await auto(["nope", "d_renewal"])).err).toBe("error: unknown crm command: automation nope d_renewal\n");
  expect((await auto(["run", "d_renewal", "--timeout", "5"])).err).toBe("error: --timeout needs --wait\n");
  expect((await auto(["pause", "d_renewal", "--automation", "A"])).err).toContain("--automation must be");
  const j = await auto(["pause", "d_renewal", "--note", "x", "--json"]);
  expect(JSON.parse(j.err).error.code).toBe("usage");
});

test("piped, TTY and --json for pause, resume, run and a paused cron", async () => {
  fake.state.next = ok("paused");
  expect((await auto(["pause", "d_renewal", "--automation", "inbound-emails"])).out).toBe("state: paused\n");
  fake.state.next = ok("waiting");
  const tty = await auto(["resume", "d_renewal", "--all"], { tty: true });
  expect(tty.out).toMatch(/^Resumed the automation on deal d_renewal\.\n\n/);
  expect(tty.out).toContain("waiting");
  fake.state.next = ok("paused");
  const body = JSON.parse((await auto(["pause", "d_renewal", "--json"])).out);
  expect(body).toEqual({ data: { state: "paused" } });
  fake.state.next = { status: 202, body: { data: { state: "triggered", run: RUN } } };
  const triggered = await auto(["run", "d_renewal"]);
  expect(triggered.out).toBe([
    "id: 7", "cron_id: c1", "profile_name: hermes", "state: ok", "trigger: manual", "actor: Ada",
    "started_at: 2026-11-07T12:00:00Z", "finished_at: 2026-11-07T12:01:00Z", "error: -", "",
  ].join("\n"));
  fake.state.next = { status: 202, body: { data: { state: "triggered", run: RUN } } };
  const rich = await auto(["run", "d_renewal", "--automation", "inbound-emails"], { tty: true });
  expect(rich.out).toMatch(/^Triggered the automation on deal d_renewal\.\n\n/);
  expect(rich.out).toContain("done");
  fake.state.next = { status: 202, body: { data: { state: "triggered", run: RUN } } };
  expect(JSON.parse((await auto(["run", "d_renewal", "--json"])).out).data.run.id).toBe(7);
  reqs().length = 0;
  fake.state.next = { status: 200, body: { data: { state: "cron_paused" } } };
  const held = await auto(["run", "d_renewal", "--wait", "--timeout", "5"]);
  expect(held.out).toBe("state: cron_paused\n");
  expect(reqs().length).toBe(1);
  expect(held.out).not.toContain("olympus crons runs");
});

test("API errors keep the envelope", async () => {
  fake.state.next = err(400, "bad_request", "That deal id or automation key is not valid.");
  let r = await auto(["pause", "d_renewal"]);
  expect(r.code).toBe(6);
  expect(r.err).toContain("not valid");
  fake.state.next = err(403, "forbidden", "You are not allowed to do that.");
  expect((await auto(["resume", "d_renewal"])).code).toBe(4);
  fake.state.next = err(404, "not_found", "Not found");
  expect((await auto(["run", "missing"])).code).toBe(3);
  fake.state.next = err(409, "automation_required", "Name one.");
  r = await auto(["pause", "d_renewal", "--json"]);
  expect(r.code).toBe(5);
  expect(JSON.parse(r.err).error.code).toBe("automation_required");
  fake.state.next = err(409, "invalid_transition", "Not paused.");
  expect((await auto(["resume", "d_renewal"])).code).toBe(5);
  fake.state.next = err(409, "already_running", "That cron is already running.");
  r = await auto(["run", "d_renewal", "--json"]);
  expect(r.code).toBe(5);
  expect(JSON.parse(r.err).error.code).toBe("already_running");
  expect(JSON.parse(r.err).error.details).toBeUndefined();
  fake.state.next = err(409, "not_queued", "The run could not be queued.", { details: { run: { ...RUN, state: "error", error: "queue down" } } });
  r = await auto(["run", "d_renewal", "--json"]);
  expect(r.code).toBe(5);
  expect(JSON.parse(r.err).error.details.run.error).toBe("queue down");
  fake.state.next = err(409, "deal_archived", "The deal is archived.");
  expect((await auto(["pause", "d_renewal"])).code).toBe(5);
  fake.state.next = err(502, "machine_unavailable", "The machine is down.");
  expect((await auto(["pause", "d_renewal"])).code).toBe(5);
  fake.state.next = err(502, "crm_unavailable", "The CRM is down.");
  expect((await auto(["run", "d_renewal"])).code).toBe(5);
  fake.state.next = err(503, "crm_upgrading", "The CRM is upgrading.");
  r = await auto(["resume", "d_renewal"]);
  expect(r.code).toBe(5);
  expect(r.err).toContain("upgrading");
  fake.state.next = { status: 202, body: { data: { state: "triggered" } } };
  r = await auto(["run", "d_renewal", "--json"]);
  expect(r.code).toBe(5);
  expect(JSON.parse(r.err).error.code).toBe("bad_response");
  expect(r.out + r.err).not.toContain(TOKENS.owner);
});

test("run --wait polls GET /crons/:id/runs and stops on a timeout or a dead machine", async () => {
  let clock = NOW;
  const sleeps: number[] = [];
  const sleep: Io["sleep"] = async (ms) => { sleeps.push(ms); clock += ms; };
  const wait = (extra: string[] = []) => {
    clock = NOW;
    sleeps.length = 0;
    reqs().length = 0;
    return auto(["run", "d_renewal", "--wait", "--timeout", "5", ...extra], { sleep, now: () => clock });
  };
  const script = (bodies: { status: number; body: unknown }[]) => {
    fake.state.onRequest = () => {
      const n = bodies.shift();
      if (n) fake.state.next = n;
    };
  };
  const page = (row: object) => ({ status: 200, body: { data: [row], page: 1, per: 10, more: false } });
  script([{ status: 202, body: { data: { state: "triggered", run: RUN } } }]);
  let r = await wait();
  expect([r.code, sleeps.length, reqs().length]).toEqual([0, 0, 1]);
  expect(r.out).toContain("state: ok\n");

  script([
    { status: 202, body: { data: { state: "triggered", run: running(9) } } },
    page(running(9)),
    page({ ...RUN, id: 9 }),
  ]);
  r = await wait();
  expect(r.code).toBe(0);
  expect(reqs().map((q) => `${q.method} ${q.path}${q.search}`)).toEqual([
    `POST ${P}/automation_run`, `GET ${RUNS}`, `GET ${RUNS}`,
  ]);
  expect(r.out).toContain("state: ok\n");

  script([
    { status: 202, body: { data: { state: "triggered", run: running(9) } } },
    page({ ...RUN, id: 9, state: "error", error: "nope" }),
  ]);
  r = await wait(["--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toEqual({ data: { run: { ...RUN, id: 9, state: "error", error: "nope" } } });

  fake.state.onRequest = () => {
    const path = reqs()[reqs().length - 1]!.path;
    fake.state.next = path.endsWith("/automation_run")
      ? { status: 202, body: { data: { state: "triggered", run: running(4) } } }
      : page(running(4));
  };
  r = await wait();
  expect(r.code).toBe(5);
  expect(r.err).toContain("timed out after 5s");
  expect(r.err).toContain("olympus crons runs c1");
  expect(reqs().some((q) => q.path.includes("/crm/"))).toBe(true);
  expect(reqs().filter((q) => q.method === "GET").every((q) => q.path === "/api/v1/orgs/acme/crons/c1/runs")).toBe(true);

  script([
    { status: 202, body: { data: { state: "triggered", run: running(8) } } },
    { status: 503, body: { error: { code: "machine_not_ready", message: "Couldn't reach your agent's machine." } } },
  ]);
  r = await wait();
  expect([r.code, reqs().length]).toEqual([5, 2]);
  expect(r.err).toContain("Couldn't reach your agent's machine.");
});

test("run --wait follows more pages until the receipt is found", async () => {
  let clock = NOW;
  const sleeps: number[] = [];
  const sleep: Io["sleep"] = async (ms) => { sleeps.push(ms); clock += ms; };
  const target = { ...RUN, id: 9 };
  fake.state.onRequest = () => {
    const q = reqs()[reqs().length - 1]!;
    if (q.path.endsWith("/automation_run")) {
      fake.state.next = { status: 202, body: { data: { state: "triggered", run: running(9) } } };
      return;
    }
    fake.state.next = q.search === "?page=2"
      ? { status: 200, body: { data: [target], page: 2, per: 10, more: false } }
      : { status: 200, body: { data: [running(100)], page: 1, per: 10, more: true } };
  };
  const r = await auto(["run", "d_renewal", "--wait", "--timeout", "5"], { sleep, now: () => clock });
  expect(r.code).toBe(0);
  expect(sleeps).toEqual([]);
  expect(r.out).toContain("id: 9\n");
  expect(r.out).toContain("state: ok\n");
  expect(reqs().map((q) => `${q.method} ${q.path}${q.search}`)).toEqual([
    `POST ${P}/automation_run`,
    "GET /api/v1/orgs/acme/crons/c1/runs?page=1",
    "GET /api/v1/orgs/acme/crons/c1/runs?page=2",
  ]);
});

test("run --wait stops when cancelled, and a missing cron id is not a success", async () => {
  const ac = new AbortController();
  fake.state.onRequest = () => {
    fake.state.next = reqs().length === 1
      ? { status: 202, body: { data: { state: "triggered", run: running(5) } } }
      : { status: 200, body: { data: [running(5)], page: 1, per: 10, more: false } };
  };
  const r = await auto(["run", "d_renewal", "--wait", "--timeout", "30"], {
    signal: ac.signal,
    sleep: async () => { ac.abort(); },
    now: () => NOW,
  });
  expect(r.code).toBe(130);
  expect(r.err).toContain("the run was started");
  expect(r.err).toContain("olympus crons runs c1");
  expect(reqs().some((q) => q.method === "POST")).toBe(true);

  const early = new AbortController();
  early.abort();
  reqs().length = 0;
  delete fake.state.onRequest;
  const before = await auto(["run", "d_renewal", "--wait", "--timeout", "5"], { signal: early.signal, now: () => NOW });
  expect(before.code).toBe(130);
  expect(before.err).toContain("the run was not started");
  expect(reqs().some((q) => q.method === "POST")).toBe(false);

  fake.state.next = { status: 202, body: { data: { state: "triggered", run: { ...running(5), cron_id: "" } } } };
  const bad = await auto(["run", "d_renewal", "--wait", "--json"]);
  expect(bad.code).toBe(5);
  expect(JSON.parse(bad.err).error.code).toBe("bad_response");
});

test("help lists the stage automation commands", async () => {
  const r = await cli(["-h"]);
  expect(r.out).toContain("  crm automation pause|resume <deal-id> [--automation KEY | --all] | run <deal-id> [--automation KEY] [--wait] [--timeout SECONDS]\n");
  expect((await cli(["crm", "automation", "pause", "--help"])).code).toBe(0);
});
