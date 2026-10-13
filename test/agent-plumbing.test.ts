import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  delete fake.state.onRequest;
});

async function cli(args: string[], signal?: AbortSignal) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "";
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, OLYMPUS_API_KEY: TOKENS.owner }, home, stdin: async () => "",
    out: (s) => { out += s; }, err: (s) => { err += s; }, signal,
  });
  return { code, out, err };
}

test("409 codes that are the caller's to fix exit 6; transient ones stay 5", async () => {
  for (const [status, code, exit] of [
    [409, "conflict", 6], [409, "crm_not_set_up", 6], [409, "no_agent", 6], [409, "session_closed", 6], [409, "briefing_not_set_up", 6],
    [409, "busy", 5], [409, "something_else", 5], [503, "machine_not_ready", 5],
  ] as const) {
    fake.state.next = { status, body: { error: { code, message: "m" } } };
    const r = await cli(["whoami"]);
    expect([code, r.code]).toEqual([code, exit]);
    expect(r.err).toStartWith("error: m");
  }
  fake.state.next = { status: 409, body: "not json" } as any;
  expect((await cli(["whoami"])).code).toBe(5);
});

test("usage lists the agent commands and keeps the exit line", async () => {
  const r = await cli(["-h"]);
  expect(r.out).toContain("  ask AGENT TEXT|- [--session ID] [--timeout SECONDS] [--no-wait]   (exit 1 turn failed, 5 timeout, 6 no agent or session closed)\n");
  expect(r.out).toContain("  sessions [--closed | --all] [--agent SLUG] [--page N]   session get <id> [--after MSG_ID] | session close <id>\n");
  expect(r.out).toContain("  briefing [--day YYYY-MM-DD] [--request]   version | --version\nglobal flags:");
  expect(r.out).toContain("exit: 0 ok, 1 usage, 2 auth, 3 not found, 4 forbidden, 5 server/network, 6 invalid or conflict, 130 cancelled\n");
});

test("the new flags are accepted by the parser but refused by commands that do not take them", async () => {
  for (const f of ["--timeout 5", "--session s", "--after 1", "--day 2026-10-12", "--closed", "--all", "--request", "--wait", "--no-wait"]) {
    for (const cmd of [["whoami"], ["tasks"], ["day"], ["crm", "pipelines"], ["event-types"]]) {
      const [flag] = f.split(" ");
      const r = await cli([...cmd, ...f.split(" ")]);
      expect([f, r.code]).toEqual([f, 1]);
      expect(r.err).toContain(`unknown option '${flag}'`);
      expect(r.err).not.toContain("Unknown option");
    }
  }
  expect(fake.state.requests.length).toBe(0);
});

test("ask, sessions, session and briefing are dispatched, not unknown commands", async () => {
  const base = "/api/v1/orgs/acme";
  const cases: [string[], string | null][] = [
    [["ask"], null],
    [["sessions", "--closed"], `GET ${base}/sessions?state=closed`],
    [["session", "get", "x"], `GET ${base}/sessions/x`],
    [["briefing", "--request"], `POST ${base}/briefings/today`],
  ];
  for (const [args, hit] of cases) {
    fake.state.requests.length = 0;
    const r = await cli(args);
    expect(r.err).not.toContain("unknown command");
    const seen = fake.state.requests.map((q) => `${q.method} ${q.path}${q.search}`);
    if (hit === null) {
      expect(r.code).toBe(1);
      expect(r.err).toContain("ask needs an agent and TEXT");
      expect(seen).toEqual([]);
    } else {
      expect(seen).toContain(hit);
    }
  }
});

test("an already-aborted io.signal does not break commands that ignore it", async () => {
  const r = await cli(["whoami"], AbortSignal.abort());
  expect(r.code).toBe(0);
});
