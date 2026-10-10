import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  api, CliError, DEFAULT_HOST, defaultOrg, deleteCreds, deviceLogin, envKey, fail, loginWithToken, print, readCreds, resolveHost, resolveOrg,
  resolveToken, writeCreds, type Io, type Me,
} from "../src/core";
import { DEVICE_CODE, startFake, TOKENS } from "./fake-api";

const fake = startFake();
const other = startFake();
afterAll(() => (fake.stop(), other.stop()));

let io: Io & { o: string[]; e: string[] };
let dir: string;
const credFile = () => join(dir, ".config/olympus/credentials.json");
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oly-core-"));
  const o: string[] = [], e: string[] = [];
  io = { env: {}, home: dir, stdin: async () => "", out: (s) => o.push(s), err: (s) => e.push(s), o, e };
  fake.state.requests.length = 0;
  other.state.requests.length = 0;
  fake.state.next = undefined;
});
const thrown = async (p: Promise<unknown> | (() => unknown)): Promise<CliError> => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e as CliError;
  }
  throw new Error("did not throw");
};
const meOf = (t: string) => () => api(fake.url, t)("GET", "/me").then((r) => r.data as Me);

describe("A1 token", () => {
  test("env first, empty env unset, stored only for its host, else exit 2", async () => {
    const creds = { host: "http://127.0.0.1:1", token: "stored" };
    expect(resolveToken("http://127.0.0.1:1", { ...io, env: { OLYMPUS_API_KEY: "envtok" } }, creds)).toBe("envtok");
    expect(resolveToken("http://127.0.0.1:1", { ...io, env: { OLYMPUS_API_KEY: "" } }, creds)).toBe("stored");
    const e = await thrown(() => resolveToken("http://127.0.0.1:2", io, creds));
    expect(e.exit).toBe(2);
    expect(e.message).toContain("login [--host H]");
    expect(e.message).toContain("OLYMPUS_API_KEY");
    expect(e.message).not.toContain("stored");
  });
});

describe("AC14 envKey", () => {
  test("trimmed; whitespace-only is unset", async () => {
    expect(resolveToken("http://127.0.0.1:1", { ...io, env: { OLYMPUS_API_KEY: "tok\n" } }, {})).toBe("tok");
    expect((await thrown(() => resolveToken("http://127.0.0.1:1", { ...io, env: { OLYMPUS_API_KEY: "  " } }, {}))).exit).toBe(2);
    expect(envKey({ ...io, env: { OLYMPUS_API_KEY: " k " } })).toBe("k");
    expect(envKey({ ...io, env: { OLYMPUS_API_KEY: "\n" } })).toBeUndefined();
    // whitespace-only key must not suppress the stored host
    expect(resolveHost(undefined, { ...io, env: { OLYMPUS_API_KEY: " " } }, { host: "http://127.0.0.1:9" })).toBe("http://127.0.0.1:9");
  });
});

describe("A2 host", () => {
  test("order, stripping, http rule", async () => {
    const c = { host: "https://stored.example" };
    expect(resolveHost("http://localhost:9/", io, c)).toBe("http://localhost:9");
    expect(resolveHost(undefined, { ...io, env: { OLYMPUS_HOST: "https://env.example/" } }, c)).toBe("https://env.example");
    expect(resolveHost(undefined, io, c)).toBe("https://stored.example");
    expect(resolveHost(undefined, { ...io, env: { OLYMPUS_API_KEY: "k", OLYMPUS_HOST: "" } }, c)).toBe(DEFAULT_HOST);
    expect(resolveHost(undefined, io, {})).toBe(DEFAULT_HOST);
    expect(resolveHost("http://127.0.0.5:1", io, {})).toBe("http://127.0.0.5:1");
    expect(resolveHost("http://[::1]:1", io, {})).toBe("http://[::1]:1");
    expect((await thrown(() => resolveHost("http://example.com", io, {}))).exit).toBe(1);
  });
  test("env token is never sent to the stored host", async () => {
    await writeCreds(io, { host: other.url, token: TOKENS.owner });
    const host = resolveHost(undefined, { ...io, env: { OLYMPUS_API_KEY: TOKENS.owner } }, await readCreds(io));
    expect(host).toBe(DEFAULT_HOST);
    // stored token against a different resolved host is not used
    expect((await thrown(() => resolveToken(fake.url, io, { host: other.url, token: TOKENS.owner }))).exit).toBe(2);
  });
});

