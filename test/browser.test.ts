import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPlan, connectBrowserCdp, type CdpSocket } from "../src/browser";
import { ACK, DATA, OPEN, cdpReader, decodeFrame, encodeCdp, encodeFrame } from "../src/browser-frame";
import type { RelayConnect, RelayHandle, RelayHandlers } from "../src/browser-relay";
import { run } from "../src/cli";
import { CliError, type Io } from "../src/core";
import { PAIR_CODE, seedBrowserPair, startFake } from "./fake-api";
import { RELAY_PATH, startFakeRelay, type FakeRelay, type Laptop } from "./fake-relay";

const ENC = new TextEncoder();

const fake = startFake();

// One relay per test, stopped in teardown: the double keeps the live laptop in a module-level
// variable, so a connection outliving its test would be handed to the next one.
const relays: FakeRelay[] = [];
const newRelay = (status?: 503) => {
  const r = startFakeRelay(status === undefined ? {} : { status });
  relays.push(r);
  return r;
};
/** `http://127.0.0.1:<port>` — what the token is paired against, and what `relayUrl` derives the socket from. */
const hostOf = (r: FakeRelay) => r.url.replace(/^ws/, "http").replace(RELAY_PATH, "");

let io: Io & { o: string[]; e: string[]; slept: number[] };
let home: string;
let ac: AbortController;
const closers: (() => void)[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "oly-attach-"));
  const o: string[] = [];
  const e: string[] = [];
  const slept: number[] = [];
  ac = new AbortController();
  io = {
    // A path that cannot run, so discovery succeeds (OLYMPUS_CHROME is taken verbatim) and every
    // test that reaches a launch must inject `spawn`.
    env: { OLYMPUS_CHROME: "/nonexistent/chromium" },
    home,
    stdin: async () => "",
    out: (s) => o.push(s),
    err: (s) => e.push(s),
    o,
    e,
    slept,
    // Every backoff is recorded and yields a tick, so the attempt cap is reached in milliseconds.
    sleep: async (ms) => void (slept.push(ms), await Bun.sleep(0)),
    signal: ac.signal,
  };
  fake.state.requests.length = 0;
  fake.state.browserPair = seedBrowserPair();
});

afterEach(() => {
  ac.abort();
  for (const close of closers.splice(0)) close();
  for (const r of relays.splice(0)) r.stop();
});

const out = () => io.o.join("");
const lines = () => out().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const states = () => lines().map((l) => l.state);
const until = async (p: () => boolean, what: string) => {
  for (let i = 0; i < 3000 && !p(); i++) await Bun.sleep(1);
  if (!p()) throw new Error(`timed out waiting for ${what}`);
};
const thrown = async (p: Promise<unknown>): Promise<CliError> => {
  try {
    await p;
  } catch (e) {
    return e as CliError;
  }
  throw new Error("did not throw");
};

const browserFile = () => join(home, ".config", "olympus", "browser.json");
const seedMachine = async (host: string, token: string, name = "laptop") => {
  await mkdir(join(home, ".config", "olympus"), { recursive: true, mode: 0o700 });
  await writeFile(browserFile(), JSON.stringify({ machines: { [host]: { machine_id: "bm_seeded", token, name } } }), { mode: 0o600 });
};

/** A relay socket the test drives: it opens on the next tick, as Bun's own client does. */
function fakeSocket() {
  const f = {
    urls: [] as string[],
    heads: [] as Record<string, string>[],
    connect: ((url, headers, h: RelayHandlers) => {
      f.urls.push(url);
      f.heads.push(headers);
      const handle: RelayHandle = { bufferedAmount: 0, send: () => {}, close: (code, reason) => h.close(code ?? 1000, reason ?? "") };
      queueMicrotask(() => h.open());
      return handle;
    }) as RelayConnect,
  };
  return f;
}

