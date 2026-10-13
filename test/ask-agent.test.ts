import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { appendMessage, seedSessions, startFake, TOKENS, type Step } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
const NOW = "2026-10-12T14:00:00Z";
beforeEach(() => {
  const s = fake.state;
  s.requests.length = 0;
  delete s.next;
  delete s.onRequest;
  s.sessions = seedSessions(NOW);
  s.turns = [];
  delete s.busy;
  delete s.machine;
});

type Opts = { tty?: boolean; stdin?: string; signal?: AbortSignal; onSleep?: (n: number) => void; skew?: { ms: number }; env?: Record<string, string> };
async function cli(args: string[], o: Opts = {}) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "", reads = 0, clock = 0;
  const sleeps: number[] = [];
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, OLYMPUS_API_KEY: TOKENS.owner, OLYMPUS_ORG: "acme", ...o.env }, home,
    stdin: async () => { reads++; return o.stdin ?? ""; },
    out: (s) => { out += s; }, err: (s) => { err += s; }, tty: o.tty ?? false, signal: o.signal,
    now: () => clock + (o.skew?.ms ?? 0), sleep: async (ms) => { sleeps.push(ms); clock += ms; o.onSleep?.(sleeps.length); },
  });
  return { code, out, err, reads, sleeps };
}
const ask = (args: string[], o: Opts = {}) => cli(["ask", "hermes", ...args], o);
const reqs = () => fake.state.requests;
const gets = () => reqs().filter((r) => r.method === "GET" && !r.path.endsWith("/people"));
const PEOPLE = "GET /api/v1/orgs/acme/people";
const posts = () => reqs().filter((r) => r.method === "POST");
const P = "/api/v1/orgs/acme/sessions";
const plan = (...steps: Step[]) => fake.state.turns.push(steps);
const errBody = (r: { err: string }) => JSON.parse(r.err).error;
const CTL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const clean = (s: string) => expect(CTL.test(s.replace(/\n/g, ""))).toBe(false);

test("a new session: create, send, then poll the whole thread", async () => {
  const r = await ask(["hello"]);
  expect(r).toMatchObject({ code: 0, out: "Got it: hello\n", err: "" });
  expect(reqs().map((q) => `${q.method} ${q.path}${q.search}`)).toEqual([
    PEOPLE, `POST ${P}`, `POST ${P}/202/messages`, `GET ${P}/202`, `GET ${P}/202`, `GET ${P}/202?after=1005`,
  ]);
  expect(posts()[0]!.body).toEqual({ agent: "hermes" });
  expect(posts()[1]!.body).toEqual({ text: "hello" });
});

test("--session reads first, prints nothing old, and polls after the last known message", async () => {
  const r = await ask(["more", "--session", "101"]);
  expect(r).toMatchObject({ code: 0, out: "Got it: more\n" });
  expect(r.out).not.toContain("test a 10% step");
  expect(reqs().map((q) => `${q.method} ${q.path}${q.search}`).slice(0, 5)).toEqual([
    PEOPLE, `GET ${P}/101`, `POST ${P}/101/messages`, `GET ${P}/101?after=1002`, `GET ${P}/101?after=1002`,
  ]);
});

test("a session with another agent is refused before anything is sent", async () => {
  fake.state.sessions.acme![0]!.agent = { slug: "other", name: "Other" };
  const r = await ask(["hi", "--session", "101", "--json"]);
  expect([r.code, r.out, errBody(r).code]).toEqual([6, "", "agent_mismatch"]);
  expect(posts()).toHaveLength(0);
});

test("TEXT - reads stdin once; blank text sends nothing", async () => {
  const r = await ask(["-"], { stdin: "from stdin\nline two" });
  expect([r.code, r.reads, posts()[1]!.body]).toEqual([0, 1, { text: "from stdin\nline two" }]);
  for (const o of [{ stdin: " \n " }, {}]) {
    reqs().length = 0;
    const b = await ask(["-"], o);
    expect([b.code, reqs().length, b.out]).toEqual([1, 0, ""]);
  }
  const c = await ask(["  "]);
  expect([c.code, reqs().length]).toEqual([1, 0]);
});

test("a turn that finishes between polls is read in one response", async () => {
  plan({ state: "queued" }, { state: "idle", reply: ["done"] });
  const r = await ask(["x"]);
  expect([r.code, r.out, gets().length]).toEqual([0, "done\n", 2]);
});

