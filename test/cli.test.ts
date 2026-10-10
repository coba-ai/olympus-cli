import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { startFake, DEVICE_CODE, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
beforeEach(() => { fake.state.requests.length = 0; delete fake.state.next; delete fake.state.device; delete fake.state.onRequest; });

async function cli(args: string[], o: { env?: Record<string, string>; stdin?: string; home?: string; creds?: string; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number; openBrowser?: (url: string) => void } = {}) {
  const home = o.home ?? (await mkdtemp(join(tmpdir(), "oly-")));
  if (o.creds !== undefined) {
    await mkdir(join(home, ".config/olympus"), { recursive: true });
    await writeFile(join(home, ".config/olympus/credentials.json"), o.creds);
  }
  let out = "", err = "";
  let clock = Date.now(); // default sleep advances the clock default now reads, so a script that runs out expires instead of spinning
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, ...o.env }, home, stdin: async () => o.stdin ?? "",
    out: (s) => { out += s; }, err: (s) => { err += s; },
    sleep: o.sleep ?? (async (ms) => { clock += ms; }), now: o.now ?? (() => clock), openBrowser: o.openBrowser,
  });
  return { code, out, err, home };
}
const owner = { OLYMPUS_API_KEY: TOKENS.owner };
const reqs = () => fake.state.requests;
const last = () => reqs()[reqs().length - 1]!;

test("B1 whoami / org list / agents list, human and json", async () => {
  const w = await cli(["whoami", "--json"], { env: owner });
  expect(w.code).toBe(0);
  expect(JSON.parse(w.out).data.user.email).toBeString();
  expect(w.out.trim().split("\n")).toHaveLength(1);
  const h = await cli(["whoami"], { env: owner });
  expect(h.out).toContain("…abcd");
  const l = JSON.parse((await cli(["org", "list", "--json"], { env: owner })).out);
  expect(l.data[0].org.slug).toBe("acme");
  expect((await cli(["org", "list"], { env: owner })).out).toContain("acme");
  const a = JSON.parse((await cli(["agents", "list", "--json"], { env: owner })).out);
  expect(a.data.map((x: any) => x.profile_name)).toContain("hermes");
  expect((await cli(["agents", "list"], { env: owner })).out).toContain("hermes");
});

test("whoami with a non-object token.organization never prints 'pinned to'", async () => {
  fake.state.next = { status: 200, body: { data: { user: { email: "a@b.c" }, token: { name: "t", last4: "abcd", organization: "acme" }, memberships: [] } } };
  const h = await cli(["whoami"], { env: owner });
  expect(h.code).toBe(0);
  expect(h.out).not.toContain("pinned to");
});

test("B1 webhook list/get/create/update/delete", async () => {
  expect((await cli(["webhook", "list"], { env: owner })).out).toContain("wh_1");
  const g = await cli(["webhook", "get", "wh_1", "--json"], { env: owner });
  expect(JSON.parse(g.out).data.instructions).toBe("seed instructions");
  const c = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "do it", "--json"], { env: owner });
  expect(c.code).toBe(0);
  expect(JSON.parse(c.out).secret).toBeString();
  expect(last().body).toEqual({ name: "n", agent: "hermes", instructions: "do it" });
  const ch = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "x", "--full-tools"], { env: owner });
  expect(ch.out).toMatch(/shown once/);
  expect(last().body).toMatchObject({ full_tools: true });
  const d = await cli(["webhook", "delete", "wh_1", "--yes", "--json"], { env: owner });
  expect(JSON.parse(d.out)).toEqual({ data: { id: "wh_1", deleted: true } });
});

test("B2 create: stdin both spellings, zero requests on bad input", async () => {
  for (const f of [["--instructions-file", "-"], ["--instructions-file=-"]]) {
    const r = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", ...f], { env: owner, stdin: "from stdin\n" });
    expect(r.code).toBe(0);
    expect((last().body as any).instructions).toBe("from stdin\n");
  }
  const dir = await mkdtemp(join(tmpdir(), "oly-f-"));
  await writeFile(join(dir, "i.txt"), "from file");
  await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions-file", join(dir, "i.txt")], { env: owner });
  expect((last().body as any).instructions).toBe("from file");
  fake.state.requests.length = 0;
  const bad = [
    ["--name", "n", "--agent", "hermes", "--instructions", "a", "--instructions-file", "-"],
    ["--agent", "hermes", "--instructions", "a"], ["--name", "n", "--instructions", "a"], ["--name", "n", "--agent", "hermes"],
    ["--name", "n", "--agent", "hermes", "--instructions-file", join(dir, "nope")],
  ];
  for (const b of bad) expect((await cli(["webhook", "create", ...b], { env: owner })).code).toBe(1);
  expect(reqs()).toHaveLength(0);
});

