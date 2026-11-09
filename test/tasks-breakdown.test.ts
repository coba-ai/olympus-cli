import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { seedTasks, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
const NOW = Date.parse("2026-10-07T14:00:00Z");
const BD = "/api/v1/orgs/acme/breakdowns/";
const START = "/api/v1/orgs/acme/tasks/tback001/breakdowns";
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  delete fake.state.onRequest;
  delete fake.state.breakdownSteps;
  fake.state.breakdowns = {};
  fake.state.today = "2026-10-07";
  fake.state.now = () => NOW;
  fake.state.tasks = seedTasks(fake.state.today);
});

type Opts = { tty?: boolean; signal?: AbortSignal; onSleep?: (n: number) => void; host?: string };
async function cli(args: string[], o: Opts = {}) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "", clock = NOW;
  const sleeps: number[] = [];
  const code = await run([...args, "--org", "acme"], {
    env: { OLYMPUS_HOST: o.host ?? fake.url, OLYMPUS_API_KEY: TOKENS.owner }, home, stdin: async () => "",
    out: (s) => { out += s; }, err: (s) => { err += s; }, tty: o.tty ?? false, signal: o.signal,
    now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; o.onSleep?.(sleeps.length); },
  });
  return { code, out, err, sleeps };
}
const bd = (args: string[], o?: Opts) => cli(["task", "breakdown", "tback001", ...args], o);
const reqs = () => fake.state.requests;
const lines = () => reqs().map((q) => `${q.method} ${q.path.startsWith(BD) ? BD + "<h>" : q.path}${q.search}`);
const posts = () => reqs().filter((q) => q.method === "POST");
const errBody = (r: { err: string }) => JSON.parse(r.err).error;
const handle = () => Object.keys(fake.state.breakdowns).at(-1)!; // the latest receipt
// Answers the status reads in order (the last one sticks); `h` is the handle from the path.
const reads = (...bodies: ((h: string) => { status: number; body?: unknown; headers?: Record<string, string> })[]) => {
  let i = 0;
  fake.state.onRequest = (r) => {
    if (r.method !== "GET" || !r.path.startsWith(BD)) return;
    fake.state.next = bodies[Math.min(i++, bodies.length - 1)]!(r.path.slice(BD.length));
  };
};
const ok = (data: Record<string, unknown>) => (h: string) => ({ status: 200, body: { data: { id: h, task_id: "tback001", ...data } } });

test("one plural start, then queued/running/succeeded reads every 3 s; json is the final status body", async () => {
  const r = await bd(["--json"]);
  expect(r.code).toBe(0);
  expect(lines()).toEqual([`POST ${START}`, `GET ${BD}<h>`, `GET ${BD}<h>`, `GET ${BD}<h>`]);
  expect(r.sleeps).toEqual([3000, 3000, 3000]);
  const h = handle();
  expect(reqs().slice(1).every((q) => q.path === BD + h)).toBe(true);
  const b = JSON.parse(r.out);
  expect(r.out).toBe(JSON.stringify(b) + "\n");
  expect(Object.keys(b)).toEqual(["data"]);
  expect(b.data).toMatchObject({ id: h, status: "succeeded", task_id: "tback001", agent: "hermes" });
  expect(b.data.added.map((s: any) => s.text)).toEqual(["First step", "Second step"]);
  expect(b.data.added.map((s: any) => s.id)).toEqual(b.data.added_ids);
  expect(r.err).toBe("");
});

test("--no-wait prints the receipt and reads nothing; the sentence names a usable resume command", async () => {
  const p = await bd(["--no-wait"]);
  expect([p.code, lines()]).toEqual([0, [`POST ${START}`]]);
  const h = handle();
  expect(p.out).toBe(`id: ${h}\nstatus: queued\n`);
  const j = await bd(["--no-wait", "--json"]);
  expect(JSON.parse(j.out).data).toMatchObject({ id: h, status: "queued", status_url: `${fake.url}${BD}${h}` }); // repeat start: same handle
  const t = await bd(["--no-wait", "--host", fake.url], { tty: true });
  expect(t.out).toBe(`Started breakdown ${h} of task tback001 (queued). Check it: olympus task breakdown-status ${h} --org acme --host ${fake.url} --wait\n`);
  expect(posts()).toHaveLength(3);
  expect(reqs().every((q) => q.method === "POST")).toBe(true);
});

