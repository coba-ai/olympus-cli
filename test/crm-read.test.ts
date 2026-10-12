import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { seedCrm, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
const NOW = Date.parse("2026-10-12T14:00:00Z");
const V = "0123456789abcdef0123456789abcdef";
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  delete fake.state.onRequest;
  fake.state.now = () => NOW;
  fake.state.crm = seedCrm();
  const S = fake.state.crm.acme!;
  for (const x of [...S.deals, ...S.people, ...S.companies]) x.version = V;
});

async function cli(args: string[], o: { env?: Record<string, string>; tty?: boolean; stdin?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "";
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, ...o.env }, home, stdin: async () => o.stdin ?? "",
    out: (s) => { out += s; }, err: (s) => { err += s; }, now: () => NOW, tty: o.tty ?? false,
  });
  return { code, out, err };
}
const owner = { OLYMPUS_API_KEY: TOKENS.owner };
const reqs = () => fake.state.requests;
const last = () => reqs()[reqs().length - 1]!;
const run1 = (args: string[], tty = false) => cli(["crm", ...args, "--org", "acme"], { env: owner, tty });
const noCtl = (s: string) => expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s.replace(/\n$/, "").replace(/\n/g, ""))).toBe(false);
const EVIL = "x\x1b]52;c;ZZ\x07\x9by";
const nextOk = (data: unknown) => { fake.state.next = { status: 200, body: { data } }; };

test("AC6 dispatch and validation: exit 1, zero requests, no token needed", async () => {
  const bad: string[][] = [
    [], ["constructor"], ["toString"], ["deal"], ["deal", "__proto__"], ["deal", "task", "toString"], ["deal", "task"], ["deal", "task", "add"],
    ["deal", "get", "d1", "x"], ["deal", "get"], ["deals", "extra"], ["pipelines", "x"], ["tags", "x"], ["person", "get", "a", "b"],
    ["deal", "get", "d1", "--pipeline", "p"], ["deals", "--entity", "deal"], ["people", "--status", "open"], ["companies", "--pipeline", "p"],
    ["pipelines", "--q", "x"], ["tags", "--q", "x"], ["search", "x", "--q", "y"], ["deal", "add", "N", "--undo"], ["deal", "move", "d1", "s", "--stage", "x"],
    ["deal", "archive", "d1", "--yes"], ["person", "archive", "p1", "--yes"], ["company", "archive", "c1", "--yes"],
    ["person", "add", "N", "--domain", "x"], ["company", "add", "N", "--email", "x"], ["company", "add", "N", "--company", "c1"],
    ["deal", "owner", "d1", "--none", "me"], ["deal", "owner", "d1"], ["deal", "company", "d1"], ["deal", "company", "d1", "c1", "--new", "N"],
    ["deal", "person", "d1"], ["deal", "person", "d1", "p1", "--new", "N"], ["deal", "person", "d1", "p1", "--email", "e"],
    ["deal", "task", "add", "d1"], ["deal", "task", "done", "d1"], ["deal", "task", "add", "d1", "T", "--undo"],
    // a positional with a space must not spell a longer subcommand
    ["deal get", "d1", "x"], ["deal", "task add", "d1", "T", "x"], ["deal task", "add", "d1", "T"], ["deal get d1"],
    ["deal", "get", ".."], ["deal", "get", "."], ["deal", "get", ""], ["person", "get", ".."], ["company", "update", "", "--name", "x"],
    ["deal", "update", "..", "--name", "x"], ["deal", "move", "..", "s"], ["deal", "note", ".", "t"], ["deal", "archive", ""],
    ["deal", "task", "add", "..", "T"], ["deal", "task", "done", "..", "t1"], ["deal", "task", "done", "d1", ".."], ["deal", "task", "done", "d1", ""],
    ["deal", "owner", "..", "me"], ["deal", "company", "..", "c1"], ["deal", "person", "", "--new", "N"], ["person", "archive", ".."],
    ["search", ""], ["search"],
    ["deals", "--page", "0"], ["deals", "--page", "-1"], ["deals", "--page", "1.5"], ["deals", "--page", "x"], ["people", "--page", "0"], ["companies", "--page", "x"],
    ["deal", "add", "N", "--company", "c", "--new-company", "X"], ["deal", "add", "N", "--person", "p", "--new-person", "X"],
    ["deal", "add", "N", "--person-email", "e@x"], ["person", "add", "N", "--company", "c", "--new-company", "X"],
    ["deal", "update", "d1"], ["deal", "update", "d1", "--version", V], ["person", "update", "p1"], ["person", "update", "p1", "--version", V],
    ["company", "update", "c1"], ["company", "update", "c1", "--version", V],
    ["deal", "update", "d1", "--tag", "a", "--no-tags"], ["deal", "update", "d1", "--tags"], ["deal", "update", "d1", "--add-tag", "a", "--tag", "b"],
    ["deal", "update", "d1", "--remove-tag", "a", "--no-tags"], ["person", "update", "p1", "--tags"], ["company", "update", "c1", "--add-tag", "a", "--no-tags"],
    ["deal", "note", "d1", "a", "b"],
  ];
  for (const a of bad) {
    const r = await cli(["crm", ...a, "--org", "acme"]); // no token: usage errors come first
    expect([a.join(" "), r.code]).toEqual([a.join(" "), 1]);
    const t = await run1(a);
    expect([a.join(" "), t.code]).toEqual([a.join(" "), 1]);
  }
  expect(reqs()).toHaveLength(0);
  // negations of boolean flags mean "not given"
  expect((await run1(["deals", "--no-archived"])).code).toBe(0);
  expect(last().search).toBe("");
});

