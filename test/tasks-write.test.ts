import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { seedTasks, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
const NOW = Date.parse("2026-10-07T14:00:00Z");
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  fake.state.today = "2026-10-07";
  fake.state.now = () => NOW;
  fake.state.tasks = seedTasks(fake.state.today);
});

async function cli(args: string[], o: { env?: Record<string, string>; tty?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "";
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, ...o.env }, home, stdin: async () => "",
    out: (s) => { out += s; }, err: (s) => { err += s; }, now: () => NOW, tty: o.tty ?? false,
  });
  return { code, out, err };
}
const owner = { OLYMPUS_API_KEY: TOKENS.owner };
const reqs = () => fake.state.requests;
const last = () => reqs()[reqs().length - 1]!;
const run1 = (args: string[], tty = false) => cli([...args, "--org", "acme"], { env: owner, tty });
const noCtl = (s: string) => expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s.replace(/\n$/, "").replace(/\n/g, ""))).toBe(false);
const EVIL = "x\x1b]52;c;ZZ\x07\x9by";
const j = (r: { out: string }) => JSON.parse(r.out);

test("AC16 add: only the given fields, POST /tasks", async () => {
  const r = await run1(["task", "add", "Write docs"]);
  expect(r.code).toBe(0);
  expect(last().method).toBe("POST");
  expect(last().path).toBe("/api/v1/orgs/acme/tasks");
  expect(last().body).toEqual({ text: "Write docs" });
  await run1(["task", "add", "T", "--desc", "D", "--assign", "me", "--backlog", "--today", "--star", "--tag", "a", "--tag", "b"]);
  expect(last().body).toEqual({ text: "T", description: "D", assignee: "me", section: "backlog", today: true, one_thing: true, tags: ["a", "b"] });
  await run1(["task", "add", "T", "--no-today", "--no-star"]);
  expect(last().body).toEqual({ text: "T" });
  await run1(["task", "add", "T", "--week", "2026-10-12"]);
  expect(last().search).toBe("?week=2026-10-12");
});

test("AC17 update: only given fields; conflicts are usage errors with no request", async () => {
  const upd = async (a: string[]) => { await run1(["task", "update", "trest001", ...a]); return last().body; };
  expect(await upd(["--text", "N"])).toEqual({ text: "N" });
  expect(await upd(["--desc", ""])).toEqual({ description: "" });
  expect(await upd(["--section", "backlog"])).toEqual({ section: "backlog" });
  expect(await upd(["--assign", "u_1"])).toEqual({ assignee: "u_1" });
  expect(await upd(["--unassign"])).toEqual({ assignee: null });
  expect(await upd(["--tag", "x", "--tag", "y"])).toEqual({ tags: ["x", "y"] });
  expect(await upd(["--no-tags"])).toEqual({ tags: [] });
  expect(last().method).toBe("PATCH");
  expect(last().path).toBe("/api/v1/orgs/acme/tasks/trest001");
  fake.state.requests.length = 0;
  for (const a of [[], ["--assign", "me", "--unassign"], ["--tag", "x", "--no-tags"], ["--tags"]]) {
    const r = await run1(["task", "update", "trest001", ...a]);
    expect(r.code).toBe(1);
  }
  expect(reqs()).toHaveLength(0);
  // usage errors come before credentials are read
  expect((await cli(["task", "update", "trest001", "--org", "acme"])).code).toBe(1);
});