test("breakdown-status is GET only: one read without --wait, followed to the result with it", async () => {
  const subs = () => fake.state.tasks.acme!["2026-10-05"]!.tasks.find((t) => t.id === "tback001")!.subtasks.length;
  const before = subs();
  await bd(["--no-wait"]);
  const h = handle();
  reqs().length = 0;
  const one = await cli(["task", "breakdown-status", h]);
  expect([one.code, one.out, one.sleeps, lines()]).toEqual([0, `id: ${h}\nstatus: queued\n`, [], [`GET ${BD}<h>`]]);
  const tty = await cli(["task", "breakdown-status", h], { tty: true });
  expect(tty.out).toBe(`Breakdown ${h} of task tback001 is running. Check it: olympus task breakdown-status ${h} --org acme --wait\n`);
  const w = await cli(["task", "breakdown-status", h, "--wait"]);
  expect(w.code).toBe(0);
  expect(w.sleeps).toEqual([]); // the first read is immediate
  expect(w.out).toMatch(/^agent: hermes\nadded: s[0-9a-z]{7}\tFirst step\nadded: s[0-9a-z]{7}\tSecond step\n$/);
  const again = await cli(["task", "breakdown-status", h, "--wait", "--json"]);
  expect(JSON.parse(again.out).data.added).toHaveLength(2); // the result is read, not made again
  expect(subs()).toBe(before + 2);
  expect(posts()).toHaveLength(0);
});

test("failed, expired and an unknown handle are honest nonzero exits that carry the handle", async () => {
  const cases: [string, number, string][] = [
    ["failed:full", 6, "full"], ["failed:no_agent", 6, "no_agent"], ["failed:task_gone", 3, "task_gone"],
    ["failed:agent_failed", 5, "agent_failed"], ["failed:Bad Code!", 5, "breakdown_failed"], ["expired", 3, "expired"],
  ];
  for (const [step, exit, code] of cases) {
    fake.state.breakdowns = {};
    fake.state.breakdownSteps = [step];
    const r = await bd(["--json"]);
    expect([step, r.code as number, r.out, errBody(r).code]).toEqual([step, exit, "", code]);
    expect(errBody(r).details).toEqual({ breakdown_id: handle(), org: "acme" });
    const h = await bd([]);
    expect([h.code as number, h.out]).toEqual([exit, ""]);
    expect(h.err).toContain(handle());
  }
  const nf = await cli(["task", "breakdown-status", "bd_nope", "--wait", "--json"]);
  expect([nf.code, errBody(nf).code, errBody(nf).details]).toEqual([3, "not_found", { breakdown_id: "bd_nope", org: "acme" }]);
  const nh = await cli(["task", "breakdown-status", "bd_nope"]);
  expect([nh.code, nh.err]).toEqual([3, "error: Not found (breakdown bd_nope)\n"]);
});

test("a malformed or foreign status body is never reported as success", async () => {
  const bodies: ((h: string) => { status: number; body?: unknown })[] = [
    () => ({ status: 200, body: { data: null } }),
    () => ({ status: 200, body: { data: { id: "bd_someoneelse", status: "succeeded", added: [] } } }),
    ok({ status: "succeeded", task_id: "tother01", added: [] }),
    ok({ status: "done", added: [] }),
    ok({ status: "succeeded" }),
    ok({ status: "succeeded", added: "First step" }),
    ok({ status: "succeeded", added: [null] }),
    () => ({ status: 200, body: "not json" }),
  ];
  for (const [i, body] of bodies.entries()) {
    fake.state.breakdowns = {};
    reads(body);
    const r = await bd(["--json"]);
    expect([i, r.code, r.out]).toEqual([i, 5, ""]);
    expect(["bad_response", "http_200"]).toContain(errBody(r).code);
    if (errBody(r).code === "bad_response") expect(errBody(r).message).toContain(`olympus task breakdown-status ${handle()} --org acme --wait`);
  }
});

