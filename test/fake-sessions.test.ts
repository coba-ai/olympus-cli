import { afterAll, beforeEach, expect, test } from "bun:test";
import { appendMessage, seedBriefings, seedSessions, startFake, TOKENS, type Step } from "./fake-api";

const NOW = "2026-10-12T14:00:00Z";
const fake = startFake();
afterAll(() => fake.stop());
beforeEach(() => {
  const s = fake.state;
  s.requests.length = 0;
  delete s.next;
  delete s.onRequest;
  s.today = "2026-10-12";
  s.sessions = seedSessions(NOW);
  s.briefings = seedBriefings("2026-10-12");
  s.turns = [];
  delete s.busy;
  delete s.machine;
  delete s.sessionsPer;
});

async function call(method: string, path: string, body?: unknown, token = TOKENS.owner) {
  const res = await fetch(`${fake.url}/api/v1/orgs/acme${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
}
const fields = (r: { json: any }) => Object.keys(r.json.error.details.fields).sort();
const post = (id: string, text: string) => call("POST", `/sessions/${id}/messages`, { text });
const get = (id: string, after?: string) => call("GET", `/sessions/${id}${after ? `?after=${after}` : ""}`);
const states = async (id: string, n: number) => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await get(id)).json.data.turn.state);
  return out;
};

test("seeds: owner sees 102, 101, 103 newest activity first; teammate sees only 201", async () => {
  const all = await call("GET", "/sessions?state=all");
  expect(all.json.data).toMatchObject({ total: 3, page: 1, per: 20 });
  expect(all.json.data.sessions.map((s: any) => s.id)).toEqual(["102", "101", "103"]);
  expect(all.json.data.sessions[0]).toEqual({
    id: "102", agent: { slug: "hermes", name: "Hermes" }, title: null, state: "open", opened_by: { id: "u_1", name: "Abe Owner" },
    created_at: "2026-10-12T13:50:00.000Z", last_activity_at: null, turn: { state: "idle", started_at: null, error: null },
  });
  expect((await call("GET", "/sessions", undefined, TOKENS.teammate)).json.data.sessions.map((s: any) => s.id)).toEqual(["201"]);
});

test("list: open by default, closed, agent filter, paging", async () => {
  expect((await call("GET", "/sessions")).json.data.sessions.map((s: any) => s.id)).toEqual(["102", "101"]);
  expect((await call("GET", "/sessions?state=closed")).json.data.sessions.map((s: any) => s.id)).toEqual(["103"]);
  expect((await call("GET", "/sessions?agent=nobody")).json.data).toMatchObject({ sessions: [], total: 0 });
  fake.state.sessionsPer = 1;
  const p2 = await call("GET", "/sessions?state=all&page=2");
  expect(p2.json.data).toMatchObject({ total: 3, page: 2, per: 1 });
  expect(p2.json.data.sessions.map((s: any) => s.id)).toEqual(["101"]);
});

test("list 422: state and page", async () => {
  const r = await call("GET", "/sessions?state=x&page=0");
  expect(r.status).toBe(422);
  expect(fields(r)).toEqual(["page", "state"]);
  expect(fields(await call("GET", "/sessions?page=x"))).toEqual(["page"]);
});

test("create: 201 shape, and 422 for agent, title and unknown keys", async () => {
  const ok = await call("POST", "/sessions", { agent: "hermes", title: "Hello" });
  expect(ok.status).toBe(201);
  expect(ok.json.data).toMatchObject({ id: "202", title: "Hello", state: "open", agent: { slug: "hermes" }, turn: { state: "idle" } });
  expect(ok.json.data.messages).toBeUndefined();
  expect((await call("POST", "/sessions", { agent: "hermes" })).json.data.title).toBeNull();
  for (const b of [{}, { agent: "nobody" }, { agent: "hera" }]) expect(fields(await call("POST", "/sessions", b))).toEqual(["agent"]);
  expect(fields(await call("POST", "/sessions", { agent: "hermes", title: "x".repeat(101) }))).toEqual(["title"]);
  expect(fields(await call("POST", "/sessions", { agent: "hermes", color: 1, pinned: 2 }))).toEqual(["color", "pinned"]);
});

test("thread: shape, cap, after, and 422 for an unknown after", async () => {
  const r = await get("101");
  expect(r.json.data.session.id).toBe("101");
  expect(r.json.data.messages.map((m: any) => [m.id, m.role, m.sender?.id ?? null])).toEqual([["1001", "user", "u_1"], ["1002", "assistant", null]]);
  expect(r.json.data.turn).toEqual({ state: "idle", started_at: null, error: null });
  expect((await get("101", "1001")).json.data.messages.map((m: any) => m.id)).toEqual(["1002"]);
  expect((await get("101", "1002")).json.data.messages).toEqual([]);
  const bad = await get("101", "999");
  expect(bad.status).toBe(422);
  expect(fields(bad)).toEqual(["after"]);
  for (let i = 0; i < 205; i++) appendMessage(fake.state, "acme", "102", "user", `m${i}`);
  expect((await get("102")).json.data.messages).toHaveLength(200);
});

test("visibility: another member's session is 404 on every route", async () => {
  for (const [m, p, b] of [["GET", "/sessions/201"], ["POST", "/sessions/201/messages", { text: "hi" }], ["DELETE", "/sessions/201"]] as const) {
    const r = await call(m, p, b);
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
  }
  expect((await call("GET", "/sessions/101", undefined, TOKENS.teammate)).status).toBe(404);
  expect((await call("GET", "/sessions/999")).status).toBe(404);
});

test("close: 200 with the session, idempotent, then messages are session_closed", async () => {
  for (let i = 0; i < 2; i++) expect((await call("DELETE", "/sessions/101")).json.data).toMatchObject({ id: "101", state: "closed" });
  const r = await post("101", "hi");
  expect([r.status, r.json.error.code]).toEqual([409, "session_closed"]);
  expect((await get("101")).status).toBe(200);
});

test("message 422: blank, missing, over the byte limit", async () => {
  for (const b of [{ text: "  " }, {}, { text: 5 }]) {
    const r = await call("POST", "/sessions/101/messages", b);
    expect(r.status).toBe(422);
    expect(fields(r)).toEqual(["text"]);
  }
  expect(fields(await post("101", "é".repeat(16001)))).toEqual(["text"]);
  expect((await post("101", "é".repeat(16000))).status).toBe(202);
});

test("default plan: queued, running, idle with the reply; the user message joins on the first non-queued GET", async () => {
  const r = await post("101", "hello");
  expect(r.status).toBe(202);
  expect(r.json.data).toEqual({ turn: { state: "queued", started_at: expect.any(String), error: null } });
  const a = await get("101", "1002");
  expect([a.json.data.turn.state, a.json.data.messages]).toEqual(["queued", []]);
  const b = await get("101", "1002");
  expect(b.json.data.turn.state).toBe("running");
  expect(b.json.data.turn.started_at).toBeString();
  expect(b.json.data.messages.map((m: any) => [m.role, m.text, m.sender?.id])).toEqual([["user", "hello", "u_1"]]);
  const c = await get("101", b.json.data.messages[0].id);
  expect(c.json.data.turn.state).toBe("idle");
  expect(c.json.data.messages.map((m: any) => [m.role, m.text])).toEqual([["assistant", "Got it: hello"]]);
  expect(Number(c.json.data.messages[0].id)).toBeGreaterThan(Number(b.json.data.messages[0].id));
  expect((await get("101", "1002")).json.data.messages).toHaveLength(2); // the last step repeats without adding messages
  expect((await post("101", "again")).status).toBe(202); // idle: not busy any more
});

test("failed plan: error text, no reply", async () => {
  fake.state.turns = [[{ state: "running" }, { state: "failed", error: "The agent ran out of credit." }]];
  await post("101", "x");
  expect((await get("101")).json.data.turn).toMatchObject({ state: "running" });
  const f = await get("101");
  expect(f.json.data.turn).toEqual({ state: "failed", started_at: expect.any(String), error: "The agent ran out of credit." });
  expect(f.json.data.messages.slice(-1)[0]).toMatchObject({ role: "user", text: "x" });
  expect((await post("101", "retry")).status).toBe(202);
});

test("never plan: stays running, busy, forever", async () => {
  fake.state.turns = [[{ state: "queued" }, { state: "running" }]];
  await post("101", "x");
  expect(await states("101", 4)).toEqual(["queued", "running", "running", "running"]);
  expect((await post("101", "y")).status).toBe(409);
});

test("race plan: idle at the 202, the reply arrives two polls later", async () => {
  fake.state.turns = [[{ state: "idle" }, { state: "idle" }, { state: "idle", reply: ["late"] }]];
  expect((await post("101", "x")).json.data.turn.state).toBe("idle");
  expect((await get("101", "1002")).json.data.messages.map((m: any) => m.role)).toEqual(["user"]);
  expect((await get("101", "1002")).json.data.messages.map((m: any) => m.role)).toEqual(["user"]);
  expect((await get("101", "1002")).json.data.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
});

test("empty plan: idle with no assistant message; multi-reply: several in order", async () => {
  fake.state.turns = [[{ state: "queued" }, { state: "idle" }]];
  await post("101", "x");
  await states("101", 2);
  expect((await get("101", "1002")).json.data.messages.map((m: any) => m.role)).toEqual(["user"]);
  fake.state.turns = [[{ state: "idle", reply: ["one", "two", "three"] }]];
  await post("101", "y");
  expect((await get("101")).json.data.messages.slice(-3).map((m: any) => m.text)).toEqual(["one", "two", "three"]);
});

test("a queued-only plan never shows the user message; user:false holds it back one more GET", async () => {
  fake.state.turns = [[{ state: "queued" }], [{ state: "running", user: false }, { state: "running" }]];
  await post("101", "q");
  await states("101", 3);
  expect((await get("101", "1002")).json.data.messages).toEqual([]);
  await call("DELETE", "/sessions/101");
  fake.state.sessions.acme![0]!.state = "open";
  fake.state.sessions.acme![0]!._live = undefined;
  await post("101", "h");
  expect((await get("101", "1002")).json.data.messages).toEqual([]);
  expect((await get("101", "1002")).json.data.messages.map((m: any) => m.text)).toEqual(["h"]);
});

test("busy: the next N posts are 409 busy with Retry-After 5, then accepted", async () => {
  fake.state.busy = 2;
  for (let i = 0; i < 2; i++) {
    const r = await post("101", "x");
    expect([r.status, r.json.error.code, r.headers.get("retry-after")]).toEqual([409, "busy", "5"]);
  }
  expect((await post("101", "x")).status).toBe(202);
  expect(fake.state.busy).toBe(0);
});

test("onRequest can add a teammate's messages mid-request (state is reachable)", async () => {
  fake.state.busy = 1;
  fake.state.onRequest = ({ method }) => {
    if (method === "POST") {
      appendMessage(fake.state, "acme", "101", "user", "from the browser", { id: "u_2", name: "Mia Mate" });
      appendMessage(fake.state, "acme", "101", "assistant", "browser reply");
    }
  };
  await post("101", "x");
  expect((await get("101", "1002")).json.data.messages.map((m: any) => m.text)).toEqual(["from the browser", "browser reply"]);
});

test("machine: none is 503 machine_not_ready, no_agent is 409; reads and close still work under no_agent", async () => {
  fake.state.machine = "none";
  const calls: [string, string, unknown?][] = [["GET", "/sessions/101"], ["POST", "/sessions", { agent: "hermes" }], ["POST", "/sessions/101/messages", { text: "x" }], ["POST", "/briefings/today"]];
  for (const [m, p, b] of calls) {
    const r = await call(m, p, b);
    expect([r.status, r.json.error.code]).toEqual([503, "machine_not_ready"]);
  }
  expect((await call("GET", "/sessions")).status).toBe(200);
  fake.state.machine = "no_agent";
  for (const [m, p, b] of calls.slice(1)) {
    const r = await call(m, p, b);
    expect([r.status, r.json.error.code]).toEqual([409, "no_agent"]);
  }
  expect((await get("101")).status).toBe(200);
});

test("briefings: ready today, none for other days, 422 for a bad day", async () => {
  const t = await call("GET", "/briefings/today");
  expect(t.json.data).toMatchObject({ day: "2026-10-12", state: "ready", session_id: "101" });
  expect(Object.keys(t.json.data.document)).toEqual(["headline", "summary", "items"]);
  expect(t.json.data.document.summary).toContain("\n");
  expect((await call("GET", "/briefings/2026-10-12")).json.data.state).toBe("ready");
  expect((await call("GET", "/briefings/2026-10-11")).json.data).toEqual({ day: "2026-10-11", state: "none", document: null, session_id: null, requested_at: null });
  for (const d of ["2026-13-01", "nope", "2026-02-30"]) {
    const r = await call("GET", `/briefings/${d}`);
    expect([r.status, ...fields(r)]).toEqual([422, "day"]);
  }
  expect((await call("POST", "/briefings/2026-10-11")).status).toBe(404);
});

test("briefing request: 202 pending once, then the same row; teammate is not set up", async () => {
  const a = await call("POST", "/briefings/today", undefined, TOKENS.pinned);
  expect(a.status).toBe(202);
  expect(a.json.data).toMatchObject({ day: "2026-10-12", state: "pending", document: null });
  expect(a.json.data.session_id).toBeString();
  expect(a.json.data.requested_at).toBeString();
  const b = await call("POST", "/briefings/today", undefined, TOKENS.pinned);
  expect([b.status, b.json.data]).toEqual([202, a.json.data]);
  expect((await call("GET", "/briefings/today", undefined, TOKENS.pinned)).json.data.state).toBe("pending");
  expect((await call("POST", "/briefings/today")).json.data.state).toBe("ready"); // owner already has one
  const t = await call("POST", "/briefings/today", undefined, TOKENS.teammate);
  expect([t.status, t.json.error.code]).toEqual([409, "briefing_not_set_up"]);
});

test("Cache-Control: no-store on every sessions and briefing response, errors included", async () => {
  fake.state.busy = 1;
  const rs = [
    await call("GET", "/sessions"), await call("GET", "/sessions?state=x"), await call("POST", "/sessions", { agent: "hermes" }),
    await call("POST", "/sessions", {}), await get("101"), await get("201"), await get("101", "nope"), await post("101", "x"), await post("101", " "),
    await call("DELETE", "/sessions/103"), await call("GET", "/briefings/today"), await call("GET", "/briefings/bad"),
    await call("POST", "/briefings/today", undefined, TOKENS.teammate), await call("POST", "/briefings/today"),
  ];
  expect(rs.map((r) => r.status)).toEqual([200, 422, 201, 422, 200, 404, 422, 409, 422, 200, 200, 422, 409, 202]);
  for (const r of rs) expect(r.headers.get("cache-control")).toBe("no-store");
  fake.state.machine = "none";
  expect((await post("101", "x")).headers.get("cache-control")).toBe("no-store");
});

test("auth: no token is 401; state.next still overrides", async () => {
  const res = await fetch(`${fake.url}/api/v1/orgs/acme/sessions`);
  expect(res.status).toBe(401);
  fake.state.next = { status: 503, body: "{}" };
  expect((await call("GET", "/sessions")).status).toBe(503);
});