test("AC7 read requests: exact path, query keys in order", async () => {
  const get = async (a: string[]) => { const r = await run1(a); expect(r.code).toBe(0); expect(last().method).toBe("GET"); return last(); };
  expect((await get(["pipelines"])).path).toBe("/api/v1/orgs/acme/crm/pipelines");
  expect((await get(["tags"])).search).toBe("");
  expect((await get(["tags", "--entity", "deal"])).search).toBe("?entity=deal");
  expect((await get(["search", "init tech"])).path).toBe("/api/v1/orgs/acme/crm/search");
  expect(last().search).toBe("?q=init+tech");
  expect((await get(["search", "x", "--entity", "person"])).search).toBe("?q=x&entity=person");
  expect((await get(["deals"])).path).toBe("/api/v1/orgs/acme/crm/deals");
  expect(last().search).toBe("");
  const all = ["--page", "2", "--sort", "name", "--archived", "--q", "a b", "--owner", "me", "--status", "open", "--stage", "none", "--pipeline", "p_sales"];
  expect((await get(["deals", ...all])).search).toBe("?pipeline=p_sales&stage=none&status=open&owner=me&q=a+b&archived=only&sort=name&page=2");
  expect((await get(["people", "--page", "3", "--sort", "name", "--archived", "--q", "d"])).search).toBe("?q=d&archived=only&sort=name&page=3");
  expect(last().path).toBe("/api/v1/orgs/acme/crm/people");
  expect((await get(["companies", "--q", "i"])).search).toBe("?q=i");
  expect(last().path).toBe("/api/v1/orgs/acme/crm/companies");
  for (const [a, p] of [[["deal", "get", "d_renewal"], "deals/d_renewal"], [["person", "get", "pe_dana"], "people/pe_dana"], [["company", "get", "c_initech"], "companies/c_initech"]] as const)
    expect((await get([...a])).path).toBe(`/api/v1/orgs/acme/crm/${p}`);
  await get(["deal", "get", "a/b?c"]).catch(() => {});
  expect(last().path).toBe("/api/v1/orgs/acme/crm/deals/a%2Fb%3Fc");
});