test("a deleted task after success says so instead of 'added none'", async () => {
  reads(ok({ status: "succeeded", agent: "Hermes", task: null, added_ids: ["s1", "s2"], added: [] }));
  const t = await bd([], { tty: true });
  expect([t.code, t.out]).toEqual([0, "Hermes added 2 subtasks to task tback001, which has since been deleted.\n"]);
  const p = await bd([]);
  expect([p.code, p.out, p.err]).toEqual([0, "agent: Hermes\n", "note: task tback001 has since been deleted\n"]);
});

test("timeout: sleeps clamp to the deadline, exit 5 with the handle, org and resume command, nothing new started", async () => {
  fake.state.breakdownSteps = ["running"];
  const r = await bd(["--timeout", "7", "--json"]);
  expect([r.code, r.out, r.sleeps]).toEqual([5, "", [3000, 3000, 1000]]);
  const e = errBody(r);
  expect(e.code).toBe("timeout");
  expect(e.details).toEqual({ breakdown_id: handle(), org: "acme" });
  expect(e.message).toBe(`no result within 7s; breakdown ${handle()} may still be running. Check it: olympus task breakdown-status ${handle()} --org acme --wait`);
  expect(posts()).toHaveLength(1);
  expect(r.err).not.toContain(TOKENS.owner);
  reqs().length = 0;
  const s = await cli(["task", "breakdown-status", handle(), "--wait", "--timeout", "4"]);
  expect([s.code, s.sleeps, posts().length]).toEqual([5, [3000, 1000], 0]);
});

test("429 Retry-After on a status read is honoured and clamped; 5xx backs off; neither restarts anything", async () => {
  const limited = (ra: string) => () => ({ status: 429, body: { error: { code: "rate_limited", message: "slow" } }, headers: { "Retry-After": ra } });
  reads(limited("10"), ok({ status: "succeeded", agent: "Hermes", added: [] }));
  const a = await bd([]);
  expect([a.code, a.sleeps, a.out]).toEqual([0, [3000, 10000], "agent: Hermes\n"]);
  fake.state.breakdowns = {};
  reads(limited("1"), ok({ status: "succeeded", added: [] }));
  expect((await bd([])).sleeps).toEqual([3000, 3000]); // never faster than the poll interval
  fake.state.breakdowns = {};
  reads(limited("99999"));
  const c = await bd(["--timeout", "20", "--json"]);
  expect([c.code, c.sleeps, errBody(c).code]).toEqual([5, [3000, 17000], "timeout"]);
  fake.state.breakdowns = {};
  reads(() => ({ status: 502, body: "<html>" }), () => ({ status: 503, body: "" }), ok({ status: "succeeded", added: [] }));
  const d = await bd([]);
  expect([d.code, d.sleeps]).toEqual([0, [3000, 6000, 12000]]);
  expect(posts()).toHaveLength(4);
  reqs().length = 0;
  reads(limited("5"));
  const one = await cli(["task", "breakdown-status", "bd_x", "--json"]); // a single read does not retry
  expect([one.code, errBody(one).details, reqs().length]).toEqual([5, { breakdown_id: "bd_x", org: "acme" }, 1]);
});