test("pairs, stores the record, and attaches with the machine token — the code sent verbatim", async () => {
  // Lowercase and hyphenated: the server upcases and strips non-letters itself, so the client must
  // send exactly what it was given. The double matches the code verbatim.
  fake.state.browserPair = seedBrowserPair(["abcd-efgh"]);
  const sock = fakeSocket();
  const p = browserPlan(["browser", "attach", "abcd-efgh"], { name: "studio" }, io, true)(fake.url, ac.signal, { connect: sock.connect });
  await until(() => states().includes("online"), "online");

  const claimed = fake.state.browserPair.claimed[0]!;
  expect(fake.state.requests).toMatchObject([{ method: "POST", path: "/api/v1/browser/pair", auth: null, body: { code: "abcd-efgh", name: "studio" } }]);
  expect(sock.urls).toEqual([`${fake.url.replace(/^http/, "ws")}${RELAY_PATH}`]);
  expect(sock.heads).toEqual([{ Authorization: `Bearer ${claimed.token}` }]);
  expect(JSON.parse(await readFile(browserFile(), "utf8"))).toEqual({
    machines: { [fake.url]: { machine_id: claimed.machine_id, token: claimed.token, name: "studio" } },
  });

  ac.abort();
  expect((await thrown(p)).exit).toBe(130);
  expect(states()).toEqual(["paired", "connecting", "online", "exit"]);
  expect(lines()[0]).toEqual({ state: "paired", machine_id: claimed.machine_id, name: "studio" });
  expect(out() + io.e.join("")).not.toContain(claimed.token);
});

test("attaches from the stored record: bearer in the header, nothing in the query, repeated --allow-origin accepted", async () => {
  const relay = newRelay();
  await seedMachine(hostOf(relay), relay.token);
  const p = run(["browser", "attach", "--host", hostOf(relay), "--json", "--allow-origin", "a.example", "--allow-origin", "b.example:8443"], io);
  await until(() => states().includes("online"), "online");

  expect(relay.state.handshakes).toMatchObject([{ auth: `Bearer ${relay.token}`, cookie: null, search: "", upgraded: true }]);
  ac.abort();
  expect(await p).toBe(130);
  expect(states()).toEqual(["connecting", "online", "exit"]);
  expect(lines().at(-1)).toEqual({ state: "exit", code: 130 });
  expect(io.e.join("")).toBe(`${JSON.stringify({ error: { code: "cancelled", message: "detached" } })}\n`);
  expect(out()).not.toContain(relay.token);
});

test("without --json the status lines are short, on stderr, and name no token", async () => {
  const relay = newRelay();
  await seedMachine(hostOf(relay), relay.token, "studio");
  const p = run(["browser", "attach", "--host", hostOf(relay)], io);
  await until(() => io.e.join("").includes("Attached"), "the attached line");
  expect(io.e.join("")).toBe(`Attached to ${hostOf(relay)} as studio. No browser window until the workbench connects.\n`);
  expect(out()).toBe("");
  ac.abort();
  expect(await p).toBe(130);
  expect(io.e.join("")).not.toContain(relay.token);
});

test("with no code and no stored record it says where to get one, and opens no socket", async () => {
  const relay = newRelay();
  expect(await run(["browser", "attach", "--host", hostOf(relay)], io)).toBe(1);
  expect(io.e.join("")).toContain(`no paired computer for ${hostOf(relay)}`);
  expect(io.e.join("")).toContain("Settings → Rafita");
  expect(relay.state.handshakes).toEqual([]);
});

test("a malformed --allow-origin is a usage error before the pair request, and every value is read", async () => {
  // The malformed value is the SECOND one: a usage error here is also proof the first did not win.
  const code = await run(["browser", "attach", PAIR_CODE, "--host", fake.url, "--allow-origin", "a.example", "--allow-origin", "b.example:99999"], io);
  expect(code).toBe(1);
  expect(io.e.join("")).toContain('invalid --allow-origin "b.example:99999"');
  expect(fake.state.requests).toEqual([]); // the pairing code is unspent
});

test("rejects an unknown flag, --name without a code, and an unknown subcommand", async () => {
  expect(await run(["browser", "attach", PAIR_CODE, "--host", fake.url, "--week", "2026-01-05"], io)).toBe(1);
  expect(io.e.join("")).toContain("unknown option '--week' for browser attach");
  expect(await run(["browser", "attach", "--host", fake.url, "--name", "studio"], io)).toBe(1);
  expect(io.e.join("")).toContain("--name is read only when pairing");
  expect(await run(["browser", "detach", "--host", fake.url], io)).toBe(1);
  expect(io.e.join("")).toContain("unknown browser command: detach");
  expect(await run(["browser", "--host", fake.url], io)).toBe(1);
  expect(io.e.join("")).toContain("browser needs a subcommand: browser attach [CODE]");
  expect(fake.state.requests).toEqual([]);
});

test("a pair refusal maps through exitForStatus unchanged: 404 → 3", async () => {
  expect(await run(["browser", "attach", "NOSUCHCD", "--host", fake.url, "--json"], io)).toBe(3);
  expect(io.e.join("")).toContain("that pairing code was not accepted");
  // Every run ends with one exit line, a pair failure included.
  expect(lines()).toEqual([{ state: "exit", code: 3 }]);
});

