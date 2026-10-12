import { afterAll, beforeEach, expect, test } from "bun:test";
import { seedCrm, seedSubscriptions, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  delete fake.state.onRequest;
  fake.state.crm = seedCrm();
  fake.state.subscriptions = seedSubscriptions();
});

async function api(method: string, path: string, body?: unknown, token = TOKENS.owner, org = "acme") {
  const res = await fetch(`${fake.url}/api/v1/orgs/${org}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}
const crm = (m: string, p: string, b?: unknown, t = TOKENS.owner) => api(m, `/crm${p}`, b, t);
const HEX32 = /^[0-9a-f]{32}$/;

test("AC4 reads: pipelines, tags, search, paging, archived filter", async () => {
  const p = await crm("GET", "/pipelines");
  expect(p.json.data[0].id).toBe("p_sales");
  expect(p.json.data[0].stages.map((s: any) => s.id)).toEqual(["st_lead", "st_won", "st_lost"]);
  expect((await crm("GET", "/tags")).json.data).toEqual(["renewal"]);
  expect((await crm("GET", "/tags?entity=person")).json.data).toEqual([]);
  const s = await crm("GET", "/search?q=INIT");
  expect(s.json.data.map((h: any) => [h.entity, h.id])).toEqual([["deal", "d_renewal"], ["company", "c_initech"]]);
  expect((await crm("GET", "/search?q=")).json.error.details.fields.q).toBeDefined();
  expect((await crm("GET", "/search?q=init&entity=company")).json.data).toHaveLength(1);

  const l = await crm("GET", "/deals?status=bogus");
  expect(l.json.data).toMatchObject({ total: 1, page: 1, per: 50 });
  expect(l.json.data.deals[0]).toMatchObject({
    id: "d_renewal", amount: "1200", currency: "USD", status: "open", company_name: "Initech", person_name: "Dana Lee",
    person_email: "dana@initech.test", owner_email: "owner@acme.test", archived: false,
  });
  expect(l.json.data.deals[0].notes).toBeUndefined();
  expect((await crm("GET", "/deals?archived=only")).json.data.deals.map((d: any) => d.id)).toEqual(["d_old"]);
  expect(fake.state.requests.at(-1)!.search).toBe("?archived=only");

  const pe = await crm("GET", "/people");
  expect(pe.json.data).toMatchObject({ total: 1, per: 50 });
  expect(pe.json.data.people[0]).toMatchObject({ id: "pe_dana", open_deals: 1, company: { id: "c_initech", name: "Initech" } });
  const co = await crm("GET", "/companies");
  expect(co.json.data.companies[0]).toMatchObject({ id: "c_initech", people: 1, open_deals: 1 });
});

test("AC4 deal detail, 404s, member read, teammate write 403", async () => {
  const d = (await crm("GET", "/deals/d_renewal")).json.data;
  expect(d).toMatchObject({ lost_reason: null, notes_count: 1, pipeline_currencies: ["USD"], stage: { id: "st_lead", kind: "open" } });
  expect(d.version).toMatch(HEX32);
  expect(d.tasks[0]).toMatchObject({ id: "ct_1", status: "open" });
  expect(d.stages).toHaveLength(3);
  expect(d.company.id).toBe("c_initech");
  expect(d.person.id).toBe("pe_dana");
  expect(d.company_name).toBeUndefined();
  expect((await crm("GET", "/deals/nope")).status).toBe(404);
  expect((await crm("GET", "/people/nope")).status).toBe(404);
  expect((await crm("GET", "/deals/d_renewal", undefined, TOKENS.teammate)).status).toBe(200);
  expect((await crm("POST", "/deals", { name: "x" }, TOKENS.teammate)).status).toBe(403);
  expect((await crm("POST", "/companies/c_initech/archive", { archived: true }, TOKENS.teammate)).status).toBe(403);
  expect((await crm("GET", "/bogus")).status).toBe(404);
  expect((await api("GET", "/crm/deals", undefined, TOKENS.multi, "beta")).json.data.total).toBe(0);
  expect((await crm("GET", "/deals", undefined, "oly_test_nope")).status).toBe(401);
});

test("AC4 deal writes: create, patch + version, conflict, move, owner, links, notes, tasks, archive", async () => {
  const c = await crm("POST", "/deals", { name: "New", amount: 50, company: { name: "Globex" }, person: { id: "pe_dana" } });
  expect(c.status).toBe(201);
  const nd = c.json.data;
  expect(nd).toMatchObject({ amount: "50", owner_email: "owner@acme.test", stage: { id: "st_lead" }, person: { id: "pe_dana" } });
  expect(nd.company.name).toBe("Globex");
  expect((await crm("POST", "/deals", {})).json.error.details.fields.name).toBeDefined();
  expect((await crm("POST", "/deals", { name: "x", stage: "zz" })).status).toBe(422);

  const v0 = (await crm("GET", "/deals/d_renewal")).json.data.version;
  const p = await crm("PATCH", "/deals/d_renewal", { next_action: "Call", tags: ["a"], version: v0 });
  expect(p.json.data).toMatchObject({ next_action: "Call", tags: ["a"], name: "Initech renewal" });
  expect(p.json.data.version).toMatch(HEX32);
  expect(p.json.data.version).not.toBe(v0);
  const bad = await crm("PATCH", "/deals/d_renewal", { name: "Z", version: v0 });
  expect(bad.status).toBe(409);
  expect(bad.json.error.code).toBe("conflict");
  expect(bad.json.error.details.current.version).toBe(p.json.data.version);
  expect(bad.json.error.details.current.name).toBe("Initech renewal");

  // a test can induce a conflict by changing the stored version mid-request
  expect(fake.state.crm.acme!.deals[0]!.version).toBe(p.json.data.version);

  expect((await crm("POST", "/deals/d_renewal/move", { stage: "st_won", from_stage: "st_lead" })).json.data)
    .toMatchObject({ status: "won", stage: { id: "st_won" }, history: [{ from_stage: "Lead", to_stage: "Won" }] });
  const same = await crm("POST", "/deals/d_renewal/move", { stage: "st_won" });
  expect(same.status).toBe(200);
  expect(same.json.data.history).toHaveLength(1);
  expect((await crm("POST", "/deals/d_renewal/move", { stage: "st_lost", from_stage: "st_lead" })).status).toBe(409);
  expect((await crm("POST", "/deals/d_renewal/move", { stage: "nope" })).status).toBe(422);

  expect((await crm("PUT", "/deals/d_renewal/owner", { owner: "me" }, TOKENS.owner)).json.data.owner_email).toBe("owner@acme.test");
  expect((await crm("PUT", "/deals/d_renewal/owner", { owner: null })).json.data.owner_email).toBeNull();
  expect((await crm("PUT", "/deals/d_renewal/owner", { owner: "x@y.z", expected: "wrong" })).status).toBe(409);
  expect((await crm("PUT", "/deals/d_renewal/company", { name: "Hooli" })).json.data.company.name).toBe("Hooli");
  expect((await crm("PUT", "/deals/d_renewal/company", { id: "zz" })).status).toBe(422);
  expect((await crm("PUT", "/deals/d_renewal/person", { full_name: "Bo" })).json.data.person.full_name).toBe("Bo");

  const n = await crm("POST", "/deals/d_renewal/notes", { body: "hi" });
  expect(n.status).toBe(201);
  expect(n.json.data.notes_count).toBe(2);
  expect((await crm("POST", "/deals/d_renewal/notes", { body: " " })).status).toBe(422);
  const t = await crm("POST", "/deals/d_renewal/tasks", { title: "Ping", assignee: "me" });
  expect(t.status).toBe(201);
  expect(t.json.data.tasks.at(-1)).toMatchObject({ title: "Ping", status: "open", assignee: "owner@acme.test" });
  expect((await crm("PATCH", "/deals/d_renewal/tasks/ct_1", { done: true })).json.data.tasks[0].status).toBe("done");
  expect((await crm("PATCH", "/deals/d_renewal/tasks/ct_1", { done: false })).json.data.tasks[0].status).toBe("open");
  expect((await crm("PATCH", "/deals/d_renewal/tasks/zz", { done: true })).status).toBe(404);
  expect((await crm("POST", "/deals/d_renewal/archive", { archived: true })).json.data.archived).toBe(true);
  expect((await crm("POST", "/deals/d_renewal/archive", { archived: false })).json.data.archived).toBe(false);
});

test("AC4 people and companies: detail, create, patch, conflict, archive", async () => {
  const pd = (await crm("GET", "/people/pe_dana")).json.data;
  expect(pd).toMatchObject({ full_name: "Dana Lee", company: { id: "c_initech" }, deals: [{ id: "d_renewal", status: "open" }] });
  expect(pd.version).toMatch(HEX32);
  const cd = (await crm("GET", "/companies/c_initech")).json.data;
  expect(cd.people).toEqual([{ id: "pe_dana", full_name: "Dana Lee", email: "dana@initech.test", job_title: null }]);
  expect(cd.deals[0].id).toBe("d_renewal");

  const np = await crm("POST", "/people", { full_name: "Eve", company: { id: "c_initech" } });
  expect(np.status).toBe(201);
  expect(np.json.data.company.id).toBe("c_initech");
  expect((await crm("POST", "/people", { email: "a@b.c" })).status).toBe(422);
  expect((await crm("POST", "/people", { full_name: "Z", company: { id: "zz" } })).status).toBe(422);
  const nc = await crm("POST", "/companies", { name: "Umbrella", city: "Raccoon" });
  expect(nc.status).toBe(201);
  expect(nc.json.data).toMatchObject({ name: "Umbrella", city: "Raccoon", deals: [], people: [] });
  expect((await crm("POST", "/companies", {})).status).toBe(422);

  const up = await crm("PATCH", "/companies/c_initech", { industry: "Software", version: cd.version });
  expect(up.json.data).toMatchObject({ industry: "Software", name: "Initech" });
  expect(up.json.data.version).not.toBe(cd.version);
  const cf = await crm("PATCH", "/people/pe_dana", { phone: "1", version: "0".repeat(32) });
  expect(cf.status).toBe(409);
  expect(cf.json.error.details.current.id).toBe("pe_dana");
  expect((await crm("POST", "/people/pe_dana/archive", { archived: true })).json.data.archived).toBe(true);
  expect((await crm("GET", "/people")).json.data.total).toBe(1); // Eve
  expect((await crm("GET", "/people?archived=include")).json.data.total).toBe(2);
});

test("seedCrm is resettable", async () => {
  await crm("POST", "/companies", { name: "Temp" });
  expect(fake.state.crm.acme!.companies).toHaveLength(2);
  fake.state.crm = seedCrm();
  expect((await crm("GET", "/companies")).json.data.total).toBe(1);
});

test("AC5 subscriptions: operator only, validation, secret once, ping, delete", async () => {
  const sub = (m: string, p: string, b?: unknown, t = TOKENS.owner) => api(m, `/subscriptions${p}`, b, t);
  const l = await sub("GET", "");
  expect(l.json.data[0]).toMatchObject({ id: "sub_000000000001", events: ["task.completed"], active: true, consecutive_failures: 0 });
  expect(l.json.data[0].secret).toBeUndefined();
  expect((await sub("GET", "", undefined, TOKENS.teammate)).status).toBe(403);
  expect((await sub("GET", "/sub_000000000001", undefined, TOKENS.teammate)).status).toBe(403);
  expect((await sub("GET", "/nope")).status).toBe(404);
  expect((await sub("GET", "/sub_000000000001")).json.data.name).toBe("seed");

  const c = await sub("POST", "", { name: "n", url: "https://x.test/h", events: ["*"] });
  expect(c.status).toBe(201);
  expect(c.json.secret).toMatch(/^[0-9a-f]{64}$/);
  expect(c.json.data.secret).toBeUndefined();
  expect(c.json.data).toMatchObject({ name: "n", events: ["*"], active: true, created_by: { id: "u_1" } });
  expect((await sub("GET", `/${c.json.data.id}`)).json.secret).toBeUndefined();
  for (const events of [[], ["bogus"], "task.created", undefined, ["*", "task.created"]])
    expect((await sub("POST", "", { name: "n", url: "u", events })).json.error.details.fields.events).toBeDefined();
  const m = await sub("POST", "", { events: ["ping"] });
  expect(m.status).toBe(422);
  expect(Object.keys(m.json.error.details.fields).sort()).toEqual(["name", "url"]);

  const u = await sub("PATCH", "/sub_000000000001", { active: false, events: ["task.created", "task.deleted"] });
  expect(u.json.data).toMatchObject({ active: false, events: ["task.created", "task.deleted"], name: "seed" });
  expect((await sub("PATCH", "/sub_000000000001", { events: [] })).status).toBe(422);
  const r = await sub("POST", "/sub_000000000001/rotate_secret");
  expect(r.json.secret).toMatch(/^[0-9a-f]{64}$/);
  expect(r.json.secret).not.toBe(c.json.secret);
  expect((await sub("POST", "/sub_000000000001/ping")).json).toEqual({ data: { delivered: true, status: 200, error: null } });
  expect((await sub("DELETE", "/sub_000000000001")).status).toBe(204);
  expect((await sub("GET", "/sub_000000000001")).status).toBe(404);

  const et = await api("GET", "/event_types", undefined, TOKENS.teammate);
  expect(et.status).toBe(200);
  expect(et.json.data).toEqual(["task.created", "task.updated", "task.completed", "task.reopened", "task.assigned", "task.deleted", "task.delegated", "ping"]);
  fake.state.subscriptions = seedSubscriptions();
  expect((await sub("GET", "")).json.data).toHaveLength(1);
});

test("D1 server shapes: search caps at 5 per entity, stage needs pipeline, narrow rows", async () => {
  const S = fake.state.crm.acme!;
  for (let i = 0; i < 8; i++) S.people.push({ ...S.people[0], id: `pe_${i}`, full_name: `Dana ${i}` });
  const hits = (await crm("GET", "/search?q=dana")).json.data;
  expect(hits.filter((h: any) => h.entity === "person")).toHaveLength(5);
  expect((await crm("GET", "/deals?stage=st_lead")).json.error.details.fields).toHaveProperty("stage");
  expect((await crm("GET", "/deals?stage=st_lead&pipeline=p_sales")).status).toBe(200);
  expect((await crm("POST", "/deals", { name: "x", stage: "st_lead" })).json.error.details.fields).toHaveProperty("stage");
  const co = (await crm("GET", "/companies")).json.data.companies[0];
  for (const k of ["website", "linkedin_url", "phone", "notes", "version"]) expect(co).not.toHaveProperty(k);
  const pe = (await crm("GET", "/people")).json.data.people[0];
  for (const k of ["linkedin_url", "notes", "version", "deal_count"]) expect(pe).not.toHaveProperty(k);
  expect(pe).toHaveProperty("open_deals");
  const dd = (await crm("GET", "/deals/d_renewal")).json.data;
  expect(dd.company).toMatchObject({ deal_count: 1 });
  expect(dd.company).not.toHaveProperty("deals");
  expect(dd.person).toMatchObject({ deal_count: 1 });
  expect(dd.person).not.toHaveProperty("deals");
  const ref = (await crm("GET", "/people/pe_dana")).json.data.deals[0];
  expect(ref.stage).toEqual({ name: "Lead", kind: "open" });
  expect(ref.pipeline.id).toBe("p_sales");
});
