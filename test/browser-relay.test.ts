import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { CLOSE, DATA, MAX_PAYLOAD, OPEN, decodeFrame, encodeCdp, encodeFrame } from "../src/browser-frame";
import {
  createRelay,
  relayUrl,
  type CdpChannel,
  type RelayConnect,
  type RelayEvent,
  type RelayHandle,
  type RelayHandlers,
} from "../src/browser-relay";
import type { BrowserMachine } from "../src/browser-store";
import type { Io } from "../src/core";
import { startFakeRelay, type RelayStatus } from "./fake-relay";

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const enc = (s: string) => ENC.encode(s);

// The same thresholds the client holds; duplicated here so a change to either has to be deliberate.
const PAUSE_ABOVE = 4 * 1024 * 1024;
const RESUME_BELOW = 1024 * 1024;
const CEILING = 16 * 1024 * 1024;
const STALLED =
  "the organization's agent machine is not answering the relay; it may be on an older image — ask an operator to redeploy it";

const relay = startFakeRelay();
afterAll(() => relay.stop());
beforeEach(() => {
  delete relay.state.status;
  relay.state.handshakes.length = 0;
});

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const machine: BrowserMachine = { machine_id: "bm_0123456789abcdef", name: "laptop", token: relay.token };
// `http://127.0.0.1:<port>` — the host the token was paired against, which is all the client stores.
const host = () => relay.url.replace(/^ws/, "http").replace("/api/v1/browser/relay", "");

// Every sleep is recorded and yields a real tick, so a backoff sequence is asserted in milliseconds
// and a poll loop (the backpressure drain) cannot starve the test of the event loop.
function testIo(slept: number[] = []): Io & { slept: number[] } {
  return { env: {}, home: "/nonexistent", stdin: async () => "", out: () => {}, err: () => {}, slept, sleep: async (ms) => void (slept.push(ms), await Bun.sleep(0)) };
}

const until = async (p: () => boolean) => {
  for (let i = 0; i < 500 && !p(); i++) await Bun.sleep(1);
  expect(p()).toBe(true);
};
const thrown = async (p: Promise<unknown>): Promise<any> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("did not throw");
};

/**
 * A socket the test drives by hand: it hands each attempt's handlers to `script` (on a later tick,
 * as Bun's own client does) and lets the test set `bufferedAmount`.
 */
function fakeSocket(script?: (attempt: number, h: RelayHandlers) => void) {
  const f = {
    urls: [] as string[],
    heads: [] as Record<string, string>[],
    sent: [] as Uint8Array[],
    buffered: 0,
    attempts: 0,
    h: undefined as RelayHandlers | undefined,
    frames: () => f.sent.map(decodeFrame),
    connect: ((url, headers, h) => {
      f.urls.push(url);
      f.heads.push(headers);
      f.h = h;
      const attempt = ++f.attempts;
      const handle: RelayHandle = {
        get bufferedAmount() {
          return f.buffered;
        },
        send: (bytes) => void f.sent.push(bytes),
        close: (code, reason) => h.close(code ?? 1000, reason ?? ""),
      };
      queueMicrotask(() => script?.(attempt, h));
      return handle;
    }) as RelayConnect,
  };
  return f;
}

/** A client on a fake socket, already online, with its events and streams collected. */
async function online(o: { script?: (n: number, h: RelayHandlers) => void; jitter?: () => number } = {}) {
  const f = fakeSocket(o.script ?? ((_, h) => h.open()));
  const io = testIo();
  const events: RelayEvent[] = [];
  const cdps: CdpChannel[] = [];
  const paused: boolean[] = [];
  const ac = new AbortController();
  const r = createRelay(io, host(), machine, {
    connect: f.connect,
    onCdpStream: (c) => cdps.push(c),
    onBackpressure: (p) => paused.push(p),
    onEvent: (e) => events.push(e),
    jitter: o.jitter ?? (() => 1),
    signal: ac.signal,
  });
  const done = r.run();
  stops.push(async () => (ac.abort(), void (await done.catch(() => {}))));
  await until(() => events.some((e) => e.state === "online"));
  return { f, io, r, events, cdps, paused, ac, done };
}

