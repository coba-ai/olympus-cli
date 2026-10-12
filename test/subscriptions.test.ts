import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { seedSubscriptions, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
const NOW = Date.parse("2026-10-07T14:00:00Z");
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  fake.state.subscriptions = seedSubscriptions();
});

async function cli(args: string[], o: { env?: Record<string, string>; tty?: boolean; stdin?: string; creds?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  if (o.creds !== undefined) {
    await mkdir(join(home, ".config/olympus"), { recursive: true });
    await writeFile(join(home, ".config/olympus/credentials.json"), o.creds);
  }
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
const sub = (args: string[], tty = false) => cli([...args, "--org", "acme"], { env: owner, tty });
const count = (s: string, x: string) => s.split(x).length - 1;
const ID = "sub_000000000001";
const SEED_DETAIL = `id: ${ID}\nname: seed\nurl: https://example.test/hook\nevents: task.completed\nactive: true\ncreated_by: u_1\nlast_delivery_at: -\nlast_delivery_status: -\nconsecutive_failures: 0\ncreated_at: 2026-10-01T09:00:00Z\n`;

test("AC15 requests: paths and bodies", async () => {
  await sub(["subscription", "list"]);
  expect([last().method, last().path]).toEqual(["GET", "/api/v1/orgs/acme/subscriptions"]);
  await sub(["subscription", "get", ID]);
  expect([last().method, last().path]).toEqual(["GET", `/api/v1/orgs/acme/subscriptions/${ID}`]);
  await sub(["subscription", "create", "--name", "N", "--url", "https://x.test/h", "--event", "task.created", "--event", "task.deleted"]);
  expect([last().method, last().path]).toEqual(["POST", "/api/v1/orgs/acme/subscriptions"]);
  expect(last().body).toEqual({ name: "N", url: "https://x.test/h", events: ["task.created", "task.deleted"] });
  await sub(["subscription", "create", "--name", "N", "--url", "https://x.test/h", "--event", "*"]);
  expect(last().body).toEqual({ name: "N", url: "https://x.test/h", events: ["*"] });
  await sub(["subscription", "update", ID, "--name", "M", "--url", "https://y.test", "--event", "task.created", "--inactive"]);
  expect([last().method, last().path]).toEqual(["PATCH", `/api/v1/orgs/acme/subscriptions/${ID}`]);
  expect(last().body).toEqual({ name: "M", url: "https://y.test", events: ["task.created"], active: false });
  await sub(["subscription", "update", ID, "--active"]);
  expect(last().body).toEqual({ active: true });
  await sub(["subscription", "rotate-secret", ID]);
  expect([last().method, last().path, last().body]).toEqual(["POST", `/api/v1/orgs/acme/subscriptions/${ID}/rotate_secret`, undefined]);
  await sub(["subscription", "ping", ID]);
  expect([last().method, last().path]).toEqual(["POST", `/api/v1/orgs/acme/subscriptions/${ID}/ping`]);
  await sub(["event-types"]);
  expect([last().method, last().path]).toEqual(["GET", "/api/v1/orgs/acme/event_types"]);
  await sub(["subscription", "delete", ID, "--yes"]);
  expect([last().method, last().path]).toEqual(["DELETE", `/api/v1/orgs/acme/subscriptions/${ID}`]);
});

test("AC15 usage errors: exit 1, zero requests, no token needed", async () => {
  const bad = [
    ["subscription", "create", "--url", "u", "--event", "task.created"], ["subscription", "create", "--name", "n", "--event", "task.created"],
    ["subscription", "create", "--name", "n", "--url", "u"], ["subscription", "update", ID],
    ["subscription", "update", ID, "--active", "--inactive"], ["subscription", "update", ID, "--no-active"], ["subscription", "update", ID, "--no-inactive"],
    ["subscription", "delete", ID], ["subscription", "get", ".."], ["subscription", "get", "."], ["subscription", "get", ""],
    ["subscription", "ping", ".."], ["subscription", "rotate-secret", ""], ["subscription", "update", "..", "--active"], ["subscription", "delete", "..", "--yes"],
    ["subscription"], ["subscription", "nope"], ["subscription", "constructor"], ["subscription", "__proto__"], ["subscription", "event-types"],
    ["subscription", "list", "extra"], ["subscription", "get"], ["event-types", "extra"],
    ["subscription", "list", "--yes"], ["subscription", "get", ID, "--name", "x"], ["subscription", "create", "--name", "n", "--url", "u", "--event", "e", "--active"],
    ["subscription", "delete", ID, "--yes", "--event", "x"], ["event-types", "--url", "x"], ["subscription", "ping", ID, "--task"],
  ];
  for (const a of bad) {
    const r = await cli(a, { stdin: "never read\n" });
    expect([a.join(" "), r.code]).toEqual([a.join(" "), 1]);
    expect(reqs().length).toBe(0);
  }
});

test("create --no-active names the flag the user typed", async () => {
  for (const f of ["active", "inactive"]) {
    const r = await cli(["subscription", "create", "--name", "n", "--url", "u", "--event", "e", `--no-${f}`], { stdin: "" });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`unknown option '--no-${f}' for subscription create`);
    expect(reqs().length).toBe(0);
  }
});

test("AC15 delete never prompts and prints deleted <id> / json / sentence", async () => {
  let asked = false;
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "";
  const code = await run(["subscription", "delete", ID, "--yes", "--org", "acme"], {
    env: { OLYMPUS_HOST: fake.url, ...owner }, home, stdin: async () => { asked = true; return "n"; }, out: (s) => { out += s; }, err: () => {}, now: () => NOW, tty: true,
  });
  expect([code, asked, out]).toEqual([0, false, `Deleted subscription ${ID}.\n`]);
  fake.state.subscriptions = seedSubscriptions();
  expect((await sub(["subscription", "delete", ID, "--yes"])).out).toBe(`deleted ${ID}\n`);
  fake.state.subscriptions = seedSubscriptions();
  expect((await sub(["subscription", "delete", ID, "--yes", "--json"])).out).toBe(`{"data":{"id":"${ID}","deleted":true}}\n`);
});

test("AC16 secret appears once on create and rotate-secret, every mode", async () => {
  const create = ["subscription", "create", "--name", "N", "--url", "https://x.test/h", "--event", "task.created"];
  for (const args of [create, ["subscription", "rotate-secret", ID]]) {
    for (const mode of ["piped", "tty", "json"]) {
      const r = await sub(mode === "json" ? [...args, "--json"] : args, mode === "tty");
      const own = mode === "json" ? JSON.parse(r.out).secret : r.out.match(/[0-9a-f]{64}/g)![0];
      expect(own).toMatch(/^[0-9a-f]{64}$/);
      expect(count(r.out, own)).toBe(1);
      expect(r.err).toBe("");
      if (mode === "piped") expect(r.out.endsWith(`\nsecret (shown once): ${own}\n`)).toBe(true);
      if (mode === "tty") {
        expect(r.out).toContain("Signing secret (shown once — store it now; it cannot be read again):");
        expect(r.out).toContain('See "Receiving events" in docs/API.md: https://github.com/coba-ai/olympus-cli/blob/main/docs/API.md#receiving-events');
      }
    }
  }
});

test("AC16 an injected data.secret still prints the secret once (piped and TTY)", async () => {
  for (const tty of [false, true]) {
    fake.state.next = { status: 200, body: { data: { id: ID, name: "n", secret: "LEAK1", events: ["task.created"], active: true }, secret: "REAL1" } };
    const r = await sub(["subscription", "rotate-secret", ID], tty);
    expect(count(r.out, "REAL1")).toBe(1);
    expect(r.out).not.toContain("LEAK1");
    expect(r.err).toBe("");
  }
});

test("AC17 piped goldens", async () => {
  expect((await sub(["subscription", "list"])).out).toBe(`${ID}\tactive\ttask.completed\t-\t0\thttps://example.test/hook\tseed\n`);
  expect((await sub(["subscription", "get", ID])).out).toBe(SEED_DETAIL);
  const u = await sub(["subscription", "update", ID, "--inactive", "--event", "task.created", "--event", "task.deleted"]);
  expect(u.out).toBe(SEED_DETAIL.replace("events: task.completed", "events: task.created,task.deleted").replace("active: true", "active: false"));
  expect((await sub(["subscription", "ping", ID])).out).toBe("delivered: true\nstatus: 200\nerror: -\n");
  fake.state.next = { status: 200, body: { data: { delivered: false, status: null, error: "connection refused" } } };
  const p = await sub(["subscription", "ping", ID]);
  expect([p.code, p.out]).toEqual([0, "delivered: false\nstatus: -\nerror: connection refused\n"]);
  expect((await sub(["event-types"])).out).toBe("task.created\ntask.updated\ntask.completed\ntask.reopened\ntask.assigned\ntask.deleted\ntask.delegated\n");
  fake.state.subscriptions.acme = [];
  const e = await sub(["subscription", "list"]);
  expect([e.code, e.out]).toEqual([0, ""]);
  expect((await sub(["subscription", "list", "--json"])).out).toBe('{"data":[]}\n');
  fake.state.subscriptions.acme = [{ id: "s1", name: "", url: "u", events: [], active: false, created_by: null, last_delivery_status: 502, consecutive_failures: 3 }];
  expect((await sub(["subscription", "list"])).out).toBe("s1\tinactive\t-\t502\t3\tu\t-\n");
  fake.state.next = { status: 200, body: { data: { id: "s1", created_by: { id: "u_9", name: "N" }, x: 1 } } };
  expect((await sub(["subscription", "get", "s1"])).out).toContain("created_by: u_9\n");
});

test("AC17 TTY forms", async () => {
  const g = await sub(["subscription", "get", ID], true);
  expect(g.out).toContain("url");
  expect(g.out).toContain("created by         Abe Owner");
  expect(g.out).toContain("last delivery      never");
  expect(g.out).toContain("created            ");
  expect((await sub(["subscription", "list"], true)).out).toContain("ID");
  expect((await sub(["subscription", "update", ID, "--inactive"], true)).out).toStartWith(`Updated subscription ${ID}.\n\n`);
  expect((await sub(["subscription", "ping", ID], true)).out).toBe(`Ping to ${ID}: delivered (200 ok)\n`);
  fake.state.next = { status: 200, body: { data: { delivered: false, status: 500, error: null } } };
  expect((await sub(["subscription", "ping", ID], true)).out).toBe(`Ping to ${ID}: not delivered (500)\n`);
  expect((await sub(["event-types"], true)).out).toContain("task.created\n");
  const j = await sub(["subscription", "ping", ID, "--json"], true);
  expect(JSON.parse(j.out).data.delivered).toBe(true);
  fake.state.subscriptions.acme = [];
  expect((await sub(["subscription", "list"], true)).out).toContain("No subscriptions in acme yet.");
});

test("AC17 hostile server strings never reach stdout", async () => {
  const EVIL = "x\x1b]52;c;ZZ\x07\x9by\nz";
  const bad = { id: EVIL, name: EVIL, url: EVIL, events: [EVIL], active: true, created_by: { id: EVIL, name: EVIL }, last_delivery_status: 500, last_delivery_at: EVIL, consecutive_failures: EVIL, created_at: EVIL };
  const noCtl = (s: string) => expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s.replace(/\n/g, ""))).toBe(false);
  for (const tty of [false, true]) {
    for (const [args, body] of [
      [["subscription", "list"], { data: [bad] }], [["subscription", "get", "s"], { data: bad }], [["subscription", "update", "s", "--active"], { data: bad }],
      [["subscription", "create", "--name", "n", "--url", "u", "--event", "task.created"], { data: bad, secret: EVIL }], [["subscription", "rotate-secret", "s"], { data: bad, secret: EVIL }],
      [["subscription", "ping", "s"], { data: { delivered: false, status: EVIL, error: EVIL } }], [["subscription", "ping", "s"], { data: { delivered: true, status: EVIL } }], [["event-types"], { data: [EVIL] }],
    ] as [string[], unknown][]) {
      fake.state.next = { status: 200, body };
      const r = await sub(args, tty);
      expect(r.code).toBe(0);
      noCtl(r.out);
    }
  }
});