test("a refused handshake backs off to the cap and exits 5, naming no cause the client cannot know", async () => {
  const relay = newRelay(503);
  await seedMachine(hostOf(relay), relay.token);
  expect(await run(["browser", "attach", "--host", hostOf(relay), "--json"], io)).toBe(5);

  const st = states();
  expect(st.filter((s) => s === "connecting").length).toBe(10);
  expect(st.filter((s) => s === "online").length).toBe(0);
  // Printed once per run of failures, not per attempt.
  expect(st.filter((s) => s === "stalled").length).toBe(1);
  expect(io.slept.length).toBe(9);
  expect(lines().at(-1)).toEqual({ state: "exit", code: 5 });
  const err = io.e.join("");
  expect(err).toContain("gave up after 10 failed connections");
  // A12 as amended: Bun surfaces no HTTP status for a refused upgrade, so the message cannot say 503.
  expect(err).not.toContain("503");
});

for (const [close, exit] of [[4401, 2], [4409, 6], [1003, 5]] as const) {
  test(`a live socket closed with ${close} exits ${exit}`, async () => {
    const relay = newRelay();
    await seedMachine(hostOf(relay), relay.token);
    const p = run(["browser", "attach", "--host", hostOf(relay), "--json"], io);
    const laptop = await relay.laptop();
    await until(() => states().includes("online"), "online");
    laptop.close(close);
    expect(await p).toBe(exit);
    expect(lines().at(-1)).toEqual({ state: "exit", code: exit });
  });
}

test("launches nothing while no cdp stream is open (Assumption 7)", async () => {
  const relay = newRelay();
  await seedMachine(hostOf(relay), relay.token);
  let spawned = 0;
  const p = browserPlan(["browser", "attach"], {}, io, true)(hostOf(relay), ac.signal, {
    spawn: () => {
      spawned++;
      throw new Error("a browser must not be launched by attach itself");
    },
  });
  const laptop = await relay.laptop();
  await until(() => states().includes("online"), "online");
  // A full round trip through the hub, so "nothing happened yet" is not just "nothing happened yet".
  laptop.send(encodeFrame(2, DATA, ENC.encode("x")));
  await Bun.sleep(20);
  expect(spawned).toBe(0);
  expect(states()).toEqual(["connecting", "online"]);

  ac.abort();
  expect((await thrown(p)).exit).toBe(130);
});

// ---- the cdp path: one Chromium, one connection and one filter per stream

type FakeCdp = CdpSocket & { port: number; sent: string[]; closed: boolean };

/** Attaches with every browser-facing seam faked, and opens `streams` cdp streams from the workbench. */
async function attachWithChrome(opts: { streams: number[] }) {
  const relay = newRelay();
  await seedMachine(hostOf(relay), relay.token);
  const argvs: string[][] = [];
  const profiles: string[] = [];
  const sockets: FakeCdp[] = [];
  let killed = 0;
  let exit!: () => void;
  const exited = new Promise<number>((res) => (exit = () => res(0)));

  const p = browserPlan(["browser", "attach"], {}, io, true)(hostOf(relay), ac.signal, {
    spawn: (argv) => (argvs.push(argv), { exited, kill: () => (killed++, exit()) }),
    mkProfile: async () => {
      const dir = await mkdtemp(join(tmpdir(), "oly-profile-"));
      // Chromium writes this once its DevTools socket is listening; the launcher polls for it.
      await writeFile(join(dir, "DevToolsActivePort"), "9876\n/devtools/browser/abc\n");
      profiles.push(dir);
      return dir;
    },
    connectCdp: async (port) => {
      const s: FakeCdp = { port, sent: [], closed: false, send: (m) => void s.sent.push(m), close: () => void (s.closed = true) };
      sockets.push(s);
      return s;
    },
    ackMs: 100,
  });
  const laptop = await relay.laptop();
  await until(() => states().includes("online"), "online");
  for (const id of opts.streams) laptop.send(encodeFrame(id, OPEN, ENC.encode("cdp")));
  await until(() => sockets.length === opts.streams.length, "the cdp connections");
  return { relay, laptop, argvs, profiles, sockets, p, killed: () => killed, exitChrome: exit };
}

/** The CDP messages the laptop sent back on one stream, un-prefixed and parsed. */
const sentOn = (laptop: Laptop, id: number) => {
  const reader = cdpReader();
  const out: any[] = [];
  for (const m of laptop.received) {
    const f = decodeFrame(m);
    if (f.id === id && f.op === DATA) for (const s of reader.push(f.payload.slice())) out.push(JSON.parse(s));
  }
  return out;
};