describe("A3 org", () => {
  test("flag/env skip /me; pin beats stored; stored beats sole; sole; ambiguity lists slugs", async () => {
    const calls: string[] = [];
    const spy = (t: string) => async () => (calls.push("me"), await meOf(t)());
    expect(await resolveOrg("x", io, {}, spy(TOKENS.owner))).toBe("x");
    expect(await resolveOrg(undefined, { ...io, env: { OLYMPUS_ORG: "y" } }, {}, spy(TOKENS.owner))).toBe("y");
    expect(calls).toHaveLength(0);
    expect(await resolveOrg(undefined, io, { org: "beta" }, spy(TOKENS.pinned))).toBe("acme");
    expect(await resolveOrg(undefined, io, { org: "beta" }, meOf(TOKENS.multi))).toBe("beta");
    expect(await resolveOrg(undefined, io, {}, meOf(TOKENS.owner))).toBe("acme");
    const e = await thrown(resolveOrg(undefined, io, {}, meOf(TOKENS.multi)));
    expect(e.exit).toBe(1);
    expect(e.message).toContain("acme");
    expect(e.message).toContain("beta");
    const none = await thrown(resolveOrg(undefined, io, {}, async () => ({ user: { email: "" }, memberships: [], token: { name: "", last4: "", organization: null } })));
    expect(none.message).toContain("no organizations");
  });
  test("fake: pinned token's /me lists only the pinned org", async () => {
    const me = await meOf(TOKENS.pinned)();
    expect(me.memberships.map((m) => m.org.slug)).toEqual(["acme"]);
    expect(me.token.organization).toEqual({ slug: "acme", name: "Acme" });
  });
});

describe("A4 credentials", () => {
  test("missing reads {}; round trip; dir 0700; file 0600; no tmp left", async () => {
    expect(await readCreds(io)).toEqual({});
    await writeCreds(io, { host: "h", token: "t", org: "o" });
    expect(await readCreds(io)).toEqual({ host: "h", token: "t", org: "o" });
    expect((await stat(join(dir, ".config/olympus"))).mode & 0o777).toBe(0o700);
    expect((await stat(credFile())).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, ".config/olympus"))).toEqual(["credentials.json"]);
  });
  test("pre-existing 0644 file ends 0600", async () => {
    await mkdir(join(dir, ".config/olympus"), { recursive: true });
    await writeFile(credFile(), "{}");
    await chmod(credFile(), 0o644);
    await writeCreds(io, { host: "h", token: "t" });
    expect((await stat(credFile())).mode & 0o777).toBe(0o600);
  });
  test("malformed file: exit 1, contents not echoed; logout/login still work over it", async () => {
    await mkdir(join(dir, ".config/olympus"), { recursive: true });
    for (const bad of [`{"token":"SECRETVALUE"`, `["SECRETVALUE"]`, `{"token":123,"host":"SECRETVALUE"}`, `"SECRETVALUE"`]) {
      await writeFile(credFile(), bad);
      const e = await thrown(readCreds(io));
      expect(e.exit).toBe(1);
      expect(JSON.stringify(e.body)).not.toContain("SECRETVALUE");
    }
    await loginWithToken(io, fake.url, TOKENS.owner);
    expect((await readCreds(io)).token).toBe(TOKENS.owner);
    await writeFile(credFile(), "garbage");
    expect(await deleteCreds(io)).toBe(true);
    expect(await deleteCreds(io)).toBe(false);
  });
  test("fs errors become credentials_io", async () => {
    await writeFile(join(dir, ".config"), "a file, not a dir");
    const e = await thrown(writeCreds(io, { token: "t" }));
    expect(e.exit).toBe(1);
    expect(e.body.error.code).toBe("credentials_io");
    expect(e.body.error.message).toContain(credFile());
  });
});

describe("A5 status mapping", () => {
  const call = (status: number, body?: unknown, headers?: Record<string, string>) => {
    fake.state.next = { status, body, headers };
    return thrown(api(fake.url, TOKENS.owner)("GET", "/me"));
  };
  test("mapping table", async () => {
    for (const [s, x] of [[401, 2], [404, 3], [403, 4], [400, 6], [422, 6], [409, 5], [429, 5], [500, 5], [503, 5]] as const)
      expect((await call(s, { error: { code: "c", message: "m" } })).exit).toBe(x);
  });
  test("API error body kept verbatim; non-JSON synthesized", async () => {
    const body = { error: { code: "invalid", message: "bad", details: { fields: { name: ["x"] } } } };
    expect((await call(422, body)).body).toEqual(body);
    expect((await call(502, "<html>")).body).toEqual({ error: { code: "http_502", message: "HTTP 502" } });
    expect((await call(500, { oops: 1 })).body.error.code).toBe("http_500");
  });
  test("429 captures Retry-After", async () => {
    expect((await call(429, { error: { code: "rate_limited", message: "slow" } }, { "Retry-After": "7" })).retryAfter).toBe("7");
  });
  test("302 is not followed", async () => {
    fake.state.next = { status: 302, headers: { Location: `${other.url}/api/v1/me` } };
    const e = await thrown(api(fake.url, TOKENS.owner)("GET", "/me"));
    expect(e.exit).toBe(5);
    expect(e.body).toEqual({ error: { code: "http_302", message: "unexpected redirect" } });
    expect(e.location).toBe(new URL(other.url).host);
    expect(other.state.requests).toHaveLength(0);
  });
  test("timeout and network failure → 5 network_error", async () => {
    fake.state.next = { status: 200, body: {}, delayMs: 300 };
    const t = await thrown(api(fake.url, TOKENS.owner, 50)("GET", "/me"));
    expect([t.exit, t.body.error.code]).toEqual([5, "network_error"]);
    const dead = startFake();
    const url = dead.url;
    dead.stop();
    const n = await thrown(api(url, TOKENS.owner)("GET", "/me"));
    expect([n.exit, n.body.error.code]).toEqual([5, "network_error"]);
    expect(JSON.stringify(n.body)).not.toContain(TOKENS.owner);
  });
  test("request shape, 204 → null", async () => {
    const a = api(fake.url, TOKENS.owner);
    const made = await a("POST", "/orgs/acme/webhooks", { name: "n", agent: "hermes", instructions: "i" });
    expect(await a("DELETE", `/orgs/acme/webhooks/${made.data.id}`)).toBeNull();
    const r = fake.state.requests;
    expect(r[1]).toMatchObject({ method: "DELETE", path: `/api/v1/orgs/acme/webhooks/${made.data.id}`, auth: `Bearer ${TOKENS.owner}` });
    expect(r[0]!.body).toEqual({ name: "n", agent: "hermes", instructions: "i" });
  });
});

