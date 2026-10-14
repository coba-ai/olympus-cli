import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { checkRelayUrl, pairBrowser, readBrowserMachine } from "../src/browser-store";
import { CliError, fail, type Io } from "../src/core";
import { PAIR_CODE, seedBrowserPair, startFake } from "./fake-api";

const fake = startFake();
const other = startFake();
afterAll(() => (fake.stop(), other.stop()));

let io: Io & { o: string[]; e: string[] };
let dir: string;
const dirOf = () => join(dir, ".config/olympus");
const fileOf = () => join(dirOf(), "browser.json");
const text = () => readFile(fileOf(), "utf8").catch(() => null);
const stored = async () => JSON.parse((await text())!);
const relayOf = (f: { url: string }) => `${f.url.replace(/^http/, "ws")}/api/v1/browser/relay`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oly-browser-"));
  const o: string[] = [], e: string[] = [];
  io = { env: {}, home: dir, stdin: async () => "", out: (s) => o.push(s), err: (s) => e.push(s), o, e };
  for (const f of [fake, other]) {
    f.state.requests.length = 0;
    f.state.next = undefined;
    f.state.browserPair = seedBrowserPair([PAIR_CODE, "SECONDCD", "THIRDCDE", "FOURTHCD"]);
  }
});

const thrown = async (p: Promise<unknown>): Promise<CliError> => {
  try {
    await p;
  } catch (e) {
    return e as CliError;
  }
  throw new Error("did not throw");
};
const pair = (host: string, o: { code?: string; name?: string } = {}) => pairBrowser(io, host, { code: PAIR_CODE, ...o });