test("AC30 update --add-tag / --remove-tag", async () => {
  await run1(["task", "update", "trest001", "--add-tag", "n1", "--add-tag", "n2"]);
  expect(last().body).toEqual({ add_tags: ["n1", "n2"] });
  await run1(["task", "update", "trest001", "--remove-tag", "web"]);
  expect(last().body).toEqual({ remove_tags: ["web"] });
  const r = await run1(["task", "update", "trest001", "--add-tag", "z", "--remove-tag", "pricing"]);
  expect(last().body).toEqual({ add_tags: ["z"], remove_tags: ["pricing"] });
  expect(r.out).toContain("tags: n1,n2,z");
  fake.state.requests.length = 0;
  for (const a of [["--add-tag", "a", "--tag", "b"], ["--remove-tag", "a", "--no-tags"], ["--add-tag", "a", "--no-tags"], ["--remove-tag", "a", "--tag", "b"]])
    expect((await run1(["task", "update", "trest001", ...a])).code).toBe(1);
  expect(reqs()).toHaveLength(0);
});

test("AC18 toggle bodies", async () => {
  const cases: [string[], unknown][] = [
    [["done"], { done: true }], [["undone"], { done: false }], [["today"], { today: true }], [["today", "--off"], { today: false }],
    [["star"], { one_thing: true }], [["star", "--off"], { one_thing: false }],
  ];
  for (const [a, body] of cases) {
    // tstar001 has an assignee; today/star are accepted by the fake there
    const r = await run1(["task", a[0]!, "tstar001", ...a.slice(1)]);
    expect(r.code).toBe(0);
    expect(last().method).toBe("PATCH");
    expect(last().body).toEqual(body);
  }
  await run1(["task", "done", "tstar001", "--week", "2026-10-05"]);
  expect(last().search).toBe("?week=2026-10-05");
});

test("dot-segment ids and --org .. are usage errors: no request, parent task untouched", async () => {
  for (const extra of [[], ["--json"]]) {
    const r = await run1(["task", "sub", "delete", "tback001", "..", "--yes", ...extra]);
    expect(r.code).toBe(1);
  }
  const o = await cli(["task", "get", "tback001", "--org", ".."], { env: owner });
  expect(o.code).toBe(1);
  expect(reqs().filter((q) => q.path.includes("/tasks"))).toHaveLength(0);
  expect(reqs()).toHaveLength(0);
  expect(Object.values(fake.state.tasks.acme!).some((w) => w.tasks.some((t: any) => t.id === "tback001"))).toBe(true);
});

test("AC19 delete", async () => {
  const no = await run1(["task", "delete", "tback001"]);
  expect(no.code).toBe(1);
  expect(reqs()).toHaveLength(0);
  expect((await run1(["task", "delete", "tback001", "--yes"])).out).toBe("deleted tback001\n");
  expect(last().method).toBe("DELETE");
  expect((await run1(["task", "delete", "tdone001", "--yes"], true)).out).toBe("Deleted task tdone001.\n");
  expect((await run1(["task", "delete", "tunk0001", "--yes", "--json"])).out).toBe('{"data":{"id":"tunk0001","deleted":true}}\n');
  expect((await run1(["task", "delete", "tunk0001", "--yes"])).code).toBe(3);
  await run1(["task", "delete", "tstar001", "--yes", "--week", "2026-10-05"]);
  expect(last().search).toBe("?week=2026-10-05");
});