describe("A6 loginWithToken", () => {
  test("success writes {host, token} and drops org", async () => {
    await writeCreds(io, { host: "h", token: "old", org: "beta" });
    const me = await loginWithToken(io, fake.url, TOKENS.owner);
    expect(me.user.email).toBe("owner@acme.test");
    expect(await readCreds(io)).toEqual({ host: fake.url, token: TOKENS.owner });
    expect(fake.state.requests.at(-1)).toMatchObject({ method: "GET", path: "/api/v1/me", auth: `Bearer ${TOKENS.owner}` });
  });
  test("failures leave the file byte-identical", async () => {
    await writeCreds(io, { host: "h", token: "old" });
    const before = await readFile(credFile());
    for (const next of [undefined, { status: 503 }, { status: 200, body: "not json" }, { status: 204 }, { status: 200, body: {} }] as const) {
      fake.state.next = next as any;
      const e = await thrown(loginWithToken(io, fake.url, next ? TOKENS.owner : "oly_test_bad_0000000000000000"));
      if (!next) expect(e.exit).toBe(2);
      expect(Buffer.compare(before, await readFile(credFile()))).toBe(0);
    }
    const dead = startFake(); const u = dead.url; dead.stop();
    await thrown(loginWithToken(io, u, TOKENS.owner));
    expect(Buffer.compare(before, await readFile(credFile()))).toBe(0);
  });
});

describe("A7 fake contract", () => {
  const as = (t: string) => api(fake.url, t);
  test("401, 404 (non-member, pin mismatch, unknown path), 403, 422, 201, 204, list/get", async () => {
    expect((await thrown(as("nope")("GET", "/me"))).exit).toBe(2);
    const raw = await fetch(`${fake.url}/api/v1/me`);
    expect(raw.headers.get("www-authenticate")).toBe('Bearer realm="olympus"');
    expect((await thrown(as(TOKENS.owner)("GET", "/orgs/beta/webhooks"))).exit).toBe(3);
    expect((await thrown(as(TOKENS.pinned)("GET", "/orgs/beta/webhooks"))).exit).toBe(3);
    expect((await thrown(as(TOKENS.owner)("GET", "/nothing"))).exit).toBe(3);
    expect((await as(TOKENS.teammate)("GET", "/orgs/acme/webhooks")).data[0].instructions).toBeUndefined();
    expect((await thrown(as(TOKENS.teammate)("DELETE", "/orgs/acme/webhooks/wh_1"))).exit).toBe(4);
    const e = await thrown(as(TOKENS.owner)("POST", "/orgs/acme/webhooks", { name: " ", agent: "zzz", instructions: "" }));
    expect(e.exit).toBe(6);
    expect(Object.keys((e.body.error.details as any).fields).sort()).toEqual(["agent", "instructions", "name"]);
    const c = await as(TOKENS.owner)("POST", "/orgs/acme/webhooks", { name: "n", agent: "hermes", instructions: "i" });
    expect(c.secret).toMatch(/^whsec_/);
    expect(c.data.id).toMatch(/^wh_\d+$/);
    expect((await as(TOKENS.owner)("GET", `/orgs/acme/webhooks/${c.data.id}`)).data.instructions).toBe("i");
    const p = await as(TOKENS.owner)("PATCH", `/orgs/acme/webhooks/${c.data.id}`, { full_tools: true });
    expect(p.data).toMatchObject({ full_tools: true, name: "n" });
    expect(await as(TOKENS.owner)("DELETE", `/orgs/acme/webhooks/${c.data.id}`)).toBeNull();
    expect((await thrown(as(TOKENS.owner)("GET", "/orgs/acme/webhooks/wh_99"))).exit).toBe(3);
    expect((await as(TOKENS.multi)("GET", "/orgs/beta/agents")).data[0].profile_name).toBe("hermes");
  });
  test("next is one-shot, applies before auth, is logged", async () => {
    fake.state.next = { status: 503, body: { error: { code: "machine_not_ready", message: "m" } } };
    expect((await thrown(as("nope")("GET", "/me"))).body.error.code).toBe("machine_not_ready");
    expect((await thrown(as("nope")("GET", "/me"))).exit).toBe(2);
    expect(fake.state.requests).toHaveLength(2);
  });
});