/** A client on a real `new WebSocket`, attached to the double, with the double's side of it. */
async function attached() {
  const io = testIo();
  const events: RelayEvent[] = [];
  const cdps: CdpChannel[] = [];
  const ac = new AbortController();
  const r = createRelay(io, host(), machine, {
    onCdpStream: (c) => cdps.push(c),
    onEvent: (e) => events.push(e),
    jitter: () => 1,
    signal: ac.signal,
  });
  const done = r.run();
  stops.push(async () => (ac.abort(), void (await done.catch(() => {}))));
  await until(() => events.some((e) => e.state === "online"));
  return { io, r, events, cdps, ac, done, laptop: await relay.laptop() };
}

// ---------------------------------------------------------------- Assumption 13, measured

test("Bun surfaces no handshake status, so every refused upgrade is one indistinguishable event", async () => {
  const seen: { code: number; reason: string }[] = [];
  for (const status of [400, 401, 404, 501, 502, 503] as RelayStatus[]) {
    relay.state.status = status;
    const ws = new WebSocket(relay.url, { headers: { Authorization: `Bearer ${relay.token}` } });
    seen.push(await new Promise((done) => ws.addEventListener("close", (e) => done({ code: e.code, reason: e.reason }))));
    expect("status" in ws || "statusCode" in ws).toBe(false);
  }
  // The measurement the reconnect policy is built on: six different statuses, one event.
  expect(new Set(seen.map((s) => `${s.code} ${s.reason}`)).size).toBe(1);
  expect(seen[0]).toEqual({ code: 1002, reason: "Expected 101 status code" });
});

test("a 401 therefore backs off like a 503 and stops only at the attempt cap, never at exit 2", async () => {
  relay.state.status = 401;
  const io = testIo();
  const events: RelayEvent[] = [];
  const r = createRelay(io, host(), machine, { onCdpStream: () => {}, onEvent: (e) => events.push(e), jitter: () => 1 });
  const e = await thrown(r.run());
  expect(e.exit).toBe(5); // not 2: nothing told us it was a 401
  expect(e.body.error.code).toBe("relay_unreachable");
  expect(io.slept.length).toBe(9);
  expect(events.filter((x) => x.state === "online")).toEqual([]);
  expect(relay.state.handshakes.length).toBe(10);
});

// ---------------------------------------------------------------- A3 reconnect policy

test("backs off 1 s doubling to 60 s with jitter, through io.sleep, and gives up at ten handshakes", async () => {
  const io = testIo();
  const events: RelayEvent[] = [];
  const f = fakeSocket((_, h) => h.close(1002, "Expected 101 status code"));
  const r = createRelay(io, host(), machine, { connect: f.connect, onCdpStream: () => {}, onEvent: (e) => events.push(e), jitter: () => 1 });
  const e = await thrown(r.run());

  expect(io.slept).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  expect(f.attempts).toBe(10);
  expect(e.exit).toBe(5);
  expect(e.body.error.message).toContain("pair again with a fresh code");
  expect(events.filter((x) => x.state === "stalled")).toEqual([{ state: "stalled", attempts: 3, message: STALLED }]);
  expect(events.filter((x) => x.state === "connecting").length).toBe(10);
});