test("AC8 piped list goldens", async () => {
  const g = async (a: string[]) => (await run1(a)).out;
  expect(await g(["pipelines"])).toBe(
    "p_sales\tpipeline\tUSD\tSales\nst_lead\tstage:p_sales\topen\tLead\nst_won\tstage:p_sales\twon\tWon\nst_lost\tstage:p_sales\tlost\tLost\n");
  expect(await g(["tags"])).toBe("renewal\n");
  expect(await g(["search", "in"])).toBe("deal\td_renewal\tInitech\tInitech renewal\ncompany\tc_initech\tinitech.test\tInitech\n");
  expect(await g(["deals"])).toBe("d_renewal\topen\tp_sales\tst_lead\t1200\tUSD\towner@acme.test\tInitech\trenewal\tInitech renewal\n");
  expect(await g(["deals", "--archived"])).toBe("d_old\tlost\tp_sales\tst_lost\t-\t-\t-\t-\t-\tOld deal\n");
  expect(await g(["people"])).toBe("pe_dana\tdana@initech.test\tc_initech\t-\t1\t-\tDana Lee\n");
  expect(await g(["companies"])).toBe("c_initech\tinitech.test\t-\t1\t-\tInitech\n");
  nextOk([]);
  expect(await g(["pipelines"])).toBe("");
  nextOk({ deals: [], total: 0, page: 1, per: 50 });
  expect(await g(["deals"])).toBe("");
});

test("AC8 rows with extra or missing fields keep the column count; unknown fields never print", async () => {
  const stuffed = { deals: [
    { id: "d1", name: "N", ZZ_EXTRA: "leak", pipeline: { id: "p1", name: "P" }, stage: "s1", tags: ["a", "b"] },
    { id: "d2", name: "M", pipeline: null, stage: { id: "s2" }, company_name: "", tags: [], status: "open", amount: "5", currency: "EUR", owner_email: "o@x", extra: { deep: 1 } },
    {}, null,
  ], total: 4, page: 1, per: 50 };
  nextOk(stuffed);
  const r = await run1(["deals"]);
  expect(r.out).toBe("d1\t-\tp1\ts1\t-\t-\t-\t-\ta,b\tN\nd2\topen\t-\ts2\t5\tEUR\to@x\t-\t-\tM\n-\t-\t-\t-\t-\t-\t-\t-\t-\t-\n-\t-\t-\t-\t-\t-\t-\t-\t-\t-\n");
  expect(r.out).not.toContain("leak");
  nextOk({ people: [{ id: "p", full_name: "F", company: { id: "c1", name: "C" }, zz: 1 }, { id: "q", company: "c2" }] });
  expect((await run1(["people"])).out).toBe("p\t-\tc1\t-\t-\t-\tF\nq\t-\tc2\t-\t-\t-\t-\n");
  nextOk({ companies: [{ id: "c", name: "N", qq: 1 }, {}] });
  expect((await run1(["companies"])).out).toBe("c\t-\t-\t-\t-\tN\n-\t-\t-\t-\t-\t-\n");
  nextOk([{ id: "p", name: "P", stages: [{ id: "s", zz: 1 }], currencies: [] }, {}]);
  expect((await run1(["pipelines"])).out).toBe("p\tpipeline\t-\tP\ns\tstage:p\t-\t-\n-\tpipeline\t-\t-\n");
  nextOk([{ entity: "deal", id: "x", label: "L", extra: 1 }, {}]);
  expect((await run1(["search", "q"])).out).toBe("deal\tx\t-\tL\n-\t-\t-\t-\n");
  // missing wrappers do not crash
  nextOk({});
  expect((await run1(["deals"])).out).toBe("");
});

