// The relay client: one WebSocket to olympus2-web's `GET /api/v1/browser/relay` (contract §1.2),
// §1.6's reconnect policy, and the §4 stream multiplexer over it.
//
// MEASURED, and the whole shape of the reconnect policy rests on it (PLAN Assumption 13, open when
// the plan was written): **Bun 1.3.13's WebSocket client does not surface the HTTP status of a
// refused upgrade.** Probed against `test/fake-relay.ts` with each of 400, 401, 404, 501, 502 and
// 503 injected; every one produced the same two events and nothing else — an `error` whose
// `message` is "WebSocket connection to '<url>' failed: Expected 101 status code", then a `close`
// with `code` 1002, `reason` "Expected 101 status code" and `wasClean` false. No status number
// appears on the error event, on its `error` property, or anywhere on the WebSocket object (its
// whole prototype chain was walked). A refused TCP connect differs only in wording: `error`
// "Failed to connect", close 1006. A pre-flight `fetch` is not the escape hatch — A4 forbids it
// here. `test/browser-relay.test.ts` "Bun surfaces no handshake status …" re-measures this against
// the double, so a Bun that starts reporting the status fails that test rather than silently
// leaving this file implementing the wrong branch.
//
// So Assumption 13's FALLBACK branch is the real one, and it is the only one implemented below:
// every failed handshake backs off under the attempt cap, and only a close code arriving on a
// socket that DID open stops. The client keys on whether `open` fired, never on the close code
// alone — 1002 "Expected 101 status code" is a handshake failure, not a live close.
import {
  ACK,
  CLOSE,
  DATA,
  OPEN,
  cdpReader,
  chunkPayload,
  decodeFrame,
  encodeCdp,
  encodeFrame,
  isWorkbenchStream,
  type CdpSend,
  type Frame,
  type Op,
  type Stream,
  type StreamOpener,
} from "./browser-frame";
import { checkRelayUrl, type BrowserMachine } from "./browser-store";
import { CliError, realSleep, type Io } from "./core";

const RELAY_PATH = "/api/v1/browser/relay";

// §1.6: 1 s doubling to 60 s, jittered. Assumption 14: ten consecutive failed handshakes, then stop —
// the relay has no throttle of its own and every attempt counts against the member's Rack::Attack
// `req/ip` budget, shared with their own browsing.
const BACKOFF_MIN = 1_000;
const BACKOFF_MAX = 60_000;
const MAX_ATTEMPTS = 10;
const STALL_AFTER = 3;
// A connection shorter than this counts as a failed attempt rather than resetting the count, so a
// socket that opens and drops at once is bounded by MAX_ATTEMPTS like any other failure.
const FLAP_UNDER_MS = 5_000;

// A5: pause reading from the local sockets above 4 MiB queued, resume below 1 MiB, so our own writes
// never reach the hub's 8 MiB receiver limit (§1.4). `bufferedAmount` drains with no event, so while
// paused it is polled. Each live stream's `pause`/`resume` is what reaches a local socket; the
// `onBackpressure` callback only tells the command.
const PAUSE_ABOVE = 4 * 1024 * 1024;
const RESUME_BELOW = 1024 * 1024;
const DRAIN_POLL_MS = 50;

// The length prefix inside a `cdp` stream is attacker-controlled (§3: the workbench side is the
// untrusted one) and `cdpReader` trusts it, so the bytes it holds for a message that never completes
// are bounded here instead. The number is a choice, not a measurement: this direction carries CDP
// commands, which are small, and the largest legitimate one anybody has named is a script body.
const CDP_REASSEMBLY_CEILING = 16 * 1024 * 1024;

const STALLED =
  "the organization's agent machine is not answering the relay; it may be on an older image — ask an operator to redeploy it";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/**
 * `wss://<host>/api/v1/browser/relay` — derived, not stored, because the token file keeps no
 * `relay_url` (Assumption 4), and re-validated by the same check the pair response goes through.
 */
export function relayUrl(host: string): string {
  return checkRelayUrl(host, new URL(host).origin.replace(/^http/, "ws") + RELAY_PATH);
}

/** The socket's three events. `error` is not among them: measured, it always arrives with a `close` behind it. */
export type RelayHandlers = { open: () => void; message: (bytes: Uint8Array) => void; close: (code: number, reason: string) => void };
export type RelayHandle = { readonly bufferedAmount: number; send: (bytes: Uint8Array) => void; close: (code?: number, reason?: string) => void };
/** Test seam: A5's pause/resume thresholds are asserted against a fake socket whose `bufferedAmount` the test sets. */
export type RelayConnect = (url: string, headers: Record<string, string>, handlers: RelayHandlers) => RelayHandle;

