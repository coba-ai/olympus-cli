import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { ACK, CLOSE, DATA, MAX_PAYLOAD, OPEN, cdpReader, decodeFrame, encodeCdp, encodeFrame } from "../src/browser-frame";
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
const TOTAL_CEILING = 32 * 1024 * 1024;
const MAX_CDP_STREAMS = 8;
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
// and a poll loop (the backpressure drain) cannot starve the test of the event loop. `tick` is how
// much `io.now` advances per read, which is how long each connection appears to have lasted: 0 (the
// default) makes every connection an instant drop, and anything over 5 s makes it a healthy one.
function testIo(slept: number[] = [], tick = 0): Io & { slept: number[] } {
  let clock = 0;
  return {
    env: {}, home: "/nonexistent", stdin: async () => "", out: () => {}, err: () => {}, slept,
    sleep: async (ms) => void (slept.push(ms), await Bun.sleep(0)),
    now: () => (clock += tick),
  };
}
const LASTED = 6_000; // over the client's 5 s flap threshold

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

test("backs off on a live 1009 or 1006, resetting the delay each time a socket opens and lasts", async () => {
  const io = testIo([], LASTED);
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
  // The peer sent "gone" as the reason on each; the event carries this client's word for the code.
  expect(events.filter((e) => e.state === "closed")).toEqual([
    { state: "closed", code: 1006, reason: "abnormal" },
    { state: "closed", code: 1009, reason: "too_big" },
    { state: "closed", code: 1006, reason: "abnormal" },
  ]);
});

test("a connection that opens and lasts resets the handshake count, so the cap is consecutive failures only", async () => {
  const io = testIo([], LASTED);
  const f = fakeSocket((n, h) => (n === 10 ? (h.open(), h.close(1006, "")) : h.close(1002, "Expected 101 status code")));
  const e = await thrown(createRelay(io, host(), machine, { connect: f.connect, onCdpStream: () => {}, jitter: () => 1 }).run());
  expect(f.attempts).toBe(20); // nine failures, one that opened, then ten more
  expect(e.exit).toBe(5);
});

// A socket that opened used to reset the count however briefly it lived, so a connection that
// dropped on arrival reconnected about once a second for as long as it kept doing that.
test("a connection that opens and drops inside 5 s is a failed attempt, so a flap is bounded by the cap", async () => {
  const io = testIo(); // the clock never advances: every connection is an instant drop
  const events: RelayEvent[] = [];
  const f = fakeSocket((_, h) => (h.open(), h.close(1006, "dropped")));
  const e = await thrown(
    createRelay(io, host(), machine, { connect: f.connect, onCdpStream: () => {}, onEvent: (x) => events.push(x), jitter: () => 1 }).run(),
  );
  expect(f.attempts).toBe(10);
  expect(io.slept).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  expect([e.exit, e.body.error.code]).toEqual([5, "relay_unreachable"]);
  // Each one still reports its close, because it really did connect.
  expect(events.filter((x) => x.state === "closed").length).toBe(10);
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
  // The seam's own pause/resume, which is what actually reaches a SOCKS socket; the callback alone
  // reaches nothing (`test/browser-socks.test.ts` drives a real one).
  const sock: string[] = [];
  s.pause = () => sock.push("pause");
  s.resume = () => sock.push("resume");

  a.f.buffered = PAUSE_ABOVE; // exactly at the threshold is not over it
  s.write(new Uint8Array(1));
  expect(a.paused).toEqual([]);
  expect(sock).toEqual([]);

  a.f.buffered = PAUSE_ABOVE + 1;
  s.write(new Uint8Array(1));
  expect(a.paused).toEqual([true]);
  expect(sock).toEqual(["pause"]);

  a.f.buffered = RESUME_BELOW; // still at the resume threshold, so still paused
  await Bun.sleep(5);
  expect(a.paused).toEqual([true]);
  expect(sock).toEqual(["pause"]);

  a.f.buffered = RESUME_BELOW - 1;
  await until(() => a.paused.length === 2);
  expect(a.paused).toEqual([true, false]);
  expect(sock).toEqual(["pause", "resume"]);
  expect(a.io.slept).toContain(50);
});

test("delivers an ACK to the tcp stream it names, and nothing else", async () => {
  const a = await online();
  const first = a.r.open("tcp:example.com:443");
  const second = a.r.open("tcp:example.com:80");
  const acked: string[] = [];
  first.onAck = () => acked.push("first");
  second.onAck = () => acked.push("second");

  a.f.h!.message(encodeFrame(4, ACK));
  expect(acked).toEqual(["second"]);
  a.f.h!.message(encodeFrame(2, ACK));
  expect(acked).toEqual(["second", "first"]);
});