test("the first cdp stream launches Chromium once, against the SOCKS port that is already listening", async () => {
  const h = await attachWithChrome({ streams: [1, 3] });

  expect(h.argvs.length).toBe(1); // one browser, however many streams
  expect(h.sockets.map((s) => s.port)).toEqual([9876, 9876]);
  const flag = h.argvs[0]!.find((a) => a.startsWith("--proxy-server="))!;
  const port = Number(/socks5:\/\/127\.0\.0\.1:(\d+)$/.exec(flag)![1]);
  expect(port).toBeGreaterThan(0);
  // Listening before the launch, which is what makes that flag mean anything: it answers SOCKS5 now.
  expect(await socksGreeting(port)).toEqual([5, 0]);

  ac.abort();
  expect((await thrown(h.p)).exit).toBe(130);
});

test("one filter per cdp connection: a page session on one stream is not a page session on the other", async () => {
  const h = await attachWithChrome({ streams: [1, 3] });
  const [first, second] = h.sockets as [FakeCdp, FakeCdp];

  // The browser tells stream 1's filter that S1 is a page session (A8's three setup commands follow).
  first.onMessage!(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { type: "page" } } }));
  expect(first.sent.map((m) => JSON.parse(m).method)).toEqual(["Page.enable", "Page.setDownloadBehavior", "Page.setInterceptFileChooserDialog"]);

  const navigate = JSON.stringify({ id: 7, method: "Page.navigate", params: { url: "https://example.com/" }, sessionId: "S1" });
  h.laptop.send(encodeFrame(1, DATA, encodeCdp(navigate)));
  h.laptop.send(encodeFrame(3, DATA, encodeCdp(navigate)));
  await until(() => sentOn(h.laptop, 3).length > 0, "the refusal on stream 3");

  // Stream 1 knows S1 and forwards it verbatim; stream 3's filter never saw that attach.
  expect(first.sent.at(-1)).toBe(navigate);
  expect(second.sent).toEqual([]);
  expect(sentOn(h.laptop, 3)).toEqual([{ id: 7, error: { code: -32000, message: expect.stringContaining("never attached to a page target") }, sessionId: "S1" }]);
  // Stream 1 carried the browser's event back and no refusal at all.
  expect(sentOn(h.laptop, 1)).toEqual([{ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { type: "page" } } }]);

  ac.abort();
  expect((await thrown(h.p)).exit).toBe(130);
});

test("--allow-origin reaches the proxy: each listed host opens a tcp: stream, anything else is refused", async () => {
  const relay = newRelay();
  await seedMachine(hostOf(relay), relay.token);
  const argvs: string[][] = [];
  let exit!: () => void;
  const exited = new Promise<number>((res) => (exit = () => res(0)));
  const p = browserPlan(["browser", "attach"], { "allow-origin": ["a.example", "b.example:8443"] }, io, true)(hostOf(relay), ac.signal, {
    spawn: (argv) => (argvs.push(argv), { exited, kill: exit }),
    mkProfile: async () => {
      const dir = await mkdtemp(join(tmpdir(), "oly-profile-"));
      await writeFile(join(dir, "DevToolsActivePort"), "9876\n/devtools/browser/abc\n");
      return dir;
    },
    connectCdp: async (port) => ({ port, send: () => {}, close: () => {} }) as CdpSocket,
    ackMs: 100,
  });
  const laptop = await relay.laptop();
  await until(() => states().includes("online"), "online");
  laptop.send(encodeFrame(1, OPEN, ENC.encode("cdp")));
  await until(() => argvs.length === 1, "the launch");
  const port = Number(/socks5:\/\/127\.0\.0\.1:(\d+)$/.exec(argvs[0]!.find((a) => a.startsWith("--proxy-server="))!)![1]);

  const opens = () =>
    laptop.received.map(decodeFrame).filter((f) => f.op === OPEN).map((f) => ({ id: f.id, target: new TextDecoder().decode(f.payload) }));
  for (const [host, dstPort] of [["a.example", 80], ["b.example", 8443]] as const) {
    const rep = socksConnect(port, host, dstPort);
    await until(() => opens().some((o) => o.target === `tcp:${host}:${dstPort}`), `the tcp: stream for ${host}`);
    laptop.send(encodeFrame(opens().find((o) => o.target === `tcp:${host}:${dstPort}`)!.id, ACK));
    expect(await rep).toBe(0x00);
  }
  // Not on the list, so the proxy answers 0x02 and opens nothing.
  expect(await socksConnect(port, "c.example", 80)).toBe(0x02);
  expect(opens().length).toBe(2);

  ac.abort();
  expect((await thrown(p)).exit).toBe(130);
});