test("a queued turn without our message yet keeps polling", async () => {
  const r = await ask(["x", "--json"]);
  const b = JSON.parse(r.out);
  expect(b.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  expect(b.turn.state).toBe("idle");
  expect(b.session.id).toBe("202");
  expect(r.out.trim().split("\n")).toHaveLength(1);
});

test("several replies are joined by a blank line", async () => {
  plan({ state: "running" }, { state: "idle", reply: ["one", "two"] });
  expect((await ask(["x"])).out).toBe("one\n\ntwo\n");
});

test("idle at accept time with the reply two polls later is still printed", async () => {
  plan({ state: "idle" }, { state: "idle" }, { state: "idle", reply: ["late"] });
  const r = await ask(["x"]);
  expect([r.code, r.out, r.err]).toEqual([0, "late\n", ""]);
});

test("a turn that ends with no reply exits 0 with a note after three idle polls", async () => {
  plan({ state: "idle" });
  const r = await ask(["x"]);
  expect([r.code, r.out, gets().length]).toEqual([0, "", 3]);
  expect(r.err).toBe("note: the agent finished without a text reply; see olympus session get 202\n");
});

test("a failed turn exits 1 with its error and the session", async () => {
  plan({ state: "queued" }, { state: "failed", error: "model unavailable" });
  const r = await ask(["x"]);
  expect([r.code, r.out, r.err]).toEqual([1, "", "error: model unavailable (session 202)\n"]);
  plan({ state: "running" }, { state: "failed" });
  const j = await ask(["x", "--json"]);
  expect([j.code, j.out, errBody(j).code, errBody(j).details.session_id]).toEqual([1, "", "turn_failed", "203"]);
});

test("another client's messages while we wait for a busy agent are not part of our reply", async () => {
  fake.state.busy = 1;
  let first = true;
  fake.state.onRequest = ({ method, path }) => {
    if (method === "POST" && path.endsWith("/101/messages") && first) {
      first = false;
      appendMessage(fake.state, "acme", "101", "user", "teammate question", { id: "u_2", name: "Mate" });
      appendMessage(fake.state, "acme", "101", "assistant", "teammate answer");
    }
  };
  const r = await ask(["mine", "--session", "101", "--json"]);
  expect(r.code).toBe(0);
  expect(r.sleeps[0]).toBe(5000);
  expect(JSON.parse(r.out).messages.map((m: any) => m.text)).toEqual(["mine", "Got it: mine"]);
  expect(posts().map((q) => q.path)).toEqual([`${P}/101/messages`, `${P}/101/messages`]);
  expect(gets()[1]!.search).toBe("?after=1002");
});

test("another client's whole turn between our read and our accepted send is not part of our reply", async () => {
  let first = true;
  fake.state.onRequest = ({ method, path }) => {
    if (method === "POST" && path.endsWith("/101/messages") && first) {
      first = false;
      appendMessage(fake.state, "acme", "101", "user", "teammate question", { id: "u_2", name: "Mate" });
      appendMessage(fake.state, "acme", "101", "assistant", "teammate answer");
    }
  };
  const r = await ask(["mine", "--session", "101"]);
  expect([r.code, r.out]).toEqual([0, "Got it: mine\n"]);
});

test("no message is sent at or after the deadline, even when a nap runs out the clock", async () => {
  fake.state.busy = 1000;
  const r = await ask(["x", "--timeout", "12", "--json"]);
  expect([r.code, errBody(r).code, r.sleeps]).toEqual([5, "busy", [5000, 5000, 2000]]);
  expect(posts().filter((q) => q.path.endsWith("/messages"))).toHaveLength(3);
});

test("cancelling during the busy wait says nothing was sent", async () => {
  fake.state.busy = 1000;
  const ctl = new AbortController();
  const r = await ask(["x"], { signal: ctl.signal, onSleep: () => ctl.abort() });
  expect([r.code, r.out]).toEqual([130, ""]);
  expect(r.err).toContain("cancelled; nothing was sent (session 202)");
  expect(posts().filter((q) => q.path.endsWith("/messages"))).toHaveLength(1);
  const j = await ask(["x", "--json"], { signal: ctl.signal });
  expect([j.code, errBody(j).message]).toEqual([130, "cancelled; nothing was sent"]);
});

test("polling never runs faster than every two seconds", async () => {
  plan({ state: "running" });
  const r = await ask(["x", "--timeout", "10"]);
  expect(r.sleeps.every((ms) => ms >= 2000)).toBe(true);
  expect(gets().length).toBeLessThanOrEqual(10_000 / 2000 + 1);
});

test("a busy agent: two refusals, 5 s waits, then the reply", async () => {
  fake.state.busy = 2;
  const r = await ask(["x"]);
  expect([r.code, r.out]).toEqual([0, "Got it: x\n"]);
  expect(r.sleeps.slice(0, 2)).toEqual([5000, 5000]);
  expect(posts().filter((q) => q.path.endsWith("/messages"))).toHaveLength(3);
});

test("busy until the deadline exits 5 and says nothing was sent", async () => {
  fake.state.busy = 1000;
  const r = await ask(["x", "--timeout", "12", "--json"]);
  const e = errBody(r);
  expect([r.code, r.out, e.code, e.message, e.details.session_id]).toEqual([5, "", "busy", "the agent is still busy in session 202; nothing was sent", "202"]);
});

test("Retry-After on a busy message is honoured with a two-second floor; a date falls back to five", async () => {
  const wait = async (h: string | undefined) => {
    fake.state.busy = 0;
    reqs().length = 0;
    let n = 0;
    fake.state.next = undefined;
    fake.state.onRequest = ({ method, path }) => {
      if (method === "POST" && path.endsWith("/messages") && n++ === 0) fake.state.next = { status: 409, headers: h ? { "Retry-After": h } : undefined, body: { error: { code: "busy", message: "m" } } };
    };
    return (await ask(["x"])).sleeps[0];
  };
  expect(await wait("0")).toBe(2000);
  expect(await wait("9")).toBe(9000);
  expect(await wait("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(5000);
});

test("poll errors back off, honour Retry-After, and a success resets the wait", async () => {
  plan({ state: "queued" }, { state: "running" }, { state: "idle", reply: ["ok"] });
  let polls = 0;
  fake.state.onRequest = ({ method, path }) => {
    if (method !== "GET" || !path.endsWith("/202")) return;
    const n = ++polls;
    if (n <= 3) fake.state.next = { status: 503, headers: n === 1 ? { "Retry-After": "7" } : undefined, body: { error: { code: "machine_not_ready", message: "m" } } };
  };
  const r = await ask(["x"]);
  expect(r.code).toBe(0);
  expect(r.sleeps.slice(0, 5)).toEqual([2000, 7000, 4000, 8000, 2000]);
});

test("poll 401/403/404/422 stop at once with their codes", async () => {
  for (const [status, code, exit] of [[401, "unauthorized", 2], [403, "forbidden", 4], [404, "not_found", 3], [422, "invalid", 5]] as const) {
    reqs().length = 0;
    fake.state.onRequest = ({ method, path }) => {
      if (method === "GET" && path.endsWith("/202")) fake.state.next = { status, body: { error: { code, message: "m" } } };
    };
    const r = await ask(["x", "--json"]);
    expect([status, r.code, r.out, gets().length]).toEqual([status, exit, "", 1]);
    expect(errBody(r).details.session_id).toBe("202");
    fake.state.sessions = seedSessions(NOW);
  }
});

test("a failing message send is never retried (5xx, timeout)", async () => {
  for (const headers of [undefined, { "Retry-After": "3" }]) {
    reqs().length = 0;
    fake.state.next = undefined;
    fake.state.onRequest = ({ method, path }) => {
      if (method === "POST" && path.endsWith("/messages")) fake.state.next = { status: 503, headers, body: { error: { code: "machine_not_ready", message: "not ready" } } };
    };
    const r = await ask(["x"]);
    expect([r.code, r.out, r.sleeps.length, posts().filter((q) => q.path.endsWith("/messages")).length]).toEqual([5, "", 0, 1]);
    expect(r.err).toContain("(session ");
  }
  // A request that times out may still have been delivered: reported as such, and not repeated.
  reqs().length = 0;
  fake.state.onRequest = async ({ method, path }) => {
    if (method === "POST" && path.endsWith("/messages")) await Bun.sleep(1300);
  };
  const net = await ask(["x", "--timeout", "1", "--json"]);
  expect([net.code, net.out, errBody(net).message]).toEqual([5, "", `the message may have been sent; check olympus session get ${errBody(net).details.session_id}`]);
  expect(posts().filter((q) => q.path.endsWith("/messages"))).toHaveLength(1);
});

test("--timeout 10 with a turn that never ends: five reads, exit 5, how to read it later", async () => {
  plan({ state: "running" });
  const r = await ask(["x", "--timeout", "10"]);
  expect([r.code, r.out, gets().length]).toEqual([5, "", 5]);
  expect(r.err).toContain("olympus session get 202");
  expect(r.err).toContain("no reply within 10s");
});

test("bad --timeout values fail before any request", async () => {
  for (const t of ["0", "x", "86401", "-5", "1.5"]) {
    const r = await ask(["x", "--timeout", t]);
    expect([t, r.code, reqs().length]).toEqual([t, 1, 0]);
  }
});

test("--no-wait: piped id, terminal sentence, json object; no read after the accept", async () => {
  const p = await ask(["x", "--no-wait"]);
  expect([p.code, p.out, p.err]).toEqual([0, "202\n", ""]);
  expect(gets()).toHaveLength(0);
  const t = await ask(["x", "--no-wait"], { tty: true });
  expect(t.out).toBe("Sent to Hermes in session 203. Read the reply later: olympus session get 203\n");
  expect(t.err).toBe("");
  const j = JSON.parse((await ask(["x", "--no-wait", "--json"], { tty: true })).out);
  expect([j.session.id, j.messages, j.turn.state]).toEqual(["204", [], "queued"]);
});

test("--no-wait with --session still reads first and prints no session line", async () => {
  const r = await ask(["x", "--no-wait", "--session", "101"], { tty: true });
  expect(r.err).toBe("");
  expect(reqs().map((q) => q.method)).toEqual(["GET", "POST"]);
});

test("cancelling inside the third wait exits 130, names the session and makes no more requests", async () => {
  plan({ state: "running" });
  const ctl = new AbortController();
  let atAbort = 0;
  const r = await ask(["x"], { signal: ctl.signal, onSleep: (n) => { if (n === 3) { atAbort = reqs().length; ctl.abort(); } } });
  expect([r.code, r.out, reqs().length]).toEqual([130, "", atAbort]);
  expect(r.err).toContain("olympus session get 202");
  const j = await ask(["x", "--json"], { signal: ctl.signal });
  expect([j.code, errBody(j).code, reqs().length]).toEqual([130, "cancelled", atAbort]);
});

test("Ctrl-C on a real process exits 130 quickly and says how to read the reply", async () => {
  plan({ state: "running" });
  const tmp = await mkdtemp(join(tmpdir(), "oly-"));
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "ask", "hermes", "hi", "--host", fake.url], {
    cwd: tmp, env: { PATH: process.env.PATH!, HOME: tmp, OLYMPUS_API_KEY: TOKENS.owner, OLYMPUS_ORG: "acme" }, stdout: "pipe", stderr: "pipe",
  });
  const t0 = Date.now();
  while (!gets().length && Date.now() - t0 < 15_000) await Bun.sleep(25);
  expect(gets().length).toBeGreaterThan(0);
  const sent = Date.now();
  p.kill("SIGINT");
  const [code, err] = [await p.exited, await new Response(p.stderr).text()];
  expect(Date.now() - sent).toBeLessThan(5000);
  expect(code).toBe(130);
  expect(err).toContain("olympus session get");
}, 20_000);

test("outputs: reply only on a pipe; session line on a terminal for new sessions only", async () => {
  const t = await ask(["x"], { tty: true });
  expect([t.out, t.err]).toEqual(["Got it: x\n", "session 202\n"]);
  const s = await ask(["x", "--session", "101"], { tty: true });
  expect(s.err).toBe("");
  const j = await ask(["x", "--json"], { tty: true });
  expect(j.err).toBe("");
});

test("exit 6: no agent, closed session, unknown agent", async () => {
  fake.state.machine = "no_agent";
  expect((await ask(["x"])).code).toBe(6);
  delete fake.state.machine;
  const closed = await ask(["x", "--session", "103", "--json"]);
  expect([closed.code, closed.out, errBody(closed).code]).toEqual([6, "", "session_closed"]);
  const unknown = await cli(["ask", "nobody", "x"]);
  expect(unknown.code).toBe(6);
  expect(unknown.err).toContain("agent");
  fake.state.machine = "none";
  expect((await ask(["x"])).code).toBe(5);
});

test("a no-agent answer to the message itself exits 6", async () => {
  fake.state.onRequest = ({ method, path }) => {
    if (method === "POST" && path.endsWith("/messages")) fake.state.next = { status: 409, body: { error: { code: "no_agent", message: "No agent." } } };
  };
  expect((await ask(["x"])).code).toBe(6);
});

test("control characters in a reply never reach the terminal; newlines stay", async () => {
  plan({ state: "idle", reply: ["a\x1b[31mb\x1b]0;t\x07c\x9b2Jd\re\nf\tg"] });
  const r = await ask(["x"]);
  clean(r.out);
  expect(r.out).toContain("\nf g");
  expect(r.out).not.toContain("\x1b");
});

test("hand-built text is clean too: session line, mismatch, no-wait sentence", async () => {
  fake.state.sessions.acme![0]!.id = "10\x1b[2J1";
  const m = await ask(["x", "--session", "10\x1b[2J1"], { tty: true });
  clean(m.out + m.err);
  fake.state.sessions.acme![0]!.agent = { slug: "ev\x1bil", name: "E\x9bvil" };
  const n = await ask(["x", "--session", "10\x1b[2J1"], { tty: true });
  clean(n.err);
  const w = await ask(["x", "--no-wait"], { tty: true });
  clean(w.out + w.err);
});

test("the token never appears in output, whatever the server says", async () => {
  for (const status of [401, 404, 409, 422, 503]) {
    for (const tty of [false, true]) {
      for (const json of [false, true]) {
        fake.state.next = { status, body: { error: { code: "x", message: `bad ${status}`, details: { fields: { agent: ["no"] } } } } };
        const r = await ask(["x", ...(json ? ["--json"] : [])], { tty });
        expect(r.out + r.err).not.toContain(TOKENS.owner);
        if (r.code !== 0) expect(r.out).toBe("");
      }
    }
  }
}, 60_000);

test("usage errors send nothing", async () => {
  for (const a of [["x", "--wait"], ["x", "--session", ".."], ["x", "--session", ""], ["x", "--closed"], ["x", "--timeout", "5", "--no-wait"]]) {
    const r = await ask(a);
    expect([a.join(" "), r.code, reqs().length, r.out]).toEqual([a.join(" "), 1, 0, ""]);
  }
  for (const a of [["ask"], ["ask", "hermes"], ["ask", "hermes", "a", "b"]]) {
    const r = await cli(a);
    expect([r.code, reqs().length]).toEqual([1, 0]);
  }
});

test("nothing is sent once the deadline has passed, even on the first attempt", async () => {
  const skew = { ms: 0 };
  fake.state.onRequest = ({ method, path }) => {
    if (method === "POST" && path === P) skew.ms = 2000; // opening the session takes longer than --timeout
  };
  const r = await ask(["x", "--timeout", "1", "--json"], { skew });
  const e = errBody(r);
  expect([r.code, r.out, e.code, e.message, e.details.session_id]).toEqual([5, "", "not_sent", "no time left to send; nothing was sent", "202"]);
  expect(posts().filter((q) => q.path.endsWith("/messages"))).toHaveLength(0);
});

test("the reply stops at another sender's later question, even when it arrives in the same poll", async () => {
  plan({ state: "idle", user: false });
  let polls = 0;
  fake.state.onRequest = ({ method, path }) => {
    if (method === "GET" && path.endsWith("/101") && ++polls === 2) {
      appendMessage(fake.state, "acme", "101", "user", "mine", { id: "u_1", name: "Me" });
      appendMessage(fake.state, "acme", "101", "assistant", "mine answer");
      appendMessage(fake.state, "acme", "101", "user", "teammate question", { id: "u_2", name: "Mate" });
      appendMessage(fake.state, "acme", "101", "assistant", "teammate answer");
    }
  };
  const r = await ask(["mine", "--session", "101", "--json"]);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.messages.map((m: any) => m.text)).toEqual(["mine", "mine answer", "teammate question", "teammate answer"]);
  polls = 0;
  fake.state.sessions = seedSessions(NOW);
  plan({ state: "idle", user: false });
  const t = await ask(["mine", "--session", "101"]);
  expect([t.code, t.out]).toEqual([0, "mine answer\n"]);
});