test("AC8 --json is the body as-is; TTY is a table with a paging footer", async () => {
  const body = { data: { deals: [{ id: "d1", name: "N", surprise: { a: 1 } }], total: 120, page: 2, per: 50, other: true } };
  fake.state.next = { status: 200, body };
  const j = await run1(["deals", "--json"]);
  expect(j.out).toBe(JSON.stringify(body) + "\n");
  for (const a of [["pipelines"], ["tags"], ["search", "i"], ["people"], ["companies"], ["deal", "get", "d_renewal"]]) {
    const r = await run1([...a, "--json"]);
    expect(JSON.parse(r.out).data).toBeDefined();
    expect(r.out.endsWith("}\n") && r.out.indexOf("\n") === r.out.length - 1).toBe(true);
  }
  fake.state.next = { status: 200, body };
  expect((await run1(["deals", "--page", "2"], true)).out).toBe(
    "ID  NAME  STATUS  STAGE  AMOUNT  CURRENCY  OWNER EMAIL  COMPANY NAME  TAGS\nd1  N     -       -      -       -         -            -             -\n\nPage 2 · showing 1 of 120. Next: --page 3\n");
  fake.state.next = { status: 200, body: { data: { deals: [{ id: "d1" }], total: 51, page: 1, per: 50 } } };
  expect((await run1(["deals"], true)).out).toEndWith("\n\nPage 1 · showing 1 of 51. Next: --page 2\n");
  fake.state.next = { status: 200, body: { data: { deals: [{ id: "d1" }], total: 51, page: 2, per: 50 } } };
  expect((await run1(["deals"], true)).out).toEndWith("\n\nPage 2 · showing 1 of 51.\n");
  fake.state.next = { status: 200, body: { data: { deals: [{ id: "d1" }], total: 1, page: 1, per: 50 } } };
  expect((await run1(["deals"], true)).out).not.toContain("Page");
  expect((await run1(["deals"], true)).out).toContain("d_renewal  Initech renewal  open    Lead   1200    USD       owner@acme.test  Initech       renewal");
  nextOk({ deals: [], total: 0, page: 1, per: 50 });
  expect((await run1(["deals"], true)).out).toBe("No deals.\n");
  nextOk({ people: [] });
  expect((await run1(["people"], true)).out).toBe("No people.\n");
  nextOk({ companies: [] });
  expect((await run1(["companies"], true)).out).toBe("No companies.\n");
  nextOk([]);
  expect((await run1(["pipelines"], true)).out).toBe("No pipelines.\n");
  nextOk([]);
  expect((await run1(["tags"], true)).out).toBe("No tags.\n");
  nextOk([]);
  expect((await run1(["search", "zz"], true)).out).toBe("No matches.\n");
  expect((await run1(["people"], true)).out).toContain("Dana Lee");
  expect((await run1(["pipelines"], true)).out).toBe("ID         NAME    INFO\np_sales    Sales   USD\n  st_lead    Lead  open\n  st_won     Won   won\n  st_lost    Lost  lost\n");
  expect((await run1(["search", "in"], true)).out).toContain("ENTITY   ID         LABEL            SUB");
});

test("AC9 piped detail goldens", async () => {
  const d = (await run1(["deal", "get", "d_renewal"])).out;
  expect(d).toBe([
    "id: d_renewal", "name: Initech renewal", "status: open", "pipeline: p_sales", "stage: st_lead", "amount: 1200", "currency: USD",
    "owner_email: owner@acme.test", "next_action: -", "lost_reason: -", "company: c_initech", "person: pe_dana", "tags: renewal", "archived: false",
    "in_stage_since: 2026-10-01T09:00:00Z", "updated_at: 2026-10-01T09:00:00Z", `version: ${V}`,
    "note: n_1\t2026-10-01T09:00:00Z\towner@acme.test\tKickoff call booked", "task: ct_1\topen\t-\towner@acme.test\tSend quote", "",
  ].join("\n"));
  expect((await run1(["person", "get", "pe_dana"])).out).toBe([
    "id: pe_dana", "full_name: Dana Lee", "email: dana@initech.test", "phone: -", "job_title: -", "linkedin_url: -", "company: c_initech", "tags: -",
    "archived: false", `version: ${V}`, "notes: -", "deal: d_renewal\topen\tLead\tInitech renewal", "",
  ].join("\n"));
  expect((await run1(["company", "get", "c_initech"])).out).toBe([
    "id: c_initech", "name: Initech", "domain: initech.test", "website: -", "industry: -", "linkedin_url: -", "phone: -", "city: -", "tags: -",
    "archived: false", `version: ${V}`, "notes: -", "person: pe_dana\tdana@initech.test\tDana Lee", "deal: d_renewal\topen\tLead\tInitech renewal", "",
  ].join("\n"));
});