test("B3 update sends only given fields", async () => {
  const c = await cli(["webhook", "create", "--name", "orig", "--agent", "hermes", "--instructions", "i", "--json"], { env: owner });
  const id = JSON.parse(c.out).data.id;
  const u = await cli(["webhook", "update", id, "--name", "x", "--json"], { env: owner });
  expect(u.code).toBe(0);
  expect(last()).toMatchObject({ method: "PATCH", body: { name: "x" } });
  expect(JSON.parse(u.out).data).toMatchObject({ id, name: "x" });
  const h = await cli(["webhook", "update", id, "--no-full-tools"], { env: owner });
  expect(h.code).toBe(0);
  expect(h.out).toContain("full_tools: false");
  expect(h.out).toContain(`id: ${id}`);
  expect(last().body).toEqual({ full_tools: false });
  expect((await cli(["webhook", "update", id, "--full-tools", "--agent", "hermes"], { env: owner })).code).toBe(0);
  expect(last().body).toEqual({ full_tools: true, agent: "hermes" });
  fake.state.requests.length = 0;
  expect((await cli(["webhook", "update", id], { env: owner })).code).toBe(1);
  expect(reqs()).toHaveLength(0);
});

test("B4 delete needs --yes", async () => {
  const r = await cli(["webhook", "delete", "wh_1"], { env: owner });
  expect(r.code).toBe(1);
  expect(reqs()).toHaveLength(0);
  const c = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "x", "--json"], { env: owner });
  const id = JSON.parse(c.out).data.id;
  expect((await cli(["webhook", "delete", id, "--yes"], { env: owner })).code).toBe(0);
});

test("B5 org use, login, logout", async () => {
  const creds = JSON.stringify({ host: fake.url, token: TOKENS.multi });
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  const r = await cli(["org", "use", "beta", "--json"], { home, creds });
  expect(JSON.parse(r.out)).toEqual({ data: { org: "beta" } });
  expect(JSON.parse(await readFile(join(home, ".config/olympus/credentials.json"), "utf8"))).toEqual({ host: fake.url, token: TOKENS.multi, org: "beta" });
  expect((await cli(["org", "use", "nope"], { home })).code).toBe(3);
  const p = await cli(["org", "use", "beta"], { env: { OLYMPUS_API_KEY: TOKENS.pinned } });
  expect(p.code).toBe(3);
  expect(p.err).toContain("acme");
  expect((await cli(["login", "--with-token"], { stdin: TOKENS.owner, env: { OLYMPUS_API_KEY: " " } })).err).not.toContain("OLYMPUS_API_KEY is set");
  const li = await cli(["login", "--with-token", "--json"], { home, stdin: ` ${TOKENS.owner}\n`, env: { OLYMPUS_API_KEY: "x" } });
  expect(li.code).toBe(0);
  expect(li.err).toContain("OLYMPUS_API_KEY");
  expect(JSON.parse(li.out).data.user.email).toBeString();
  expect(JSON.parse(await readFile(join(home, ".config/olympus/credentials.json"), "utf8"))).toEqual({ host: fake.url, token: TOKENS.owner });
  expect((await cli(["whoami"], { home })).code).toBe(0);
  const lo = await cli(["logout", "--json"], { home, env: { OLYMPUS_API_KEY: "x" } });
  expect(JSON.parse(lo.out)).toEqual({ data: { deleted: true } });
  expect(lo.err).toContain("OLYMPUS_API_KEY");
  expect(JSON.parse((await cli(["logout", "--json"], { home })).out)).toEqual({ data: { deleted: false } });
  expect((await cli(["whoami"], { home })).code).toBe(2);
});

test("org resolution: pin beats stored, --org skips /me", async () => {
  const creds = JSON.stringify({ host: fake.url, token: TOKENS.pinned, org: "beta" });
  expect((await cli(["agents", "list"], { creds })).code).toBe(0);
  expect(last().path).toContain("/orgs/acme/");
  fake.state.requests.length = 0;
  await cli(["agents", "list", "--org", "beta"], { env: owner });
  expect(reqs().map((r) => r.path).join()).not.toContain("/me");
  const m = await cli(["agents", "list"], { env: { OLYMPUS_API_KEY: TOKENS.multi } });
  expect(m.code).toBe(1);
  expect(m.err).toContain("beta");
});

