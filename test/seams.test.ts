import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, create, CliError, fail, idempotencyKey } from "../src/core";
import { run } from "../src/cli";
import { seedCrm, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
const NOW = Date.parse("2026-10-12T14:00:00Z");
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  delete fake.state.onRequest;
  fake.state.now = () => NOW;
  fake.state.crm = seedCrm();
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

test("negated booleans are named as typed, with zero requests", async () => {
  for (const [args, msg] of [
    [["task", "get", "t1", "--no-archived"], "unknown option '--no-archived' for task get"],
    [["day", "list", "--no-draft"], "unknown option '--no-draft' for day list"],
    [["whoami", "--no-mine"], "unknown option '--no-mine'"],
    [["subscription", "create", "--name", "n", "--url", "https://x.test", "--event", "*", "--no-active"], "unknown option '--no-active' for subscription create"],
  ] as const) {
    const r = await cli([...args], { env: owner });
    expect(r.code).toBe(1);
    expect(r.err).toBe(`error: ${msg}\n`);
    expect(reqs().length).toBe(0);
  }
});

test("flags are reported in the order typed", async () => {
  const r = await cli(["task", "get", "t1", "--archived", "--no-mine"], { env: owner });
  expect(r.err).toBe("error: unknown option '--archived' for task get\n");
});

test("api headers: absent by default, sent verbatim when given", async () => {
  const seen: (string | null)[] = [];
  const srv = Bun.serve({ port: 0, fetch: (req) => { seen.push(req.headers.get("idempotency-key")); return Response.json({}); } });
  try {
    const call = api(`http://127.0.0.1:${srv.port}`, "t");
    await call("POST", "/x", {});
    await call("POST", "/x", {}, undefined, { "Idempotency-Key": "k-1" });
    expect(seen).toEqual([null, "k-1"]);
  } finally {
    srv.stop(true);
  }
});

test("idempotencyKey", () => {
  const a = idempotencyKey(), b = idempotencyKey();
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a).not.toBe(b);
  for (const ok of ["a", "A_b.c:d-9", "x".repeat(128)]) expect(idempotencyKey(ok)).toBe(ok);
  for (const bad of ["", "x".repeat(129), "a b", "a\n", "é", "a/b"])
    expect(() => idempotencyKey(bad)).toThrow("--idempotency-key must be 1-128 characters from A-Z a-z 0-9 _ . : -");
});

const HINT = "To retry with the same key, run the same command with --idempotency-key K9";
async function failing(status: number | "network", tty: boolean, json: boolean) {
  let call;
  if (status === "network") call = api("http://127.0.0.1:1", "t");
  else {
    fake.state.next = { status, body: { error: { code: "c", message: "boom", details: { saved: true, fields: { a: ["b"] } } } } };
    call = api(fake.url, TOKENS.owner);
  }
  let err = "";
  try {
    await create(call, "/orgs/acme/crm/deals", { name: "n" }, "K9");
    throw new Error("expected failure");
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    const code = fail({ env: {}, home: "", stdin: async () => "", out() {}, err: (s) => { err += s; }, tty }, json, e as CliError);
    return { code, err, e: e as CliError };
  }
}

test("create sends the key; hint only on exit 5, terminal, not --json", async () => {
  const t = await failing(503, true, false);
  expect(last().path).toBe("/api/v1/orgs/acme/crm/deals");
  expect(t.code).toBe(5);
  expect(t.err.trimEnd().split("\n").at(-1)).toBe(HINT);
  expect(t.err).toContain("  a: b\n");
  expect((await failing(503, false, false)).err).not.toContain("--idempotency-key");
  const j = await failing(503, true, true);
  expect(j.err).toBe(JSON.stringify(j.e.body) + "\n");
  const n = await failing("network", true, false);
  expect(n.err.trimEnd().split("\n").at(-1)).toBe(HINT);
});

test("other exits never get the hint", async () => {
  for (const s of [400, 401, 403, 404, 422]) {
    const r = await failing(s, true, false);
    expect(r.code).not.toBe(5);
    expect(r.err).not.toContain("--idempotency-key");
  }
});

test("stage and currency: last wins as strings, except under crm pipeline", async () => {
  const r = await cli(["crm", "deal", "add", "N", "--currency", "EUR", "--currency", "USD", "--stage", "bogus", "--stage", "st_lead", "--org", "acme"], { env: owner });
  expect(r.code).not.toBe(1); // the fake may refuse the values (exit 6); only the request body is asserted
  expect(last().body).toEqual({ name: "N", currency: "USD", stage: "st_lead" });
  await cli(["crm", "deal", "update", "d_renewal", "--currency", "X", "--org", "acme"], { env: owner });
  expect(last().body).toMatchObject({ currency: "X" });
  expect(typeof (last().body as any).currency).toBe("string");
}, 60_000);

test("--no-stage and --no-currency are rejected by the parser", async () => {
  for (const f of ["--no-stage", "--no-currency"]) {
    const r = await cli(["crm", "deals", f, "--org", "acme"], { env: owner });
    expect(r.code).toBe(1);
    expect(r.err).toBe(`error: Unknown option '${f}'\n`);
    expect(reqs().length).toBe(0);
  }
});
