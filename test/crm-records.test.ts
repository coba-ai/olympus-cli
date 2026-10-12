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
const noCtl = (s: string) => expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s.replace(/\n/g, ""))).toBe(false);
const EVIL = "x\x1b]52;c;ZZ\x07\x9by";
const P = "/api/v1/orgs/acme/crm";
const S = () => fake.state.crm.acme!;
const err = (status: number, code: string, message = "m", extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  ({ status, headers, body: { error: { code, message, ...extra } } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("deletion-preview requests and piped, terminal and json output", async () => {
  let r = await run1(["deal", "deletion-preview", "d_renewal"]);
  expect([last().method, last().path, last().search, last().idem]).toEqual(["GET", `${P}/deals/d_renewal/deletion_preview`, "", null]);
  expect(r.out).toBe("entity: deal\nid: d_renewal\nname: Initech renewal\nimpact: notes\t1\nimpact: tasks\t1\n");
  r = await run1(["person", "deletion-preview", "pe_dana"]);
  expect([last().path, r.out]).toEqual([`${P}/people/pe_dana/deletion_preview`, "entity: person\nid: pe_dana\nname: Dana Lee\nimpact: deals_unlinked\t1\n"]);
  r = await run1(["company", "deletion-preview", "c_initech"]);
  expect([last().path, r.out]).toEqual([`${P}/companies/c_initech/deletion_preview`,
    "entity: company\nid: c_initech\nname: Initech\nimpact: people_unlinked\t1\nimpact: deals_unlinked\t1\n"]);
  r = await run1(["person", "deletion-preview", "pe_dana"], { tty: true });
  expect(r.out).toBe("entity  person\nid      pe_dana\nname    Dana Lee\n\nimpact:\n  deals unlinked  1\n");
  r = await run1(["deal", "deletion-preview", "d_renewal", "--json"]);
  expect(JSON.parse(r.out)).toEqual({ data: { entity: "deal", id: "d_renewal", name: "Initech renewal", impact: { notes: 1, tasks: 1 } } });
  fake.state.next = { status: 200, body: { data: { entity: "deal", id: "d1", name: "N", impact: {} } } };
  expect((await run1(["deal", "deletion-preview", "d1"], { tty: true })).out).toBe("entity  deal\nid      d1\nname    N\n\nimpact: none\n");
  fake.state.next = { status: 200, body: { data: { entity: "deal", id: "d1", name: "N", impact: {} } } };
  expect((await run1(["deal", "deletion-preview", "d1"])).out).toBe("entity: deal\nid: d1\nname: N\n");
});

test("delete needs --yes: usage error, zero requests, stdin never read", async () => {
  for (const kind of ["deal", "person", "company"]) {
    const r = await run1([kind, "delete", "x"], { tty: true });
    expect([r.code, r.err, r.out, r.reads]).toEqual([1, `error: crm ${kind} delete needs --yes\n`, "", 0]);
  }
  expect(reqs()).toHaveLength(0);
});

test("delete piped and --json sends exactly one DELETE", async () => {
  let r = await run1(["deal", "delete", "d_old", "--yes"]);
  expect([r.code, r.out, reqs().map((x) => [x.method, x.path, x.idem])]).toEqual([0, "deleted d_old\n", [["DELETE", `${P}/deals/d_old`, null]]]);
  expect(S().deals.map((d) => d.id)).toEqual(["d_renewal"]);
  reqs().length = 0;
  r = await run1(["person", "delete", "pe_dana", "--yes", "--json"], { tty: true });
  expect([r.out, reqs().map((x) => [x.method, x.path])]).toEqual(['{"data":{"id":"pe_dana","deleted":true}}\n', [["DELETE", `${P}/people/pe_dana`]]]);
  reqs().length = 0;
  r = await run1(["company", "delete", "c_initech", "--yes"]);
  expect([r.out, reqs().map((x) => [x.method, x.path])]).toEqual(["deleted c_initech\n", [["DELETE", `${P}/companies/c_initech`]]]);
});

test("delete on a terminal shows the preview, then deletes", async () => {
  const r = await run1(["deal", "delete", "d_renewal", "--yes"], { tty: true });
  expect(r.code).toBe(0);
  expect(r.out).toBe("entity  deal\nid      d_renewal\nname    Initech renewal\n\nimpact:\n  notes  1\n  tasks  1\n\nDeleted deal d_renewal.\n");
  expect(reqs().map((x) => [x.method, x.path, x.idem])).toEqual([["GET", `${P}/deals/d_renewal/deletion_preview`, null], ["DELETE", `${P}/deals/d_renewal`, null]]);
  expect(S().deals.map((d) => d.id)).toEqual(["d_old"]);
});

test("a failed terminal preview ends the command before any DELETE", async () => {
  fake.state.next = err(404, "not_found", "Not found");
  let r = await run1(["deal", "delete", "nope", "--yes"], { tty: true });
  expect([r.code, r.out, reqs().map((x) => x.method)]).toEqual([3, "", ["GET"]]);
  fake.state.next = err(409, "machine_needs_update", "Update the machine.");
  r = await run1(["deal", "delete", "d_old", "--yes"], { tty: true });
  expect([r.code, reqs().map((x) => x.method)]).toEqual([5, ["GET", "GET"]]);
  expect(S().deals).toHaveLength(2);
});

test("a 2xx preview that is not an object with an impact object stops the delete (exit 5)", async () => {
  const named = { entity: "deal", id: "d_old", name: "N" };
  for (const body of [{ data: "x" }, { data: [] }, {}, { data: { ...named, impact: "lots" } }, { data: named }]) {
    reqs().length = 0;
    fake.state.next = { status: 200, body };
    const r = await run1(["deal", "delete", "d_old", "--yes"], { tty: true });
    expect([r.code, r.err, r.out, reqs().map((x) => x.method)]).toEqual([5, "error: unexpected response\n", "", ["GET"]]);
  }
  expect(S().deals).toHaveLength(2);
});

test("a delete refused with 409 conflict after a good preview: preview on stdout, error on stderr, exit 6", async () => {
  fake.state.onRequest = (r) => { if (r.method === "DELETE") fake.state.next = err(409, "conflict", "Referenced elsewhere."); };
  const r = await run1(["deal", "delete", "d_renewal", "--yes"], { tty: true });
  expect(r.code).toBe(6);
  expect(r.out).toBe("entity  deal\nid      d_renewal\nname    Initech renewal\n\nimpact:\n  notes  1\n  tasks  1\n");
  expect(r.err).toBe("error: Referenced elsewhere. (it changed since you read it; read it again and retry)\n");
});

test("unlink sends a bodyless DELETE and prints the deal", async () => {
  for (const what of ["company", "person"]) {
    reqs().length = 0;
    const r = await run1(["deal", `unlink-${what}`, "d_renewal"]);
    expect(r.code).toBe(0);
    expect(reqs()).toHaveLength(1);
    expect([last().method, last().path, last().search, last().body ?? null, last().idem]).toEqual(["DELETE", `${P}/deals/d_renewal/${what}`, "", null, null]);
    expect(r.out).toContain(`${what}: -\n`);
  }
  const t = await run1(["deal", "unlink-company", "d_renewal"], { tty: true });
  expect(t.out.startsWith("Unlinked the company from deal d_renewal.\n\n")).toBe(true);
  expect((await run1(["deal", "unlink-person", "d_renewal"], { tty: true })).out.startsWith("Unlinked the person from deal d_renewal.\n\n")).toBe(true);
});

test("task done toggles an org-wide task", async () => {
  let r = await run1(["task", "done", "ct_1"]);
  expect([last().method, last().path, last().body, last().idem]).toEqual(["PATCH", `${P}/tasks/ct_1`, { done: true }, null]);
  expect(r.out).toBe("task: ct_1\tdone\t-\towner@acme.test\tSend quote\n");
  r = await run1(["task", "done", "ct_1", "--undo"]);
  expect([last().body, r.out]).toEqual([{ done: false }, "task: ct_1\topen\t-\towner@acme.test\tSend quote\n"]);
  r = await run1(["task", "done", "ct_1"], { tty: true });
  expect(r.out).toBe("Marked task ct_1 done.\n\nid        ct_1\ntitle     Send quote\nstatus    done\ndue at    -\nassignee  owner@acme.test\n");
  r = await run1(["task", "done", "ct_1", "--undo"], { tty: true });
  expect(r.out.startsWith("Marked task ct_1 not done.\n\n")).toBe(true);
  r = await run1(["task", "done", "ct_1", "--json"]);
  expect(JSON.parse(r.out).data.status).toBe("done");
  expect((await run1(["task", "done", ".."])).code).toBe(1);
});

test("person and company task add", async () => {
  for (const [kind, path, id] of [["person", "people", "pe_dana"], ["company", "companies", "c_initech"]] as const) {
    reqs().length = 0;
    let r = await run1([kind, "task", "add", id, "Call back"]);
    expect([r.code, last().method, last().path, last().body]).toEqual([0, "POST", `${P}/${path}/${id}/tasks`, { title: "Call back" }]);
    expect(r.out).toMatch(/\ntask: ct_\w+\topen\t-\t-\tCall back\n$/);
    r = await run1([kind, "task", "add", id, "T2", "--due", "2026-10-20", "--assign", "me"]);
    expect(last().body).toEqual({ title: "T2", due_at: "2026-10-20", assignee: "me" });
    const newId = S()[path].find((x) => x.id === id)!.tasks.at(-1).id;
    r = await run1([kind, "task", "add", id, "T3"], { tty: true });
    expect(r.out).toMatch(new RegExp(`^Added task ct_\\w+ to ${kind} ${id}\\.\\n\\n`));
    expect(newId).toMatch(/^ct_/);
  }
  for (const a of [["person", "task", "add", "..", "T"], ["person", "task", "add", "p"], ["person", "task", "done", "p", "x"], ["person", "task", "add", "p", "T", "--bogus"]])
    expect((await run1(a)).code).toBe(1);
});

test("detail: interaction, task and legacy_notes lines", async () => {
  const ix = [{ occurred_at: "2026-10-01T09:00:00Z", kind: "email", direction: "outbound", summary: "Sent\tquote\nline2" }, { kind: "call" }];
  Object.assign(S().deals[0]!, { interactions: ix, legacy_notes: "old\nnotes" });
  Object.assign(S().people[0]!, { interactions: ix, tasks: [{ id: "ct_9", title: "Ring", status: "open", due_at: null, assignee: "a@b.test" }] });
  Object.assign(S().companies[0]!, { interactions: ix, tasks: [{ id: "ct_8", title: "Visit", status: "done", due_at: "2026-10-20", assignee: null }] });
  const lines = async (a: string[]) => (await run1(a)).out.split("\n");
  let l = await lines(["deal", "get", "d_renewal"]);
  const v = l.findIndex((x) => x.startsWith("version: "));
  expect(l[v + 1]).toBe("legacy_notes: old notes");
  expect(l.filter((x) => x.startsWith("interaction:"))).toEqual(["interaction: 2026-10-01T09:00:00Z\temail\toutbound\tSent quote line2", "interaction: -\tcall\t-\t-"]);
  expect(l.findIndex((x) => x.startsWith("interaction:"))).toBeGreaterThan(l.findIndex((x) => x.startsWith("task:")));
  l = await lines(["person", "get", "pe_dana"]);
  const at = (p: string) => l.findIndex((x) => x.startsWith(p));
  expect(l.filter((x) => x.startsWith("task:"))).toEqual(["task: ct_9\topen\t-\ta@b.test\tRing"]);
  expect(at("deal:")).toBeLessThan(at("task:"));
  expect(at("task:")).toBeLessThan(at("interaction:"));
  expect(l.some((x) => x.startsWith("legacy_notes"))).toBe(false);
  l = await lines(["company", "get", "c_initech"]);
  expect(l.filter((x) => x.startsWith("task:"))).toEqual(["task: ct_8\tdone\t2026-10-20\t-\tVisit"]);
  expect(at("deal:")).toBeLessThan(at("task:"));
  expect(at("task:")).toBeLessThan(at("interaction:"));
  const tty = (await run1(["deal", "get", "d_renewal"], { tty: true })).out;
  expect(tty).toContain("\n\ninteractions:\n  ");
  expect(tty).toContain("\n\nlegacy notes:\n  old\n  notes\n");
  expect((await run1(["person", "get", "pe_dana"], { tty: true })).out).toContain("\n\ntasks:\n  ct_9  open  -  a@b.test  Ring");
});

test("detail: records without the new keys, or with empty ones, print as before", async () => {
  const before = (await run1(["deal", "get", "d_renewal"])).out;
  for (const legacy of [undefined, null, "", 5, { a: 1 }]) {
    Object.assign(S().deals[0]!, { legacy_notes: legacy, interactions: [] });
    expect((await run1(["deal", "get", "d_renewal"])).out).toBe(before);
  }
  expect(before).not.toMatch(/interaction|legacy/);
  const tty = (await run1(["deal", "get", "d_renewal"], { tty: true })).out;
  expect(tty).not.toMatch(/interactions:|legacy notes/);
  for (const [k, id] of [["person", "pe_dana"], ["company", "c_initech"]]) {
    const t = (await run1([k!, "get", id!], { tty: true })).out;
    expect(t).not.toMatch(/interactions:|tasks:|legacy/);
  }
});

test("unknown flags: a negated boolean is named as typed", async () => {
  const r = await run1(["deal", "get", "d_1", "--no-archived"]);
  expect([r.code, r.err, reqs().length]).toEqual([1, "error: unknown option '--no-archived' for crm deal get\n", 0]);
  expect((await run1(["deal", "get", "d_1", "--archived"])).err).toBe("error: unknown option '--archived' for crm deal get\n");
});

const CREATES: { name: string; args: string[]; count: () => number }[] = [
  { name: "deal add", args: ["deal", "add", "Fresh"], count: () => S().deals.length },
  { name: "person add", args: ["person", "add", "Fresh"], count: () => S().people.length },
  { name: "company add", args: ["company", "add", "Fresh"], count: () => S().companies.length },
  { name: "deal note", args: ["deal", "note", "d_renewal", "hello"], count: () => S().deals[0]!.notes.length },
  { name: "deal task add", args: ["deal", "task", "add", "d_renewal", "T"], count: () => S().deals[0]!.tasks.length },
  { name: "person task add", args: ["person", "task", "add", "pe_dana", "T"], count: () => (S().people[0]!.tasks ?? []).length },
  { name: "company task add", args: ["company", "task", "add", "c_initech", "T"], count: () => (S().companies[0]!.tasks ?? []).length },
];

test("every record create sends a fresh v4 key, or the one given", async () => {
  for (const c of CREATES) {
    const a = await run1(c.args), b = await run1(c.args);
    const [k1, k2] = reqs().slice(-2).map((x) => x.idem);
    expect([c.name, a.code, b.code]).toEqual([c.name, 0, 0]);
    expect(k1).toMatch(UUID);
    expect(k2).toMatch(UUID);
    expect(k1).not.toBe(k2);
    expect(a.out + b.out).not.toContain(k1!);
    await run1([...c.args, "--idempotency-key", "my.key:1"]);
    expect(last().idem).toBe("my.key:1");
  }
});

test("the same key twice leaves one record and identical output", async () => {
  for (const c of CREATES) {
    const n = c.count();
    const a = await run1([...c.args, "--idempotency-key", `k-${c.name.replace(/ /g, "-")}`]);
    const b = await run1([...c.args, "--idempotency-key", `k-${c.name.replace(/ /g, "-")}`]);
    expect([c.name, a.code, b.code, c.count() - n]).toEqual([c.name, 0, 0, 1]);
    expect(b.out).toBe(a.out);
    expect(b.out).not.toContain("k-");
  }
});

test("an invalid key is a usage error before any request", async () => {
  for (const c of CREATES)
    for (const k of ["", "a b", "x".repeat(129), "é", "a/b", "a\nb"]) {
      const r = await run1([...c.args, "--idempotency-key", k]);
      expect([c.name, r.code, r.err]).toEqual([c.name, 1, "error: --idempotency-key must be 1-128 characters from A-Z a-z 0-9 _ . : -\n"]);
    }
  expect(reqs()).toHaveLength(0);
});

test("--idempotency-key on anything but a create is refused; non-creates send no key", async () => {
  const others = [
    ["deal", "get", "d_renewal"], ["deal", "move", "d_renewal", "st_won"], ["deal", "delete", "d_old", "--yes"], ["person", "deletion-preview", "pe_dana"],
    ["task", "done", "ct_1"], ["deal", "unlink-company", "d_renewal"], ["deal", "archive", "d_renewal"], ["deal", "update", "d_renewal", "--name", "n"],
    ["deal", "task", "done", "d_renewal", "ct_1"], ["person", "update", "pe_dana", "--phone", "1"], ["deals"],
  ];
  for (const a of others) expect([a.join(" "), (await run1([...a, "--idempotency-key", "k"])).code]).toEqual([a.join(" "), 1]);
  expect(reqs()).toHaveLength(0);
  for (const a of others) {
    await run1(a, { tty: true });
    await run1(a);
  }
  expect(reqs().length).toBeGreaterThan(others.length);
  expect(reqs().every((x) => x.idem === null)).toBe(true);
});

test("exit 5 on a create: hint on a terminal only, naming the key sent", async () => {
  for (const c of CREATES) {
    const body = { error: { code: "machine_not_ready", message: "Starting.", details: { saved: false } } };
    fake.state.next = { status: 503, body };
    let r = await run1(c.args, { tty: true });
    const key = last().idem!;
    expect([c.name, r.code]).toEqual([c.name, 5]);
    expect(r.err).toBe(`error: Starting.\nTo retry with the same key, run the same command with --idempotency-key ${key}\n`);
    expect(r.out).toBe("");
    fake.state.next = { status: 503, body };
    r = await run1(c.args);
    expect([r.code, r.err]).toEqual([5, "error: Starting.\n"]);
    fake.state.next = { status: 503, body };
    r = await run1([...c.args, "--json"], { tty: true });
    expect([r.code, r.err]).toEqual([5, JSON.stringify(body) + "\n"]);
    fake.state.next = { status: 503, body };
    r = await run1([...c.args, "--idempotency-key", "mine"], { tty: true });
    expect(r.err.endsWith("--idempotency-key mine\n")).toBe(true);
  }
});

test("a network error on a create is exit 5 with the hint on a terminal", async () => {
  const o = { env: { ...owner, OLYMPUS_HOST: "http://127.0.0.1:1" } };
  let r = await run1(["person", "add", "P"], { ...o, tty: true });
  expect(r.code).toBe(5);
  expect(r.err).toMatch(/\nTo retry with the same key, run the same command with --idempotency-key [0-9a-f-]{36}\n$/);
  r = await run1(["person", "add", "P"], o);
  expect([r.code, r.err.includes("--idempotency-key")]).toEqual([5, false]);
  r = await run1(["person", "add", "P", "--json"], { ...o, tty: true });
  expect([r.code, r.err.includes("--idempotency-key")]).toEqual([5, false]);
  expect(r.err.endsWith("}\n")).toBe(true);
  r = await run1(["person", "delete", "pe_dana", "--yes"], { ...o, tty: false });
  expect([r.code, r.err.includes("--idempotency-key")]).toEqual([5, false]);
});

test("errors: 404 exits 3 without the credentials hint, a teammate gets 4, 422 exits 6", async () => {
  let r = await run1(["deal", "deletion-preview", "nope"]);
  expect([r.code, r.err]).toEqual([3, "error: Not found\n"]);
  r = await run1(["person", "delete", "nope", "--yes"]);
  expect([r.code, r.err.includes("credentials.json")]).toEqual([3, false]);
  r = await run1(["task", "done", "nope"]);
  expect(r.code).toBe(3);
  const mate = { env: { OLYMPUS_API_KEY: TOKENS.teammate } };
  for (const a of [["deal", "delete", "d_old", "--yes"], ["task", "done", "ct_1"], ["deal", "unlink-person", "d_renewal"], ["person", "task", "add", "pe_dana", "T"]])
    expect([a.join(" "), (await run1(a, mate)).code]).toEqual([a.join(" "), 4]);
  expect(S().deals).toHaveLength(2);
  fake.state.next = err(422, "invalid", "bad", { details: { fields: { title: ["blank"] } } });
  r = await run1(["company", "task", "add", "c_initech", "T"]);
  expect([r.code, r.err]).toEqual([6, "error: bad\n  title: blank\n"]);
  fake.state.next = err(409, "conflict", "Changed.");
  expect((await run1(["deal", "unlink-company", "d_renewal"])).err).toBe("error: Changed. (it changed since you read it; read it again and retry)\n");
});

test("token sweep: the new commands x error statuses x tty x json never print the token", async () => {
  const T = TOKENS.owner;
  const cmds: string[][] = [
    ["deal", "deletion-preview", "d_renewal"], ["person", "deletion-preview", "pe_dana"], ["company", "deletion-preview", "c_initech"],
    ["deal", "delete", "d_old", "--yes"], ["person", "delete", "pe_dana", "--yes"], ["company", "delete", "c_initech", "--yes"],
    ["deal", "unlink-company", "d_renewal"], ["deal", "unlink-person", "d_renewal"], ["task", "done", "ct_1"], ["task", "done", "ct_1", "--undo"],
    ["person", "task", "add", "pe_dana", "T"], ["company", "task", "add", "c_initech", "T"],
    ["deal", "add", "N"], ["person", "add", "P"], ["company", "add", "C"], ["deal", "note", "d_renewal", "x"], ["deal", "task", "add", "d_renewal", "T"],
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

test("hostile strings in every new printed field never reach stdout as controls", async () => {
  const task = { id: EVIL, title: EVIL, status: EVIL, due_at: EVIL, assignee: { email: EVIL } };
  const interactions = [{ occurred_at: EVIL, kind: EVIL, direction: EVIL, summary: EVIL }];
  const rich = { id: EVIL, name: EVIL, full_name: EVIL, version: EVIL, legacy_notes: EVIL, interactions, tasks: [task, EVIL] };
  const preview = { entity: EVIL, id: EVIL, name: EVIL, impact: { [EVIL]: EVIL, other_key: { a: EVIL } } };
  for (const tty of [false, true]) {
    for (const [a, data] of [
      [["deal", "get", "d1"], rich], [["person", "get", "p1"], rich], [["company", "get", "c1"], rich],
      [["deal", "unlink-company", "d1"], rich], [["deal", "unlink-person", "d1"], rich],
      [["person", "task", "add", "p1", "T"], rich], [["company", "task", "add", "c1", "T"], rich],
      [["task", "done", "t1"], task], [["deal", "deletion-preview", "d1"], preview], [["person", "deletion-preview", "p1"], preview],
    ] as [string[], unknown][]) {
      fake.state.next = { status: 200, body: { data } };
      const r = await run1(a, { tty });
      expect([a.join(" "), r.code]).toEqual([a.join(" "), 0]);
      noCtl(r.out);
      expect(r.out).not.toContain("\x1b");
    }
    // delete: hostile preview on the terminal, then the DELETE answers 404; stdout still clean
    fake.state.next = { status: 200, body: { data: preview } };
    const d = await run1(["deal", "delete", "d1", "--yes"], { tty });
    noCtl(d.out);
    noCtl(d.err);
  }
  // ids typed on the command line are cleaned in sentences
  for (const a of [["task", "done", EVIL], ["deal", "unlink-company", EVIL], ["person", "task", "add", EVIL, "T"], ["deal", "delete", EVIL, "--yes"]]) {
    fake.state.next = { status: 200, body: { data: { id: "ok", tasks: [{ id: EVIL }] } } };
    const r = await run1(a, { tty: true });
    noCtl(r.out);
    noCtl(r.err);
  }
  fake.state.next = err(422, "invalid", EVIL, { details: { fields: { [EVIL]: [EVIL] } } });
  const e = await run1(["person", "task", "add", "p1", "T"], { tty: true });
  noCtl(e.err);
});
