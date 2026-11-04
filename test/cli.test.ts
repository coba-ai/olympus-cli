import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { startFake, DEVICE_CODE, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
beforeEach(() => { fake.state.requests.length = 0; delete fake.state.next; delete fake.state.device; delete fake.state.onRequest; });

let ttyDefault = false; // B7 reruns its sweep with this on
async function cli(args: string[], o: { env?: Record<string, string>; stdin?: string; home?: string; creds?: string; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number; openBrowser?: (url: string) => void; tty?: boolean } = {}) {
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
    sleep: o.sleep ?? (async (ms) => { clock += ms; }), now: o.now ?? (() => clock), openBrowser: o.openBrowser, tty: o.tty ?? ttyDefault,
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

test("B7 token never leaks (piped and tty)", async () => {
  for (const tty of [false, true]) {
  ttyDefault = tty;
  try {
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
  } finally { ttyDefault = false; }
  }
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

// ---- rich (tty) output. Fixed clock: 2026-10-10 14:00 UTC.
const NOW = () => Date.parse("2026-10-10T14:00:00Z");
const rich = (args: string[], o: Parameters<typeof cli>[1] = {}) => cli(args, { tty: true, now: NOW, ...o });
const multi = { OLYMPUS_API_KEY: TOKENS.multi };
const storedOrg = (org: string) => JSON.stringify({ host: fake.url, token: TOKENS.multi, org });
const seeded = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: "deploys", agent: "hermes", full_tools: true, url: `${fake.url}/hooks/${id}`,
  last_delivery_at: "2026-10-10T11:00:00Z", last_delivery_status: 202, created_at: "2026-10-06T09:12:00Z",
  instructions: "When a deploy finishes,\npost a summary.", ...extra,
});
const withBeta = async (rows: any[], f: () => Promise<void>) => {
  fake.state.webhooks.beta = rows;
  try { await f(); } finally { fake.state.webhooks.beta = []; }
};

test("R1 agents list: table, older server, empty", async () => {
  const r = await rich(["agents", "list"], { env: owner });
  expect(r.out).toBe(
    "PROFILE  NAME              STATUS  CREATED  ROLE\n" +
    "hermes   Hermes (primary)  active  9d ago   Front desk for the team\n" +
    "hera     Hera              paused  20d ago  -\n");
  fake.state.next = { status: 200, body: { data: [{ profile_name: "hermes", name: "Hermes", paused: false }, { profile_name: "hera", name: "Hera", paused: true }] } };
  const old = await rich(["agents", "list", "--org", "acme"], { env: owner });
  expect(old.code).toBe(0);
  expect(old.out).toBe("PROFILE  NAME    STATUS\nhermes   Hermes  active\nhera     Hera    paused\n");
  fake.state.next = { status: 200, body: { data: [{ profile_name: "a", name: "A", paused: false, role_line: "x", created_at: null }] } };
  expect((await rich(["agents", "list", "--org", "acme"], { env: owner })).out).toBe("PROFILE  NAME  STATUS  ROLE\na        A     active  x\n");
  fake.state.next = { status: 200, body: { data: [] } };
  expect((await rich(["agents", "list", "--org", "acme"], { env: owner })).out).toBe("No agents in acme yet. Agents are created in the Olympus app.\n");
});

test("R2 org list marks the default and says where it came from", async () => {
  const stored = await rich(["org", "list"], { env: multi, creds: storedOrg("beta") });
  expect(stored.out).toBe("   SLUG  NAME  ROLE\n   acme  Acme  operator\n*  beta  Beta  operator\n\n* default org (saved by olympus org use)\n");
  expect(stored.out.split("\n").every((l) => l === l.trimEnd())).toBe(true);
  const none = await rich(["org", "list"], { env: multi });
  expect(none.out).toBe("   SLUG  NAME  ROLE\n   acme  Acme  operator\n   beta  Beta  operator\n\nNo default org; pick one with `olympus org use <slug>` or pass --org.\n");
  const stale = await rich(["org", "list"], { env: multi, creds: storedOrg("gone") });
  expect(stale.out).toContain("default org gone (saved by olympus org use) is not one of your organizations");
  expect(stale.out).not.toContain("*  ");
  const only = await rich(["org", "list"], { env: owner });
  expect(only.out).toContain("*  acme");
  expect(only.out).toContain("* default org (only membership)");
  expect((await rich(["org", "list", "--org", "beta"], { env: multi })).out).toContain("* default org (--org)");
  // one /me, nothing else
  fake.state.requests.length = 0;
  await rich(["org", "list"], { env: multi, creds: storedOrg("beta") });
  expect(reqs().map((q) => q.path)).toEqual(["/api/v1/me"]);
});

test("R3 whoami block, one /me", async () => {
  const r = await rich(["whoami"], { env: owner });
  expect(r.out).toBe(
    `host           ${fake.url}\nuser           owner@acme.test\ntoken          test …abcd (from OLYMPUS_API_KEY)\n` +
    "scope          all organizations\ndefault org    acme (only membership)\norganizations  acme (Acme, operator)\n");
  expect(reqs().map((q) => q.path)).toEqual(["/api/v1/me"]);
  const p = await rich(["whoami"], { env: { OLYMPUS_API_KEY: TOKENS.pinned } });
  expect(p.out).toContain("scope          acme (pinned)\ndefault org    acme (token pin)\n");
  expect((await rich(["whoami"], { env: multi })).out).toContain("organizations  acme (Acme, operator)\n               beta (Beta, operator)");
  const s = await rich(["whoami"], { creds: storedOrg("beta") });
  expect(s.out).toContain("token          test …abcd (from credentials.json)");
  expect(s.out).toContain("default org    beta (saved by olympus org use)");
  expect((await rich(["whoami"], { env: multi })).out).toContain("default org    none");
});

test("R4b whoami single-lines email; webhook block 'never' when status null but time set", async () => {
  fake.state.next = { status: 200, body: { data: { user: { email: "a@b.c\nevil: x" }, token: { name: "t", last4: "abcd" }, memberships: [] } } };
  const w = await rich(["whoami"], { env: owner });
  expect(w.out).toMatch(/^user +a@b\.c.*evil: x$/m);
  await withBeta([seeded("wh_9", { last_delivery_status: null })], async () => {
    expect((await rich(["webhook", "get", "wh_9", "--org", "beta"], { env: multi })).out).toContain("last delivery  never\n");
  });
});

test("R4 webhook list / get / update / delete", async () => {
  await withBeta([seeded("wh_7"), seeded("wh_1", { name: "seed", full_tools: false, last_delivery_at: null, last_delivery_status: null })], async () => {
    const o = { env: multi };
    expect((await rich(["webhook", "list", "--org", "beta"], o)).out).toBe(
      "ID    NAME     AGENT   TOOLS  LAST DELIVERY\nwh_7  deploys  hermes  full   202 accepted, 3h ago\nwh_1  seed     hermes  -      never\n");
    expect((await rich(["webhook", "get", "wh_7", "--org", "beta"], o)).out).toBe(
      "id             wh_7\nname           deploys\nagent          hermes\nfull tools     yes\n" +
      `url            ${fake.url}/hooks/wh_7\n` +
      "last delivery  202 accepted, 3h ago (2026-10-10 11:00 UTC)\ncreated        4d ago (2026-10-06 09:12 UTC)\n\n" +
      "instructions:\n  When a deploy finishes,\n  post a summary.\n");
    expect((await rich(["webhook", "get", "wh_1", "--org", "beta"], o)).out).toContain("last delivery  never\n");
    const u = await rich(["webhook", "update", "wh_7", "--no-full-tools", "--org", "beta"], o);
    expect(u.out.startsWith("Updated webhook wh_7.\n\nid             wh_7\n")).toBe(true);
    expect(u.out).toContain("full tools     no\n");
    expect(u.out).not.toContain("instructions:");
    expect((await rich(["webhook", "delete", "wh_7", "--yes", "--org", "beta"], o)).out).toBe("Deleted webhook wh_7.\n");
  });
  // unknown keys follow the known ones, before instructions
  await withBeta([seeded("wh_9", { extra_key: "x", nested: { a: 1 } })], async () => {
    const g = (await rich(["webhook", "get", "wh_9", "--org", "beta"], { env: multi })).out;
    expect(g.indexOf("created ")).toBeLessThan(g.indexOf("extra_key      x"));
    expect(g.indexOf("nested")).toBeGreaterThan(0);
    expect(g.indexOf("nested")).toBeLessThan(g.indexOf("instructions:"));
    expect(g).toContain('{"a":1}');
  });
});

test("R5 empty webhook list, webhook create", async () => {
  fake.state.webhooks.beta = [];
  expect((await rich(["webhook", "list", "--org", "beta"], { env: multi })).out).toBe(
    "No webhooks in beta yet. Create one:\n  olympus webhook create --name NAME --agent PROFILE --instructions TEXT\n");
  try {
    const c = await rich(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "do it", "--org", "beta"], { env: multi });
    expect(c.code).toBe(0);
    expect(c.out).toMatch(/^id {13}wh_\d+\nname {11}n\n/);
    expect(c.out).toMatch(/created {8}just now|created {8}\d+m ago|created {8}\S+ \(/); // wall-clock created_at vs fixed clock: shape only
    expect(c.out).toMatch(/last delivery {2}never\n/);
    expect(c.out).not.toContain("instructions:");
    expect(c.out).toMatch(/\n\nSigning secret \(shown once — store it now; it cannot be read again\):\n {2}whsec_[0-9a-f]+\n/);
    expect(c.out).toContain('See "Delivering to a webhook" in docs/API.md: https://github.com/coba-ai/olympus-cli/blob/main/docs/API.md#delivering-to-a-webhook\n');
  } finally { fake.state.webhooks.beta = []; }
});

test("R6 confirmations are sentences", async () => {
  expect((await rich(["login", "--with-token"], { stdin: TOKENS.owner })).out).toBe(`Logged in to ${fake.url} as owner@acme.test.\n`);
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  await cli(["login", "--with-token"], { home, stdin: TOKENS.owner });
  expect((await rich(["logout"], { home })).out).toBe("Logged out; stored credentials removed.\n");
  expect((await rich(["logout"], { home })).out).toBe("Not logged in; no stored credentials.\n");
  expect((await rich(["org", "use", "beta"], { env: multi })).out).toBe("Default org is now beta.\n");
});

test("R7 piped and tty --json are byte-equal", async () => {
  for (const args of [["agents", "list", "--json"], ["whoami", "--json"]]) {
    const [a, b] = [await cli(args, { env: owner, tty: false }), await cli(args, { env: owner, tty: true })];
    expect(b.out).toBe(a.out);
  }
  // piped stays the tab-separated shape even when the server sends the new fields
  expect((await cli(["agents", "list"], { env: owner, tty: false })).out).toBe("hermes\tHermes\tactive\nhera\tHera\tpaused\n");
});

test("R8 terminal control sequences from the server never reach a tty", async () => {
  const bad = "\x1b]52;c;AAAA\x07\x9b";
  const noCtl = (out: string) => { expect(out).not.toContain("\x1b"); expect(out).not.toContain("\x9b"); expect(out).not.toContain("\x07"); };
  fake.state.next = { status: 200, body: { data: [{ profile_name: "p" + bad, name: "n" + bad, paused: false, role_line: "r" + bad, created_at: "bad" + bad }] } };
  const a = await rich(["agents", "list", "--org", "acme"], { env: owner });
  noCtl(a.out);
  expect(a.out).toContain("n]52;c;AAAA");
  const me = { data: { user: { email: "e" + bad }, token: { name: "t" + bad, last4: "abcd", organization: null }, memberships: [{ org: { slug: "acme", name: "A" + bad }, role: "operator" + bad }] } };
  fake.state.next = { status: 200, body: me };
  noCtl((await rich(["whoami"], { env: owner })).out);
  fake.state.next = { status: 200, body: me };
  noCtl((await rich(["org", "list"], { env: owner })).out);
  await withBeta([seeded("wh_x", { name: "n" + bad, instructions: "i" + bad + "\nline2", created_at: "bad" + bad, last_delivery_at: "bad" + bad })], async () => {
    const g = await rich(["webhook", "get", "wh_x", "--org", "beta"], { env: multi });
    noCtl(g.out);
    expect(g.out).toContain("\n  line2");
    noCtl((await rich(["webhook", "list", "--org", "beta"], { env: multi })).out);
  });
  const c = await rich(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "x", "--org", "beta"], { env: multi });
  fake.state.webhooks.beta = [];
  noCtl(c.out);
  noCtl((await rich(["org", "use", "beta" + bad], { env: multi })).out);
  noCtl((await rich(["agents", "list", "--org", "acme" + bad], { env: owner })).out);
  fake.state.next = { status: 200, body: { data: [] } };
  noCtl((await rich(["agents", "list", "--org", "acme"], { env: owner })).out);
});

const PENDING = "an owner must approve this in Olympus → Webhooks";
const REJECTED = "an owner rejected this; fix it and update to resubmit";

test("webhook mode, signature and provider secret", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oly-wh-"));
  const secretPath = join(dir, "secret.txt");
  const schemePath = join(dir, "scheme.json");
  const providerSecret = "provider-secret-value-xyz";
  await writeFile(secretPath, providerSecret + "\n");
  const scheme = { kind: "hmac", header: "x-signature", encoding: "hex", prefix: "sha256=", signed: "body" };
  await writeFile(schemePath, JSON.stringify(scheme) + "\n");

  const created = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--mode", "inbox", "--signature", "github", "--provider-secret-file", secretPath, "--json"], { env: owner });
  expect(created.code).toBe(0);
  const body = JSON.parse(created.out);
  expect(body.secret).toBeNull();
  expect(body.data).toMatchObject({ mode: "inbox", signature: "github", approval: "approved", created_via: "api_person" });
  expect(body.data.approved_at).toBeString();
  expect(body.data.provider_secret).toBeUndefined();
  expect(created.out).not.toContain("shown once");
  expect(created.out).not.toContain(providerSecret);
  expect(created.err).not.toContain(providerSecret);
  expect(last().body).toMatchObject({ mode: "inbox", signature: "github", provider_secret: providerSecret });
  const id = body.data.id;
  const again = await cli(["webhook", "get", id, "--json"], { env: owner });
  expect(JSON.stringify(again)).not.toContain(providerSecret);
  expect(JSON.parse(again.out).data.provider_secret).toBeUndefined();

  const text = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--signature", "stripe"], { env: owner });
  expect(text.code).toBe(0);
  expect(text.out).not.toContain("shown once");
  expect(text.out).not.toContain("approval");
  expect(text.out).not.toContain("stripe");
  expect(text.err).toBe("");
  const shown = await rich(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--signature", "stripe"], { env: owner });
  expect(shown.out).toContain("stripe");
  expect(shown.out).toContain("approved");
  expect(shown.err).toBe("");

  const oly = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--signature", "olympus"], { env: owner });
  expect(oly.out).toMatch(/secret \(shown once\): whsec_[0-9a-f]+/);

  const fromStdin = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--signature", "linear", "--provider-secret-file", "-"], { env: owner, stdin: providerSecret + "\n\n" });
  expect(fromStdin.code).toBe(0);
  expect((last().body as any).provider_secret).toBe(providerSecret + "\n");
  expect(fromStdin.out).not.toContain(providerSecret);
  expect(fromStdin.err).not.toContain(providerSecret);

  const custom = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--mode", "run", "--signature-file", schemePath, "--json"], { env: owner });
  expect(custom.code).toBe(0);
  expect((last().body as any).signature).toEqual(scheme);
  expect(JSON.parse(custom.out).data.signature).toEqual(scheme);
  expect(JSON.parse(custom.out).secret).toBeNull();
  const tokenScheme = { kind: "token", header: "authorization" };
  await writeFile(schemePath, JSON.stringify(tokenScheme));
  const token = await cli(["webhook", "update", id, "--signature-file", schemePath, "--json"], { env: owner });
  expect(token.code).toBe(0);
  expect((last().body as any).signature).toEqual(tokenScheme);
  expect(JSON.parse(token.out).data.signature).toEqual(tokenScheme);
  const prefixed = { kind: "token", header: "authorization", prefix: "Bearer " };
  await writeFile(schemePath, JSON.stringify(prefixed));
  const withPrefix = await cli(["webhook", "update", id, "--signature-file", schemePath, "--json"], { env: owner });
  expect(withPrefix.code).toBe(0);
  expect((last().body as any).signature).toEqual(prefixed);
  expect(JSON.parse(withPrefix.out).data.signature).toEqual(prefixed);
  const maxPrefix = { kind: "token", header: "x-webhook-token", prefix: "x".repeat(32) };
  await writeFile(schemePath, JSON.stringify(maxPrefix));
  const atMax = await cli(["webhook", "update", id, "--signature-file", schemePath, "--json"], { env: owner });
  expect(atMax.code).toBe(0);
  expect((last().body as any).signature).toEqual(maxPrefix);

  const patched = await cli(["webhook", "update", id, "--mode", "run", "--json"], { env: owner });
  expect(patched.code).toBe(0);
  expect(last().body).toEqual({ mode: "run" });
  expect(JSON.parse(patched.out).data.mode).toBe("run");

  fake.state.requests.length = 0;
  const bad = [
    ["--signature", "github", "--signature-file", schemePath],
    ["--signature", "GitHub"],
    ["--signature", "nope"],
    ["--mode", "both"],
    ["--provider-secret-file", join(dir, "missing")],
  ];
  for (const flags of bad) {
    const r = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", ...flags], { env: owner });
    expect(r.code).toBe(1);
  }
  await writeFile(secretPath, "");
  expect((await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--provider-secret-file", secretPath], { env: owner })).code).toBe(1);
  await writeFile(secretPath, "\n");
  expect((await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--provider-secret-file", secretPath], { env: owner })).code).toBe(1);
  expect((await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--provider-secret-file", "-"], { env: owner, stdin: "\n" })).code).toBe(1);
  await writeFile(schemePath, "{");
  expect((await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--signature-file", schemePath], { env: owner })).code).toBe(1);
  await writeFile(schemePath, JSON.stringify({ kind: "token", header: "cookie" }));
  expect((await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--signature-file", schemePath], { env: owner })).code).toBe(1);
  await writeFile(schemePath, JSON.stringify({ kind: "token", header: "authorization", prefix: 1 }));
  expect((await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--signature-file", schemePath], { env: owner })).code).toBe(1);
  await writeFile(schemePath, JSON.stringify({ kind: "token", header: "authorization", prefix: "x".repeat(33) }));
  expect((await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--signature-file", schemePath], { env: owner })).code).toBe(1);
  expect((await cli(["webhook", "list", "--mode", "inbox"], { env: owner })).code).toBe(1);
  expect(reqs()).toHaveLength(0);

  const argvSecret = "argv-secret-should-not-leak";
  for (const args of [
    ["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--provider-secret", argvSecret],
    ["webhook", "update", id, "--provider-secret=" + argvSecret],
  ]) {
    const r = await cli(args, { env: owner });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(argvSecret);
    expect(r.err).not.toContain(argvSecret);
    expect(r.err).toContain("provider-secret-file");
  }
  expect(reqs()).toHaveLength(0);
});

test("piped webhook stdout stays byte-identical when the server adds fields", async () => {
  const u = fake.url;
  const data = {
    id: "wh_keep", name: "n", agent: "hermes", full_tools: false,
    url: `${u}/hooks/wh_keep`, last_delivery_at: null, last_delivery_status: null,
    created_at: "2026-10-02T10:00:00Z", instructions: "do it",
    approval: "approved", approved_at: "2026-10-02T10:00:00Z", created_via: "api_person",
    mode: "inbox", signature: "github", secret_set: true, future_field: "nope",
  };
  const golden = `id: wh_keep\nname: n\nagent: hermes\nfull_tools: false\nurl: ${u}/hooks/wh_keep\nlast_delivery_at: null\nlast_delivery_status: null\ncreated_at: 2026-10-02T10:00:00Z\ninstructions: do it\n`;
  fake.state.next = { status: 201, body: { data, secret: "whsec_abcdef" } };
  const created = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "do it", "--org", "acme"], { env: owner });
  expect(created.code).toBe(0);
  expect(created.err).toBe("");
  expect(created.out).toBe(golden + "secret (shown once): whsec_abcdef\n");
  fake.state.next = { status: 200, body: { data } };
  const got = await cli(["webhook", "get", "wh_keep", "--org", "acme"], { env: owner });
  expect(got.err).toBe("");
  expect(got.out).toBe(golden);
  fake.state.next = { status: 200, body: { data: [data, { ...data, id: "wh_keep2", name: "m" }] } };
  const listed = await cli(["webhook", "list", "--org", "acme"], { env: owner });
  expect(listed.err).toBe("");
  expect(listed.out).toBe("wh_keep\tn\thermes\t-\t-\nwh_keep2\tm\thermes\t-\t-\n");
  fake.state.next = { status: 200, body: { data } };
  const j = await cli(["webhook", "get", "wh_keep", "--org", "acme", "--json"], { env: owner });
  expect(j.err).toBe("");
  expect(JSON.parse(j.out).hint).toBeUndefined();
  expect(JSON.parse(j.out).data).toMatchObject({ approval: "approved", approved_at: "2026-10-02T10:00:00Z", created_via: "api_person", mode: "inbox", signature: "github", secret_set: true, future_field: "nope" });
  fake.state.next = { status: 200, body: { data } };
  const tty = await rich(["webhook", "get", "wh_keep", "--org", "acme"], { env: owner });
  expect(tty.err).toBe("");
  expect(tty.out).toContain("inbox");
  expect(tty.out).toContain("github");
  expect(tty.out).toMatch(/secret set\s+true/);
  expect(tty.out).toContain("approved");
  expect(tty.out).toContain("api_person");
  expect(tty.out).toContain("future_field");
  expect(tty.out).toContain("nope");
  expect(tty.out.indexOf("future_field")).toBeLessThan(tty.out.indexOf("instructions:"));
});

test("webhook pending and rejected hints, text and json", async () => {
  const pending = () => { fake.state.next = { status: 201, body: { data: { id: "wh_p", name: "n", agent: "hermes", full_tools: false, approval: "pending", approved_at: null, created_via: "agent_turn" }, secret: null } }; };
  pending();
  const j = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--org", "acme", "--json"], { env: owner });
  expect(j.code).toBe(0);
  const parsed = JSON.parse(j.out);
  expect(parsed.data.approval).toBe("pending");
  expect(parsed.data.created_via).toBe("agent_turn");
  expect(parsed.hint).toBe(PENDING);
  expect(j.err).toBe(PENDING + "\n");
  expect(j.out).not.toContain("shown once");
  pending();
  const piped = await cli(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--org", "acme"], { env: owner });
  expect(piped.out).toBe("id: wh_p\nname: n\nagent: hermes\nfull_tools: false\n");
  expect(piped.out).not.toContain(PENDING);
  expect(piped.err).toBe(PENDING + "\n");
  expect(piped.out).not.toContain("shown once");
  fake.state.next = { status: 201, body: { data: { id: "wh_p", name: "n", approval: "pending", created_via: "agent_turn" }, secret: "whsec_should_still_show" } };
  const tty = await rich(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "i", "--org", "acme"], { env: owner });
  expect(tty.out).toContain("approval       pending");
  expect(tty.out).toContain("agent_turn");
  expect(tty.out).toContain(PENDING);
  expect(tty.out).toContain("shown once");
  expect(tty.err).toBe("");

  const rejectedGet = `id: wh_r\nname: deploys\nagent: hermes\nfull_tools: true\nurl: ${fake.url}/hooks/wh_r\nlast_delivery_at: 2026-10-10T11:00:00Z\nlast_delivery_status: 202\ncreated_at: 2026-10-06T09:12:00Z\ninstructions: When a deploy finishes,\npost a summary.\n`;
  await withBeta([
    seeded("wh_r", { approval: "rejected", approved_at: "2026-10-01T00:00:00Z", created_via: "agent_turn", mode: "inbox", signature: "github", secret_set: false }),
    seeded("wh_ok", { approval: "approved", approved_at: "2026-10-02T00:00:00Z", created_via: "api_person" }),
  ], async () => {
    const h = await cli(["webhook", "get", "wh_r", "--org", "beta"], { env: multi });
    expect(h.out).toBe(rejectedGet);
    expect(h.err).toBe(REJECTED + "\n");
    const jr = await cli(["webhook", "get", "wh_r", "--org", "beta", "--json"], { env: multi });
    expect(JSON.parse(jr.out).data.approval).toBe("rejected");
    expect(JSON.parse(jr.out).data.signature).toBe("github");
    expect(JSON.parse(jr.out).hint).toBe(REJECTED);
    expect(jr.err).toBe(REJECTED + "\n");
    const tg = await rich(["webhook", "get", "wh_r", "--org", "beta"], { env: multi });
    expect(tg.out).toContain("rejected");
    expect(tg.out).toContain("github");
    expect(tg.out).toContain("agent_turn");
    expect(tg.out).toMatch(/secret set\s+false/);
    expect(tg.out).toContain(REJECTED);
    expect(tg.err).toBe("");
    const list = await rich(["webhook", "list", "--org", "beta"], { env: multi });
    expect(list.out).toContain("APPROVAL");
    expect(list.out).toContain("rejected");
    expect(list.out).toContain("approved");
    expect(list.out).toContain(REJECTED);
    expect(list.out.match(new RegExp(REJECTED, "g"))).toHaveLength(1);
    expect(list.err).toBe("");
    const plain = await cli(["webhook", "list", "--org", "beta"], { env: multi });
    expect(plain.out).toBe("wh_r\tdeploys\thermes\tfull-tools\t202\nwh_ok\tdeploys\thermes\tfull-tools\t202\n");
    expect(plain.err).toBe(REJECTED + "\n");
    const u = await cli(["webhook", "update", "wh_r", "--name", "x", "--org", "beta"], { env: multi });
    expect(u.code).toBe(0);
    expect(u.out).toContain("name: x");
    expect(u.out).not.toContain("approval");
    expect(u.out).not.toContain(REJECTED);
    expect(u.err).toBe(REJECTED + "\n");
  });
});