test("AC18 errors: teammate 4, event-types ok, 404 -> 3, 422 -> 6", async () => {
  const mate = { OLYMPUS_API_KEY: TOKENS.teammate };
  for (const a of [["subscription", "list"], ["subscription", "get", ID], ["subscription", "create", "--name", "n", "--url", "u", "--event", "task.created"],
    ["subscription", "update", ID, "--active"], ["subscription", "delete", ID, "--yes"], ["subscription", "rotate-secret", ID], ["subscription", "ping", ID]]) {
    const r = await cli([...a, "--org", "acme"], { env: mate });
    expect([a.join(" "), r.code]).toEqual([a.join(" "), 4]);
  }
  expect((await cli(["event-types", "--org", "acme"], { env: mate })).code).toBe(0);
  const creds = JSON.stringify({ host: fake.url, org: "nope" });
  for (const a of [["subscription", "get", "nope"], ["subscription", "update", "nope", "--active"], ["subscription", "delete", "nope", "--yes"], ["subscription", "ping", "nope"], ["subscription", "rotate-secret", "nope"]]) {
    const r = await cli(a, { env: owner, creds });
    expect([a.join(" "), r.code]).toEqual([a.join(" "), 3]);
    expect(r.err).not.toContain("from credentials.json");
  }
  expect((await cli(["subscription", "list"], { env: owner, creds })).err).toContain("from credentials.json");
  const u = await sub(["subscription", "update", ID, "--event", "task.bogus"]);
  expect(u.code).toBe(6);
  expect(u.err).toContain("events");
  expect((await sub(["subscription", "create", "--name", "n", "--url", "u", "--event", "task.bogus"])).code).toBe(6);
});

