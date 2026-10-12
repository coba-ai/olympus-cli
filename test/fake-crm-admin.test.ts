import { afterAll, beforeEach, expect, test } from "bun:test";
import { seedCrm, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  fake.state.crm = seedCrm();
  fake.state.idempotency = {};
});

async function crm(method: string, path: string, body?: unknown, token = TOKENS.owner, headers: Record<string, string> = {}) {
  const res = await fetch(`${fake.url}/api/v1/orgs/acme/crm${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, res };
}

test("pipelines: create, detail, patch with version, archive, list", async () => {
  const c = await crm("POST", "/pipelines", { name: "Ops", stages: [{ name: "A", kind: "open" }, { name: "B", kind: "won" }], currencies: ["EUR"] });
  expect(c.status).toBe(201);
  const p = c.json.data;
  expect(p).toMatchObject({ name: "Ops", currencies: ["EUR"], archived: false, archived_stages: [] });
  expect(p.stages.map((s: any) => s.name)).toEqual(["A", "B"]);
  expect((await crm("POST", "/pipelines", { name: "x", stages: [] })).status).toBe(422);

  const [a, b] = p.stages;
  const u = await crm("PATCH", `/pipelines/${p.id}`, { name: "Ops2", version: p.version, stages: [{ id: b.id, name: "B", kind: "won" }, { name: "C", kind: "lost" }], removals: [{ stage: a.id, move_to: b.id }] });
  expect(u.status).toBe(200);
  expect(u.json.data.name).toBe("Ops2");
  expect(u.json.data.stages.map((s: any) => s.name)).toEqual(["B", "C"]);
  expect(u.json.data.archived_stages).toEqual([{ id: a.id, name: "A", kind: "open" }]);
  expect(u.json.data.version).not.toBe(p.version);

  const stale = await crm("PATCH", `/pipelines/${p.id}`, { name: "no", version: p.version });
  expect(stale.status).toBe(409);
  expect(stale.json.error.details.current.name).toBe("Ops2");
  const r = await crm("PATCH", `/pipelines/${p.id}`, { restores: [a.id] });
  expect(r.json.data.stages.map((s: any) => s.id)).toContain(a.id);

  expect((await crm("POST", `/pipelines/${p.id}/archive`, { archived: true })).json.data.archived).toBe(true);
  expect((await crm("GET", "/pipelines")).json.data.map((x: any) => x.id)).toEqual(["p_sales"]);
  const all = (await crm("GET", "/pipelines?archived=include")).json.data;
  expect(all.map((x: any) => [x.id, x.archived])).toEqual([["p_sales", false], [p.id, true]]);
  expect((await crm("GET", "/pipelines")).json.data[0]).toHaveProperty("archived", false);
  expect((await crm("GET", "/pipelines/p_sales")).json.data).toMatchObject({ id: "p_sales", archived: false, archived_stages: [] });
  expect((await crm("GET", "/pipelines/nope")).status).toBe(404);
});

test("deletion preview, delete, unlink", async () => {
  expect((await crm("GET", "/deals/d_renewal/deletion_preview")).json.data).toEqual({ entity: "deal", id: "d_renewal", name: "Initech renewal", impact: { notes: 1, tasks: 1 } });
  expect((await crm("GET", "/people/pe_dana/deletion_preview")).json.data.impact).toEqual({ deals_unlinked: 1 });
  expect((await crm("GET", "/companies/c_initech/deletion_preview")).json.data.impact).toEqual({ people_unlinked: 1, deals_unlinked: 1 });
  const un = await crm("DELETE", "/deals/d_renewal/company");
  expect(un.status).toBe(200);
  expect(un.json.data.company).toBeNull();
  expect((await crm("DELETE", "/deals/d_renewal/person")).json.data.person).toBeNull();
  expect((await crm("DELETE", "/deals/d_old")).status).toBe(204);
  expect((await crm("GET", "/deals/d_old")).status).toBe(404);
  expect((await crm("DELETE", "/companies/c_initech")).status).toBe(204);
  expect((await crm("DELETE", "/companies/c_initech")).status).toBe(404);
  expect((await crm("DELETE", "/people/pe_dana", undefined, TOKENS.teammate)).status).toBe(403);
});

test("record tasks and the org-wide toggle; detail extras only when stored", async () => {
  const person = (await crm("GET", "/people/pe_dana")).json.data;
  expect(person).not.toHaveProperty("tasks");
  expect(person).not.toHaveProperty("interactions");
  expect((await crm("GET", "/deals/d_renewal")).json.data).not.toHaveProperty("legacy_notes");
  const t = await crm("POST", "/people/pe_dana/tasks", { title: "Call", due_at: "2026-11-01", assignee: "me" });
  expect(t.status).toBe(201);
  expect(t.json.data.tasks).toMatchObject([{ title: "Call", status: "open", due_at: "2026-11-01", assignee: "owner@acme.test" }]);
  const co = await crm("POST", "/companies/c_initech/tasks", { title: "Visit" });
  expect(co.json.data.tasks).toHaveLength(1);
  expect((await crm("POST", "/companies/c_initech/tasks", { title: " " })).status).toBe(422);
  const id = t.json.data.tasks[0].id;
  expect((await crm("PATCH", `/tasks/${id}`, { done: true })).json.data).toEqual({ id, title: "Call", status: "done", due_at: "2026-11-01", assignee: "owner@acme.test" });
  expect((await crm("PATCH", "/tasks/ct_1", { done: true })).json.data.status).toBe("done");
  expect((await crm("PATCH", "/tasks/nope", { done: true })).status).toBe(404);
  fake.state.crm.acme!.deals[0]!.interactions = [{ kind: "call" }];
  fake.state.crm.acme!.deals[0]!.legacy_notes = "old";
  const d = (await crm("GET", "/deals/d_renewal")).json.data;
  expect(d).toMatchObject({ interactions: [{ kind: "call" }], legacy_notes: "old" });
});

test("idempotency: log field, replay, reuse, malformed, teammate", async () => {
  const k = { "Idempotency-Key": "key-1" };
  const first = await crm("POST", "/deals", { name: "X" }, TOKENS.owner, k);
  expect(first.status).toBe(201);
  expect(fake.state.requests.at(-1)!.idem).toBe("key-1");
  const again = await crm("POST", "/deals", { name: "X" }, TOKENS.owner, k);
  expect(again.status).toBe(201);
  expect(again.res.headers.get("Idempotent-Replayed")).toBe("true");
  expect(again.json.data.id).toBe(first.json.data.id);
  expect(fake.state.crm.acme!.deals.filter((d) => d.name === "X")).toHaveLength(1);
  expect(first.res.headers.get("Idempotent-Replayed")).toBeNull();

  const body = await crm("POST", "/deals", { name: "Y" }, TOKENS.owner, k);
  expect(body.status).toBe(422);
  expect(body.json.error.details.fields.idempotency_key).toEqual(["was already used for a different request"]);
  const route = await crm("POST", "/people", { full_name: "X" }, TOKENS.owner, k);
  expect(route.json.error.details.fields.idempotency_key).toEqual(["was already used for a different request"]);
  expect((await crm("POST", "/people", { full_name: "Z" }, TOKENS.owner, { "Idempotency-Key": "bad key!" })).json.error.details.fields.idempotency_key).toEqual(["is invalid"]);
  expect(fake.state.requests.at(-1)!.idem).toBe("bad key!");

  const t = await crm("POST", "/companies/c_initech/tasks", { title: "T" }, TOKENS.owner, { "Idempotency-Key": "k2" });
  await crm("POST", "/companies/c_initech/tasks", { title: "T" }, TOKENS.owner, { "Idempotency-Key": "k2" });
  expect(t.json.data.tasks).toHaveLength(1);
  expect(fake.state.crm.acme!.companies[0]!.tasks).toHaveLength(1);
  expect((await crm("POST", "/deals", { name: "W" }, TOKENS.teammate, { "Idempotency-Key": "k3" })).status).toBe(403);
  await crm("GET", "/deals");
  expect(fake.state.requests.at(-1)!.idem).toBeNull();
});