test("A8 404 names a stored org; host-scoped stored org", async () => {
  const r = await cli(["agents", "list"], { env: owner, creds: JSON.stringify({ host: fake.url, org: "beta" }) });
  expect(r.code).toBe(3);
  expect(r.err).toContain("from credentials.json");
  const other = JSON.stringify({ host: "http://other.invalid", org: "beta" });
  const m = await cli(["agents", "list"], { env: { OLYMPUS_API_KEY: TOKENS.multi }, creds: other });
  expect(m.code).toBe(1);
  expect(m.err).toContain("acme, beta");
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  const u = await cli(["org", "use", "beta"], { home, env: { OLYMPUS_API_KEY: TOKENS.multi }, creds: other });
  expect(u.code).toBe(1);
  expect(u.err).toContain("other.invalid");
  expect(u.err).toContain(fake.url);
  expect(await readFile(join(home, ".config/olympus/credentials.json"), "utf8")).toBe(other);
});

test("B6 login --with-token needs a token on stdin", async () => {
  expect((await cli(["login", "--with-token"], { stdin: "  \n" })).code).toBe(1);
  expect((await cli(["login", "extra"], { env: owner })).code).toBe(1);
  expect(reqs()).toHaveLength(0);
});

const credsFile = (home: string) => join(home, ".config/olympus/credentials.json");
const existing = JSON.stringify({ host: "http://old.invalid", token: "oly_old", org: "x" });

test("D1 device login: pending then ok, human and json", async () => {
  fake.state.device = { script: ["authorization_pending", "ok"] };
  const h = await cli(["login"], { env: { OLYMPUS_API_KEY: "ignored" } });
  expect(h.code).toBe(0);
  expect(h.out).toBe(`logged in to ${fake.url} as owner@acme.test\n`);
  expect(h.err).toContain("ABCD-EFGH");
  expect(h.err).toContain("OLYMPUS_API_KEY is set");
  expect((await stat(credsFile(h.home))).mode & 0o777).toBe(0o600);
  const dev = reqs().filter((r) => r.path.includes("/device/"));
  expect(dev.map((r) => r.path)).toEqual(["/api/v1/device/code", "/api/v1/device/token", "/api/v1/device/token"]);
  expect(dev.every((r) => r.auth === null)).toBe(true);
  expect((dev[0]!.body as any).client_name).toBe(`olympus-cli on ${hostname()}`);

  fake.state.device = { script: ["authorization_pending", "ok"] };
  const j = await cli(["login", "--json"]);
  expect(j.code).toBe(0);
  expect(j.out.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(j.out).data.user.email).toBe("owner@acme.test");
  expect((await stat(credsFile(j.home))).mode & 0o777).toBe(0o600);
});

test("D2 browser opener", async () => {
  const run1 = async (args: string[], env: Record<string, string>) => {
    fake.state.device = { script: ["ok"] };
    const urls: string[] = [];
    const r = await cli(args, { env, openBrowser: (u) => void urls.push(u) });
    expect(r.code).toBe(0);
    return urls;
  };
  expect(await run1(["login", "--no-browser"], { DISPLAY: ":0" })).toEqual([]);
  expect(await run1(["login", "--no-browser"], { WAYLAND_DISPLAY: "w" })).toEqual([]);
  if (process.platform === "linux") expect(await run1(["login"], {})).toEqual([]);
  expect(await run1(["login"], { DISPLAY: ":0" })).toEqual([`${fake.url}/device?user_code=ABCD-EFGH`]);
});

test("D3 Ctrl-C: 130, writes nothing, listener restored", async () => {
  const before = process.listenerCount("SIGINT");
  for (const creds of [undefined, existing]) {
    fake.state.device = { script: [] };
    const r = await cli(["login", "--json"], { creds, sleep: async () => void process.emit("SIGINT") });
    expect(r.code).toBe(130);
    expect(JSON.parse(r.err.trim().split("\n").pop()!).error.code).toBe("cancelled");
    expect(r.out).toBe("");
    expect(process.listenerCount("SIGINT")).toBe(before);
    if (creds === undefined) expect(await Bun.file(credsFile(r.home)).exists()).toBe(false);
    else expect(await readFile(credsFile(r.home), "utf8")).toBe(creds);
  }
});