test("AC9 detail robustness: unknown fields never print, missing fields and odd shapes print -", async () => {
  nextOk({
    id: "d9", name: "Odd", ZZ_UNKNOWN: "leak", pipeline: "p_bare", stage: { id: "s_obj", name: "S" }, company: { id: "c9", name: "C" }, person: null, archived: "yes",
    notes: [{ id: "n1", author: { email: "a@x", id: "u1" }, body: "line1\nline2\ttab" }, { id: "n2", author: { name: "Only Name" } }, { id: "n3", author: { id: "u3" } }, null],
    tasks: [{ id: "t1", title: "T", assignee: { id: "u1", email: "z@x" } }, { id: "t2", assignee: "me" }, "junk"],
  });
  const r = await run1(["deal", "get", "d9"]);
  expect(r.out).toBe([
    "id: d9", "name: Odd", "status: -", "pipeline: p_bare", "stage: s_obj", "amount: -", "currency: -", "owner_email: -", "next_action: -", "lost_reason: -",
    "company: c9", "person: -", "tags: -", "archived: false", "in_stage_since: -", "updated_at: -", "version: -",
    "note: n1\t-\ta@x\tline1 line2 tab", "note: n2\t-\tOnly Name\t-", "note: n3\t-\tu3\t-", "note: -\t-\t-\t-",
    "task: t1\t-\t-\tz@x\tT", "task: t2\t-\t-\tme\t-", "task: -\t-\t-\t-\t-", "",
  ].join("\n"));
  expect(r.out).not.toContain("leak");
  nextOk({ id: "p9", full_name: "P", company: "c_bare", deals: "not-a-list", what: 1 });
  expect((await run1(["person", "get", "p9"])).out).toBe([
    "id: p9", "full_name: P", "email: -", "phone: -", "job_title: -", "linkedin_url: -", "company: c_bare", "tags: -", "archived: false", "version: -", "notes: -", "",
  ].join("\n"));
  nextOk({});
  expect((await run1(["company", "get", "c1"])).out.split("\n").filter((l) => l.startsWith("id:"))).toEqual(["id: -"]);
});

test("AC9 TTY detail names records; --json is the body as-is", async () => {
  const t = (await run1(["deal", "get", "d_renewal"], true)).out;
  expect(t).toBe([
    "id              d_renewal", "name            Initech renewal", "status          open", "pipeline        Sales", "stage           Lead",
    "amount          1200", "currency        USD", "owner email     owner@acme.test", "next action     -", "lost reason     -",
    "company         Initech", "person          Dana Lee", "tags            renewal", "archived        -",
    "in stage since  11d ago (2026-10-01 09:00 UTC)", "updated at      11d ago (2026-10-01 09:00 UTC)", `version         ${V}`,
    "", "notes:", "  n_1  11d ago (2026-10-01 09:00 UTC)  owner@acme.test  Kickoff call booked", "", "tasks:", "  ct_1  open  -  owner@acme.test  Send quote", "",
  ].join("\n"));
  const p = (await run1(["person", "get", "pe_dana"], true)).out;
  expect(p).toContain("company       Initech");
  expect(p).toEndWith("\n\ndeals:\n  d_renewal  open  Lead  Initech renewal\n");
  const c = (await run1(["company", "get", "c_initech"], true)).out;
  expect(c).toContain("\n\npeople:\n  pe_dana  dana@initech.test  Dana Lee\n\ndeals:\n");
  const body = { data: { id: "x", whatever: { a: [1] } } };
  fake.state.next = { status: 200, body };
  expect((await run1(["deal", "get", "x", "--json"])).out).toBe(JSON.stringify(body) + "\n");
});