describe("A8 fail/print", () => {
  const err = (exit: 1 | 2 | 3 | 5 | 6, error: any, ra?: string, loc?: string, status?: number) => new CliError(exit, { error }, ra, loc, status);
  test("json: exactly the body, one line, stderr only", () => {
    const e = err(6, { code: "invalid", message: "bad", details: { fields: { name: ["x"] } } });
    expect(fail(io, true, e)).toBe(6);
    expect(io.e).toEqual([JSON.stringify(e.body) + "\n"]);
    expect(io.o).toEqual([]);
  });
  test("human: message, fields, retry-after, status fallback, 404 hint, redirect hint", () => {
    fail(io, false, err(6, { code: "invalid", message: "bad", details: { fields: { name: ["a", "b"], agent: ["c"] } } }));
    expect(io.e.pop()).toBe("error: bad\n  name: a, b\n  agent: c\n");
    fail(io, false, err(5, { code: "rate_limited", message: "slow" }, "30"));
    expect(io.e.pop()).toBe("error: slow (retry after 30s)\n");
    fail(io, false, err(5, { code: "x" } as any, undefined, undefined, 500));
    expect(io.e.pop()).toBe("error: HTTP 500\n");
    fail(io, false, err(3, { code: "not_found", message: "gone" }), { orgFromCreds: "acme" });
    expect(io.e.pop()).toBe('error: gone (org "acme" from credentials.json; override with --org)\n');
    fail(io, false, err(3, { code: "not_found", message: "gone" }));
    expect(io.e.pop()).toBe("error: gone\n");
    fail(io, false, err(5, { code: "http_302", message: "unexpected redirect" }, undefined, "app.x.ai", 302));
    expect(io.e.pop()).toBe("error: unexpected redirect (redirected to app.x.ai; check --host)\n");
    expect(io.o).toEqual([]);
  });
  test("AC15 print: empty human string writes nothing; json unchanged", () => {
    print(io, false, { data: [] }, () => "");
    expect(io.o).toEqual([]);
    print(io, true, { data: [] }, () => "");
    expect(io.o).toEqual(['{"data":[]}\n']);
  });
  test("print: json compact line; human via callback", () => {
    print(io, true, { data: { a: 1 } }, () => "no");
    print(io, false, {}, () => "hello");
    expect(io.o).toEqual(['{"data":{"a":1}}\n', "hello\n"]);
  });
});

describe("B7 token never leaks", () => {
  test("across error paths and modes", async () => {
    const t = TOKENS.owner;
    await mkdir(join(dir, ".config/olympus"), { recursive: true });
    await writeFile(credFile(), `{"token":"${t}"`);
    const errs: CliError[] = [await thrown(readCreds(io))];
    for (const status of [401, 403, 404, 422, 503, 302]) {
      fake.state.next = { status, body: { error: { code: "c", message: "m" } } };
      errs.push(await thrown(api(fake.url, t)("GET", "/me")));
    }
    errs.push(await thrown(api(fake.url, "bad")("GET", "/me")));
    errs.push(await thrown(loginWithToken(io, fake.url, "oly_test_bad_0000000000000000")));
    errs.push(await thrown(() => resolveToken(fake.url, io, { host: "other", token: t })));
    const dead = startFake(); const u = dead.url; dead.stop();
    errs.push(await thrown(api(u, t)("GET", "/me")));
    for (const e of errs) for (const json of [true, false]) fail(io, json, e);
    print(io, true, await api(fake.url, t)("GET", "/me"), () => "x");
    const all = [...io.o, ...io.e].join("");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(t);
    expect(all).not.toContain("oly_test_bad_0000000000000000");
  });
});