test("an ACK on anything but a live laptop stream closes it, or is dropped if there is nothing to close", async () => {
  const a = await online();
  a.f.h!.message(encodeFrame(1, OPEN, enc("cdp")));
  const cdp = a.cdps[0]!;
  let closed = false;
  cdp.onClose = () => (closed = true);

  // A `cdp` stream has no dial to acknowledge, so an ACK there is the untrusted peer sending a frame
  // §4 does not have on that stream: the stream goes.
  a.f.h!.message(encodeFrame(1, ACK));
  expect(closed).toBe(true);
  expect(a.f.frames().at(-1)).toMatchObject({ id: 1, op: CLOSE });

  // An ACK for an id with no stream is dropped, like a DATA frame on one (A1), and the socket lives.
  const before = a.f.sent.length;
  a.f.h!.message(encodeFrame(8, ACK));
  a.f.h!.message(encodeFrame(1, ACK)); // the one just closed
  expect(a.f.sent.length).toBe(before);
  expect(a.events.filter((e) => e.state === "closed")).toEqual([]);
});

/** A §4 inner length prefix declaring `n` payload bytes. */
const prefix = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

test("closes a cdp stream whose declared length never completes, past the reassembly ceiling", async () => {
  const a = await online();
  a.f.h!.message(encodeFrame(1, OPEN, enc("cdp")));
  const cdp = a.cdps[0]!;
  let closed = false;
  cdp.onClose = () => (closed = true);
  cdp.onMessage = () => expect.unreachable();

  // A prefix claiming 64 MiB, then full-size DATA frames that never get there.
  const chunk = new Uint8Array(MAX_PAYLOAD - 4);
  a.f.h!.message(encodeFrame(1, DATA, new Uint8Array([...prefix(64 * 1024 * 1024), ...chunk])));
  for (let held = chunk.length; held <= CEILING && !closed; held += chunk.length) a.f.h!.message(encodeFrame(1, DATA, chunk));

  expect(closed).toBe(true);
  expect(a.f.frames().at(-1)).toMatchObject({ id: 1, op: CLOSE });
  expect(a.events.at(-1)).toMatchObject({ state: "refused", id: 1, target: "cdp" });
});

// The ceiling used to be counted by subtracting the byte length of each DECODED message, so bytes
// that are not UTF-8 — replacement characters re-encode to three bytes each, one per bad byte —
// paid back more than they cost and accumulated negative credit to spend on an incomplete message.
// Reproduced at 25 MiB retained on one stream.
test("malformed UTF-8 buys no credit against the reassembly ceiling", async () => {
  const a = await online();
  a.f.h!.message(encodeFrame(1, OPEN, enc("cdp")));
  const cdp = a.cdps[0]!;
  let closed = false;
  cdp.onClose = () => (closed = true);

  // 200 000 bytes of 0xFF, declared and complete: 200 004 bytes in, 600 000 bytes of replacement
  // characters out.
  const bad = new Uint8Array([...prefix(200_000), ...new Uint8Array(200_000).fill(0xff)]);
  let fed = 0;
  for (let i = 0; i < 50 && !closed; i++) {
    a.f.h!.message(encodeFrame(1, DATA, bad));
    fed += bad.length;
  }
  // Then an incomplete message, spending whatever credit those bought.
  const chunk = new Uint8Array(MAX_PAYLOAD);
  if (!closed) {
    a.f.h!.message(encodeFrame(1, DATA, prefix(64 * 1024 * 1024)));
    fed += 4;
  }
  for (let i = 0; i < 200 && !closed; i++) {
    a.f.h!.message(encodeFrame(1, DATA, chunk));
    fed += chunk.length;
  }

  expect(closed).toBe(true);
  expect(fed).toBeLessThanOrEqual(CEILING);
  expect(a.f.frames().at(-1)).toMatchObject({ id: 1, op: CLOSE });
  expect(a.events.at(-1)).toMatchObject({ state: "refused", id: 1, target: "cdp" });
});

test("caps how many cdp streams are live at once, refusing a further OPEN with CLOSE", async () => {
  const a = await online();
  for (let i = 0; i < MAX_CDP_STREAMS; i++) a.f.h!.message(encodeFrame(2 * i + 1, OPEN, enc("cdp")));
  expect(a.cdps.length).toBe(MAX_CDP_STREAMS);

  const over = 2 * MAX_CDP_STREAMS + 1;
  a.f.h!.message(encodeFrame(over, OPEN, enc("cdp")));
  expect(a.cdps.length).toBe(MAX_CDP_STREAMS); // refused, not handed on
  expect(a.f.frames().at(-1)).toMatchObject({ id: over, op: CLOSE });
  expect(a.events.at(-1)).toMatchObject({ state: "refused", id: over, target: "cdp" });

  // Closing one makes room: the cap is on live streams, not on how many were ever opened.
  a.f.h!.message(encodeFrame(1, CLOSE));
  a.f.h!.message(encodeFrame(over, OPEN, enc("cdp")));
  expect(a.cdps.length).toBe(MAX_CDP_STREAMS + 1);
  expect(a.events.at(-1)).toMatchObject({ state: "stream", id: over, target: "cdp" });
});