test("jitter shortens each delay to between half and the full step", async () => {
  const io = testIo();
  const f = fakeSocket((_, h) => h.close(1002, "Expected 101 status code"));
  await thrown(createRelay(io, host(), machine, { connect: f.connect, onCdpStream: () => {}, jitter: () => 0 }).run());
  expect(io.slept).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("stops on the close codes a live socket can carry: 4401 exit 2, 4409 exit 6, 1003 exit 5", async () => {
  for (const [code, exit, name] of [
    [4401, 2, "revoked"],
    [4409, 6, "replaced"],
    [1003, 5, "text_frame"],
  ] as const) {
    const io = testIo();
    const f = fakeSocket((_, h) => (h.open(), h.close(code, "")));
    const e = await thrown(createRelay(io, host(), machine, { connect: f.connect, onCdpStream: () => {}, jitter: () => 1 }).run());
    expect([code, e.exit, e.body.error.code]).toEqual([code, exit, name]);
    expect(f.attempts).toBe(1); // stopped, not retried
    expect(io.slept).toEqual([]);
  }
});

test("backs off on a live 1009 or 1006, resetting the delay each time a socket opens", async () => {
  const io = testIo();
  const events: RelayEvent[] = [];
  const ac = new AbortController();
  const f = fakeSocket((n, h) => {
    h.open();
    h.close(n % 2 ? 1006 : 1009, "gone");
    if (n === 4) ac.abort();
  });
  await createRelay(io, host(), machine, { connect: f.connect, onCdpStream: () => {}, onEvent: (e) => events.push(e), jitter: () => 1, signal: ac.signal }).run();
  // The fourth close and the abort land together, so that one is not reported: an aborted run says nothing more.
  expect(io.slept).toEqual([1000, 1000, 1000]);
  expect(events.filter((e) => e.state === "closed")).toEqual([
    { state: "closed", code: 1006, reason: "gone" },
    { state: "closed", code: 1009, reason: "gone" },
    { state: "closed", code: 1006, reason: "gone" },
  ]);
});

test("a connection that opens resets the handshake count, so the cap is consecutive failures only", async () => {
  const io = testIo();
  const f = fakeSocket((n, h) => (n === 10 ? (h.open(), h.close(1006, "")) : h.close(1002, "Expected 101 status code")));
  const e = await thrown(createRelay(io, host(), machine, { connect: f.connect, onCdpStream: () => {}, jitter: () => 1 }).run());
  expect(f.attempts).toBe(20); // nine failures, one that opened, then ten more
  expect(e.exit).toBe(5);
});

test("returns rather than throws when the signal aborts, and leaves no socket behind", async () => {
  const ac = new AbortController();
  const io = testIo();
  const f = fakeSocket((_, h) => h.open());
  const r = createRelay(io, host(), machine, { connect: f.connect, onCdpStream: () => {}, signal: ac.signal });
  const done = r.run();
  await until(() => f.attempts === 1);
  ac.abort();
  await done;
  // The stream opened after the abort is born dead, because the connection is gone.
  const s = r.open("tcp:example.com:443");
  let closed = false;
  s.onClose = () => (closed = true);
  await Bun.sleep(1);
  expect(closed).toBe(true);
  expect(f.attempts).toBe(1);
});

// ---------------------------------------------------------------- A4 handshake

test("derives the relay url from the stored host and refuses one checkRelayUrl would not accept", () => {
  expect(relayUrl("https://app.example.com")).toBe("wss://app.example.com/api/v1/browser/relay");
  expect(relayUrl("http://127.0.0.1:3111")).toBe("ws://127.0.0.1:3111/api/v1/browser/relay");
  expect(() => relayUrl("http://example.com")).toThrow(/not a WebSocket url/); // ws: off loopback
});

test("sends the bearer in an Authorization header, never in the query string, and never fetches the relay", async () => {
  const fetched: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: any, init: any) => (fetched.push(String(input?.url ?? input)), real(input, init))) as typeof fetch;
  try {
    await attached();
  } finally {
    globalThis.fetch = real;
  }
  expect(relay.state.handshakes).toEqual([
    { auth: `Bearer ${relay.token}`, cookie: null, search: "", upgraded: true },
  ]);
  expect(fetched.filter((u) => u.includes("/browser/"))).toEqual([]);
});