describe("device login", () => {
  let sleeps: number[], t: number, onSleep: (n: number) => void | Promise<void>;
  beforeEach(() => {
    sleeps = [];
    t = 1_000_000;
    onSleep = () => {};
    fake.state.device = undefined;
    io.sleep = async (ms) => {
      sleeps.push(ms);
      t += ms;
      await onSleep(sleeps.length);
    };
    io.now = () => t;
  });
  const dev = (script: string[], more: Record<string, unknown> = {}) => (fake.state.device = { script, ...more });
  const run = (o: Partial<Parameters<typeof deviceLogin>[2]> = {}) =>
    deviceLogin(io, fake.url, { clientName: "olympus-cli on box", browser: false, ...o });
  const existing = async () => {
    await writeCreds(io, { host: "h", token: "old", org: "beta" });
    return readFile(credFile());
  };
  const same = async (before: Buffer) => expect(Buffer.compare(before, await readFile(credFile()))).toBe(0);
  const polls = () => fake.state.requests.filter((r) => r.path === "/api/v1/device/token");

  test("AC1 no token sends no Authorization header", async () => {
    await thrown(api(fake.url)("GET", "/me"));
    expect(fake.state.requests[0]!.auth).toBeNull();
  });

  test("AC2/3/5 pending, slow_down keeps +5s, success verifies /me and writes 0600", async () => {
    dev(["", "slow_down", "", "ok"]);
    io.env.OLYMPUS_API_KEY = "envtok";
    const me = await run();
    expect(me.user.email).toBe("owner@acme.test");
    expect(sleeps).toEqual([5000, 5000, 10000, 10000]);
    expect(await readCreds(io)).toEqual({ host: fake.url, token: TOKENS.owner });
    expect((await stat(credFile())).mode & 0o777).toBe(0o600);
    const rs = fake.state.requests;
    expect(rs[0]).toMatchObject({ method: "POST", path: "/api/v1/device/code", auth: null, body: { client_name: "olympus-cli on box" } });
    for (const r of polls()) expect(r).toMatchObject({ auth: null, body: { device_code: DEVICE_CODE } });
    expect(rs.at(-1)).toMatchObject({ path: "/api/v1/me", auth: `Bearer ${TOKENS.owner}` });
    const err = io.e.join("");
    expect(err).toContain("ABCD-EFGH");
    expect(err).toContain(`${fake.url}/device?user_code=ABCD-EFGH`);
    expect(io.o).toEqual([]);
  });

  test("AC3 429 is non-terminal: +5s and waits at least Retry-After", async () => {
    dev(["ok"]);
    onSleep = (n) => void (n === 1 && (fake.state.next = { status: 429, body: { error: { code: "rate_limited", message: "Too many requests." } }, headers: { "Retry-After": "20" } }));
    await run();
    expect(sleeps).toEqual([5000, 20000]);
    dev(["ok"]);
    sleeps.length = 0;
    onSleep = (n) => void (n === 1 && (fake.state.next = { status: 429, body: { error: { code: "rate_limited", message: "Too many requests." } } })); // no Retry-After: the server always sends one, but the client must survive a bare 429
    await run();
    expect(sleeps).toEqual([5000, 10000]);
  });

  test("F1 a huge Retry-After never sleeps past the code lifetime, no poll after the deadline", async () => {
    const before = await existing();
    dev(["ok"], { expires_in: 60 });
    onSleep = (n) => void (n === 1 && (fake.state.next = { status: 429, body: { error: { code: "rate_limited", message: "Too many requests." } }, headers: { "Retry-After": "3600" } }));
    const e = await thrown(run());
    expect([e.exit, e.body.error.code]).toEqual([2, "expired_token"]);
    expect(sleeps.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(60_000);
    expect(polls().length).toBe(1);
    await same(before);
  });

  test("AC4 expired_token/access_denied exit 2, other codes and statuses via exitForStatus; file untouched", async () => {
    const before = await existing();
    for (const [script, exit, code] of [
      [["expired_token"], 2, "expired_token"], [["access_denied"], 2, "access_denied"], [["weird_code"], 6, "weird_code"],
    ] as const) {
      dev([...script]);
      const e = await thrown(run());
      expect([e.exit, e.body.error.code]).toEqual([exit, code]);
      await same(before);
    }
    for (const [status, exit] of [[503, 5], [401, 2], [404, 3], [302, 5]] as const) {
      dev([]);
      sleeps.length = 0;
      onSleep = (n) => void (n === 1 && (fake.state.next = { status, body: { error: { code: "c", message: "m" } } }));
      expect((await thrown(run())).exit).toBe(exit);
      await same(before);
    }
  });

  test("AC4 client-side deadline exits 2 expired_token with no further poll", async () => {
    const before = await existing();
    dev([], { expires_in: 12 });
    const e = await thrown(run());
    expect([e.exit, e.body.error.code]).toEqual([2, "expired_token"]);
    expect(sleeps).toEqual([5000, 5000, 2000]);
    expect(polls()).toHaveLength(2);
    await same(before);
  });

  test("/device/code failures are terminal: 404 hint, 429, 422, bad shapes", async () => {
    const before = await existing();
    let e = await thrown(run()); // no device script -> fake 404
    expect([e.exit, e.message]).toEqual([3, "this server does not support device login; use `olympus login --with-token`"]);
    for (const [status, exit] of [[429, 5], [422, 6]] as const) {
      fake.state.next = { status, body: { error: { code: "c", message: "m" } }, headers: status === 429 ? { "Retry-After": "60" } : undefined };
      expect((await thrown(run())).exit).toBe(exit);
    }
    for (const codeBody of [{}, { device_code: "d", user_code: "u", verification_uri: "v", expires_in: 0 }, { device_code: "d", user_code: "u", verification_uri: "v" }]) {
      dev([], { codeBody });
      e = await thrown(run());
      expect([e.exit, e.body.error.code]).toEqual([5, "bad_response"]);
    }
    expect(sleeps).toEqual([]);
    await same(before);
  });

  test("AC5 bad 200 shapes write nothing", async () => {
    const before = await existing();
    for (const body of [{ token: TOKENS.owner }, { data: {} }, { data: { token: "" } }, { data: { token: 5 } }]) {
      dev([]);
      sleeps.length = 0;
      onSleep = (n) => void (n === 1 && (fake.state.next = { status: 200, body }));
      const e = await thrown(run());
      expect([e.exit, e.body.error.code]).toEqual([5, "bad_response"]);
      await same(before);
    }
  });

  test("interval: missing -> 5s, tiny -> clamped to 1s", async () => {
    dev(["ok"], { interval: 0 });
    await run();
    expect(sleeps).toEqual([1000]);
    sleeps.length = 0;
    dev(["ok"], { codeBody: { device_code: DEVICE_CODE, user_code: "U", verification_uri: `${fake.url}/device`, expires_in: 60 } });
    await run();
    expect(sleeps).toEqual([5000]);
  });

  describe("AC7 browser", () => {
    const opened: string[] = [];
    beforeEach(() => {
      opened.length = 0;
      io.openBrowser = (u) => void opened.push(u);
      dev(["ok"]);
    });
    test("opens verification_uri_complete, else verification_uri, only with a display", async () => {
      io.env.DISPLAY = ":0";
      await run({ browser: true });
      expect(opened).toEqual([`${fake.url}/device?user_code=ABCD-EFGH`]);
      opened.length = 0;
      dev(["ok"], { omitComplete: true });
      io.env = { WAYLAND_DISPLAY: "wayland-0" };
      await run({ browser: true });
      expect(opened).toEqual([`${fake.url}/device`]);
    });
    test("not with browser:false, not without a display, not for non-http(s)", async () => {
      io.env.DISPLAY = ":0";
      await run({ browser: false });
      if (process.platform !== "darwin") {
        dev(["ok"]);
        io.env = {};
        await run({ browser: true });
      }
      dev(["ok"], { codeBody: { device_code: DEVICE_CODE, user_code: "U", verification_uri: "javascript:alert(1)", expires_in: 60 } });
      io.env = { DISPLAY: ":0" };
      await run({ browser: true });
      expect(opened).toEqual([]);
      expect(io.e.join("")).toContain("javascript:alert(1)");
    });
    test("a throwing opener does not stop login", async () => {
      io.env.DISPLAY = ":0";
      io.openBrowser = () => {
        throw new Error("no xdg-open");
      };
      expect((await run({ browser: true })).user.email).toBe("owner@acme.test");
    });
  });

  describe("C2 cancel", () => {
    const cancelCase = async (setup: (ac: AbortController) => void) => {
      for (const withFile of [false, true]) {
        const before = withFile ? await existing() : undefined;
        const ac = new AbortController();
        dev([]);
        setup(ac);
        const e = await thrown(run({ signal: ac.signal }));
        expect([e.exit, e.body]).toEqual([130, { error: { code: "cancelled", message: "login cancelled" } }]);
        if (before) await same(before);
        else expect(await readdir(join(dir, ".config")).catch(() => "none")).toBe("none");
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir);
      }
    };
    test("abort during sleep", () => cancelCase((ac) => (onSleep = () => ac.abort())));
    test("abort aborts the in-flight poll promptly", async () => {
      const t0 = performance.now();
      await cancelCase((ac) => {
        onSleep = () => {
          fake.state.next = { status: 400, body: {}, delayMs: 5000 };
          setTimeout(() => ac.abort(), 30);
        };
      });
      expect(performance.now() - t0).toBeLessThan(3000);
    });
    test("abort during the /me verify writes nothing", async () => {
      const before = await existing();
      const ac = new AbortController();
      fake.state.next = { status: 200, body: { data: { user: { email: "x" } } }, delayMs: 5000 };
      setTimeout(() => ac.abort(), 30);
      const t0 = performance.now();
      expect((await thrown(loginWithToken(io, fake.url, TOKENS.owner, ac.signal))).exit).toBe(130);
      expect(performance.now() - t0).toBeLessThan(3000);
      await same(before);
    });
    test("real sleep resolves on abort without waiting", async () => {
      delete io.sleep;
      dev([]);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 30);
      const t0 = performance.now();
      expect((await thrown(run({ signal: ac.signal }))).exit).toBe(130);
      expect(performance.now() - t0).toBeLessThan(2000);
    });
  });

  test("leak sweep: neither the token nor device_code reaches stdout/stderr, both modes", async () => {
    const withDeviceCode = { device_code: DEVICE_CODE, verification_uri: "v", expires_in: 60 }; // no user_code
    const cases: { script?: string[]; codeBody?: unknown; next?: any; env?: Record<string, string> }[] = [
      { script: ["ok"] }, { script: ["expired_token"] }, { script: ["access_denied"] }, { script: ["weird_code"] },
      { script: ["echo"] }, { codeBody: withDeviceCode },
      { script: [], next: { status: 200, body: { token: TOKENS.owner } } },
      { script: [], next: { status: 503, body: { error: { code: "c", message: `boom ${DEVICE_CODE}` } } } },
      { script: [], next: { status: 400, body: { error: { code: DEVICE_CODE, message: DEVICE_CODE } } } },
      { script: ["ok"], env: { OLYMPUS_API_KEY: TOKENS.owner } },
    ];
    for (const c of cases) {
      for (const json of [true, false]) {
        dev(c.script ?? [], c.codeBody ? { codeBody: c.codeBody } : {});
        onSleep = (n) => void (n === 1 && c.next && (fake.state.next = c.next));
        sleeps.length = 0;
        try {
          const me = await run();
          print(io, json, { data: me }, () => `logged in as ${me.user.email}`);
        } catch (e) {
          fail(io, json, e as CliError);
        }
      }
    }
    const all = [...io.o, ...io.e].join("");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(TOKENS.owner);
    expect(all).not.toContain(DEVICE_CODE);
  });
});