test("the person's own later message is folded into the reply", async () => {
  plan({ state: "idle", user: false });
  let polls = 0;
  fake.state.onRequest = ({ method, path }) => {
    if (method === "GET" && path.endsWith("/101") && ++polls === 2) {
      const me = { id: "u_1", name: "Me" };
      appendMessage(fake.state, "acme", "101", "user", "mine", me);
      appendMessage(fake.state, "acme", "101", "assistant", "first");
      appendMessage(fake.state, "acme", "101", "user", "steer", me);
      appendMessage(fake.state, "acme", "101", "assistant", "second");
    }
  };
  expect((await ask(["mine", "--session", "101"])).out).toBe("first\n\nsecond\n");
});

test("stdin text with a trailing newline still matches the server's trimmed copy", async () => {
  plan({ state: "idle", reply: ["mine reply"] });
  fake.state.onRequest = ({ method, path }) => {
    if (method === "POST" && path.endsWith("/101/messages")) {
      appendMessage(fake.state, "acme", "101", "user", "teammate question", { id: "u_2", name: "Mate" });
      appendMessage(fake.state, "acme", "101", "assistant", "teammate answer");
    } else if (method === "GET") {
      const live = fake.state.sessions.acme!.find((x) => x.id === "101")!._live;
      if (live) live.text = live.text.trim(); // the server strips what it stores
    }
  };
  const r = await ask(["-", "--session", "101"], { stdin: "mine\n" });
  expect([r.code, r.out]).toEqual([0, "mine reply\n"]);
});