// ---------------------------------------------------------------- A5 stream multiplexing

test("accepts a workbench cdp stream on an odd id and carries whole CDP messages both ways", async () => {
  const a = await attached();
  a.laptop.send(encodeFrame(1, OPEN, enc("cdp")));
  await until(() => a.cdps.length === 1);
  const cdp = a.cdps[0]!;
  const got: string[] = [];
  cdp.onMessage = (m) => got.push(m);
  expect(a.events).toContainEqual({ state: "stream", id: 1, target: "cdp" });

  // One CDP message split across two DATA frames, and a second whole one behind it: the length
  // prefix is the boundary, the DATA frames are not.
  const one = encodeCdp(JSON.stringify({ id: 1, method: "Page.navigate" }));
  const two = encodeCdp(JSON.stringify({ id: 2, method: "Runtime.evaluate" }));
  a.laptop.send(encodeFrame(1, DATA, one.subarray(0, 6)));
  a.laptop.send(encodeFrame(1, DATA, new Uint8Array([...one.subarray(6), ...two])));
  await until(() => got.length === 2);
  expect(got).toEqual([DEC.decode(one.subarray(4)), DEC.decode(two.subarray(4))]);

  // And back: length-prefixed, on the same odd id.
  cdp.send(JSON.stringify({ id: 1, result: {} }));
  const back = decodeFrame(await a.laptop.next());
  expect(back).toMatchObject({ id: 1, op: DATA });
  expect(DEC.decode(back.payload.subarray(4))).toBe(JSON.stringify({ id: 1, result: {} }));

  // The workbench closing the stream reaches the consumer once.
  let closes = 0;
  cdp.onClose = () => closes++;
  a.laptop.send(encodeFrame(1, CLOSE));
  await until(() => closes === 1);
});

test("refuses with CLOSE every OPEN but a cdp on a free odd id, and hands none of them on", async () => {
  const a = await attached();
  for (const [id, target] of [
    [2, "cdp"], // even: the laptop's half of the id space
    [3, "tcp:127.0.0.1:9222"], // only the laptop opens tcp:
    [5, "shell"],
    [7, ""],
  ] as const) {
    a.laptop.send(encodeFrame(id, OPEN, enc(target)));
    expect(decodeFrame(await a.laptop.next())).toMatchObject({ id, op: CLOSE });
  }
  expect(a.cdps).toEqual([]);
  expect(a.events.filter((e) => e.state === "refused").map((e: any) => e.id)).toEqual([2, 3, 5, 7]);

  // A second OPEN on a live id: both the duplicate and the stream it collided with are closed.
  a.laptop.send(encodeFrame(1, OPEN, enc("cdp")));
  await until(() => a.cdps.length === 1);
  let closed = false;
  a.cdps[0]!.onClose = () => (closed = true);
  a.laptop.send(encodeFrame(1, OPEN, enc("cdp")));
  expect(decodeFrame(await a.laptop.next())).toMatchObject({ id: 1, op: CLOSE });
  expect(closed).toBe(true);
  expect(a.cdps.length).toBe(1);
});

test("drops a DATA frame for a stream that was never opened, and an undecodable frame", async () => {
  const a = await attached();
  a.laptop.send(encodeFrame(9, DATA, enc("nobody is listening")));
  a.laptop.send(new Uint8Array([0, 0, 0]));
  a.laptop.send(encodeFrame(1, OPEN, enc("cdp")));
  await until(() => a.cdps.length === 1); // still alive, and the next frame is still understood
  expect(a.events.filter((e) => e.state === "closed")).toEqual([]);
});

test("sends binary frames only, so the hub never closes it with 1003", async () => {
  const a = await attached();
  a.laptop.send(encodeFrame(1, OPEN, enc("cdp")));
  await until(() => a.cdps.length === 1);
  a.cdps[0]!.send(JSON.stringify({ id: 1, method: "Page.enable" }));
  await a.laptop.next();
  expect(a.events.some((e) => e.state === "closed")).toBe(false);
  expect(a.laptop.received.every((m) => m instanceof Uint8Array)).toBe(true);
});