test("caps cdp reassembly across all streams, not only per stream", async () => {
  const a = await online();
  const streams = 4;
  const closed: number[] = [];
  for (let i = 0; i < streams; i++) {
    const id = 2 * i + 1;
    a.f.h!.message(encodeFrame(id, OPEN, enc("cdp")));
    a.cdps[i]!.onClose = () => closed.push(id);
  }

  // Each declares 15 MiB — comfortably under the per-stream ceiling — and never completes it.
  let fed = 0;
  for (let i = 0; i < streams; i++) {
    a.f.h!.message(encodeFrame(2 * i + 1, DATA, prefix(15 * 1024 * 1024)));
    fed += 4;
  }
  const chunk = new Uint8Array(MAX_PAYLOAD);
  for (let round = 0; round < 50 && !closed.length; round++) {
    for (let i = 0; i < streams && !closed.length; i++) {
      a.f.h!.message(encodeFrame(2 * i + 1, DATA, chunk));
      fed += chunk.length;
    }
  }

  expect(closed.length).toBe(1); // the stream the crossing frame arrived on, and only that one
  // The frame that would have crossed the total is refused rather than buffered, so what the readers
  // ever held is `fed` minus that frame.
  expect(fed - MAX_PAYLOAD).toBeLessThanOrEqual(TOTAL_CEILING);
  expect(a.events.at(-1)).toMatchObject({ state: "refused", id: closed[0]!, target: "cdp" });
  expect(a.cdps.length).toBe(streams); // the other three are still live
});

// The existing backpressure tests drive TCP writes of one frame each, which never exercise what
// fragmenting does once the threshold is crossed mid-write.
test("A5: stops fragmenting a large CDP response into a socket already over the threshold", async () => {
  const a = await online();
  a.f.h!.message(encodeFrame(1, OPEN, enc("cdp")));
  const cdp = a.cdps[0]!;
  const big = JSON.stringify({ id: 1, result: { data: "x".repeat(1024 * 1024) } });
  const parts = Math.ceil(encodeCdp(big).length / MAX_PAYLOAD);
  expect(parts).toBe(5);

  a.f.buffered = PAUSE_ABOVE + 1;
  const before = a.f.sent.length;
  cdp.send(big);
  expect(a.f.sent.length).toBe(before); // not one fragment into a buffer that is already over
  expect(a.paused).toEqual([true]); // and the pause is published without waiting for a send

  a.f.buffered = 0;
  await until(() => a.f.sent.length - before === parts);
  const frames = a.f.frames().slice(before);
  expect(frames.map((f) => [f.id, f.op])).toEqual(frames.map(() => [1, DATA]));
  // In order, and whole: the deferred remainder is the same bytes, not a re-fragmentation.
  const r = cdpReader();
  expect(frames.flatMap((f) => r.push(f.payload))).toEqual([big]);
  expect(a.paused).toEqual([true, false]);
});

test("A5: a stream registered while the pause is active is paused too — tcp and the cdp seam alike", async () => {
  const a = await online();
  const first = a.r.open("tcp:example.com:443");
  a.f.buffered = PAUSE_ABOVE + 1;
  first.write(new Uint8Array(1));
  expect(a.paused).toEqual([true]);

  const seen: string[] = [];
  const late = a.r.open("tcp:example.com:80");
  late.pause = () => seen.push("tcp pause");
  late.resume = () => seen.push("tcp resume");

  // `CdpChannel.pause`/`resume` is the seam for reaching Chromium's socket; nothing in the app sets
  // it yet (`browser.ts`), so this test is its only caller.
  a.f.h!.message(encodeFrame(1, OPEN, enc("cdp")));
  const cdp = a.cdps[0]!;
  cdp.pause = () => seen.push("cdp pause");
  cdp.resume = () => seen.push("cdp resume");

  await until(() => seen.length === 2);
  expect(seen).toEqual(["tcp pause", "cdp pause"]);

  a.f.buffered = 0;
  await until(() => seen.length === 4);
  expect(seen).toEqual(["tcp pause", "cdp pause", "tcp resume", "cdp resume"]);
});