describe("fake parity with server 439af0d6", () => {
  const as = (t: string) => api(fake.url, t);
  const raw = (path: string, init: RequestInit & { token?: string } = {}) =>
    fetch(`${fake.url}${path}`, { ...init, headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), "Content-Type": "application/json" } });
  const wh = "/api/v1/orgs/acme/webhooks";
  const fields = async (t: string, method: string, path: string, body: unknown) => {
    const e = await thrown(as(t)(method as any, path.replace("/api/v1", ""), body));
    return { exit: e.exit, fields: (e.body.error.details as any)?.fields, code: e.body.error.code };
  };
  const shape = (v: any): any =>
    Array.isArray(v) ? v.map(shape) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : v === null ? "null" : typeof v;

  test("pinned /me lists only the pinned org, as {slug, name}", async () => {
    const fixture = await Bun.file(join(import.meta.dir, "fixtures/me.pinned.json")).json();
    const { data } = await as(TOKENS.pinned)("GET", "/me");
    // keys and value types, recursively; both memberships (fixture: beta only, fake: pin only) are one-element lists
    expect(shape({ data })).toEqual(shape(fixture));
    expect(data.token.organization).toEqual({ slug: "acme", name: "Acme" });
    expect(data.memberships.map((m: any) => m.org.slug)).toEqual(["acme"]);
  });
  test("AC2e pinnedGone: no memberships, null organization, every org route 404", async () => {
    const { data } = await as(TOKENS.pinnedGone)("GET", "/me");
    expect([data.memberships, data.token.organization]).toEqual([[], null]);
    for (const p of ["/orgs/acme/agents", "/orgs/acme/webhooks"]) expect((await thrown(as(TOKENS.pinnedGone)("GET", p))).exit).toBe(3);
  });
  test("1 roles are operator/teammate; writes need operator", async () => {
    expect((await as(TOKENS.owner)("GET", "/me")).data.memberships[0].role).toBe("operator");
    expect((await as(TOKENS.teammate)("GET", "/me")).data.memberships[0].role).toBe("teammate");
  });
  test("3 unknown /api/v1 path is 404 not_found before auth, with or without a token", async () => {
    for (const token of [undefined, "bad", TOKENS.owner]) {
      const r = await raw("/api/v1/nope", { token });
      expect([r.status, ((await r.json()) as any).error.code]).toEqual([404, "not_found"]);
    }
  });
  test("4 malformed JSON: 400 on device regardless of bearer; after auth elsewhere", async () => {
    fake.state.device = { script: [] };
    const bad = { method: "POST", body: "{nope" };
    for (const token of [undefined, "bad"]) expect((await raw("/api/v1/device/token", { ...bad, token })).status).toBe(400);
    expect((await raw(wh, { ...bad, token: "bad" })).status).toBe(401);
    const r = await raw(wh, { ...bad, token: TOKENS.owner });
    expect([r.status, await r.json()]).toEqual([400, { error: { code: "bad_request", message: "Malformed JSON body." } }]);
    fake.state.device = undefined;
  });
  test("5 show: unknown id 404 first, teammate 403; teammate update/destroy/create", async () => {
    expect((await thrown(as(TOKENS.teammate)("GET", "/orgs/acme/webhooks/wh_99"))).exit).toBe(3);
    expect((await thrown(as(TOKENS.teammate)("GET", "/orgs/acme/webhooks/wh_1"))).exit).toBe(4);
    expect((await thrown(as(TOKENS.teammate)("PATCH", "/orgs/acme/webhooks/wh_99", {}))).exit).toBe(3);
    expect((await thrown(as(TOKENS.teammate)("PATCH", "/orgs/acme/webhooks/wh_1", { name: 5 }))).exit).toBe(4);
    expect((await thrown(as(TOKENS.teammate)("DELETE", "/orgs/acme/webhooks/wh_99"))).exit).toBe(3);
    expect((await thrown(as(TOKENS.teammate)("POST", "/orgs/acme/webhooks", {}))).exit).toBe(4);
  });
  test("6 agents hermes (active) and hera (paused)", async () => {
    expect((await as(TOKENS.owner)("GET", "/orgs/acme/agents")).data.map((a: any) => [a.profile_name, a.paused])).toEqual([["hermes", false], ["hera", true]]);
  });
  test("7 unknown agent must exist; paused agent given or kept is 'is paused'", async () => {
    const ok = { name: "n", instructions: "i" };
    expect((await fields(TOKENS.owner, "POST", wh, { ...ok, agent: "zzz" })).fields).toEqual({ agent: ["must exist"] });
    expect((await fields(TOKENS.owner, "POST", wh, ok)).fields).toEqual({ agent: ["must exist"] });
    expect((await fields(TOKENS.owner, "POST", wh, { ...ok, agent: "hera" })).fields).toEqual({ agent: ["is paused"] });
    expect((await fields(TOKENS.owner, "PATCH", `${wh}/wh_1`, { agent: "zzz" })).fields).toEqual({ agent: ["must exist"] });
    expect((await fields(TOKENS.owner, "PATCH", `${wh}/wh_1`, { agent: "hera" })).fields).toEqual({ agent: ["is paused"] });
    expect((await fields(TOKENS.owner, "PATCH", `${wh}/wh_paused`, { name: "x" })).fields).toEqual({ agent: ["is paused"] });
    // own paused-agent webhook: the shared seed wh_paused must stay on hera for other tests
    const own = { ...fake.state.webhooks.acme!.find((w) => w.id === "wh_paused")!, id: "wh_own_paused" };
    fake.state.webhooks.acme!.push(own);
    try {
      expect((await as(TOKENS.owner)("PATCH", "/orgs/acme/webhooks/wh_own_paused", { agent: "hermes" })).data.agent).toBe("hermes");
    } finally { fake.state.webhooks.acme = fake.state.webhooks.acme!.filter((w) => w.id !== "wh_own_paused"); }
  });
  test("8 strict types; null name/agent 422, null instructions keeps", async () => {
    const ok = { name: "n", agent: "hermes", instructions: "i" };
    expect((await fields(TOKENS.owner, "POST", wh, { ...ok, full_tools: "yes" })).fields).toEqual({ full_tools: ["must be true or false"] });
    expect((await fields(TOKENS.owner, "POST", wh, { name: 1, agent: 2, instructions: 3 })).fields).toEqual({
      name: ["must be a string"], agent: ["must be a string"], instructions: ["must be a string"],
    });
    expect((await fields(TOKENS.owner, "PATCH", `${wh}/wh_1`, { name: null })).code).toBe("invalid");
    expect((await fields(TOKENS.owner, "PATCH", `${wh}/wh_1`, { agent: null })).fields).toEqual({ agent: ["must exist"] });
    expect((await as(TOKENS.owner)("PATCH", "/orgs/acme/webhooks/wh_1", { instructions: null })).data.name).toBe("seed");
    expect((await as(TOKENS.owner)("GET", "/orgs/acme/webhooks/wh_1")).data.instructions).toBe("seed instructions");
  });
  test("9 show and create send Cache-Control: no-store", async () => {
    expect((await raw(`${wh}/wh_1`, { token: TOKENS.owner })).headers.get("cache-control")).toBe("no-store");
    const c = await raw(wh, { method: "POST", token: TOKENS.owner, body: JSON.stringify({ name: "n", agent: "hermes", instructions: "i" }) });
    expect([c.status, c.headers.get("cache-control")]).toEqual([201, "no-store"]);
    expect("instructions" in ((await c.json()) as any).data).toBe(false);
  });
  test("10 server wording: 401, 403, byte-identical 404", async () => {
    const m = async (r: Response) => ((await r.json()) as any).error.message;
    expect(await m(await raw("/api/v1/me", { token: "bad" }))).toBe("Missing or invalid API token.");
    expect(await m(await raw(`${wh}/wh_1`, { method: "DELETE", token: TOKENS.teammate }))).toBe("You are not allowed to do that.");
    const a = await (await raw("/api/v1/orgs/zzz/webhooks", { token: TOKENS.owner })).text();
    const b = await (await raw(`${wh}/wh_99`, { token: TOKENS.owner })).text();
    expect([a, b]).toEqual([b, '{"error":{"code":"not_found","message":"Not found"}}']);
  });
});