test("cancelling while the message is in flight says it may have been sent", async () => {
  const ctl = new AbortController();
  fake.state.onRequest = ({ method, path }) => {
    if (method === "POST" && path.endsWith("/messages")) ctl.abort();
  };
  const r = await ask(["x", "--json"], { signal: ctl.signal });
  expect([r.code, r.out, errBody(r).message]).toEqual([130, "", "cancelled; the message may have been sent; check olympus session get 202"]);
});

const teammateTurn = (text: string, answer: string) => {
  fake.state.onRequest = ({ method, path }) => {
    if (method === "POST" && path.endsWith("/101/messages")) {
      appendMessage(fake.state, "acme", "101", "user", text, { id: "u_2", name: "Mate" });
      appendMessage(fake.state, "acme", "101", "assistant", answer);
    }
  };
};

test("another person's whole turn before our message is visible is never printed", async () => {
  plan({ state: "idle", user: false }, { state: "idle", reply: ["mine reply"] });
  teammateTurn("teammate question", "teammate answer");
  const r = await ask(["mine", "--session", "101"]);
  expect([r.code, r.out]).toEqual([0, "mine reply\n"]);
});

// A teammate speaks after our message, between our polls; the session state then belongs to their turn.
const teammateAfterUs = (poll: number) => {
  let n = 0;
  fake.state.onRequest = ({ method, path }) => {
    if (method === "GET" && path.endsWith("/101") && ++n === poll) appendMessage(fake.state, "acme", "101", "user", "teammate question", { id: "u_2", name: "Mate" });
  };
};