test("AC18 token and secret sweep: errors never print the token, all exit non-zero", async () => {
  const cmds = [["subscription", "list"], ["subscription", "create", "--name", "n", "--url", "u", "--event", "task.created"], ["subscription", "rotate-secret", ID], ["subscription", "ping", ID], ["event-types"]];
  for (const status of [401, 403, 404, 422, 503]) {
    for (const a of cmds) {
      for (const tty of [false, true]) {
        for (const json of [false, true]) {
          fake.state.next = { status, body: { error: { code: "x", message: "bad", details: { fields: { events: ["no"] } } } } };
          const r = await cli([...a, "--org", "acme", ...(json ? ["--json"] : [])], { env: owner, tty });
          expect(r.code).not.toBe(0);
          expect(r.out + r.err).not.toContain(TOKENS.owner);
          expect(r.out).toBe("");
        }
      }
    }
  }
}, 60_000);

test("AC19 --help lists the subscription usage lines", async () => {
  const r = await cli(["--help"]);
  expect(r.out).toContain("  subscription list | get <id> | delete <id> --yes | rotate-secret <id> | ping <id>\n");
  expect(r.out).toContain("  subscription create --name N --url URL --event T... ('*' = all) | update <id> [--name N] [--url URL] [--event T]... [--active | --inactive]\n");
  expect(r.out).toContain("  event-types");
});

