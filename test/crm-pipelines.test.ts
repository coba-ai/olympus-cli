import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  fake.state.idempotency = {};
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
const run1 = (args: string[], o: { tty?: boolean; env?: Record<string, string> } = {}) => cli(["crm", ...args, "--org", "acme"], { env: owner, ...o });
const noCtl = (s: string) => expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s.replace(/\n/g, ""))).toBe(false);
const EVIL = "x\x1b]52;c;ZZ\x07\x9by";
const P = "/api/v1/orgs/acme/crm";
const S = () => fake.state.crm.acme!;
const err = (status: number, code: string, message = "m", extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  ({ status, headers, body: { error: { code, message, ...extra } } });
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("AC15 requests: method, path, body, query", async () => {
  const hit = async (a: string[], method: string, path: string, body: unknown, search = "") => {
    const r = await run1(a);
    expect([a.join(" "), r.code]).toEqual([a.join(" "), 0]);
    expect([last().method, last().path, last().body, last().search]).toEqual([method, path, body, search]);
  };
  const D = `${P}/pipelines/p_sales`;
  await hit(["pipelines"], "GET", `${P}/pipelines`, undefined);
  await hit(["pipelines", "--archived"], "GET", `${P}/pipelines`, undefined, "?archived=include");
  await hit(["pipeline", "get", "p_sales"], "GET", D, undefined);
  await hit(["pipeline", "add", "P", "--stage", "a:open"], "POST", `${P}/pipelines`, { name: "P", stages: [{ name: "a", kind: "open" }] });
  await hit(["pipeline", "add", "P", "--stage", "a:open", "--stage", "b:won", "--currency", "USD", "--currency", "EUR"], "POST", `${P}/pipelines`,
    { name: "P", stages: [{ name: "a", kind: "open" }, { name: "b", kind: "won" }], currencies: ["USD", "EUR"] });
  // the kind is passed through unchecked (the server refuses it) and the name keeps earlier colons
  await run1(["pipeline", "add", "P", "--stage", "a:b:weird"]);
  expect(last().body).toEqual({ name: "P", stages: [{ name: "a:b", kind: "weird" }] });
  await hit(["pipeline", "update", "p_sales", "--name", "N"], "PATCH", D, { name: "N" });
  S().pipelines[0]!.version = "v1";
  await hit(["pipeline", "update", "p_sales", "--currency", "USD", "--currency", "EUR", "--version", "v1"], "PATCH", D, { currencies: ["USD", "EUR"], version: "v1" });
  await hit(["pipeline", "update", "p_sales", "--stage", "st_lead=Lead:open", "--stage", "New:won", "--stage", "=A=B:lost", "--stage", "st_x=C=D:open"], "PATCH", D,
    { stages: [{ id: "st_lead", name: "Lead", kind: "open" }, { name: "New", kind: "won" }, { name: "A=B", kind: "lost" }, { id: "st_x", name: "C=D", kind: "open" }] });
  await hit(["pipeline", "update", "p_sales", "--remove", "st_lost:st_lead", "--remove", "a:b:c", "--restore", "st_1", "--restore", "st_2"], "PATCH", D,
    { removals: [{ stage: "st_lost", move_to: "st_lead" }, { stage: "a:b", move_to: "c" }], restores: ["st_1", "st_2"] });
  await hit(["pipeline", "archive", "p_sales"], "POST", `${D}/archive`, { archived: true });
  await hit(["pipeline", "archive", "p_sales", "--undo"], "POST", `${D}/archive`, { archived: false });
  await run1(["pipeline", "get", "a/b"]);
  expect(last().path).toBe(`${P}/pipelines/a%2Fb`);
});

test("AC15 pipeline add sends a v4 Idempotency-Key, different per run; get/update/archive/list send none", async () => {
  await run1(["pipeline", "add", "P", "--stage", "a:open"]);
  const first = last().idem;
  await run1(["pipeline", "add", "P", "--stage", "a:open"]);
  expect(first).toMatch(UUID4);
  expect(last().idem).toMatch(UUID4);
  expect(last().idem).not.toBe(first);
  for (const a of [["pipelines"], ["pipelines", "--archived"], ["pipeline", "get", "p_sales"],
    ["pipeline", "update", "p_sales", "--name", "N"], ["pipeline", "archive", "p_sales"]]) {
    await run1(a);
    expect([a.join(" "), last().idem]).toEqual([a.join(" "), null]);
  }
});

test("AC15 usage errors exit 1 with zero requests", async () => {
  const bad: string[][] = [
    ["pipeline", "add", "P"], ["pipeline", "add", "P", "--stage", "nokind"], ["pipeline", "add", "P", "--stage", ":open"], ["pipeline", "add", "P", "--stage", "a:"],
    ["pipeline", "add", "P", "--stage", "a:open", "--idempotency-key", "bad key"], ["pipeline", "add", "P", "--stage", "a:open", "--idempotency-key", ""],
    ["pipeline", "update", "p_sales"], ["pipeline", "update", "p_sales", "--version", "v1"], ["pipeline", "update", "p_sales", "--stage", "nokind"],
    ["pipeline", "update", "p_sales", "--stage", "id=:open"], ["pipeline", "update", "p_sales", "--remove", "a"], ["pipeline", "update", "p_sales", "--remove", ":b"],
    ["pipeline", "update", "p_sales", "--remove", "a:"],
    ["pipeline", "get", ".."], ["pipeline", "get", "."], ["pipeline", "get", ""],
    ["pipeline", "update", "..", "--name", "x"], ["pipeline", "archive", ".."], ["pipeline", "archive", ""],
    ["pipeline", "get"], ["pipeline", "get", "a", "b"], ["pipeline", "add"], ["pipeline", "bogus", "x"],
    ["pipeline", "get", "p_sales", "--idempotency-key", "k"], ["pipeline", "update", "p_sales", "--name", "x", "--idempotency-key", "k"],
    ["pipeline", "archive", "p_sales", "--idempotency-key", "k"], ["pipelines", "--idempotency-key", "k"],
    ["pipelines", "--stage", "a:open"], ["pipeline", "get", "p_sales", "--archived"], ["pipeline", "archive", "p_sales", "--name", "x"], ["pipeline", "add", "P", "--undo"],
    ["pipeline", "update", "p_sales", "--undo"], ["pipeline", "get", "p_sales", "--name", "x"], ["pipeline", "add", "P", "--stage", "a:open", "--version", "v"],
    ["pipeline", "archive", "p_sales", "--restore", "x"], ["pipeline", "get", "p_sales", "--currency", "USD"],
  ];
  for (const a of bad) {
    reqs().length = 0;
    const r = await cli(["crm", ...a, "--org", "acme"], { env: owner });
    expect([a.join(" "), r.code, reqs().length]).toEqual([a.join(" "), 1, 0]);
  }
  // usage errors surface before credentials are read
  expect((await cli(["crm", "pipeline", "add", "P"], { env: {} })).code).toBe(1);
  expect((await cli(["crm", "pipeline", "add", "P", "--stage", "a:open", "--idempotency-key", "bad key"], { env: {} })).code).toBe(1);
});

test("AC15 messages for the pipeline usage cases", async () => {
  expect((await run1(["pipeline", "add", "P"])).err).toBe("error: crm pipeline add needs at least one --stage\n");
  expect((await run1(["pipeline", "add", "P", "--stage", "x"])).err).toBe("error: --stage must be NAME:KIND\n");
  expect((await run1(["pipeline", "update", "p_sales", "--version", "v"])).err).toBe("error: crm pipeline update needs at least one field to change\n");
});

test("AC15 negated array flags: one pinned behaviour", async () => {
  const r = await run1(["pipeline", "add", "P", "--stage", "a:open", "--no-currency"]);
  // whatever parseArgs does with a negated string option, it must not crash or send a malformed body
  expect([0, 1]).toContain(r.code);
  if (r.code === 0) expect(Array.isArray((last().body as any).currencies) || (last().body as any).currencies === undefined).toBe(true);
});

const seedArchived = () => {
  S().pipelines[0]!.archived_stages = [{ id: "st_old", name: "Old", kind: "lost" }];
  S().pipelines.push({ id: "p_old", name: "Legacy", currencies: [], archived_at: "2026-10-01T00:00:00Z", stages: [{ id: "st_o1", name: "Only", kind: "open", position: 0 }] });
};

test("AC16 piped goldens: detail and the archived list", async () => {
  seedArchived();
  S().pipelines[0]!.version = "v7";
  const g = await run1(["pipeline", "get", "p_sales"]);
  expect(g.out).toBe([
    "id: p_sales", "name: Sales", "currencies: USD", "archived: false", "version: v7",
    "stage: st_lead\topen\tLead", "stage: st_won\twon\tWon", "stage: st_lost\tlost\tLost", "archived_stage: st_old\tlost\tOld", "",
  ].join("\n"));
  const e = await run1(["pipeline", "get", "p_old"]);
  expect(e.out).toContain("currencies: -\narchived: true\n");
  const live = (await run1(["pipelines"])).out;
  expect(live).toBe("p_sales\tpipeline\tUSD\tSales\nst_lead\tstage:p_sales\topen\tLead\nst_won\tstage:p_sales\twon\tWon\nst_lost\tstage:p_sales\tlost\tLost\n");
  const all = (await run1(["pipelines", "--archived"])).out;
  expect(all).toBe(live + "p_old\tpipeline:archived\t-\tLegacy\nst_o1\tstage:p_old\topen\tOnly\n");
});

test("AC16 TTY forms and --json", async () => {
  seedArchived();
  const list = (await run1(["pipelines", "--archived"], { tty: true })).out;
  expect(list).toContain("Legacy (archived)");
  expect(list).not.toContain("Sales (archived)");
  expect((await run1(["pipelines"], { tty: true })).out).not.toContain("Legacy");
  const g = (await run1(["pipeline", "get", "p_sales"], { tty: true })).out;
  for (const s of ["Sales", "USD", "st_lead", "Lead", "archived stages:", "st_old"]) expect(g).toContain(s);
  for (const a of [["pipeline", "get", "p_sales"], ["pipelines", "--archived"], ["pipeline", "archive", "p_sales"], ["pipeline", "update", "p_sales", "--name", "J"]]) {
    const r = await run1([...a, "--json"]);
    const body = JSON.parse(r.out);
    expect(r.out).toBe(JSON.stringify(body) + "\n");
    expect(body.data).toBeDefined();
  }
  const a = await run1(["pipeline", "add", "Fresh", "--stage", "a:open", "--json"]);
  expect(JSON.parse(a.out).data.name).toBe("Fresh");
});

test("AC16 sentences and effects", async () => {
  let r = await run1(["pipeline", "add", "Fresh", "--stage", "a:open", "--stage", "b:won"]);
  const id = S().pipelines.find((p) => p.name === "Fresh")!.id;
  expect(r.out.startsWith(`id: ${id}\nname: Fresh\n`)).toBe(true);
  r = await run1(["pipeline", "add", "Fresh2", "--stage", "a:open"], { tty: true });
  expect(r.out).toMatch(/^Added pipeline p_\w+\.\n\n/);
  r = await run1(["pipeline", "update", "p_sales", "--name", "Renamed"], { tty: true });
  expect(r.out).toMatch(/^Updated pipeline p_sales\.\n\n/);
  expect(S().pipelines[0]!.name).toBe("Renamed");
  r = await run1(["pipeline", "archive", "p_sales"], { tty: true });
  expect(r.out).toMatch(/^Archived pipeline p_sales\.\n\n/);
  expect(S().pipelines[0]!.archived_at).toBeTruthy();
  r = await run1(["pipeline", "archive", "p_sales", "--undo"], { tty: true });
  expect(r.out).toMatch(/^Restored pipeline p_sales\.\n\n/);
  expect(S().pipelines[0]!.archived_at).toBeNull();
  r = await run1(["pipeline", "update", "p_sales", "--stage", "st_lead=Lead:open", "--stage", "st_won=Won:won", "--remove", "st_lost:st_lead"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("archived_stage: st_lost\tlost\tLost");
});

test("AC16 idempotency on add: reused key replays, invalid key refused, hint rules", async () => {
  const add = (extra: string[] = [], o: { tty?: boolean } = {}) => run1(["pipeline", "add", "Once", "--stage", "a:open", "--idempotency-key", "K1", ...extra], o);
  const a = await add();
  const b = await add();
  expect([a.code, b.code]).toEqual([0, 0]);
  expect(last().idem).toBe("K1");
  expect(S().pipelines.filter((p) => p.name === "Once").length).toBe(1);
  expect(b.out).toBe(a.out);
  reqs().length = 0;
  expect((await add(["--idempotency-key", "bad key"])).code).toBe(1);
  expect(reqs().length).toBe(0);
  fake.state.next = err(503, "machine_not_ready", "Starting.", { details: { saved: false } });
  let r = await run1(["pipeline", "add", "Z", "--stage", "a:open", "--idempotency-key", "K2"], { tty: true });
  expect(r.code).toBe(5);
  expect(r.err).toContain("--idempotency-key K2");
  fake.state.next = err(503, "machine_not_ready", "Starting.", { details: { saved: false } });
  r = await run1(["pipeline", "add", "Z", "--stage", "a:open", "--idempotency-key", "K2"]);
  expect([r.code, r.err.includes("--idempotency-key")]).toEqual([5, false]);
  const body = { error: { code: "machine_not_ready", message: "Starting.", details: { saved: false } } };
  fake.state.next = { status: 503, body };
  r = await run1(["pipeline", "add", "Z", "--stage", "a:open", "--json"], { tty: true });
  expect([r.code, r.err]).toEqual([5, JSON.stringify(body) + "\n"]);
});

test("AC16 EVIL control strings never reach stdout", async () => {
  S().pipelines[0] = {
    ...S().pipelines[0]!, id: EVIL, name: EVIL, currencies: [EVIL], version: EVIL, archived_at: "2026-10-01T00:00:00Z",
    stages: [{ id: EVIL, name: EVIL, kind: EVIL }], archived_stages: [{ id: EVIL, name: EVIL, kind: EVIL }],
  };
  for (const tty of [false, true]) {
    for (const a of [["pipelines", "--archived"], ["pipelines"]]) noCtl((await run1(a, { tty })).out);
    for (const a of [["pipeline", "get", EVIL], ["pipeline", "update", EVIL, "--name", "n"], ["pipeline", "archive", EVIL], ["pipeline", "archive", EVIL, "--undo"]]) {
      const r = await run1(a, { tty });
      noCtl(r.out);
      noCtl(r.err);
    }
  }
  fake.state.next = { status: 201, body: { data: { id: EVIL, name: EVIL, stages: [{ id: EVIL, name: EVIL, kind: EVIL }], currencies: [EVIL], archived_stages: [] } } };
  noCtl((await run1(["pipeline", "add", EVIL, "--stage", `${EVIL}:open`], { tty: true })).out);
  fake.state.next = { status: 201, body: { data: { id: EVIL, name: EVIL, stages: [], currencies: [] } } };
  noCtl((await run1(["pipeline", "add", "P", "--stage", "a:open"])).out);
});

test("AC16 token sweep: pipeline commands x error statuses x tty x json never print the token", async () => {
  const T = TOKENS.owner;
  const cmds: string[][] = [
    ["pipelines"], ["pipelines", "--archived"], ["pipeline", "get", "p_sales"], ["pipeline", "add", "P", "--stage", "a:open"],
    ["pipeline", "update", "p_sales", "--name", "y"], ["pipeline", "archive", "p_sales"], ["pipeline", "archive", "p_sales", "--undo"],
  ];
  const nexts = [
    err(401, "unauthorized", "no"), err(404, "not_found", "no"), err(409, "conflict", "no", { details: { current: {} } }),
    err(422, "invalid", "bad", { details: { fields: { name: ["blank"] } } }), err(503, "crm_unavailable", "later", {}, { "Retry-After": "30" }),
  ];
  let failures = 0;
  for (const tty of [false, true])
    for (const json of [[], ["--json"]])
      for (const c of cmds)
        for (const next of nexts) {
          fake.state.next = next as any;
          const r = await cli(["crm", ...c, "--org", "acme", ...json], { env: { OLYMPUS_API_KEY: T }, tty });
          expect(r.out).not.toContain(T);
          expect(r.err).not.toContain(T);
          if (r.code !== 0) failures++;
        }
  expect(failures).toBe(2 * 2 * cmds.length * nexts.length);
}, 60_000);
