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
});

async function cli(args: string[], o: { env?: Record<string, string>; tty?: boolean; stdin?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "", reads = 0;
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, ...o.env }, home, stdin: async () => { reads++; return o.stdin ?? ""; },
    out: (s) => { out += s; }, err: (s) => { err += s; }, now: () => NOW, tty: o.tty ?? false,
  });
  return { code, out, err, reads };
}
const owner = { OLYMPUS_API_KEY: TOKENS.owner };
const reqs = () => fake.state.requests;
const last = () => reqs()[reqs().length - 1]!;
const run1 = (args: string[], o: { tty?: boolean; stdin?: string; env?: Record<string, string> } = {}) =>
  cli(["crm", ...args, "--org", "acme"], { env: owner, ...o });
const noCtl = (s: string) => expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s.replace(/\n$/, "").replace(/\n/g, ""))).toBe(false);
const EVIL = "x\x1b]52;c;ZZ\x07\x9by";
const P = "/api/v1/orgs/acme/crm";
const S = () => fake.state.crm.acme!;
const err = (status: number, code: string, message = "m", extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  ({ status, headers, body: { error: { code, message, ...extra } } });

test("AC10 deal add bodies", async () => {
  const r = await run1(["deal", "add", "Big deal"]);
  expect(r.code).toBe(0);
  expect([last().method, last().path]).toEqual(["POST", `${P}/deals`]);
  expect(last().body).toEqual({ name: "Big deal" });
  await run1(["deal", "add", "N", "--pipeline", "p_sales", "--stage", "st_lead", "--amount", "99.5", "--currency", "USD", "--next", "call", "--owner", "me", "--company", "c_initech", "--person", "pe_dana"]);
  expect(last().body).toEqual({ name: "N", pipeline: "p_sales", stage: "st_lead", amount: "99.5", currency: "USD", next_action: "call", owner: "me", company: { id: "c_initech" }, person: { id: "pe_dana" } });
  await run1(["deal", "add", "N", "--new-company", "Acme Co", "--new-person", "Eve", "--person-email", "eve@x.test"]);
  expect(last().body).toEqual({ name: "N", company: { name: "Acme Co" }, person: { full_name: "Eve", email: "eve@x.test" } });
  await run1(["deal", "add", "N", "--new-person", "Eve"]);
  expect(last().body).toEqual({ name: "N", person: { full_name: "Eve" } });
});

test("AC10 deal update, move, owner, company, person, note, task, archive", async () => {
  const D = `${P}/deals/d_renewal`;
  const hit = async (a: string[], method: string, path: string, body: unknown) => {
    const r = await run1(["deal", ...a]);
    expect([a.join(" "), r.code]).toEqual([a.join(" "), 0]);
    expect([last().method, last().path, last().body]).toEqual([method, path, body]);
    return r;
  };
  S().deals[0]!.version = "vv";
  await hit(["update", "d_renewal", "--name", "N", "--amount", "5", "--currency", "EUR", "--next", "x", "--lost-reason", "price", "--tag", "a", "--tag", "b", "--version", "vv"], "PATCH", D,
    { name: "N", amount: "5", currency: "EUR", next_action: "x", lost_reason: "price", tags: ["a", "b"], version: "vv" });
  await hit(["update", "d_renewal", "--no-tags"], "PATCH", D, { tags: [] });
  await hit(["update", "d_renewal", "--next", ""], "PATCH", D, { next_action: "" });
  await hit(["move", "d_renewal", "st_won"], "POST", `${D}/move`, { stage: "st_won" });
  await hit(["owner", "d_renewal", "a@b.test"], "PUT", `${D}/owner`, { owner: "a@b.test" });
  await hit(["owner", "d_renewal", "me"], "PUT", `${D}/owner`, { owner: "me" });
  await hit(["owner", "d_renewal", "--none"], "PUT", `${D}/owner`, { owner: null });
  await hit(["company", "d_renewal", "c_initech"], "PUT", `${D}/company`, { id: "c_initech" });
  await hit(["company", "d_renewal", "--new", "NewCo"], "PUT", `${D}/company`, { name: "NewCo" });
  await hit(["person", "d_renewal", "pe_dana"], "PUT", `${D}/person`, { id: "pe_dana" });
  await hit(["person", "d_renewal", "--new", "Eve"], "PUT", `${D}/person`, { full_name: "Eve" });
  await hit(["person", "d_renewal", "--new", "Eve", "--email", "e@x"], "PUT", `${D}/person`, { full_name: "Eve", email: "e@x" });
  await hit(["note", "d_renewal", "a - b: multi word"], "POST", `${D}/notes`, { body: "a - b: multi word" });
  await hit(["task", "add", "d_renewal", "Call"], "POST", `${D}/tasks`, { title: "Call" });
  await hit(["task", "add", "d_renewal", "Call", "--due", "2026-10-20", "--assign", "me"], "POST", `${D}/tasks`, { title: "Call", due_at: "2026-10-20", assignee: "me" });
  await hit(["task", "done", "d_renewal", "ct_1"], "PATCH", `${D}/tasks/ct_1`, { done: true });
  await hit(["task", "done", "d_renewal", "ct_1", "--undo"], "PATCH", `${D}/tasks/ct_1`, { done: false });
  await run1(["deal", "task", "done", "d_renewal", "a/b"]);
  expect(last().path).toBe(`${D}/tasks/a%2Fb`);
  await hit(["archive", "d_renewal"], "POST", `${D}/archive`, { archived: true });
  await hit(["archive", "d_renewal", "--undo"], "POST", `${D}/archive`, { archived: false });
  await hit(["archive", "d_renewal", "--no-undo"], "POST", `${D}/archive`, { archived: true });
});

test("AC10 person and company bodies", async () => {
  const hit = async (a: string[], method: string, path: string, body: unknown) => {
    const r = await run1(a);
    expect([a.join(" "), r.code]).toEqual([a.join(" "), 0]);
    expect([last().method, last().path, last().body]).toEqual([method, path, body]);
  };
  await hit(["person", "add", "Eve"], "POST", `${P}/people`, { full_name: "Eve" });
  await hit(["person", "add", "Eve", "--email", "e@x", "--phone", "1", "--job-title", "CTO", "--linkedin-url", "u", "--company", "c_initech"], "POST", `${P}/people`,
    { full_name: "Eve", email: "e@x", phone: "1", job_title: "CTO", linkedin_url: "u", company: { id: "c_initech" } });
  await hit(["person", "add", "Eve", "--new-company", "Zed"], "POST", `${P}/people`, { full_name: "Eve", company: { name: "Zed" } });
  S().people[0]!.version = "v1";
  await hit(["person", "update", "pe_dana", "--name", "D", "--email", "e", "--phone", "p", "--job-title", "j", "--linkedin-url", "l", "--notes", "n", "--tag", "t", "--version", "v1"], "PATCH", `${P}/people/pe_dana`,
    { full_name: "D", email: "e", phone: "p", job_title: "j", linkedin_url: "l", notes: "n", tags: ["t"], version: "v1" });
  await hit(["person", "archive", "pe_dana"], "POST", `${P}/people/pe_dana/archive`, { archived: true });
  await hit(["person", "archive", "pe_dana", "--undo"], "POST", `${P}/people/pe_dana/archive`, { archived: false });
  await hit(["company", "add", "Zed"], "POST", `${P}/companies`, { name: "Zed" });
  await hit(["company", "add", "Zed", "--domain", "d", "--website", "w", "--industry", "i", "--linkedin-url", "l", "--phone", "p", "--city", "c"], "POST", `${P}/companies`,
    { name: "Zed", domain: "d", website: "w", industry: "i", linkedin_url: "l", phone: "p", city: "c" });
  await hit(["company", "update", "c_initech", "--name", "N", "--domain", "d", "--website", "w", "--industry", "i", "--linkedin-url", "l", "--phone", "p", "--city", "c", "--notes", "n", "--no-tags"], "PATCH", `${P}/companies/c_initech`,
    { name: "N", domain: "d", website: "w", industry: "i", linkedin_url: "l", phone: "p", city: "c", notes: "n", tags: [] });
  await hit(["company", "archive", "c_initech"], "POST", `${P}/companies/c_initech/archive`, { archived: true });
});

test("AC10 outputs: piped is the detail form, TTY is the sentence then the block", async () => {
  const tty = async (a: string[]) => (await run1(a, { tty: true })).out;
  const piped = (await run1(["deal", "move", "d_renewal", "st_won"])).out;
  expect(piped).toStartWith("id: d_renewal\nname: Initech renewal\nstatus: won\n");
  expect(await tty(["deal", "move", "d_renewal", "st_won"])).toStartWith("Moved deal d_renewal to Won.\n\nid ");
  expect(await tty(["deal", "add", "Fresh"])).toMatch(/^Added deal d_[0-9a-z]+\.\n\nid /);
  expect(await tty(["deal", "update", "d_renewal", "--name", "Z"])).toStartWith("Updated deal d_renewal.\n\n");
  expect(await tty(["deal", "owner", "d_renewal", "a@b.test"])).toStartWith("Deal d_renewal is now owned by a@b.test.\n\n");
  expect(await tty(["deal", "owner", "d_renewal", "--none"])).toStartWith("Deal d_renewal is now owned by nobody.\n\n");
  expect(await tty(["deal", "company", "d_renewal", "c_initech"])).toStartWith("Linked company Initech to deal d_renewal.\n\n");
  expect(await tty(["deal", "person", "d_renewal", "pe_dana"])).toStartWith("Linked Dana Lee to deal d_renewal.\n\n");
  expect(await tty(["deal", "note", "d_renewal", "hi"])).toStartWith("Added a note to deal d_renewal.\n\n");
  expect(await tty(["deal", "task", "add", "d_renewal", "T"])).toStartWith("Added a task to deal d_renewal.\n\n");
  expect(await tty(["deal", "task", "done", "d_renewal", "ct_1"])).toStartWith("Marked task ct_1 done.\n\n");
  expect(await tty(["deal", "task", "done", "d_renewal", "ct_1", "--undo"])).toStartWith("Marked task ct_1 not done.\n\n");
  expect(await tty(["deal", "archive", "d_renewal"])).toStartWith("Archived deal d_renewal.\n\n");
  expect(await tty(["deal", "archive", "d_renewal", "--undo"])).toStartWith("Restored deal d_renewal.\n\n");
  expect(await tty(["person", "add", "Eve"])).toMatch(/^Added person pe_[0-9a-z]+\.\n\n/);
  expect(await tty(["person", "update", "pe_dana", "--phone", "1"])).toStartWith("Updated person pe_dana.\n\n");
  expect(await tty(["person", "archive", "pe_dana"])).toStartWith("Archived person pe_dana.\n\n");
  expect(await tty(["company", "add", "Zed"])).toMatch(/^Added company c_[0-9a-z]+\.\n\n/);
  expect(await tty(["company", "update", "c_initech", "--city", "X"])).toStartWith("Updated company c_initech.\n\n");
  expect(await tty(["company", "archive", "c_initech", "--undo"])).toStartWith("Restored company c_initech.\n\n");
  const j = await run1(["deal", "archive", "d_renewal", "--json"]);
  expect(JSON.parse(j.out).data.id).toBe("d_renewal");
  expect(j.out.indexOf("\n")).toBe(j.out.length - 1);
});

test("AC11 --add-tag / --remove-tag: a GET then one PATCH with the merged tags and the GET's version", async () => {
  S().deals[0]!.tags = ["a", "b", "c"];
  S().deals[0]!.version = "v-from-get";
  const r = await run1(["deal", "update", "d_renewal", "--add-tag", "z", "--add-tag", "a", "--add-tag", "z", "--remove-tag", "b", "--next", "ring"]);
  expect(r.code).toBe(0);
  expect(reqs().map((q) => q.method)).toEqual(["GET", "PATCH"]);
  expect(reqs()[0]!.path).toBe(`${P}/deals/d_renewal`);
  expect(last().path).toBe(`${P}/deals/d_renewal`);
  expect(last().body).toEqual({ tags: ["a", "c", "z"], next_action: "ring", version: "v-from-get" });
  expect(S().deals[0]!.tags).toEqual(["a", "c", "z"]);
  // --json is exactly the PATCH response
  const j = await run1(["deal", "update", "d_renewal", "--remove-tag", "z", "--json"]);
  expect(JSON.parse(j.out).data.tags).toEqual(["a", "c"]);
  expect(j.out.indexOf("\n")).toBe(j.out.length - 1);
  // removing then adding the same tag keeps it once; exact strings, no case folding
  fake.state.requests.length = 0;
  await run1(["deal", "update", "d_renewal", "--remove-tag", "a", "--add-tag", "a", "--add-tag", "A"]);
  expect(last().body).toMatchObject({ tags: ["c", "a", "A"] });
});

test("AC11 --version V overrides the GET's version; a record without tags or a string version still works", async () => {
  await run1(["person", "update", "pe_dana", "--add-tag", "t", "--version", "mine"]);
  expect(last().body).toEqual({ tags: ["t"], version: "mine" });
  await run1(["company", "update", "c_initech", "--add-tag", "t"]);
  expect(last().body).toMatchObject({ tags: ["t"], version: expect.stringMatching(/^[0-9a-f]{32}$/) });
  fake.state.next = { status: 200, body: { data: { id: "d1", tags: null, version: 7 } } };
  await run1(["deal", "update", "d1", "--add-tag", "x"]);
  expect(reqs().map((q) => q.method).slice(-2)).toEqual(["GET", "PATCH"]);
  expect(last().body).toEqual({ tags: ["x"] });
});

test("AC11 GET 404 stops before the PATCH; PATCH 409 is exit 6 with the hint", async () => {
  const nf = await run1(["deal", "update", "nope", "--add-tag", "x"]);
  expect(nf.code).toBe(3);
  expect(reqs().map((q) => q.method)).toEqual(["GET"]);
  fake.state.requests.length = 0;
  // another writer changes the record between our read and our write
  let bumped = false;
  fake.state.onRequest = async (r) => {
    if (r.method === "PATCH" && !bumped) { bumped = true; S().deals[0]!.version = "someone-else"; }
  };
  const c = await run1(["deal", "update", "d_renewal", "--add-tag", "x"]);
  expect(c.code).toBe(6);
  expect(c.err).toContain("(it changed since you read it; read it again and retry)");
  expect(reqs().map((q) => q.method)).toEqual(["GET", "PATCH"]);
  expect(S().deals[0]!.tags).toEqual(["renewal"]);
  // an explicit --version that is stale is the same conflict
  const s = await run1(["deal", "update", "d_renewal", "--name", "x", "--version", "stale"]);
  expect(s.code).toBe(6);
});

test("AC11 --tag replaces, --no-tags empties, --tags alone is a usage error", async () => {
  await run1(["deal", "update", "d_renewal", "--tag", "x", "--tag", "y"]);
  expect(reqs()).toHaveLength(1);
  expect(last().body).toEqual({ tags: ["x", "y"] });
  await run1(["deal", "update", "d_renewal", "--no-tags"]);
  expect(last().body).toEqual({ tags: [] });
  const n = reqs().length;
  expect((await run1(["deal", "update", "d_renewal", "--tags"])).code).toBe(1);
  expect(reqs()).toHaveLength(n);
});

test("AC12 note TEXT is sent as given; - reads stdin, and only then", async () => {
  const a = await run1(["deal", "note", "d_renewal", "plain text"], { stdin: "SHOULD NOT BE READ" });
  expect(a.reads).toBe(0);
  expect(last().body).toEqual({ body: "plain text" });
  const b = await run1(["deal", "note", "d_renewal", "-"], { stdin: "  line one\n\nline two\n" });
  expect(b.reads).toBe(1);
  expect(last().body).toEqual({ body: "  line one\n\nline two\n" });
  const n = reqs().length;
  for (const stdin of ["", "  \n\t\n"]) {
    const e = await run1(["deal", "note", "d_renewal", "-"], { stdin });
    expect(e.code).toBe(1);
  }
  expect(reqs()).toHaveLength(n);
});

test("AC13 CRM errors map to exit codes and messages", async () => {
  const cur = { current: { id: "d_renewal" } };
  fake.state.next = err(409, "conflict", "Deal changed.", { details: cur });
  let r = await run1(["deal", "move", "d_renewal", "st_won"]);
  expect([r.code, r.err]).toEqual([6, "error: Deal changed. (it changed since you read it; read it again and retry)\n"]);
  fake.state.next = err(409, "conflict", "Deal changed.", { details: cur });
  r = await run1(["deal", "move", "d_renewal", "st_won", "--json"]);
  expect([r.code, JSON.parse(r.err).error.details]).toEqual([6, cur]);
  fake.state.next = err(409, "crm_not_set_up", "CRM is not set up yet.");
  r = await run1(["deals"]);
  expect([r.code, r.err]).toEqual([6, "error: CRM is not set up yet.\n"]);
  fake.state.next = err(409, "machine_needs_update", "Update the machine.");
  r = await run1(["pipelines"]);
  expect([r.code, r.err]).toEqual([5, "error: Update the machine.\n"]);
  fake.state.next = err(503, "crm_unavailable", "CRM is busy.", {}, { "Retry-After": "30" });
  r = await run1(["people"]);
  expect([r.code, r.err]).toEqual([5, "error: CRM is busy. (retry after 30s)\n"]);
  // a teammate may read but not write
  const mate = { OLYMPUS_API_KEY: TOKENS.teammate };
  expect((await run1(["deals"], { env: mate })).code).toBe(0);
  for (const a of [["deal", "add", "N"], ["deal", "move", "d_renewal", "st_won"], ["person", "add", "P"], ["company", "archive", "c_initech"], ["deal", "update", "d_renewal", "--name", "x"]]) {
    r = await run1(a, { env: mate });
    expect([a.join(" "), r.code]).toEqual([a.join(" "), 4]);
  }
  // a missing record is 3 with no credentials.json hint; a missing org on a list keeps it
  for (const a of [["deal", "get", "nope"], ["person", "get", "nope"], ["company", "get", "nope"], ["deal", "move", "nope", "st_won"], ["deal", "task", "done", "d_renewal", "nope"], ["company", "archive", "nope"]]) {
    r = await run1(a);
    expect([a.join(" "), r.code]).toEqual([a.join(" "), 3]);
    expect(r.err).not.toContain("credentials.json");
  }
  // 422 names the field
  r = await run1(["deal", "add", " "]);
  expect(r.code).toBe(6);
  expect(r.err).toContain("name: can't be blank");
  r = await run1(["search", ""]);
  expect(r.code).toBe(1);
});

test("AC13 a 404 on a list keeps the credentials.json hint", async () => {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  await Bun.write(join(home, ".config/olympus/credentials.json"), JSON.stringify({ host: fake.url, token: TOKENS.owner, org: "gone" }));
  let err = "";
  const code = await run(["crm", "deals"], { env: { OLYMPUS_HOST: fake.url }, home, stdin: async () => "", out: () => {}, err: (s) => { err += s; }, now: () => NOW, tty: false });
  expect(code).toBe(3);
  expect(err).toContain('org "gone" from credentials.json');
});

test("AC14 hostile strings in write outputs and errors never reach stdout or stderr as controls", async () => {
  const hostile = { id: EVIL, name: EVIL, owner_email: EVIL, stage: { id: EVIL, name: EVIL }, company: { name: EVIL }, person: { full_name: EVIL }, tasks: [{ id: EVIL }], tags: [EVIL] };
  for (const tty of [false, true])
    for (const a of [["deal", "move", "d1", "s"], ["deal", "owner", "d1", "x"], ["deal", "company", "d1", "c"], ["deal", "person", "d1", "p"], ["deal", "task", "add", "d1", "T"], ["deal", "archive", "d1"], ["deal", "add", "N"]]) {
      fake.state.next = { status: 200, body: { data: hostile } };
      const r = await run1(a, { tty });
      expect(r.code).toBe(0);
      noCtl(r.out);
      expect(r.out).not.toContain("\x1b");
    }
  fake.state.next = err(422, "invalid", EVIL, { details: { fields: { [EVIL]: [EVIL] } } });
  const e = await run1(["deal", "add", "N"]);
  expect(e.err).not.toContain("\x1b");
  noCtl(e.err);
  // ids from the command line are cleaned in the sentence too
  const r = await run1(["deal", "archive", EVIL], { tty: true });
  noCtl(r.out);
});

test("AC14 token sweep: CRM commands x error statuses x tty x json never print the token", async () => {
  const T = TOKENS.owner;
  const cmds: string[][] = [
    ["pipelines"], ["tags"], ["search", "q"], ["deals"], ["people"], ["companies"], ["deal", "get", "d_renewal"], ["person", "get", "pe_dana"], ["company", "get", "c_initech"],
    ["deal", "add", "N"], ["deal", "update", "d_renewal", "--name", "y"], ["deal", "update", "d_renewal", "--add-tag", "t"], ["deal", "move", "d_renewal", "st_won"],
    ["deal", "owner", "d_renewal", "me"], ["deal", "company", "d_renewal", "c_initech"], ["deal", "person", "d_renewal", "pe_dana"], ["deal", "note", "d_renewal", "x"],
    ["deal", "task", "add", "d_renewal", "T"], ["deal", "task", "done", "d_renewal", "ct_1"], ["deal", "archive", "d_renewal"],
    ["person", "add", "P"], ["person", "update", "pe_dana", "--phone", "1"], ["person", "archive", "pe_dana"],
    ["company", "add", "C"], ["company", "update", "c_initech", "--city", "x"], ["company", "archive", "c_initech"],
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

test("AC14 --help carries the CRM usage lines exactly", async () => {
  const r = await cli(["--help"]);
  const lines = [
    "  crm pipelines | crm tags [--entity E] | crm search QUERY [--entity E]",
    "  crm deals [--pipeline ID] [--stage ID|none] [--status S] [--owner EMAIL|me|none] [--q T] [--archived] [--sort S] [--page N]",
    "  crm deal get <id> | add NAME | update <id> | move <id> STAGE_ID | owner <id> EMAIL|me|--none | archive <id> [--undo]",
    "  crm deal add NAME [--pipeline ID] [--stage ID] [--amount N] [--currency C] [--next T] [--owner W] [--company ID | --new-company NAME] [--person ID | --new-person NAME [--person-email E]]",
    "  crm deal update <id> [--name T] [--amount N] [--currency C] [--next T] [--lost-reason T] [--tag T]... | [--no-tags] | [--add-tag T]... [--remove-tag T]... [--version V]",
    "  crm deal company <id> COMPANY_ID | --new NAME   crm deal person <id> PERSON_ID | --new NAME [--email E]",
    "  crm deal note <id> TEXT|-   crm deal task add <id> TITLE [--due ISO] [--assign W]   crm deal task done <id> <task_id> [--undo]",
    "  crm people | companies [--q T] [--archived] [--sort S] [--page N]   crm person|company get <id> | archive <id> [--undo]",
    "  crm person add NAME [--email E] [--phone P] [--job-title T] [--linkedin-url U] [--company ID | --new-company NAME]",
    "  crm company add NAME [--domain D] [--website U] [--industry T] [--linkedin-url U] [--phone P] [--city C]",
    "  crm person|company update <id> [--name T] [field flags as add] [--notes T] [tag flags] [--version V]   (--add/--remove-tag: read then write, not atomic)",
  ];
  for (const l of lines) expect(r.out).toContain(l + "\n");
});

test("write errors: 503 machine_not_ready with details.saved: no retry hint, still exit 5", async () => {
  const body = { saved: true, id: "d_x" };
  const hdr = { "Retry-After": "30" };
  fake.state.next = err(503, "machine_not_ready", "The machine is starting; the deal may have been saved.", { details: body }, hdr);
  let r = await run1(["deal", "add", "N"]);
  expect([r.code, r.err]).toEqual([5, "error: The machine is starting; the deal may have been saved.\n"]);
  fake.state.next = err(503, "machine_not_ready", "The machine is starting; the deal may have been saved.", { details: body }, hdr);
  r = await run1(["deal", "add", "N", "--json"]);
  expect([r.code, JSON.parse(r.err).error.details]).toEqual([5, body]);
  fake.state.next = err(503, "machine_not_ready", "Starting.", { details: { saved: false } }, hdr);
  r = await run1(["deal", "add", "N"]);
  expect([r.code, r.err]).toEqual([5, "error: Starting. (retry after 30s)\n"]);
  fake.state.next = err(503, "machine_not_ready", "Starting.", {}, hdr);
  expect((await run1(["deal", "add", "N"])).err).toBe("error: Starting. (retry after 30s)\n");
});

test("write errors: 422 with details.existing exits 6 and --json carries it", async () => {
  const existing = { id: "c_initech", name: "Initech" };
  fake.state.next = err(422, "duplicate", "Already exists.", { details: { existing } });
  let r = await run1(["company", "add", "Initech", "--json"]);
  expect([r.code, JSON.parse(r.err).error.details.existing]).toEqual([6, existing]);
  fake.state.next = err(422, "duplicate", "Already exists.", { details: { existing } });
  r = await run1(["company", "add", "Initech"]);
  expect([r.code, r.err]).toEqual([6, "error: Already exists.\n"]);
});