test("AC20 subtasks", async () => {
  const a = await run1(["task", "sub", "add", "tback001", "Sub one", "--assign", "me"]);
  expect(a.code).toBe(0);
  expect(last().method).toBe("POST");
  expect(last().path).toBe("/api/v1/orgs/acme/tasks/tback001/subtasks");
  expect(last().body).toEqual({ text: "Sub one", assignee: "me" });
  expect(a.out).toMatch(/^id: tback001\n/);
  expect(a.out).toMatch(/\nsubtask: s[0-9a-z]{7}\topen\tu_1\t-\tSub one\n$/);
  await run1(["task", "sub", "add", "tback001", "Plain"]);
  expect(last().body).toEqual({ text: "Plain" });
  const d = await run1(["task", "sub", "done", "trest001", "s0000002"]);
  expect(last().method).toBe("PATCH");
  expect(last().path).toBe("/api/v1/orgs/acme/tasks/trest001/subtasks/s0000002");
  expect(last().body).toEqual({ done: true });
  expect(d.out).toContain("subtask: s0000002\tdone\t-\t-\tReview");
  await run1(["task", "sub", "done", "trest001", "s0000002", "--undo"]);
  expect(last().body).toEqual({ done: false });
  fake.state.requests.length = 0;
  expect((await run1(["task", "sub", "delete", "trest001", "s0000002"])).code).toBe(1);
  expect(reqs()).toHaveLength(0);
  const del = await run1(["task", "sub", "delete", "trest001", "s0000002", "--yes"]);
  expect(last().method).toBe("DELETE");
  expect(del.out).toStartWith("id: trest001\n");
  expect(del.out).not.toContain("s0000002");
  const dj = await run1(["task", "sub", "delete", "trest001", "s0000001", "--yes", "--json"]);
  const body = await (await fetch(`${fake.url}/api/v1/orgs/acme/tasks/trest001`, { headers: { Authorization: `Bearer ${TOKENS.owner}` } })).json();
  expect(dj.out).toBe(JSON.stringify(body) + "\n");
  await run1(["task", "sub", "add", "tback001", "w", "--week", "2026-10-05"]);
  expect(last().search).toBe("?week=2026-10-05");
  await run1(["task", "sub", "done", "tback001", "nope", "--week", "2026-10-05"]);
  expect(last().search).toBe("?week=2026-10-05");
  expect((await run1(["task", "sub", "done", "trest001", "nope"])).code).toBe(3);
});

test("AC21 item output: piped detail, TTY sentence + block, json body", async () => {
  const p = await run1(["task", "update", "tback001", "--text", "Renamed"]);
  expect(p.out).toBe(
    "id: tback001\ntext: Renamed\ndescription: -\nsection: backlog\norder: 3\ndone: false\ndone_at: -\nassignee: -\ntags: -\n" +
    "today: false\none_thing: false\nadded_on: 2026-10-07\ndelegated_to: -\ndelegated_at: -\n");
  const t = async (a: string[]) => (await run1(["task", ...a], true)).out;
  const add = await t(["add", "Fresh"]);
  expect(add).toMatch(/^Added task t[0-9a-z]{7}\.\n\nid /);
  expect(add).toContain("text       Fresh");
  expect(await t(["update", "tback001", "--text", "R2"])).toStartWith("Updated task tback001.\n\n");
  expect(await t(["done", "tback001"])).toStartWith("Marked tback001 done.\n\n");
  expect(await t(["undone", "tback001"])).toStartWith("Marked tback001 not done.\n\n");
  expect(await t(["today", "tback001"])).toStartWith("Marked tback001 for today.\n\n");
  expect(await t(["today", "tback001", "--off"])).toStartWith("Removed tback001 from today.\n\n");
  expect(await t(["star", "tstar001"])).toStartWith("Starred tstar001.\n\n");
  expect(await t(["star", "tstar001", "--off"])).toStartWith("Unstarred tstar001.\n\n");
  expect(await t(["sub", "add", "tback001", "S"])).toMatch(/^Added subtask s[0-9a-z]{7} to tback001\.\n\n/);
  expect(await t(["sub", "done", "trest001", "s0000001"])).toStartWith("Marked subtask s0000001 done.\n\n");
  expect(await t(["sub", "done", "trest001", "s0000001", "--undo"])).toStartWith("Marked subtask s0000001 not done.\n\n");
  expect(await t(["sub", "delete", "trest001", "s0000001", "--yes"])).toStartWith("Deleted subtask s0000001 from trest001.\n\n");
  const js = await run1(["task", "done", "tback001", "--json"]);
  expect(j(js).data).toMatchObject({ id: "tback001", done: true });
  expect(js.out.endsWith("\n") && js.out.indexOf("\n") === js.out.length - 1).toBe(true);
});