test("a null data body does not crash list, get or ping", async () => {
  for (const tty of [false, true]) {
    for (const args of [["subscription", "list"], ["subscription", "get", "s"], ["subscription", "ping", "s"], ["event-types"]]) {
      fake.state.next = { status: 200, body: { data: null } };
      const r = await sub(args, tty);
      expect([args.join(" "), r.code, r.err.includes("internal")]).toEqual([args.join(" "), 0, false]);
    }
  }
});

test("events: ping is not subscribable: create and update exit 6 naming events", async () => {
  for (const a of [["subscription", "create", "--name", "n", "--url", "u", "--event", "ping"], ["subscription", "update", ID, "--event", "ping"]]) {
    const r = await sub(a);
    expect([r.code, r.err]).toEqual([6, expect.stringContaining("events")]);
  }
});

test("events: ping rate limited: 429 exits 5 with retry-after", async () => {
  const body = { error: { code: "rate_limited", message: "Too many pings" } };
  fake.state.next = { status: 429, body, headers: { "Retry-After": "10" } };
  const r = await sub(["subscription", "ping", ID]);
  expect([r.code, r.out, r.err]).toEqual([5, "", "error: Too many pings (retry after 10s)\n"]);
  fake.state.next = { status: 429, body, headers: { "Retry-After": "10" } };
  const j = await sub(["subscription", "ping", ID, "--json"]);
  expect(j.code).toBe(5);
  expect(JSON.parse(j.err)).toEqual(body);
});

test("events: ping network failure: null status, exit 0", async () => {
  const data = { delivered: false, status: null, error: "timeout" };
  fake.state.next = { status: 200, body: { data } };
  expect(await sub(["subscription", "ping", ID])).toMatchObject({ code: 0, out: "delivered: false\nstatus: -\nerror: timeout\n" });
  fake.state.next = { status: 200, body: { data } };
  expect(await sub(["subscription", "ping", ID], true)).toMatchObject({ code: 0, out: `Ping to ${ID}: not delivered (timeout)\n` });
});

test("events: unknown id: teammate gets 403 (exit 4), operator 404 (exit 3)", async () => {
  expect((await cli(["subscription", "get", "nope", "--org", "acme"], { env: { OLYMPUS_API_KEY: TOKENS.teammate } })).code).toBe(4);
  expect((await sub(["subscription", "get", "nope"])).code).toBe(3);
});