test("D4 expired / denied / past deadline exit 2 and keep the file", async () => {
  for (const script of [["expired_token"], ["access_denied"]]) {
    fake.state.device = { script };
    const r = await cli(["login"], { creds: existing });
    expect(r.code).toBe(2);
    expect(await readFile(credsFile(r.home), "utf8")).toBe(existing);
  }
  fake.state.device = { script: [], expires_in: 10 };
  let t = 0;
  const r = await cli(["login"], { creds: existing, now: () => (t += 20_000) });
  expect(r.code).toBe(2);
  expect(await readFile(credsFile(r.home), "utf8")).toBe(existing);
});

test("D5 device login never leaks token or device_code", async () => {
  const noUserCode = { device_code: DEVICE_CODE, verification_uri: `${fake.url}/device`, expires_in: 600, interval: 5 };
  const rs = [];
  for (const d of [{ script: ["echo"] }, { script: ["ok"], codeBody: noUserCode }, { script: ["ok"] }])
    for (const json of [[], ["--json"]]) {
      fake.state.device = { ...d, script: [...d.script] };
      rs.push(await cli(["login", ...json]));
    }
  for (const r of rs) for (const x of [r.out, r.err]) { expect(x).not.toContain(DEVICE_CODE); expect(x).not.toContain(TOKENS.owner); }
  expect(rs.filter((r) => r.code !== 0)).toHaveLength(4);
});

test("B7 token never leaks", async () => {
  const T = TOKENS.owner;
  const sweeps: { r: Awaited<ReturnType<typeof cli>> }[] = [];
  const base = { env: { OLYMPUS_API_KEY: T } };
  for (const next of [{ status: 401, body: { error: { code: "unauthorized", message: "no" } } }, { status: 403, body: { error: { code: "forbidden", message: "no" } } },
    { status: 404, body: { error: { code: "not_found", message: "no" } } }, { status: 422, body: { error: { code: "invalid", message: "bad", details: { fields: { name: ["blank"] } } } } },
    { status: 503, body: { error: { code: "machine_not_ready", message: "later" } } }, { status: 200, body: "garbage" }]) {
    for (const json of [[], ["--json"]]) {
      fake.state.next = next as any;
      sweeps.push({ r: await cli(["whoami", ...json], base) });
    }
  }
  sweeps.push({ r: await cli(["whoami"], { env: { OLYMPUS_API_KEY: T, OLYMPUS_HOST: "http://127.0.0.1:1" } }) });
  sweeps.push({ r: await cli(["whoami"], { env: { OLYMPUS_API_KEY: T, OLYMPUS_HOST: "http://example.com" } }) });
  for (const json of [[], ["--json"]]) {
    sweeps.push({ r: await cli(["login", "--with-token", ...json], { stdin: T + "x" }) });
    sweeps.push({ r: await cli(["whoami", ...json], { creds: `{"token":"${T}",` }) });
    sweeps.push({ r: await cli(["whoami", ...json], { creds: JSON.stringify({ host: "http://other.invalid", token: T }) }) });
  }
  const NL = { OLYMPUS_API_KEY: T + "\n" };
  for (const json of [[], ["--json"]]) {
    sweeps.push({ r: await cli(["whoami", ...json], { env: NL }) });
    fake.state.next = { status: 401, body: { error: { code: "unauthorized", message: "no" } } };
    sweeps.push({ r: await cli(["whoami", ...json], { env: NL }) });
    // (b) malformed file excused by the key, refused by org use; (e) token without host; (a) file changed under org use
    sweeps.push({ r: await cli(["whoami", ...json], { env: NL, creds: `{"token":"${T}",` }) });
    sweeps.push({ r: await cli(["org", "use", "acme", ...json], { env: NL, creds: `{"token":"${T}",` }) });
    sweeps.push({ r: await cli(["org", "use", "acme", ...json], { env: NL, creds: JSON.stringify({ token: T }) }) });
    const home = await mkdtemp(join(tmpdir(), "oly-"));
    fake.state.onRequest = async (q) => { if (q.path === "/api/v1/me") await rm(credsFile(home)); };
    sweeps.push({ r: await cli(["org", "use", "acme", ...json], { home, env: NL, creds: JSON.stringify({ host: fake.url, token: T }) }) });
    delete fake.state.onRequest;
  }
  for (const { r } of sweeps) { expect(r.out).not.toContain(T); expect(r.err).not.toContain(T); }
  expect(sweeps.some(({ r }) => r.code !== 0)).toBe(true);
});

