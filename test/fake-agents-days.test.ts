import { afterAll, beforeEach, expect, test } from "bun:test";
import { seedTasks, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  fake.state.today = "2026-10-07";
  fake.state.now = () => Date.parse("2026-10-07T12:00:00Z");
  fake.state.tasks = seedTasks(fake.state.today);
  fake.state.days = {};
});

async function api(method: string, path: string, body?: unknown, token: string | null = TOKENS.owner) {
  const res = await fetch(`${fake.url}/api/v1/orgs/acme${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, h: res.headers, json: text ? JSON.parse(text) : undefined };
}
const fieldsOf = (r: { json: any }) => r.json.error.details.fields;

test("delegate: 201, session shape, item stamped, version bumped, 404s", async () => {
  const r = await api("POST", "/tasks/trest001/delegate", { agent: "hermes" });
  expect(r.status).toBe(201);
  expect(r.h.get("cache-control")).toBe("no-store");
  const { task, session } = r.json.data;
  expect(session.id).toMatch(/^w[0-9a-z]{14}$/);
  expect(session).toEqual({ id: session.id, title: null, agent: "hermes", url: `${fake.url}/acme/sessions/${session.id}` });
  expect(task).toMatchObject({ id: "trest001", delegated_to: "hermes", delegated_at: "2026-10-07T12:00:00.000Z" });
  expect(Object.keys(task)).not.toContain("session_id");
  expect((await api("GET", "/tasks")).json.data.version).toBe(2);
  expect((await api("POST", "/tasks/trest001/delegate", {})).json.data.session.agent).toBe("hermes");
  expect((await api("POST", "/tasks/nope0000/delegate", {})).status).toBe(404);
  expect((await api("POST", "/tasks/trest001/delegate?week=2026-09-01", {})).status).toBe(404);
});

test("breakdown: 200, display name, two subtasks appended, injected 502", async () => {
  const r = await api("POST", "/tasks/trest001/breakdown", {});
  expect(r.status).toBe(200);
  expect(r.h.get("cache-control")).toBe("no-store");
  const { task, agent, added } = r.json.data;
  expect(agent).toBe("Hermes");
  expect(added.map((s: any) => [s.text, s.done, s.order])).toEqual([["First step", false, 2], ["Second step", false, 3]]);
  expect(added[0].id).toMatch(/^s[0-9a-z]{7}$/);
  expect(task.subtasks).toHaveLength(4);
  expect((await api("POST", "/tasks/trest001/breakdown", { agent: "Zed" })).json.data.agent).toBe("Zed");
  fake.state.next = { status: 502, body: JSON.stringify({ error: { code: "agent_failed", message: "x" } }) };
  expect((await api("POST", "/tasks/trest001/breakdown", {})).status).toBe(502);
});

test("async breakdown: 202 receipt with Location/Retry-After, steps per read, org-scoped 404, one active per org", async () => {
  fake.state.breakdowns = {};
  const r = await api("POST", "/tasks/trest001/breakdowns", { agent: "hermes" });
  expect([r.status, r.h.get("retry-after"), r.h.get("cache-control")]).toEqual([202, "3", "no-store"]);
  const h = r.json.data.id;
  expect(h).toMatch(/^bd_[0-9a-z]{20}$/);
  expect(r.h.get("location")).toBe(r.json.data.status_url);
  expect(r.json.data).toMatchObject({ status: "queued", task_id: "trest001", agent: "hermes", finished_at: null });
  expect((await api("POST", "/tasks/trest001/breakdowns", {})).json.data.id).toBe(h);
  const other = await api("POST", "/tasks/tback001/breakdowns", {});
  expect([other.status, other.h.get("retry-after"), other.json.error.code]).toEqual([429, "15", "rate_limited"]);
  expect((await api("GET", `/breakdowns/${h}`)).json.data.status).toBe("queued");
  expect((await api("GET", `/breakdowns/${h}`)).json.data.status).toBe("running");
  const done = (await api("GET", `/breakdowns/${h}`)).json.data;
  expect([done.status, done.added.map((s: any) => s.text), done.added.map((s: any) => s.id)]).toEqual(["succeeded", ["First step", "Second step"], done.added_ids]);
  expect((await api("GET", `/breakdowns/${h}`)).json.data.added_ids).toEqual(done.added_ids); // committed once
  const beta = await fetch(`${fake.url}/api/v1/orgs/beta/breakdowns/${h}`, { headers: { Authorization: `Bearer ${TOKENS.multi}` } });
  expect(beta.status).toBe(404);
  expect((await api("GET", "/breakdowns/bd_unknown")).status).toBe(404);
});

test("days list: Mon-Fri with nulls, week normalised, malformed 422", async () => {
  const r = await api("GET", "/days?week=2026-10-11");
  expect(r.status).toBe(200);
  expect(r.h.get("cache-control")).toBe("no-store");
  expect(r.json.data.week).toBe("2026-10-05");
  expect(r.json.data.days.map((d: any) => d.day)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  expect(r.json.data.days[0]).toEqual({ day: "2026-10-05", closed: false, closed_at: null, score: null, entry: null });
  const bad = await api("GET", "/days?week=nope");
  expect(bad.status).toBe(422);
  expect(fieldsOf(bad).week).toBeArray();
});

test("day get/put: entry shape, close semantics, 422 day", async () => {
  const D = "/days/2026-10-07";
  expect((await api("GET", D)).json.data).toEqual({ day: "2026-10-07", closed: false, closed_at: null, score: null, entry: null });
  const p = await api("PUT", D, { shipped: "a", blockers: ["x", "y"], learnings: ["l"], reflection: "r" });
  expect(p.status).toBe(200);
  expect(p.json.data).toEqual({
    day: "2026-10-07", closed: true, closed_at: "2026-10-07T12:00:00.000Z", score: null,
    entry: {
      shipped: "a", blockers: [{ id: "b1", text: "x" }, { id: "b2", text: "y" }], learnings: [{ id: "l1", text: "l" }], reflection: "r",
      summary: { tasks_created: 0, tasks_done: 0, one_thing_progress: 0, learnings: 1, allocation: [] }, agent_note: null, week_close: false,
    },
  });
  expect((await api("GET", D)).json.data).toEqual(p.json.data);
  fake.state.now = () => Date.parse("2026-10-07T15:00:00Z");
  const d = await api("PUT", D, { shipped: "b", close: false });
  expect(d.json.data.closed_at).toBe("2026-10-07T12:00:00.000Z");
  expect(d.json.data.entry).toMatchObject({ shipped: "b", reflection: "r" });
  const f = await api("PUT", "/days/2026-10-08", { close: false });
  expect(f.json.data).toMatchObject({ closed: false, closed_at: null });
  for (const bad of ["nope", "2026-10-10", "2026-13-40"]) {
    for (const m of ["GET", "PUT"]) {
      const x = await api(m, `/days/${bad}`, m === "PUT" ? {} : undefined);
      expect(x.status).toBe(422);
      expect(fieldsOf(x).day).toBeArray();
    }
  }
});

test("routing: wrong shape/method is 404, before auth", async () => {
  for (const [m, p] of [
    ["GET", "/tasks/trest001/delegate"], ["PATCH", "/tasks/trest001/breakdown"], ["POST", "/tasks/trest001/other"],
    ["POST", "/days"], ["DELETE", "/days/2026-10-07"], ["GET", "/days/2026-10-07/x"], ["POST", "/tasks/trest001/delegate/x"],
  ] as const) {
    expect((await api(m, p, m === "GET" ? undefined : {})).status).toBe(404);
  }
  expect((await api("POST", "/tasks/trest001/delegate", {}, null)).status).toBe(401);
});