test("Ctrl-C tears down: Chromium killed, profile removed, SOCKS listener closed, cdp socket closed", async () => {
  const h = await attachWithChrome({ streams: [1] });
  const port = Number(/socks5:\/\/127\.0\.0\.1:(\d+)$/.exec(h.argvs[0]!.find((a) => a.startsWith("--proxy-server="))!)![1]);
  expect(await socksGreeting(port)).toEqual([5, 0]);

  ac.abort();
  expect((await thrown(h.p)).exit).toBe(130);
  expect(h.killed()).toBe(1);
  expect(h.sockets[0]!.closed).toBe(true);
  expect(await stat(h.profiles[0]!).catch((e) => e.code)).toBe("ENOENT");
  expect(await socksGreeting(port).catch(() => "refused")).toBe("refused");
});

test("the browser exiting ends the command with exit 0", async () => {
  const h = await attachWithChrome({ streams: [1] });
  h.exitChrome();
  await h.p; // resolves: no CliError, so cli.ts returns 0
  expect(lines().at(-1)).toEqual({ state: "exit", code: 0 });
  expect(await stat(h.profiles[0]!).catch((e) => e.code)).toBe("ENOENT");
});

test("the cdp connection is the BROWSER-level endpoint named by /json/version", async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, s) {
      const u = new URL(req.url);
      paths.push(u.pathname);
      if (u.pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/devtools/browser/abc` });
      return s.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: { message: (ws, m) => void ws.send(`echo:${m}`) },
  });
  closers.push(() => server.stop(true));

  const sock = await connectBrowserCdp(server.port!);
  const got = new Promise<string>((r) => (sock.onMessage = r));
  sock.send("hi");
  expect(await got).toBe("echo:hi");
  // A page endpoint (/devtools/page/<id>) has no sessions, so every filtered command would be refused.
  expect(paths).toEqual(["/json/version", "/devtools/browser/abc"]);
  sock.close();
});

test("a browser that cannot be reached ends the command with its own exit code", async () => {
  const relay = newRelay();
  await seedMachine(hostOf(relay), relay.token);
  const p = browserPlan(["browser", "attach"], {}, io, true)(hostOf(relay), ac.signal, {
    spawn: () => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    },
  });
  const laptop = await relay.laptop();
  await until(() => states().includes("online"), "online");
  laptop.send(encodeFrame(1, OPEN, ENC.encode("cdp")));
  expect((await thrown(p)).exit).toBe(5);
  expect(lines().at(-1)).toEqual({ state: "exit", code: 5 });
});

test("no browser on the computer is exit 1, before the pairing code is spent", async () => {
  io.env.OLYMPUS_CHROME = "";
  io.env.PATH = "";
  expect(await run(["browser", "attach", PAIR_CODE, "--host", fake.url], io)).toBe(1);
  expect(io.e.join("")).toContain("OLYMPUS_CHROME");
  expect(fake.state.requests).toEqual([]);
});

// ---- SOCKS5 clients, just enough to read a reply code

/** The server's method-selection reply to a `[5,1,0]` greeting. */
function socksGreeting(port: number): Promise<number[]> {
  return new Promise<number[]>((resolve, reject) => {
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (s) => void s.write(new Uint8Array([5, 1, 0])),
        data: (s, d) => (s.end(), resolve([...d])),
        error: (_s, e) => reject(e),
      },
    }).catch(reject);
  });
}

/** Greeting, then CONNECT to a DOMAINNAME target; resolves with the reply's REP byte. */
function socksConnect(port: number, host: string, dstPort: number): Promise<number> {
  const name = ENC.encode(host);
  const request = new Uint8Array([5, 1, 0, 3, name.length, ...name, dstPort >> 8, dstPort & 0xff]);
  const seen: number[] = [];
  return new Promise<number>((resolve, reject) => {
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (s) => void s.write(new Uint8Array([5, 1, 0])),
        data: (s, d) => {
          seen.push(...d);
          if (seen.length === 2) s.write(request);
          else if (seen.length >= 12) (s.end(), resolve(seen[3]!));
        },
        error: (_s, e) => reject(e),
      },
    }).catch(reject);
  });
}