/** One accepted `cdp` stream, with §4's length prefix applied on both sides. `onMessage` and `onClose` are set by the consumer on the tick it is handed over. */
export type CdpChannel = {
  send: CdpSend;
  /** Ends the stream from our side. Idempotent; does not call `onClose`. */
  close: () => void;
  onMessage?: (message: string) => void;
  /** The workbench closed the stream, the socket dropped, or we killed it. */
  onClose?: () => void;
};

/** One line of `--json` per state change (Assumption 11), rendered by the command. Never carries the token. */
export type RelayEvent =
  | { state: "connecting"; attempt: number }
  | { state: "online" }
  | { state: "stream"; id: number; target: string }
  | { state: "refused"; id: number; target: string; reason: string }
  | { state: "closed"; code: number; reason: string }
  | { state: "stalled"; attempts: number; message: string }
  | { state: "backoff"; ms: number; attempts: number };

export type RelayOptions = {
  /** An accepted workbench `cdp` stream (§5.6). The command wires it to the CDP filter and launches Chromium on the first one (Assumption 7). */
  onCdpStream: (cdp: CdpChannel) => void;
  /** A5: `true` to stop reading from every local socket, `false` to resume. */
  onBackpressure?: (paused: boolean) => void;
  onEvent?: (event: RelayEvent) => void;
  signal?: AbortSignal;
  /** Seeded in tests so the backoff sequence is exact; `Math.random` otherwise. Returns [0,1). */
  jitter?: () => number;
  connect?: RelayConnect;
};

export type Relay = {
  /** Handed to the SOCKS proxy (2.3): opens an even-id `tcp:<host>:<port>` stream. The id is allocated here; a caller never picks one. */
  open: StreamOpener;
  /** Holds the socket until the signal aborts (returns) or §1.6 says stop (throws `CliError`). */
  run: () => Promise<void>;
};

// A4: an HTTP/1.1 Upgrade through Bun's own client, with the bearer in a header. Never `fetch` — an
// HTTP/2 connection reaches Rails as a plain GET and is answered 400 `bad_handshake` (§1.2).
const connectWebSocket: RelayConnect = (url, headers, h) => {
  const ws = new WebSocket(url, { headers });
  ws.binaryType = "arraybuffer";
  ws.onopen = () => h.open();
  ws.onmessage = (e) => {
    // The hub forwards binary verbatim and sends no text of its own (§1.4); anything else is ignored.
    if (typeof e.data !== "string") h.message(new Uint8Array(e.data as ArrayBuffer));
  };
  ws.onclose = (e) => h.close(e.code, e.reason);
  // Taken and dropped: every failure also fires `close`, which is what drives the loop (measured, top of file).
  ws.onerror = () => {};
  return ws;
};

// §1.5's close codes that stop, on a socket that opened. Everything else backs off, including 1009
// and the 1006 of a dropped pipe (a deploy, a heartbeat failure, a revoked token mid-pipe).
const STOP: Record<number, { exit: 2 | 5 | 6; code: string; message: string }> = {
  4401: {
    exit: 2,
    code: "revoked",
    message: "this computer was revoked from the organization; pair it again with a fresh code from Settings → Rafita",
  },
  4409: {
    // Assumption 6. The close code carries no identity, so the message cannot say which process won.
    exit: 6,
    code: "replaced",
    message:
      "another process or computer is attached as this machine and took the connection; stop it, or pair this computer again with a fresh code",
  },
  1003: {
    // The hub closes a text sender with 1003 and we only ever send binary, so this is our own bug.
    exit: 5,
    code: "text_frame",
    message: "the relay refused a text frame; that is a bug in this CLI, which sends binary frames only",
  },
};

type Entry = {
  data: (bytes: Uint8Array) => void;
  gone: () => void;
  /** Only a laptop-opened `tcp:` stream has these: an ACK to deliver, and a local socket to pause. */
  ack?: () => void;
  pause?: () => void;
  resume?: () => void;
};
type Conn = { handle: RelayHandle; streams: Map<number, Entry>; nextEven: number; paused: boolean; closed: boolean };

