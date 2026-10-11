import { afterAll, beforeEach, expect, test } from "bun:test";
import { seedTasks, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  fake.state.today = "2026-10-07"; // Wednesday; week 2026-10-05
  fake.state.now = () => Date.parse("2026-10-07T12:00:00Z");
  fake.state.tasks = seedTasks(fake.state.today);
});

const W = "2026-10-05";
async function api(method: string, path: string, body?: unknown, token = TOKENS.owner, org = "acme") {
  const res = await fetch(`${fake.url}/api/v1/orgs/${org}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, h: res.headers, json: text ? JSON.parse(text) : undefined };
}
const fieldsOf = (r: { json: any }) => r.json.error.details.fields;

test("AC1 people: members by name, agents primary first, me only on caller, no-store", async () => {
  const r = await api("GET", "/people");
  expect(r.status).toBe(200);
  expect(r.h.get("cache-control")).toBe("no-store");
  expect(r.json.data.map((p: any) => [p.id, p.kind, p.me])).toEqual([
    ["u_1", "user", true], ["u_4", "user", false], ["u_2", "user", false], ["u_3", "user", false],
    ["hermes", "agent", false], ["hera", "agent", false],
  ]);
  expect(r.json.data[0]).toMatchObject({ name: "Abe Owner", email: "owner@acme.test" });
  expect(r.json.data[5]).toMatchObject({ paused: true });
  const t = await api("GET", "/people", undefined, TOKENS.teammate);
  expect(t.json.data.filter((p: any) => p.me).map((p: any) => p.id)).toEqual(["u_2"]);
  // beta: multi only (pinned is pinned to acme)
  const b = await api("GET", "/people", undefined, TOKENS.multi, "beta");
  expect(b.json.data.filter((p: any) => p.kind === "user").map((p: any) => p.id)).toEqual(["u_4"]);
  expect((await api("GET", "/people", undefined, TOKENS.pinned, "beta")).status).toBe(404);
});

test("AC2 week: shape, ISO Monday, malformed 422, non-current empty read stores nothing, write creates", async () => {
  const r = await api("GET", "/tasks");
  expect(r.h.get("cache-control")).toBe("no-store");
  expect(r.json.data).toMatchObject({ week: W, current: true, version: 1, me: "u_1" });
  expect(r.json.data.tasks.map((t: any) => t.id)).toEqual(["tstar001", "trest001", "tdone001", "tback001", "tunk0001", "tlegacy1"]);
  expect((await api("GET", "/tasks?week=2026-10-11")).json.data.week).toBe(W); // Sunday
  for (const bad of ["nope", "", "2026-13-40"]) {
    const x = await api("GET", `/tasks?week=${bad}`);
    expect(x.status).toBe(422);
    expect(x.json.error.code).toBe("invalid");
    expect(fieldsOf(x).week).toBeArray();
  }
  const old = await api("GET", "/tasks?week=2026-09-01");
  expect(old.json.data).toMatchObject({ week: "2026-08-31", current: false, version: 0, tasks: [] });
  expect(Object.keys(fake.state.tasks.acme!)).toEqual([W]);
  const w = await api("POST", "/tasks?week=2026-09-01", { text: "old" });
  expect(w.status).toBe(201);
  expect((await api("GET", "/tasks?week=2026-08-31")).json.data).toMatchObject({ version: 1 });
});

test("AC3 strict types, text rules, unknown keys ignored", async () => {
  const cases: [any, string][] = [
    [{ text: 1 }, "text"], [{ text: "  " }, "text"], [{}, "text"], [{ text: "x", description: 1 }, "description"],
    [{ text: "x", section: 1 }, "section"], [{ text: "x", section: "one_thing" }, "section"],
    [{ text: "x", tags: "a" }, "tags"], [{ text: "x", tags: [1] }, "tags"],
    [{ text: "x", done: "yes" }, "done"], [{ text: "x", today: 1 }, "today"], [{ text: "x", one_thing: null }, "one_thing"],
  ];
  for (const [b, k] of cases) {
    const r = await api("POST", "/tasks", b);
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("invalid");
    expect(fieldsOf(r)[k]).toBeArray();
  }
  const ok = await api("POST", "/tasks", { text: "hi", tags: ["a"], bogus: 1 });
  expect(ok.status).toBe(201);
  expect(ok.json.data).toMatchObject({ text: "hi", tags: ["a"], section: "the_rest", done: false, added_on: "2026-10-07", subtasks: [] });
  expect(ok.json.data.bogus).toBeUndefined();
  const u = await api("PATCH", "/tasks/tstar001", { text: " " });
  expect(u.status).toBe(422);
  expect((await api("PATCH", "/tasks/tstar001", { description: "d", section: "backlog" })).json.data).toMatchObject({ description: "d", section: "backlog", text: "Star task" });
});

test("AC4 assignee forms and refusals", async () => {
  const k = { id: "u_2", name: "Mia Mate", kind: "user" };
  for (const v of ["u_2", "MATE@acme.test"]) expect((await api("PATCH", "/tasks/tback001", { assignee: v })).json.data.assignee).toEqual(k);
  expect((await api("PATCH", "/tasks/tback001", { assignee: "me" })).json.data.assignee).toEqual({ id: "u_1", name: "Abe Owner", kind: "user" });
  expect((await api("PATCH", "/tasks/tback001", { assignee: "hermes" })).json.data.assignee).toEqual({ id: "hermes", name: "Hermes", kind: "agent" });
  expect((await api("PATCH", "/tasks/tback001", { assignee: null })).json.data.assignee).toBeNull();
  const nobody = await api("PATCH", "/tasks/tback001", { assignee: "ghost" });
  expect(nobody.status).toBe(422);
  expect(fieldsOf(nobody).assignee).toEqual(["must be a member or agent of this organization"]);
  expect(fieldsOf(await api("PATCH", "/tasks/tback001", { assignee: "" })).assignee).toEqual(["must be a member or agent of this organization"]);
  expect(fieldsOf(await api("POST", "/tasks", { text: "x", assignee: "hera" })).assignee).toEqual(["is paused"]);
  const t = await api("GET", "/tasks/tunk0001");
  expect(t.json.data.assignee).toEqual({ id: "u_9", name: null, kind: null });
  expect((await api("GET", "/tasks/tback001", undefined, TOKENS.teammate)).json.data.assignee).toBeNull();
  expect((await api("PATCH", "/tasks/tback001", { assignee: "me" }, TOKENS.teammate)).json.data.assignee.id).toBe("u_2");
});

test("AC5 today/one_thing refusals and done_at", async () => {
  const past = "?week=2026-09-01";
  expect(fieldsOf(await api("POST", `/tasks${past}`, { text: "x", today: true })).today).toBeArray();
  expect(fieldsOf(await api("POST", `/tasks${past}`, { text: "x", assignee: "me", one_thing: true })).one_thing).toBeArray();
  expect((await api("POST", `/tasks${past}`, { text: "x", today: false, one_thing: false })).status).toBe(201);
  expect(fieldsOf(await api("PATCH", "/tasks/tback001", { one_thing: true })).one_thing).toBeArray(); // no assignee
  expect((await api("PATCH", "/tasks/tback001", { one_thing: true, assignee: "me" })).json.data.one_thing).toBe(true);
  expect((await api("PATCH", "/tasks/tback001", { today: true })).json.data.today).toBe(true);
  const d = await api("PATCH", "/tasks/tback001", { done: true });
  expect(d.json.data).toMatchObject({ done: true, done_at: "2026-10-07T12:00:00.000Z" });
  fake.state.now = () => Date.parse("2026-10-07T13:00:00Z");
  expect((await api("PATCH", "/tasks/tback001", { done: true })).json.data.done_at).toBe("2026-10-07T12:00:00.000Z");
  expect((await api("PATCH", "/tasks/tback001", { done: false })).json.data).toMatchObject({ done: false, done_at: null });
  expect((await api("GET", "/tasks/tlegacy1")).json.data).toMatchObject({ section: "one_thing", one_thing: true });
});

test("AC6 ids, 404s, 204 delete, subtask routes return parent, version, any member", async () => {
  expect((await api("GET", "/tasks/nope")).json).toEqual({ error: { code: "not_found", message: "Not found" } });
  expect((await api("PATCH", "/tasks/nope", { done: true })).status).toBe(404);
  expect((await api("DELETE", "/tasks/nope")).status).toBe(404);
  expect((await api("GET", "/tasks/tback001?week=2026-09-01")).status).toBe(404);
  const c = await api("POST", "/tasks", { text: "x" }, TOKENS.teammate);
  expect(c.status).toBe(201);
  expect(c.json.data.id).toMatch(/^t[0-9a-z]{7}$/);
  const id = c.json.data.id;
  const v = () => api("GET", "/tasks").then((r) => r.json.data.version);
  expect(await v()).toBe(2);
  const s = await api("POST", `/tasks/${id}/subtasks`, { text: "sub", assignee: "u_2" }, TOKENS.teammate);
  expect(s.status).toBe(201);
  expect(s.json.data.id).toBe(id);
  expect(s.json.data.subtasks[0].id).toMatch(/^s[0-9a-z]{7}$/);
  expect(s.json.data.subtasks[0].assignee.id).toBe("u_2");
  const sid = s.json.data.subtasks[0].id;
  expect(await v()).toBe(3);
  const p = await api("PATCH", `/tasks/${id}/subtasks/${sid}`, { done: true });
  expect(p.status).toBe(200);
  expect(p.json.data.subtasks[0]).toMatchObject({ done: true, done_at: "2026-10-07T12:00:00.000Z" });
  expect((await api("POST", `/tasks/${id}/subtasks`, { text: " " })).status).toBe(422);
  expect((await api("PATCH", `/tasks/${id}/subtasks/nope`, { done: true })).status).toBe(404);
  const del = await api("DELETE", `/tasks/${id}/subtasks/${sid}`);
  expect(del.status).toBe(200);
  expect(del.json.data).toMatchObject({ id, subtasks: [] });
  expect(await v()).toBe(5);
  const rm = await fetch(`${fake.url}/api/v1/orgs/acme/tasks/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${TOKENS.teammate}` } });
  expect(rm.status).toBe(204);
  expect(rm.headers.get("cache-control")).toBe("no-store");
  expect((await api("GET", `/tasks/${id}`)).status).toBe(404);
});

test("AC7 routing: unknown paths 404 before auth, log has search, path unchanged", async () => {
  const bare = (p: string) => fetch(`${fake.url}/api/v1/orgs/acme${p}`);
  expect((await bare("/tasks/a/b/c/d/e")).status).toBe(404);
  expect((await bare("/tasks/a/nothing")).status).toBe(404);
  expect((await bare("/tasks")).status).toBe(401);
  expect((await bare("/people")).status).toBe(401);
  fake.state.requests.length = 0;
  await api("GET", "/tasks?week=2026-10-07");
  expect(fake.state.requests[0]).toMatchObject({ method: "GET", path: "/api/v1/orgs/acme/tasks", search: "?week=2026-10-07" });
  expect((await api("GET", "/tasks", undefined, TOKENS.owner, "zzz")).status).toBe(404);
});

test("tags: org-wide, most used first, no-store, auth and membership like people", async () => {
  fake.state.tasks.acme![W]!.tasks[0]!.tags = ["web"];
  fake.state.tasks.acme!["2026-09-28"] = { version: 1, tasks: [{ id: "told0001", text: "old", tags: ["web", "old"], subtasks: [] }] };
  const r = await api("GET", "/tags");
  expect(r.status).toBe(200);
  expect(r.h.get("cache-control")).toBe("no-store");
  expect(r.json).toEqual({ data: ["web", "pricing", "old"] });
  expect((await api("GET", "/tags", undefined, "bad")).status).toBe(401);
  expect((await api("GET", "/tags", undefined, TOKENS.pinned, "beta")).status).toBe(404);
});

test("AC30 add_tags / remove_tags: exact strings, strict arrays, not with tags", async () => {
  await api("PATCH", "/tasks/trest001", { tags: ["a", "b"] });
  const r = await api("PATCH", "/tasks/trest001", { add_tags: [" c ", "a", " "], remove_tags: ["b", "B"] });
  expect(r.status).toBe(200);
  expect(r.json.data.tags).toEqual(["a", "c"]);
  expect((await api("PATCH", "/tasks/trest001", { remove_tags: ["zz"] })).json.data.tags).toEqual(["a", "c"]);
  for (const b of [{ add_tags: "a" }, { remove_tags: [1] }, { add_tags: null }]) {
    const x = await api("PATCH", "/tasks/trest001", b);
    expect(x.status).toBe(422);
    expect(fieldsOf(x)[Object.keys(b)[0]!]).toBeArray();
  }
  for (const k of ["add_tags", "remove_tags"]) {
    const x = await api("PATCH", "/tasks/trest001", { tags: ["q"], [k]: ["z"] });
    expect(x.status).toBe(422);
    expect(fieldsOf(x).tags).toBeArray();
  }
  expect((await api("GET", "/tasks/trest001")).json.data.tags).toEqual(["a", "c"]);
});