describe("A2 claim and store", () => {
  test("201 stores the record for the host: 0600 file in a 0700 dir, no bearer, no temp file left", async () => {
    const { machine, relayUrl } = await pair(fake.url, { name: "studio" });

    expect(machine.token).toMatch(/^obm_.+/);
    expect(machine.machine_id).toMatch(/^bm_[0-9a-z]{16}$/);
    expect(machine.name).toBe("studio");
    expect(relayUrl).toBe(relayOf(fake));
    expect(await stored()).toEqual({ machines: { [fake.url]: machine } });
    expect((await stat(dirOf())).mode & 0o777).toBe(0o700);
    expect((await stat(fileOf())).mode & 0o777).toBe(0o600);
    expect(await readdir(dirOf())).toEqual(["browser.json"]);
    expect(await readBrowserMachine(io, fake.url)).toEqual(machine);
    expect(fake.state.requests).toMatchObject([
      { method: "POST", path: "/api/v1/browser/pair", auth: null, body: { code: PAIR_CODE, name: "studio" } },
    ]);
    expect(fake.state.browserPair.claimed).toEqual([{ machine_id: machine.machine_id, name: "studio", token: machine.token }]);
  });

  test("--name defaults to hostname(), as login's clientName does", async () => {
    const { machine } = await pair(fake.url);
    expect(machine.name).toBe(hostname());
    expect((fake.state.requests[0]!.body as any).name).toBe(hostname());
  });

  test("a pre-existing 0644 file ends 0600", async () => {
    await mkdir(dirOf(), { recursive: true });
    await writeFile(fileOf(), '{"machines":{}}');
    await chmod(fileOf(), 0o644);
    await pair(fake.url);
    expect((await stat(fileOf())).mode & 0o777).toBe(0o600);
  });

  test("a second host adds a record; re-pairing a host replaces only its own", async () => {
    const a = await pair(fake.url, { name: "one" });
    const b = await pair(other.url, { name: "two" });
    expect(await stored()).toEqual({ machines: { [fake.url]: a.machine, [other.url]: b.machine } });

    const again = await pair(fake.url, { code: "SECONDCD", name: "one again" });
    expect(await stored()).toEqual({ machines: { [fake.url]: again.machine, [other.url]: b.machine } });
    expect(again.machine.token).not.toBe(a.machine.token);
    expect(await readBrowserMachine(io, other.url)).toEqual(b.machine);
  });

  test("no stored record for a host, or no file at all, reads undefined", async () => {
    expect(await readBrowserMachine(io, fake.url)).toBeUndefined();
    await pair(fake.url);
    expect(await readBrowserMachine(io, other.url)).toBeUndefined();
  });

  test("404 exits 3 naming every cause, 400 exits 6, and neither writes", async () => {
    const unknown = await thrown(pair(fake.url, { code: "NOSUCHCD" }));
    expect(unknown.exit).toBe(3);
    expect(unknown.message).not.toBe("Not found");
    expect(unknown.message).toContain("expired");
    expect(unknown.message).toContain("fresh code");

    await pair(fake.url, { code: "THIRDCDE" }); // spends it
    expect((await thrown(pair(fake.url, { code: "THIRDCDE" }))).exit).toBe(3); // second claim: the same 404

    expect((await thrown(pair(fake.url, { code: "" }))).exit).toBe(6);
  });

  test("a token that is not obm_ + a character, or a missing machine id, is refused before anything is written", async () => {
    const relay_url = relayOf(fake);
    for (const data of [
      undefined, {}, { machine_id: "bm_1", relay_url },
      { token: "oly_live_abc", machine_id: "bm_1", relay_url },
      { token: "obm_", machine_id: "bm_1", relay_url },
      { token: 7, machine_id: "bm_1", relay_url },
      { token: "obm_abc", relay_url },
      { token: "obm_abc", machine_id: "", relay_url },
    ]) {
      fake.state.next = { status: 201, body: data === undefined ? {} : { data } };
      const e = await thrown(pair(fake.url));
      expect([e.exit, e.body.error.code]).toEqual([5, "bad_response"]);
      expect(await text()).toBeNull();
    }
  });

  test("a relay url off the resolved host, or not a WebSocket url, is refused before anything is written", async () => {
    for (const relayUrl of [
      "https://127.0.0.1/api/v1/browser/relay", // right shape, wrong scheme
      `${fake.url}/api/v1/browser/relay`, // http: to the right host
      relayOf(other), // ws: to a loopback host that is not the one we paired with
      "wss://relay.example.test/api/v1/browser/relay",
      "not a url",
      "",
    ]) {
      fake.state.browserPair = seedBrowserPair([PAIR_CODE]);
      fake.state.browserPair.relayUrl = relayUrl;
      const e = await thrown(pair(fake.url));
      expect([e.exit, e.body.error.code]).toEqual([5, "bad_response"]);
      expect(e.message).toContain("not a WebSocket url");
      expect(await text()).toBeNull();
    }
    fake.state.browserPair = seedBrowserPair([PAIR_CODE]);
    fake.state.next = { status: 201, body: { data: { token: "obm_abc", machine_id: "bm_1" } } }; // no relay url at all
    expect((await thrown(pair(fake.url))).body.error.message).toContain("no relay url");
  });

  test("checkRelayUrl: wss to the API host; ws only to a loopback host", () => {
    const ok = (host: string, url: string) => expect(checkRelayUrl(host, url)).toBe(url);
    const no = (host: string, url: unknown) => expect(() => checkRelayUrl(host, url)).toThrow();
    ok("https://app.example.test", "wss://app.example.test/api/v1/browser/relay");
    ok("https://app.example.test:8443", "wss://app.example.test:8443/api/v1/browser/relay");
    ok("http://127.0.0.1:3111", "ws://127.0.0.1:3111/api/v1/browser/relay");
    ok("http://localhost:3111", "ws://localhost:3111/api/v1/browser/relay");
    ok("http://[::1]:3111", "ws://[::1]:3111/api/v1/browser/relay");
    no("https://app.example.test", "ws://app.example.test/api/v1/browser/relay"); // ws: off loopback
    no("https://app.example.test", "wss://app.example.test:8443/api/v1/browser/relay"); // port is part of the host
    no("https://app.example.test", "wss://evil.example.test/api/v1/browser/relay");
    no("http://127.0.0.1:3111", "ws://127.0.0.1:3112/api/v1/browser/relay");
    no("https://app.example.test", "https://app.example.test/api/v1/browser/relay");
    no("https://app.example.test", undefined);
    no("https://app.example.test", 7);
  });

  test("a malformed browser.json fails before the code is spent, with readCreds' shape and no contents", async () => {
    await mkdir(dirOf(), { recursive: true });
    for (const body of [
      `{"machines":{"h":{"token":"obm_SECRETVALUE"`,
      `["obm_SECRETVALUE"]`,
      `{"machines":["obm_SECRETVALUE"]}`,
      `{"machines":{"h":"obm_SECRETVALUE"}}`,
      `{"machines":{"h":{"machine_id":"bm_1","token":"obm_SECRETVALUE"}}}`, // no name
      `{"machines":{"h":{"machine_id":1,"token":"obm_SECRETVALUE","name":"x"}}}`,
      `"obm_SECRETVALUE"`,
    ]) {
      await writeFile(fileOf(), body);
      for (const e of [await thrown(readBrowserMachine(io, "h")), await thrown(pair(fake.url))]) {
        expect([e.exit, e.body.error.code]).toEqual([1, "credentials_malformed"]);
        expect(JSON.stringify(e.body)).not.toContain("SECRETVALUE");
        expect(e.message).toContain(fileOf());
      }
      expect(fake.state.requests).toHaveLength(0); // the code is still claimable
      expect(await text()).toBe(body);
    }
    expect(fake.state.browserPair.codes).toContain(PAIR_CODE);
  });

  test("an unreadable file is credentials_io, not an internal error", async () => {
    await mkdir(fileOf(), { recursive: true }); // a directory where the file should be
    const e = await thrown(readBrowserMachine(io, fake.url));
    expect([e.exit, e.body.error.code]).toEqual([1, "credentials_io"]);
    expect(e.message).toContain(fileOf());
  });

  test("a token-shaped string the server controls reaches no sink: relay url, machine id, name, a non-404 body", async () => {
    // Obviously fake, and lower case on purpose: `new URL` lower-cases a host, so a mixed-case literal
    // would make the redirect channel below pass without testing anything.
    const LEAK = "obm_fake_not_a_real_token";
    const good = { token: "obm_fake_machine_token", machine_id: "bm_0000000000000001", relay_url: relayOf(fake) };
    const errs: CliError[] = [];
    // Every refusal is checked for the two things a leak would need: a thrown message, and a file.
    const refused = async (next: NonNullable<typeof fake.state.next>) => {
      fake.state.next = next;
      const e = await thrown(pair(fake.url));
      errs.push(e);
      expect(await text()).toBeNull();
      return e;
    };

    // 1. The relay url, in a query and as the host itself.
    for (const relay_url of [`wss://127.0.0.1:1/api/v1/browser/relay?token=${LEAK}`, `wss://${LEAK}.example.test/relay`])
      expect((await refused({ status: 201, body: { data: { ...good, relay_url } } })).body.error.code).toBe("bad_response");
    // 2. A machine id that IS the response's token: refused on its format rather than stored and printed.
    expect((await refused({ status: 201, body: { data: { ...good, token: LEAK, machine_id: LEAK } } })).body.error.code).toBe("bad_response");
    // 3. A non-404 refusal: message, details.fields and Retry-After are all strings a stranger chose
    // (the pair route is unauthenticated), and fail() prints all three.
    await refused({
      status: 500,
      body: { error: { code: "boom", message: `the server broke: ${LEAK}`, details: { fields: { code: [LEAK] } } } },
      headers: { "Retry-After": LEAK },
    });
    // 4. A 3xx: fail() prints the Location's host as "redirected to …".
    await refused({ status: 302, body: "", headers: { Location: `https://${LEAK}.example.test/` } });
    // 5. The 404, whose message is written in this repo.
    errs.push(await thrown(pair(fake.url, { code: "NOSUCHCD" })));

    // A real claim: the token the server actually minted must reach no sink either, and pairing prints nothing.
    const real = (await pair(fake.url, { name: "quiet" })).machine;
    expect([io.o, io.e]).toEqual([[], []]);

    // 6. A name the server sends back: the client stores the one it sent.
    fake.state.next = { status: 201, body: { data: { ...good, name: LEAK } } };
    const { machine } = await pair(fake.url, { code: "SECONDCD", name: "studio" });
    expect(machine).toEqual({ machine_id: good.machine_id, token: good.token, name: "studio" });

    // 7. The file, which holds a real token and is read back on every attach.
    await writeFile(fileOf(), `{"machines":{"h":{"token":"${real.token}"}}}`);
    errs.push(await thrown(readBrowserMachine(io, "h")));

    for (const e of errs) {
      expect(e.message).not.toContain(LEAK);
      expect(JSON.stringify(e.body)).not.toContain(LEAK);
      for (const json of [true, false]) fail(io, json, e);
    }
    const all = [...io.o, ...io.e].join("");
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [LEAK, real.token, good.token]) expect(all).not.toContain(secret);
    expect(io.o).toEqual([]);
  });
});