test("a teammate's later turn failing does not fail ours", async () => {
  plan({ state: "running", reply: ["mine reply"] }, { state: "failed", error: "their boom" });
  teammateAfterUs(3);
  const r = await ask(["mine", "--session", "101"]);
  expect([r.code, r.out, r.err]).toEqual([0, "mine reply\n", ""]);
});

test("a teammate's later turn still running does not hold ours", async () => {
  plan({ state: "running", reply: ["mine reply"] }, { state: "running" });
  teammateAfterUs(3);
  const r = await ask(["mine", "--session", "101"]);
  expect([r.code, r.out, r.err]).toEqual([0, "mine reply\n", ""]);
});

test("a teammate speaking after a turn with no text finishes it without waiting", async () => {
  plan({ state: "running" }, { state: "running" });
  teammateAfterUs(3);
  const r = await ask(["mine", "--session", "101"]);
  expect([r.code, r.out]).toEqual([0, ""]);
  expect(r.err).toContain("finished without a text reply");
});

test("the same text from another sender is not taken for ours", async () => {
  plan({ state: "queued" }, { state: "idle", reply: ["mine reply"] });
  teammateTurn("mine", "teammate answer");
  const r = await ask(["mine", "--session", "101"]);
  expect([r.code, r.out]).toEqual([0, "mine reply\n"]);
});

test("our message never appearing while a teammate's turn does times out", async () => {
  plan({ state: "idle", user: false });
  teammateTurn("teammate question", "teammate answer");
  const r = await ask(["mine", "--session", "101", "--timeout", "10"]);
  expect([r.code, r.out]).toEqual([5, ""]);
  expect(r.err).toContain("olympus session get 101");
});

test("no row marked as the caller: bad_response and nothing is sent", async () => {
  fake.state.next = { status: 200, body: { data: [{ id: "u_1", name: "Me", kind: "user", me: false }] } };
  const r = await ask(["x", "--json"]);
  expect([r.code, r.out, errBody(r).code]).toEqual([5, "", "bad_response"]);
  expect(posts()).toHaveLength(0);
});

test("--no-wait never asks who the caller is", async () => {
  await ask(["x", "--no-wait"]);
  expect(reqs().some((q) => q.path.endsWith("/people"))).toBe(false);
});