test("B8 usage errors", async () => {
  for (const a of [["--bogus"], ["nope"], ["org"], ["org", "use"], ["whoami", "extra"], ["webhook", "get"], ["webhook", "list", "x"]]) {
    expect((await cli(a, { env: owner })).code).toBe(1);
  }
  const j = await cli(["--bogus", "--json"], { env: owner });
  expect(JSON.parse(j.err).error.code).toBe("usage");
  const h = await cli(["--help"]);
  expect(h.code).toBe(0);
  expect(h.out).toContain("usage");
  expect((await cli(["-h"])).out).toContain("usage");
  const bare = await cli([]);
  expect(bare.code).toBe(1);
  expect(bare.err).toContain("usage");
  expect(bare.out).toBe("");
  expect((await cli(["webhook", "update", "wh_1", "--instructions", "-foo"], { env: owner })).code).toBe(1);
  const c = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--json"], { env: owner });
  const id = JSON.parse(c.out).data.id;
  expect((await cli(["webhook", "update", id, "--instructions=-foo"], { env: owner })).code).toBe(0);
  expect(last().body).toEqual({ instructions: "-foo" });
  expect(reqs().filter((r) => r.method === "PATCH")).toHaveLength(1);
});

// Regression tests: output, flags and org resolution
const missing = async (p: string) => !(await stat(p).then(() => true, () => false));

test("AC14 whoami with a newline-terminated key exits 0", async () => {
  const r = await cli(["whoami"], { env: { OLYMPUS_API_KEY: TOKENS.owner + "\n" } });
  expect(r.code).toBe(0);
  expect(last().auth).toBe(`Bearer ${TOKENS.owner}`);
});

test("AC16 org use: credentials deleted during /me -> credentials_changed, nothing written", async () => {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  fake.state.onRequest = async (q) => { if (q.path === "/api/v1/me") await rm(credsFile(home)); };
  const r = await cli(["org", "use", "beta", "--json"], { home, creds: JSON.stringify({ host: fake.url, token: TOKENS.multi }) });
  expect(r.code).toBe(1);
  expect(JSON.parse(r.err).error.code).toBe("credentials_changed");
  expect(await missing(credsFile(home))).toBe(true);
  expect(r.err).not.toContain(TOKENS.multi);
  expect(r.out).toBe("");
});

test("AC16 org use: org changed during /me -> credentials_changed, file left as the other writer made it", async () => {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  const theirs = JSON.stringify({ host: fake.url, token: TOKENS.multi, org: "acme" });
  fake.state.onRequest = async (q) => { if (q.path === "/api/v1/me") await writeFile(credsFile(home), theirs); };
  const r = await cli(["org", "use", "beta"], { home, creds: JSON.stringify({ host: fake.url, token: TOKENS.multi }) });
  expect(r.code).toBe(1);
  expect(r.err).toContain("credentials");
  expect(await readFile(credsFile(home), "utf8")).toBe(theirs);
});

test("AC17 malformed file + env key: whoami and agents list work; org use refuses, file untouched", async () => {
  for (const args of [["whoami"], ["agents", "list"]]) {
    const r = await cli(args, { env: owner, creds: "{bad" });
    expect(r.code).toBe(0);
  }
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  reqs().length = 0;
  const r = await cli(["org", "use", "acme"], { home, env: owner, creds: "{bad" });
  expect(r.code).toBe(1);
  expect(await readFile(credsFile(home), "utf8")).toBe("{bad");
  expect(reqs().length).toBe(0);
  expect((await cli(["whoami"], { creds: "{bad" })).code).toBe(1);
});

test("AC18 webhook get/update/delete by id: no stored-org hint; list keeps it", async () => {
  const creds = JSON.stringify({ host: fake.url, org: "nope" });
  for (const a of [["webhook", "get", "nope"], ["webhook", "update", "nope", "--name", "x"], ["webhook", "delete", "nope", "--yes"]]) {
    const r = await cli(a, { env: owner, creds });
    expect(r.code).toBe(3);
    expect(r.err).not.toContain("from credentials.json");
  }
  const l = await cli(["webhook", "list"], { env: owner, creds });
  expect(l.code).toBe(3);
  expect(l.err).toContain("from credentials.json");
});