test("the server's status_url and Location are never followed; reads go to the org and handle", async () => {
  const h = "bd_custom0001";
  fake.state.next = {
    status: 202,
    body: { data: { id: h, status: "queued", task_id: "tback001", status_url: `https://evil.example/api/v1/orgs/other/breakdowns/${h}` } },
    headers: { Location: "https://evil.example/x" },
  };
  reads(ok({ status: "running" }), ok({ status: "succeeded", added: [] }));
  const r = await bd([]);
  expect(r.code).toBe(0);
  expect(reqs().map((q) => q.path)).toEqual([START, BD + h, BD + h]);
  for (const bad of ["../x", "bd_", "bd_a/b", "", 7]) {
    reqs().length = 0;
    fake.state.next = { status: 202, body: { data: { id: bad, status: "queued" } } };
    const b = await bd(["--json"]);
    expect([b.code, errBody(b).code, reqs().length]).toEqual([5, "bad_response", 1]);
    expect(errBody(b).message).toContain("olympus task get tback001");
  }
});

test("an unknown start outcome is never sent again and never falls back to the synchronous route", async () => {
  for (const next of [{ status: 502, body: "<html>" }, { status: 202, body: "not json" }, { status: 504 }]) {
    reqs().length = 0;
    fake.state.next = next;
    const r = await bd([]);
    expect([r.code, r.out, lines()]).toEqual([5, "", [`POST ${START}`]]);
    expect(r.err).toContain("the breakdown may have started; check the task before running it again: olympus task get tback001");
  }
  const down = await bd(["--week", "2026-10-05", "--json"], { host: "http://127.0.0.1:9" });
  expect([down.code, errBody(down).code]).toEqual([5, "network_error"]);
  expect(errBody(down).message).toContain("may have started; check the task before running it again: olympus task get tback001 --week 2026-10-05");
  // Definite refusals: nothing started, said plainly, not retried.
  for (const next of [
    { status: 429, body: { error: { code: "rate_limited", message: "Too many breakdowns in progress. Try again shortly." } }, headers: { "Retry-After": "15" } },
    { status: 503, body: { error: { code: "not_queued", message: "could not queue", details: { breakdown: { id: "bd_closed01", status: "failed" } } } } },
    { status: 422, body: { error: { code: "invalid", message: "Validation failed.", details: { fields: { subtasks: ["too many"] } } } } },
  ]) {
    reqs().length = 0;
    fake.state.next = next;
    const r = await bd([]);
    expect([r.code === 0, posts().length, reqs().length]).toEqual([false, 1, 1]);
    expect(r.err).not.toContain("may have started");
  }
  fake.state.next = { status: 429, body: { error: { code: "rate_limited", message: "busy" } }, headers: { "Retry-After": "15" } };
  expect((await bd([])).err).toBe("error: busy (retry after 15s)\n");
});

test("an unknown start or a bad handle names a check command for the same org and explicit host, quoted to paste", async () => {
  const at = async (args: string[], env: Record<string, string>) => {
    let out = "", err = "";
    const code = await run(args, { env: { OLYMPUS_API_KEY: TOKENS.multi, ...env }, home: await mkdtemp(join(tmpdir(), "oly-")),
      stdin: async () => "", out: (s) => { out += s; }, err: (s) => { err += s; }, tty: false });
    return { code, out, err };
  };
  const cases: [string[], Record<string, string>, string][] = [
    [["--org", "beta", "--host", fake.url], {}, `olympus task get tback001 --org beta --host ${fake.url}`],
    [["--week", "2026-10-05"], { OLYMPUS_HOST: fake.url, OLYMPUS_ORG: "beta" }, "olympus task get tback001 --week 2026-10-05 --org beta"],
  ];
  for (const [flags, env, cmd] of cases)
    for (const next of [{ status: 502, body: "<html>" }, { status: 202, body: { data: { id: "../x", status: "queued" } } }]) {
      reqs().length = 0;
      fake.state.next = next;
      const r = await at(["task", "breakdown", "tback001", ...flags], env);
      expect([r.code, r.out, posts().length, reqs().length]).toEqual([5, "", 1, 1]);
      expect(posts()[0]!.path).toBe("/api/v1/orgs/beta/tasks/tback001/breakdowns");
      expect(r.err).toEndWith(`check the task before running it again: ${cmd}\n`);
    }
  reqs().length = 0;
  fake.state.next = { status: 502, body: "<html>" };
  const q = await at(["task", "breakdown", "it's a b", "--org", "beta", "--host", fake.url], {});
  expect([q.code, posts().length]).toEqual([5, 1]);
  expect(q.err).toEndWith(`check the task before running it again: olympus task get 'it'\\''s a b' --org beta --host ${fake.url}\n`);
});