describe("defaultOrg and print seams", () => {
  test("defaultOrg reports its source; flag/env skip /me; ambiguous/none -> undefined", async () => {
    const calls: string[] = [];
    const spy = (t: string) => async () => (calls.push("me"), await meOf(t)());
    expect(await defaultOrg("x", io, {}, spy(TOKENS.owner))).toEqual({ slug: "x", from: "flag" });
    expect(await defaultOrg(undefined, { ...io, env: { OLYMPUS_ORG: "y" } }, {}, spy(TOKENS.owner))).toEqual({ slug: "y", from: "env" });
    expect(calls).toHaveLength(0);
    expect(await defaultOrg(undefined, io, { org: "beta" }, meOf(TOKENS.pinned))).toEqual({ slug: "acme", from: "pin" });
    expect(await defaultOrg(undefined, io, { org: "beta" }, meOf(TOKENS.multi))).toEqual({ slug: "beta", from: "stored" });
    expect(await defaultOrg(undefined, io, {}, meOf(TOKENS.owner))).toEqual({ slug: "acme", from: "only" });
    expect(await defaultOrg(undefined, io, {}, meOf(TOKENS.multi))).toBeUndefined();
    const none = async () => ({ user: { email: "" }, memberships: [], token: { name: "", last4: "", organization: null } });
    expect(await defaultOrg(undefined, io, {}, none)).toBeUndefined();
  });
  test("print: rich only when tty and provided; json calls neither", () => {
    const h = () => "human", r = () => "rich";
    print({ ...io, tty: true }, false, {}, h, r);
    print({ ...io, tty: true }, false, {}, h);
    print({ ...io, tty: false }, false, {}, h, r);
    print(io, false, {}, h, r);
    expect(io.o).toEqual(["rich\n", "human\n", "human\n", "human\n"]);
    io.o.length = 0;
    let called = 0;
    const spy = () => (called++, "x");
    for (const tty of [true, false]) print({ ...io, tty }, true, { a: 1 }, spy, spy);
    expect(called).toBe(0);
    expect(io.o).toEqual(['{"a":1}\n', '{"a":1}\n']);
  });
});