test("AC19 org use refuses a stored token with no host, file byte-identical", async () => {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  const creds = JSON.stringify({ token: TOKENS.multi });
  const r = await cli(["org", "use", "acme"], { home, env: { OLYMPUS_API_KEY: TOKENS.multi }, creds });
  expect(r.code).toBe(1);
  expect(r.err).toContain("olympus login --host");
  expect(r.err).not.toContain(TOKENS.multi);
  expect(await readFile(credsFile(home), "utf8")).toBe(creds);
});

test("AC20 empty webhook list: human prints nothing, json prints the body", async () => {
  const h = await cli(["webhook", "list", "--org", "beta"], { env: { OLYMPUS_API_KEY: TOKENS.multi } });
  expect(h.code).toBe(0);
  expect(h.out).toBe("");
  const j = await cli(["webhook", "list", "--org", "beta", "--json"], { env: { OLYMPUS_API_KEY: TOKENS.multi } });
  expect(j.out).toBe('{"data":[]}\n');
});

const pinned = { OLYMPUS_API_KEY: TOKENS.pinned };

test("AC2 pinned token: whoami shows the slug, never [object Object]", async () => {
  const h = await cli(["whoami"], { env: pinned });
  expect(h.out).toContain("(pinned to acme)");
  expect(h.out).not.toContain("[object Object]");
});

test("AC2 pinned token: agents list with no --org requests exactly /orgs/acme/agents", async () => {
  const r = await cli(["agents", "list"], { env: pinned });
  expect(r.code).toBe(0);
  expect(reqs().map((x) => x.path)).toEqual(["/api/v1/me", "/api/v1/orgs/acme/agents"]);
});

test("AC2 pinned token: org use acme exits 0, org use beta exits 3 naming the slug", async () => {
  expect((await cli(["org", "use", "acme"], { env: pinned })).code).toBe(0);
  const b = await cli(["org", "use", "beta"], { env: pinned });
  expect(b.code).toBe(3);
  expect(b.err).toContain('pinned to org "acme"');
  expect(b.err).not.toContain("[object Object]");
});

test("AC2 pinnedGone token: whoami prints no pin, agents list is 'no organizations'", async () => {
  const gone = { OLYMPUS_API_KEY: TOKENS.pinnedGone };
  const w = await cli(["whoami"], { env: gone });
  expect(w.code).toBe(0);
  expect(w.out).not.toContain("pinned");
  const a = await cli(["agents", "list"], { env: gone });
  expect(a.code).toBe(1);
  expect(a.err).toContain("no organizations");
});

test("AC4a update on a paused agent: exit 6, --json stderr is the server body, human shows the field", async () => {
  const j = await cli(["webhook", "update", "wh_paused", "--name", "x", "--json"], { env: owner });
  expect(j.code).toBe(6);
  expect(j.err).toBe('{"error":{"code":"invalid","message":"Validation failed.","details":{"fields":{"agent":["is paused"]}}}}\n');
  const h = await cli(["webhook", "update", "wh_paused", "--name", "x"], { env: owner });
  expect(h.code).toBe(6);
  expect(h.err).toContain("agent: is paused");
});

test("AC4b teammate webhook get is 403 -> exit 4", async () => {
  const id = JSON.parse((await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--json"], { env: owner })).out).data.id;
  expect((await cli(["webhook", "get", id], { env: { OLYMPUS_API_KEY: TOKENS.teammate } })).code).toBe(4);
});

test("AC4c non-JSON 5xx: exit 5, http_<status>, the HTML is never echoed", async () => {
  for (const [status, body] of [[500, "<html><body>Internal Server Error</body></html>"], [502, ""]] as const) {
    fake.state.next = { status, body, headers: { "Content-Type": "text/html" } };
    const r = await cli(["whoami", "--json"], { env: owner });
    expect(r.code).toBe(5);
    expect(JSON.parse(r.err).error.code).toBe(`http_${status}`);
    expect(r.err).not.toContain("<html");
  }
});

test("AC4d webhook delete without --yes still exits 1 with no request", async () => {
  const r = await cli(["webhook", "delete", "wh_1"], { env: owner });
  expect(r.code).toBe(1);
  expect(reqs()).toHaveLength(0);
});