test("allocates the even ids for laptop-opened tcp streams, fragments writes, and closes once", async () => {
  const a = await online();
  const s = a.r.open("tcp:example.com:443");
  expect(a.f.frames()).toEqual([{ id: 2, op: OPEN, payload: enc("tcp:example.com:443") }]);
  expect(a.events).toContainEqual({ state: "stream", id: 2, target: "tcp:example.com:443" });

  s.write(new Uint8Array(MAX_PAYLOAD + 1).fill(7));
  expect(a.f.frames().slice(1).map((f) => [f.id, f.op, f.payload.length])).toEqual([
    [2, DATA, MAX_PAYLOAD],
    [2, DATA, 1],
  ]);

  expect(a.r.open("tcp:example.com:80")).toBeDefined();
  expect(a.f.frames().at(-1)).toMatchObject({ id: 4, op: OPEN });

  s.close();
  s.close();
  expect(a.f.frames().filter((f) => f.op === CLOSE)).toEqual([{ id: 2, op: CLOSE, payload: new Uint8Array(0) }]);
  expect(a.f.sent.every((b) => b instanceof Uint8Array)).toBe(true);
});

test("copies a DATA payload before handing it over, and ends every live stream when the socket drops", async () => {
  const a = await online();
  const s = a.r.open("tcp:example.com:443");
  const got: Uint8Array[] = [];
  s.onData = (b) => got.push(b);
  let closed = false;
  s.onClose = () => (closed = true);

  // The frame the socket hands in is reused by the caller the moment the handler returns.
  const message = encodeFrame(2, DATA, new Uint8Array([1, 2, 3]));
  a.f.h!.message(message);
  message.fill(0xff);
  expect([...got[0]!]).toEqual([1, 2, 3]);

  a.f.h!.close(1006, "dropped");
  expect(closed).toBe(true);
});

test("pauses the local sockets above 4 MiB queued and resumes below 1 MiB", async () => {
  const a = await online();
  const s = a.r.open("tcp:example.com:443");

  a.f.buffered = PAUSE_ABOVE; // exactly at the threshold is not over it
  s.write(new Uint8Array(1));
  expect(a.paused).toEqual([]);

  a.f.buffered = PAUSE_ABOVE + 1;
  s.write(new Uint8Array(1));
  expect(a.paused).toEqual([true]);

  a.f.buffered = RESUME_BELOW; // still at the resume threshold, so still paused
  await Bun.sleep(5);
  expect(a.paused).toEqual([true]);

  a.f.buffered = RESUME_BELOW - 1;
  await until(() => a.paused.length === 2);
  expect(a.paused).toEqual([true, false]);
  expect(a.io.slept).toContain(50);
});

test("closes a cdp stream whose declared length never completes, past the reassembly ceiling", async () => {
  const a = await online();
  a.f.h!.message(encodeFrame(1, OPEN, enc("cdp")));
  const cdp = a.cdps[0]!;
  let closed = false;
  cdp.onClose = () => (closed = true);
  cdp.onMessage = () => expect.unreachable();

  // A prefix claiming 64 MiB, then full-size DATA frames that never get there.
  const chunk = new Uint8Array(MAX_PAYLOAD - 4);
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, 64 * 1024 * 1024);
  a.f.h!.message(encodeFrame(1, DATA, new Uint8Array([...head, ...chunk])));
  for (let held = chunk.length; held <= CEILING && !closed; held += chunk.length) a.f.h!.message(encodeFrame(1, DATA, chunk));

  expect(closed).toBe(true);
  expect(a.f.frames().at(-1)).toMatchObject({ id: 1, op: CLOSE });
  expect(a.events.at(-1)).toMatchObject({ state: "refused", id: 1, target: "cdp" });
});