test("AC14 hostile server strings never reach stdout, piped or TTY", async () => {
  const E = EVIL;
  const deal = { id: E, name: E, status: E, pipeline: { id: E, name: E }, stage: { id: E, name: E }, amount: E, currency: E, owner_email: E, next_action: E, lost_reason: E,
    company: { id: E, name: E }, person: { id: E, name: E }, company_name: E, tags: [E], archived: E, in_stage_since: E, updated_at: E, version: E,
    notes: [{ id: E, author: E, body: E, created_at: E }], tasks: [{ id: E, title: E, status: E, due_at: E, assignee: { email: E } }] };
  const person = { id: E, full_name: E, email: E, phone: E, job_title: E, linkedin_url: E, notes: E, tags: [E], company: { id: E, name: E }, open_deals: E, deals: [deal] };
  const company = { id: E, name: E, domain: E, website: E, industry: E, linkedin_url: E, phone: E, city: E, notes: E, tags: [E], open_deals: E, people: [person], deals: [deal] };
  const cases: [string[], unknown][] = [
    [["deals"], { deals: [deal], total: E, page: 1, per: 50 }], [["people"], { people: [person] }], [["companies"], { companies: [company] }],
    [["pipelines"], [{ id: E, name: E, currencies: [E], stages: [{ id: E, name: E, kind: E }] }]], [["tags"], [E]],
    [["search", "q"], [{ entity: E, id: E, label: E, sub: E }]], [["deal", "get", "x"], deal], [["person", "get", "x"], person], [["company", "get", "x"], company],
  ];
  for (const tty of [false, true])
    for (const [a, data] of cases) {
      nextOk(data);
      const r = await run1(a, tty);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("\x1b");
      expect(r.out).not.toContain("\x9b");
      noCtl(r.out);
    }
});

test("TTY: a future task due date prints the date, not 'just now'", async () => {
  nextOk({ id: "d_1", tasks: [{ id: "ct_1", status: "open", due_at: "2026-10-20T00:00:00Z", assignee: "a@b.c", title: "T" }] });
  const r = await run1(["deal", "get", "d_1"], true);
  expect(r.out).toContain("2026-10-20 00:00 UTC");
  expect(r.out).toMatch(/\+\d+d \(2026-10-20 00:00 UTC\)/);
  expect(r.out).not.toContain("just now (2026-10-20");
});

test("D1 deal ref rows print the stage name; null list pipeline id prints - and never leaks the name into the id column", async () => {
  for (const a of [["person", "get", "pe_dana"], ["company", "get", "c_initech"]]) {
    const o = (await run1(a)).out;
    expect(o).toContain("deal: d_renewal\topen\tLead\tInitech renewal\n");
    expect(o).not.toContain("st_lead");
  }
  const dl = fake.state.crm.acme!.deals.find((d: any) => d.id === "d_renewal")!;
  dl.null_pipeline_id = true;
  expect((await run1(["deals"])).out).toBe("d_renewal\topen\t-\tst_lead\t1200\tUSD\towner@acme.test\tInitech\trenewal\tInitech renewal\n");
  expect((await run1(["deals"], true)).out).not.toContain("Sales");
  nextOk({ id: "d1", pipeline: { id: null, name: "Sales" }, stage: { id: "s1", name: "Lead" } });
  const t = (await run1(["deal", "get", "d1"], true)).out;
  expect(t).toContain("pipeline        Sales");
  nextOk({ id: "d1", pipeline: { id: null, name: "Sales" } });
  expect((await run1(["deal", "get", "d1"])).out).toContain("pipeline: -\n");
});