test("AC21 server strings are cleaned in every write output", async () => {
  fake.state.tasks.acme!["2026-10-05"]!.tasks[3]!.text = EVIL;
  for (const tty of [false, true]) {
    for (const a of [["done", "tback001"], ["update", "tback001", "--desc", EVIL], ["sub", "add", "tback001", EVIL]]) {
      const r = await run1(["task", ...a], tty);
      expect(r.out).not.toContain("\x1b");
      expect(r.out).not.toContain("\x9b");
      noCtl(r.out);
    }
  }
  expect(fake.state.requests.some((r) => JSON.stringify(r.body ?? "").includes("ZZ"))).toBe(true); // the request is sent raw
});

test("AC22 422 names each field; json stderr is the body; 404 has no creds hint", async () => {
  const bad = await run1(["task", "update", "trest001", "--assign", "hera"]);
  expect(bad.code).toBe(6);
  expect(bad.err).toContain("assignee: is paused");
  const many = await run1(["task", "add", " ", "--assign", "nobody"]);
  expect(many.code).toBe(6);
  expect(many.err).toContain("text:");
  expect(many.err).toContain("assignee:");
  const bj = await run1(["task", "update", "trest001", "--assign", "hera", "--json"]);
  expect(bj.code).toBe(6);
  expect(JSON.parse(bj.err).error.details.fields).toEqual({ assignee: ["is paused"] });
  fake.state.next = { status: 422, body: { error: { code: "invalid", message: "bad", details: { fields: { today: ["too many"] } } } } };
  const cap = await run1(["task", "today", "tback001"]);
  expect(cap.code).toBe(6);
  expect(cap.err).toContain("today: too many");
  fake.state.next = { status: 422, body: { error: { code: "invalid", message: "bad", details: { fields: { one_thing: [`${EVIL}`] } } } } };
  const ot = await run1(["task", "star", "tback001"]);
  expect(ot.err).not.toContain("\x1b");
  const wk = await run1(["task", "add", "x", "--week", "nonsense"]);
  expect(wk.code).toBe(6);
  expect(wk.err).toContain("week");
  for (const a of [["update", "nope", "--text", "x"], ["done", "nope"], ["undone", "nope"], ["today", "nope"], ["star", "nope"], ["delete", "nope", "--yes"],
    ["sub", "add", "nope", "x"], ["sub", "done", "nope", "s1"], ["sub", "delete", "nope", "s1", "--yes"]]) {
    const r = await cli(["task", ...a, "--org", "acme"], { env: { OLYMPUS_API_KEY: TOKENS.owner } });
    expect(r.code).toBe(3);
    expect(r.err).not.toContain("credentials.json");
  }
});

test("AC23 token sweep over every write command", async () => {
  const T = TOKENS.owner;
  const cmds: string[][] = [
    ["add", "x"], ["update", "tback001", "--text", "y"], ["done", "tback001"], ["undone", "tback001"], ["today", "tback001"], ["star", "tstar001"],
    ["delete", "tback001", "--yes"], ["sub", "add", "tback001", "s"], ["sub", "done", "trest001", "s0000001"], ["sub", "delete", "trest001", "s0000001", "--yes"],
  ];
  const nexts = [
    { status: 401, body: { error: { code: "unauthorized", message: "no" } } }, { status: 404, body: { error: { code: "not_found", message: "no" } } },
    { status: 422, body: { error: { code: "invalid", message: "bad", details: { fields: { text: ["blank"] } } } } },
    { status: 503, body: { error: { code: "machine_not_ready", message: "later" } } },
  ];
  let failures = 0;
  for (const tty of [false, true])
    for (const json of [[], ["--json"]])
      for (const c of cmds)
        for (const next of nexts) {
          fake.state.next = next as any;
          const r = await cli(["task", ...c, "--org", "acme", ...json], { env: { OLYMPUS_API_KEY: T }, tty });
          expect(r.out).not.toContain(T);
          expect(r.err).not.toContain(T);
          if (r.code !== 0) failures++;
        }
  expect(failures).toBe(2 * 2 * cmds.length * nexts.length);
});