test("cancel: after acceptance names the handle and stops; before the start sends nothing", async () => {
  fake.state.breakdownSteps = ["running"];
  const ctl = new AbortController();
  let at = 0;
  const r = await bd([], { signal: ctl.signal, onSleep: (n) => { if (n === 2) { at = reqs().length; ctl.abort(); } } });
  expect(r.code).toBe(130);
  expect(reqs()).toHaveLength(at);
  expect(posts()).toHaveLength(1);
  expect(r.err).toBe(`error: cancelled; breakdown ${handle()} may still be running. Check it: olympus task breakdown-status ${handle()} --org acme --wait\n`);
  const j = await bd(["--json"], { signal: ctl.signal });
  expect([j.code, errBody(j).message, posts().length]).toEqual([130, "cancelled; nothing was started", 1]);
});

test("usage: wait flags and handles are checked before any request", async () => {
  const bad = [
    ["task", "breakdown", "tback001", "--wait"], ["task", "breakdown", "tback001", "--no-wait", "--timeout", "5"],
    ["task", "breakdown", "tback001", "--timeout", "0"], ["task", "breakdown", "tback001", "--timeout", "1.5"],
    ["task", "breakdown", "tback001", "--timeout", "86401"],
    ["task", "breakdown-status"], ["task", "breakdown-status", "bd_a", "bd_b"], ["task", "breakdown-status", "x"],
    ["task", "breakdown-status", ".."], ["task", "breakdown-status", "bd_a/b"], ["task", "breakdown-status", "bd_a", "--timeout", "5"],
    ["task", "breakdown-status", "bd_a", "--no-wait"], ["task", "breakdown-status", "bd_a", "--week", "2026-10-05"],
    ["task", "breakdown-status", "bd_a", "--agent", "hermes"],
  ];
  for (const a of bad) expect([a.join(" "), (await cli(a)).code]).toEqual([a.join(" "), 1]);
  expect(reqs()).toHaveLength(0);
});

test("help lists breakdown and breakdown-status", async () => {
  let help = "";
  const r = await run(["-h"], { env: {}, home: "/nonexistent", stdin: async () => "", out: (s) => { help += s; }, err: () => {} });
  expect(r).toBe(0);
  expect(help).toContain("  task delegate <id> [--to AGENT] | task breakdown <id> [--agent AGENT] [--timeout SECONDS | --no-wait]   (both accept --week D)\n");
  expect(help).toContain("  task breakdown-status <handle> [--wait] [--timeout SECONDS]");
});

test("Ctrl-C on a real process exits 130 quickly with the handle and how to resume", async () => {
  fake.state.breakdownSteps = ["running"];
  const tmp = await mkdtemp(join(tmpdir(), "oly-"));
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "task", "breakdown", "tback001", "--host", fake.url], {
    cwd: tmp, env: { PATH: process.env.PATH!, HOME: tmp, OLYMPUS_API_KEY: TOKENS.owner, OLYMPUS_ORG: "acme" }, stdout: "pipe", stderr: "pipe",
  });
  const t0 = Date.now();
  while (!posts().length && Date.now() - t0 < 15_000) await Bun.sleep(25);
  await Bun.sleep(300); // inside the 3 s poll sleep
  const sent = Date.now();
  p.kill("SIGINT");
  const [code, out, err] = [await p.exited, await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  expect(Date.now() - sent).toBeLessThan(2500);
  expect([code, out]).toEqual([130, ""]);
  expect(err).toContain(`breakdown ${handle()} may still be running. Check it: olympus task breakdown-status ${handle()} --org acme --host ${fake.url} --wait`);
  expect(posts()).toHaveLength(1);
}, 20_000);
