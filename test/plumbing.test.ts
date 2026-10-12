import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { exitForStatus } from "../src/core";
import { startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
});

async function cli(args: string[], env: Record<string, string> = { OLYMPUS_API_KEY: TOKENS.owner }) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "";
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, ...env }, home, stdin: async () => "",
    out: (s) => { out += s; }, err: (s) => { err += s; }, tty: false,
  });
  return { code, out, err };
}
const inject = (status: number, body: unknown, headers?: Record<string, string>) => { fake.state.next = { status, body, headers }; };
const eb = (code: string, message: string) => ({ error: { code, message } });

test("AC1 exitForStatus maps 409 by code", async () => {
  expect(exitForStatus(409)).toBe(5);
  expect(exitForStatus(409, "conflict")).toBe(6);
  expect(exitForStatus(409, "crm_not_set_up")).toBe(6);
  expect(exitForStatus(409, "machine_needs_update")).toBe(5);
  for (const [status, body, want] of [
    [409, eb("conflict", "x"), 6], [409, eb("crm_not_set_up", "x"), 6], [409, eb("machine_needs_update", "x"), 5],
    [409, eb("other", "x"), 5], [409, "not json", 5], [503, eb("crm_unavailable", "x"), 5],
  ] as const) {
    inject(status, body);
    expect((await cli(["whoami"])).code).toBe(want);
  }
});

test("AC2 messages", async () => {
  inject(409, eb("conflict", "stale\x1b[2J"));
  const r = await cli(["whoami"]);
  expect(r.err).toBe("error: stale[2J (it changed since you read it; read it again and retry)\n");
  expect(r.err).toContain("(it changed since you read it; read it again and retry)\n");
  expect(r.err).not.toContain("\x1b");

  const body = eb("conflict", "stale");
  inject(409, body);
  expect((await cli(["whoami", "--json"])).err).toBe(JSON.stringify(body) + "\n");

  inject(409, eb("machine_needs_update", "update it"));
  expect((await cli(["whoami"])).err).toBe("error: update it\n");

  inject(503, eb("crm_unavailable", "down"), { "Retry-After": "30" });
  expect((await cli(["whoami"])).err).toBe("error: down (retry after 30s)\n");

  inject(422, { error: { code: "invalid", message: "bad", details: { fields: { q: ["blank"] } } } });
  expect((await cli(["whoami"])).err).toBe("error: bad\n  q: blank\n");
});

test("AC3 legacy-only flag guard", async () => {
  for (const args of [["whoami", "--event", "x"], ["webhook", "list", "--q", "x"], ["agents", "list", "--tag", "x"], ["org", "list", "--week", "d"], ["logout", "--url", "u"]]) {
    fake.state.requests.length = 0;
    const r = await cli(args, {});
    expect(r.code).toBe(1);
    expect(r.err).toContain(`unknown option '${args.find((a) => a.startsWith("--"))}'`);
    expect(fake.state.requests.length).toBe(0);
  }
  expect((await cli(["webhook", "list", "--yes"])).code).toBe(0);
});

test("help shows new usage lines", async () => {
  const r = await cli(["-h"]);
  expect(r.out).toContain("  crm pipelines | crm tags");
  expect(r.out).toContain("  subscription list | get <id> | delete <id> --yes | rotate-secret <id> | ping <id>\n");
  expect(r.out).toContain("  event-types   (event names for --event)\n");
  expect(r.out).toContain("6 invalid or conflict");
});

test("crm / subscription dispatch reaches the module", async () => {
  expect((await cli(["crm", "nope"])).err).toContain("unknown crm command");
  expect((await cli(["subscription", "nope"])).err).toContain("unknown subscription command");
});