export function createRelay(io: Io, host: string, machine: BrowserMachine, o: RelayOptions): Relay {
  const sleep = io.sleep ?? realSleep;
  const now = io.now ?? Date.now;
  const connect = o.connect ?? connectWebSocket;
  const jitter = o.jitter ?? Math.random;
  const url = relayUrl(host);
  const emit = (e: RelayEvent) => o.onEvent?.(e);

  // The live connection, published only once the socket is open. Stream ids are per-connection.
  let conn: Conn | null = null;

  const sendRaw = (c: Conn, bytes: Uint8Array) => {
    if (c.closed) return;
    c.handle.send(bytes);
    pressure(c);
  };
  const frame = (c: Conn, id: number, op: Op, payload?: Uint8Array) => sendRaw(c, encodeFrame(id, op, payload));
  const stream = (c: Conn, id: number, bytes: Uint8Array) => {
    for (const part of chunkPayload(bytes)) frame(c, id, DATA, part);
  };

  function pressure(c: Conn) {
    if (c.paused || c.closed || c.handle.bufferedAmount <= PAUSE_ABOVE) return;
    c.paused = true;
    for (const e of c.streams.values()) e.pause?.();
    o.onBackpressure?.(true);
    void drain(c);
  }
  async function drain(c: Conn) {
    while (!c.closed && c.handle.bufferedAmount >= RESUME_BELOW) await sleep(DRAIN_POLL_MS);
    if (!c.paused) return; // teardown got there first and already resumed
    c.paused = false;
    for (const e of c.streams.values()) e.resume?.();
    o.onBackpressure?.(false);
  }

  /** Ends a stream from our side: CLOSE to the peer, and the consumer is told, because it did not ask for this. */
  const kill = (c: Conn, id: number) => {
    const e = c.streams.get(id);
    if (!e) return;
    c.streams.delete(id);
    frame(c, id, CLOSE);
    e.gone();
  };
  const refuse = (c: Conn, id: number, target: string, reason: string) => {
    frame(c, id, CLOSE);
    emit({ state: "refused", id, target, reason });
  };

  // A5/§5.6: the only thing the workbench may open is a `cdp` stream, on an odd id, that is not
  // already live. Everything else is answered with CLOSE and never reaches Chromium.
  function opened(c: Conn, id: number, payload: Uint8Array) {
    const target = DEC.decode(payload);
    if (!isWorkbenchStream(id)) return refuse(c, id, target, "an even stream id is the laptop's to open");
    if (c.streams.has(id)) {
      // The peer's view of this id and ours have diverged, so the live stream goes too; `kill` sends the CLOSE.
      kill(c, id);
      return emit({ state: "refused", id, target, reason: "that stream id is already open" });
    }
    if (target !== "cdp") return refuse(c, id, target, "the workbench may open `cdp` streams only");

    const reader = cdpReader();
    let held = 0; // bytes `reader` is holding for a message that has not completed
    const cdp: CdpChannel = {
      send: (message) => {
        if (c.streams.has(id)) stream(c, id, encodeCdp(message));
      },
      close: () => {
        if (!c.streams.delete(id)) return;
        reader.close();
        frame(c, id, CLOSE);
      },
    };
    c.streams.set(id, {
      data(bytes) {
        held += bytes.length;
        const messages = reader.push(bytes);
        for (const m of messages) held -= 4 + Buffer.byteLength(m);
        for (const m of messages) cdp.onMessage?.(m);
        if (held <= CDP_REASSEMBLY_CEILING) return;
        kill(c, id);
        emit({ state: "refused", id, target, reason: `a cdp message over ${CDP_REASSEMBLY_CEILING} bytes` });
      },
      gone() {
        reader.close();
        cdp.onClose?.();
      },
    });
    emit({ state: "stream", id, target });
    o.onCdpStream(cdp);
  }

  function message(c: Conn, bytes: Uint8Array) {
    let f: Frame;
    try {
      f = decodeFrame(bytes);
    } catch {
      return; // not a §4 frame; dropped, like every other byte we cannot place
    }
    if (f.op === OPEN) return opened(c, f.id, f.payload);
    const e = c.streams.get(f.id);
    if (!e) return; // A1: a fragment on a closed stream is dropped, not buffered
    if (f.op === CLOSE) {
      c.streams.delete(f.id);
      return e.gone();
    }
    if (f.op === ACK) {
      // Only a `tcp:` stream we opened has a dial to acknowledge. An ACK on a workbench-opened `cdp`
      // stream is the untrusted peer sending a frame §4 does not have there, so that stream goes,
      // the same answer `opened` gives a duplicate OPEN.
      if (isWorkbenchStream(f.id)) return kill(c, f.id);
      return e.ack?.();
    }
    // COPY: `decodeFrame`'s payload is a view into the WebSocket message buffer, and a consumer may
    // hold on to it. Nothing here depends on whether Bun reuses that buffer; the copy makes it moot.
    e.data(f.payload.slice());
  }

  function teardown(c: Conn) {
    c.closed = true;
    const entries = [...c.streams.values()];
    c.streams.clear();
    for (const e of entries) e.gone();
    if (!c.paused) return;
    c.paused = false;
    o.onBackpressure?.(false);
  }

  const open: StreamOpener = (target) => {
    const c = conn;
    if (!c || c.closed) {
      // Born dead: there is no socket to carry it. `onClose` is set by the caller after we return,
      // so it fires on a microtask; the SOCKS side answers its CONNECT with 0x04 either way (A9).
      const dead: Stream = { write: () => {}, close: () => {} };
      queueMicrotask(() => dead.onClose?.());
      return dead;
    }
    const id = c.nextEven;
    c.nextEven += 2;
    const s: Stream = {
      write: (bytes) => {
        if (c.streams.has(id)) stream(c, id, bytes);
      },
      close: () => {
        if (c.streams.delete(id)) frame(c, id, CLOSE);
      },
    };
    c.streams.set(id, {
      data: (bytes) => s.onData?.(bytes),
      gone: () => s.onClose?.(),
      ack: () => s.onAck?.(),
      pause: () => s.pause?.(),
      resume: () => s.resume?.(),
    });
    frame(c, id, OPEN, ENC.encode(target));
    emit({ state: "stream", id, target });
    return s;
  };

  // One handshake and the socket it may become. Resolves when the socket is gone, saying whether it
  // ever opened — which is the whole of Assumption 13's fallback branch.
  function session(signal?: AbortSignal): Promise<{ opened: boolean; code: number; reason: string }> {
    return new Promise((done) => {
      // `c` is assigned before any handler can run: the real client dispatches its events from the
      // event loop, never from inside the constructor, and the test's fake does the same.
      let c!: Conn;
      let up = false;
      let settled = false;
      const finish = (code: number, reason: string) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (conn === c) conn = null;
        teardown(c);
        done({ opened: up, code, reason });
      };
      // Settled here as well as on the close event, because a socket aborted mid-handshake is not
      // guaranteed to report one, and `run` must not be left waiting on a SIGINT.
      const abort = () => {
        c.handle.close(1000, "closing");
        finish(1000, "closing");
      };
      const handle = connect(url, { Authorization: `Bearer ${machine.token}` }, {
        open: () => {
          up = true;
          conn = c;
          emit({ state: "online" });
        },
        message: (bytes) => message(c, bytes),
        close: finish,
      });
      c = { handle, streams: new Map(), nextEven: 2, paused: false, closed: false };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async function run(): Promise<void> {
    const signal = o.signal;
    let attempts = 0; // consecutive failures: a handshake that never opened, or a connection that flapped
    let delay = BACKOFF_MIN;
    for (;;) {
      if (signal?.aborted) return;
      emit({ state: "connecting", attempt: attempts + 1 });
      const at = now();
      const end = await session(signal);
      if (signal?.aborted) return;
      if (end.opened) {
        const stop = STOP[end.code];
        if (stop) throw new CliError(stop.exit, { error: { code: stop.code, message: stop.message } });
        emit({ state: "closed", code: end.code, reason: end.reason });
      }
      // A connection that opened AND LASTED resets both the count and the delay (Assumption 14). One
      // that dropped inside FLAP_UNDER_MS counts as a failed attempt instead: resetting on any open at
      // all let a socket that opens and drops at once reconnect about every second forever, because
      // nothing then distinguished it from a healthy reconnect.
      if (end.opened && now() - at >= FLAP_UNDER_MS) {
        attempts = 0;
        delay = BACKOFF_MIN;
      } else {
        attempts++;
        if (attempts >= MAX_ATTEMPTS)
          throw new CliError(5, {
            error: {
              code: "relay_unreachable",
              // Bun reports no status (top of file), so this cannot name the cause, and the count is
              // the cap itself: more attempts would eat the member's console rate budget.
              message: `gave up after ${MAX_ATTEMPTS} failed connections to the relay; it may be unreachable, or this computer may no longer be paired — pair again with a fresh code from Settings → Rafita`,
            },
          });
        // Printed once per run of failures, not per attempt. 502 is three causes — a companion that is
        // not ready, a companion image with no hub route, or the hub's 64-laptop cap — and in this
        // branch it is not even known to be a 502, so the message names no single one.
        if (attempts === STALL_AFTER) emit({ state: "stalled", attempts, message: STALLED });
      }
      // Half to full of the current delay: the herd after a web deploy spreads, and the floor holds.
      const ms = Math.round(delay * (0.5 + 0.5 * jitter()));
      emit({ state: "backoff", ms, attempts });
      // A suspend/resume leaves a half-open socket; there is no liveness check here and the hub's
      // `idleTimeout: 45` + `sendPings: true` is what closes it (§1.5). A sleep longer than the
      // pending backoff fires it on wake, because `setTimeout` is behind `io.sleep`.
      await sleep(ms, signal);
      delay = Math.min(delay * 2, BACKOFF_MAX);
    }
  }

  return { open, run };
}