// A deferred write used to be keyed on the stream ID alone, so the drain it was waiting for could
// land after the peer had closed that id and opened it again — and the new conversation was handed
// the old one's bytes. Reproduced with exactly this script.
test("A5: a reused stream id inherits none of the previous stream's deferred bytes", async () => {
  const a = await online();
  a.f.h!.message(encodeFrame(1, OPEN, enc("cdp")));
  await until(() => a.cdps.length === 1);

  a.f.buffered = PAUSE_ABOVE + 1; // nothing goes out; the response waits on the drain
  a.cdps[0]!.send(JSON.stringify({ id: 1, result: "OLD RESPONSE" }));
  const before = a.f.sent.length;
  expect(a.paused).toEqual([true]);

  a.f.h!.message(encodeFrame(1, CLOSE)); // that conversation ends
  a.f.h!.message(encodeFrame(1, OPEN, enc("cdp"))); // and the peer opens a new one on the same id
  await until(() => a.cdps.length === 2);

  a.f.buffered = 0;
  await until(() => a.paused.length === 2);
  expect(a.f.frames().slice(before).filter((f) => f.op === DATA)).toEqual([]);
});

// A5 bounded the SOCKET's buffer and nothing else: every further write on a paused stream added
// another retained fragment, with no cap and no release until the connection drained.
test("A5: a stream's deferred writes are bounded, and closing it drops what it still owed", async () => {
  const a = await online();
  const s = a.r.open("tcp:example.com:443");
  const other = a.r.open("tcp:example.com:80");
  let closed = false;
  s.onClose = () => (closed = true);

  a.f.buffered = PAUSE_ABOVE + 1; // nothing goes out for as long as this holds
  const chunk = new Uint8Array(2 * 1024 * 1024);
  let writes = 0;
  for (; writes < 8 && !closed; writes++) s.write(chunk);

  // The cap is 8 MiB per stream, so the fifth 2 MiB write is the one too many.
  expect([closed, writes]).toEqual([true, 5]);
  expect(a.f.frames().at(-1)).toMatchObject({ id: 2, op: CLOSE });
  expect(a.events.at(-1)).toMatchObject({ state: "refused", id: 2, reason: "write_queue_full" });

  // A close from our own side drops the queue the same way, well under the cap.
  other.write(new Uint8Array(MAX_PAYLOAD * 2));
  other.close();

  a.f.buffered = 0;
  await until(() => a.paused.length === 2);
  expect(a.f.frames().filter((f) => f.op === DATA)).toEqual([]); // neither queue ever reached the socket
});

// ---------------------------------------------------------------- §3: the peer's text is never echoed

// Reproduced before these tests existed: `OPEN("obm_…")` produced a `refused` event carrying that
// string, and a live close carried the peer's reason the same way — both reach a `--json` line and
// the member's terminal. The workbench picks both strings, so either is a path for a secret it was
// handed to come back out of this CLI.
test("no workbench-chosen text reaches an event or a --json line: not an OPEN target, not a close reason", async () => {
  const a = await online();
  const secret = machine.token; // the member's own pairing token, which must never be printed

  a.f.h!.message(encodeFrame(3, OPEN, enc(secret)));
  a.f.h!.message(encodeFrame(5, OPEN, enc(`tcp:${secret}:443`)));
  a.f.h!.message(encodeFrame(7, OPEN, enc("cdp")));
  await until(() => a.cdps.length === 1);
  a.f.h!.message(encodeFrame(7, DATA, new Uint8Array([...prefix(CEILING + 1), 1]))); // breaks §4's inner framing
  a.f.h!.close(1006, secret);
  await until(() => a.events.some((e) => e.state === "closed"));

  // A `--json` line is one event, serialized: what the member sees is exactly this string.
  const json = a.events.map((e) => JSON.stringify(e)).join("\n");
  expect(json).not.toContain(secret);
  expect(json).not.toContain("obm_");
  expect(a.events.filter((e) => e.state === "refused")).toEqual([
    { state: "refused", id: 3, target: "other", reason: "not_a_cdp_target" },
    { state: "refused", id: 5, target: "other", reason: "not_a_cdp_target" },
    { state: "refused", id: 7, target: "cdp", reason: "cdp_framing" },
  ]);
  expect(a.events.filter((e) => e.state === "closed")).toEqual([{ state: "closed", code: 1006, reason: "abnormal" }]);
});

test("nor to the error a give-up throws, whose every word this CLI chose", async () => {
  const io = testIo(); // the clock never advances, so each connection is a flap and the cap is reached
  const events: RelayEvent[] = [];
  const f = fakeSocket((_, h) => (h.open(), h.close(1002, machine.token)));
  const e = await thrown(
    createRelay(io, host(), machine, { connect: f.connect, onCdpStream: () => {}, onEvent: (x) => events.push(x), jitter: () => 1 }).run(),
  );
  expect(`${e} ${e.message ?? ""} ${JSON.stringify(e.body)} ${JSON.stringify(events)}`).not.toContain("obm_");
  expect(events.filter((x) => x.state === "closed").length).toBe(10);
});
