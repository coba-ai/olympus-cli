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
  type CdpReader,
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

// A5 bounds what the SOCKET holds; this bounds what is waiting for it. Without it every further
// write on a paused stream queued another fragment — and with it the buffer it is a view of — with
// no cap at all. 8 MiB per stream is a choice, not a measurement: two of PAUSE_ABOVE, so one large
// CDP response can sit behind another that is still going out, and well under what the per-stream
// reassembly ceiling already allows in the other direction. At it the stream is KILLED: CLOSE to
// the peer, `onClose` to the consumer, and a `write_queue_full` event. The alternative — dropping
// fragments and carrying on — would corrupt the length-prefixed message stream the next bytes
// belong to, which is a worse failure than a stream that ends.
const MAX_DEFERRED = 8 * 1024 * 1024;
const EMPTY_PART = new Uint8Array(0);

// The length prefix inside a `cdp` stream is attacker-controlled (§3: the workbench side is the
// untrusted one), so every `cdp` stream's reader is given this as its `max`: a prefix declaring more
// is refused before its body is buffered, and the reader's tail is therefore always under it. The
// number is a choice, not a measurement: this direction carries CDP commands, which are small, and
// the largest legitimate one anybody has named is a script body.
const CDP_REASSEMBLY_CEILING = 16 * 1024 * 1024;

// Two aggregate bounds, because the per-stream ceiling alone multiplies by however many streams the
// peer opens, and every fresh odd-id OPEN costs a reader, a filter, a task and eventually a Chromium
// WebSocket. Both numbers are choices, not measurements.
//
// MAX_CDP_STREAMS bounds how many `cdp` streams are live at once; an OPEN past it is answered with
// CLOSE and never reaches Chromium, and closing one makes room again. Chromium drives one, and a
// bridge reconnecting may briefly hold a second, so eight is slack rather than a fit.
//
// CDP_REASSEMBLY_TOTAL bounds the sum of every reader's held tail. A DATA frame that would carry the
// total past it closes the stream it arrived on, before the reader buffers it — so the sum never
// exceeds the number, rather than exceeding it by a frame.
const MAX_CDP_STREAMS = 8;
const CDP_REASSEMBLY_TOTAL = 32 * 1024 * 1024;

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
  /**
   * A5, set by the consumer on the tick the stream is handed over, like `onMessage`: stop and
   * restart reading from whatever feeds this stream — the CDP socket to Chromium. The relay calls
   * them while its own `bufferedAmount` is over A5's threshold and when it drains, and on a stream
   * registered while that pause is already active. Nothing sets them today, so the CDP side of the
   * pause does not reach Chromium; this is the seam for wiring it, not the wiring.
   */
  pause?: () => void;
  resume?: () => void;
};

/** What a stream is for, in this file's words — never the peer's bytes. `other` is anything else. */
export type StreamKind = "cdp" | "tcp" | "other";
/** Why an OPEN or a write was refused, in this file's words. A closed set, and the whole set. */
export type RefusedReason =
  | "even_stream_id"
  | "stream_id_in_use"
  | "not_a_cdp_target"
  | "too_many_cdp_streams"
  | "cdp_reassembly_total"
  | "cdp_framing"
  | "write_queue_full";
/** How a live socket closed, in this file's words: `CLOSE_KIND` keyed on the code, never the peer's reason string. */
export type CloseKind = "normal" | "going_away" | "protocol" | "unsupported" | "no_status" | "abnormal" | "policy" | "too_big" | "server_error" | "other";

/**
 * One line of `--json` per state change (Assumption 11), rendered by the command.
 *
 * NOTHING THE PEER SENT IS ECHOED HERE, and that is the point of the three unions above. The
 * workbench is the untrusted side (§3) and it chooses both the OPEN target and the close reason, so
 * quoting either is a path from a frame it composed to the member's terminal and to a `--json`
 * line — a token handed to a workbench that then put it in an OPEN target came back out that way
 * before this round. The peer's target bytes are compared with `cdp` and then dropped; its close
 * reason is dropped for the code's own word; a thrown error's message never reaches an event.
 * `target` on a `stream` event is either that same `cdp` literal or the dial string this CLI's own
 * SOCKS proxy built — never bytes off the wire.
 *
 * What enforces it: the literal unions above (a quoted string does not type-check as one), and
 * `test/browser-relay.test.ts` "no workbench-chosen text reaches an event or a --json line …",
 * which drives the member's token through an OPEN target and a close reason and looks for it in
 * every event, every serialized `--json` line and the thrown error.
 */
export type RelayEvent =
  | { state: "connecting"; attempt: number }
  | { state: "online" }
  | { state: "stream"; id: number; target: string }
  | { state: "refused"; id: number; target: StreamKind; reason: RefusedReason }
  | { state: "closed"; code: number; reason: CloseKind }
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

// The close codes §1.5 and RFC 6455 define, in this file's words. The socket also carries a reason
// STRING, and it is deliberately dropped rather than reported (RelayEvent): the peer writes it. A
// code with no entry here is `other` — the number is still in the event, and it is the number the
// policy below keys on anyway.
const CLOSE_KIND: Record<number, CloseKind> = {
  1000: "normal",
  1001: "going_away",
  1002: "protocol",
  1003: "unsupported",
  1005: "no_status",
  1006: "abnormal",
  1008: "policy",
  1009: "too_big",
  1011: "server_error",
};
const closeKind = (code: number): CloseKind => CLOSE_KIND[code] ?? "other";

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

/** A5: one stream's deferred fragments, in order. Consumed by the `at` index, never shifted; `bytes` is what is still owed. */
type Queue = { parts: Uint8Array[]; at: number; bytes: number; pumping: boolean };
type Entry = {
  /** What this stream is for, for an event. Derived here, never from the peer's bytes beyond `=== "cdp"`. */
  kind: StreamKind;
  data: (bytes: Uint8Array) => void;
  gone: () => void;
  /** Only a laptop-opened `tcp:` stream has this: a dial to acknowledge. */
  ack?: () => void;
  pause?: () => void;
  resume?: () => void;
  /** A5: the fragments of this stream's writes still waiting on a drain. Dropped the moment the stream is. */
  queue?: Queue;
  /** Resolves when this stream is dropped, so a deferred write stops waiting on the connection's drain with it. */
  ended: Promise<void>;
  end: () => void;
};
/** An `Entry` with its `ended`/`end` pair wired; every stream is built through here. */
const newEntry = (e: Omit<Entry, "ended" | "end">): Entry => {
  let end!: () => void;
  const ended = new Promise<void>((resolve) => (end = resolve));
  return { ...e, ended, end };
};
type Conn = {
  handle: RelayHandle;
  streams: Map<number, Entry>;
  /** Every live `cdp` stream's reader, which is what the two aggregate bounds are measured over. */
  cdps: Set<CdpReader>;
  nextEven: number;
  paused: boolean;
  /** Set while `drain` is polling, so a deferred write has something to await rather than spin. */
  drained: Promise<void> | null;
  closed: boolean;
};

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

  // A5: one write's DATA frames, in order. Synchronous while the socket's buffer is under the
  // threshold; the first fragment that finds it OVER stops there and the rest of the write is
  // queued on the stream, so a large CDP response no longer pours every remaining fragment into a
  // full buffer. Later writes go behind what the stream already owes, which keeps them in order.
  //
  // A CLOSE — ours or the peer's — DROPS what the stream still owes rather than flushing it:
  // `drop` empties the queue on the spot and the CLOSE goes out at once. Chosen deliberately this
  // round, over flushing first, because flushing hands a peer that is not draining a way to keep
  // this process holding its bytes for as long as it likes — which is the bound MAX_DEFERRED
  // exists for — and the far end of a closed stream has nobody left to read what arrives. The cost
  // is real: a consumer that writes and then closes at once loses the tail of that write whenever
  // the socket is over A5's threshold. Pinned by `test/browser-relay.test.ts` "A5: a stream's
  // deferred writes are bounded, and closing it drops what it still owed" for a close from this
  // side, and "A5: a reused stream id inherits none of the previous stream's deferred bytes" for
  // the peer's CLOSE — one `drop` serves both.
  const stream = (c: Conn, id: number, bytes: Uint8Array) => {
    const e = c.streams.get(id);
    if (!e) return;
    const parts = chunkPayload(bytes);
    if (!parts.length) return;
    if (e.queue) return enqueue(c, id, e, parts, 0);
    const next = burst(c, id, e, parts, 0);
    if (next >= parts.length) return;
    pressure(c); // published here, not on the next tick, so crossing the threshold always says so
    enqueue(c, id, e, parts, next);
  };
  /** Queues what the socket would not take, and starts the pump unless one is already running for this stream. */
  function enqueue(c: Conn, id: number, e: Entry, parts: Uint8Array[], from: number) {
    const q = (e.queue ??= { parts: [], at: 0, bytes: 0, pumping: false });
    for (let i = from; i < parts.length; i++) {
      q.parts.push(parts[i]!);
      q.bytes += parts[i]!.length;
    }
    if (q.bytes > MAX_DEFERRED) {
      kill(c, id); // which clears the queue; nothing of it goes out
      return emit({ state: "refused", id, target: e.kind, reason: "write_queue_full" });
    }
    if (q.pumping) return;
    q.pumping = true;
    void pump(c, id, e, q);
  }
  /** Sends parts from `from` until the buffer goes over the threshold or the stream goes; returns where it stopped. */
  function burst(c: Conn, id: number, e: Entry, parts: Uint8Array[], from: number): number {
    let i = from;
    for (; i < parts.length; i++) {
      // The ENTRY, not the id: an id the peer closed and reopened is a different stream, and the
      // bytes this write belongs to are not its to receive.
      if (c.closed || c.streams.get(id) !== e) return parts.length;
      if (c.handle.bufferedAmount > PAUSE_ABOVE) break;
      frame(c, id, DATA, parts[i]!);
    }
    return i;
  }
  /** Drains one stream's queue into the socket, waiting on the connection's drain between bursts. */
  async function pump(c: Conn, id: number, e: Entry, q: Queue): Promise<void> {
    while (q.at < q.parts.length) {
      if (c.closed || c.streams.get(id) !== e) return; // the entry, as in `burst`
      while (q.at < q.parts.length && c.handle.bufferedAmount <= PAUSE_ABOVE) {
        const part = q.parts[q.at]!;
        q.parts[q.at++] = EMPTY_PART; // released as it goes out, so the queue holds only what it still owes
        q.bytes -= part.length;
        frame(c, id, DATA, part);
        if (c.closed || c.streams.get(id) !== e) return;
      }
      if (q.at >= q.parts.length) break;
      pressure(c);
      // `c.drained` is null between the poll finishing and the pause being lifted, and null when the
      // buffer is over the threshold with no pause published (a closed connection). Poll, not spin —
      // and `e.ended` ends the wait the moment the stream is dropped, rather than one poll later.
      await Promise.race([c.drained ?? sleep(DRAIN_POLL_MS), e.ended]);
    }
    q.pumping = false;
    if (e.queue === q) e.queue = undefined; // owes nothing: synchronous again until the next crossing
  }

  function pressure(c: Conn) {
    if (c.paused || c.closed || c.handle.bufferedAmount <= PAUSE_ABOVE) return;
    c.paused = true;
    for (const e of c.streams.values()) e.pause?.();
    o.onBackpressure?.(true);
    c.drained = drain(c);
  }
  async function drain(c: Conn) {
    while (!c.closed && c.handle.bufferedAmount >= RESUME_BELOW) await sleep(DRAIN_POLL_MS);
    c.drained = null;
    if (!c.paused) return; // teardown got there first and already resumed
    c.paused = false;
    for (const e of c.streams.values()) e.resume?.();
    o.onBackpressure?.(false);
  }

  // A5: a stream registered while the pause is already active is paused too, or it would read at
  // full speed into a socket every other stream has stopped feeding. On a microtask because the
  // consumer sets `pause` after `open` returns, or inside `onCdpStream` — not before we register it.
  const joinPause = (c: Conn, e: Entry) => {
    if (!c.paused) return;
    queueMicrotask(() => {
      if (c.paused && !c.closed) e.pause?.();
    });
  };

  /**
   * Takes a stream off the connection: its deferred fragments go on this tick, and anything waiting
   * on a drain for it stops waiting. `only` makes it a no-op unless that exact entry still holds
   * the id — a `Stream` or `CdpChannel` handed out earlier must not close the stream that reused
   * its number. Returns the entry, or undefined if the id was already free.
   */
  const drop = (c: Conn, id: number, only?: Entry): Entry | undefined => {
    const e = c.streams.get(id);
    if (!e || (only && e !== only)) return undefined;
    c.streams.delete(id);
    e.queue = undefined;
    e.end();
    return e;
  };
  /** Ends a stream from our side: CLOSE to the peer, and the consumer is told, because it did not ask for this. */
  const kill = (c: Conn, id: number) => {
    const e = drop(c, id);
    if (!e) return;
    frame(c, id, CLOSE);
    e.gone();
  };
  const refuse = (c: Conn, id: number, target: StreamKind, reason: RefusedReason) => {
    frame(c, id, CLOSE);
    emit({ state: "refused", id, target, reason });
  };

  // A5/§5.6: the only thing the workbench may open is a `cdp` stream, on an odd id, that is not
  // already live. Everything else is answered with CLOSE and never reaches Chromium.
  function opened(c: Conn, id: number, payload: Uint8Array) {
    // The peer's bytes, compared and then dropped: `kind` is one of two words chosen here, and the
    // decoded string reaches no event, no log line and no error (see RelayEvent).
    const target = DEC.decode(payload);
    const kind: StreamKind = target === "cdp" ? "cdp" : "other";
    if (!isWorkbenchStream(id)) return refuse(c, id, kind, "even_stream_id");
    if (c.streams.has(id)) {
      // The peer's view of this id and ours have diverged, so the live stream goes too; `kill` sends the CLOSE.
      kill(c, id);
      return emit({ state: "refused", id, target: kind, reason: "stream_id_in_use" });
    }
    if (target !== "cdp") return refuse(c, id, kind, "not_a_cdp_target");
    if (c.cdps.size >= MAX_CDP_STREAMS) return refuse(c, id, "cdp", "too_many_cdp_streams");

    // The per-stream ceiling is the reader's own `max`, so it refuses an oversize declaration before
    // buffering the body and its tail stays under the number without anything here counting bytes.
    const reader = cdpReader(CDP_REASSEMBLY_CEILING);
    c.cdps.add(reader);
    const release = () => {
      c.cdps.delete(reader);
      reader.close();
    };
    // Both halves key on `entry`, not on `id`: the peer may close this stream and open another on
    // the same number, and a channel handed out for the first one has no business writing to or
    // closing the second (`test/browser-relay.test.ts` "A5: a reused stream id inherits none …").
    const cdp: CdpChannel = {
      send: (message) => {
        if (c.streams.get(id) === entry) stream(c, id, encodeCdp(message));
      },
      close: () => {
        if (!drop(c, id, entry)) return;
        release();
        frame(c, id, CLOSE);
      },
    };
    const entry: Entry = newEntry({
      kind: "cdp",
      data(bytes) {
        // Wire bytes only, summed over every live reader, and checked before this frame is buffered.
        let total = bytes.length;
        for (const r of c.cdps) total += r.held;
        if (total > CDP_REASSEMBLY_TOTAL) {
          kill(c, id);
          return emit({ state: "refused", id, target: "cdp", reason: "cdp_reassembly_total" });
        }
        let messages: string[];
        try {
          messages = reader.push(bytes);
        } catch {
          // A declared length over the ceiling, or bytes that are not UTF-8: either way the peer is
          // not speaking §4's inner framing, so the stream goes rather than the frame being dropped.
          // The thrown message is built from our own numbers, but it is dropped all the same — the
          // event says which rule was broken and nothing about what arrived.
          kill(c, id);
          return emit({ state: "refused", id, target: "cdp", reason: "cdp_framing" });
        }
        for (const m of messages) cdp.onMessage?.(m);
      },
      gone() {
        release();
        cdp.onClose?.();
      },
      pause: () => cdp.pause?.(),
      resume: () => cdp.resume?.(),
    });
    c.streams.set(id, entry);
    emit({ state: "stream", id, target: "cdp" }); // the literal we compared to, not the bytes we compared
    o.onCdpStream(cdp);
    joinPause(c, entry);
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
      drop(c, f.id);
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
    for (const e of entries) {
      e.queue = undefined; // the socket is gone; what it owed goes with it
      e.end();
      e.gone();
    }
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
    // Keyed on `entry` like the cdp channel's two halves, for the same reason — though an even id
    // is never reused on one connection (`nextEven` only climbs), so here it is uniformity, not a
    // bug being fixed.
    const s: Stream = {
      write: (bytes) => {
        if (c.streams.get(id) === entry) stream(c, id, bytes);
      },
      close: () => {
        if (drop(c, id, entry)) frame(c, id, CLOSE);
      },
    };
    const entry: Entry = newEntry({
      kind: target.startsWith("tcp:") ? "tcp" : "other",
      data: (bytes) => s.onData?.(bytes),
      gone: () => s.onClose?.(),
      ack: () => s.onAck?.(),
      pause: () => s.pause?.(),
      resume: () => s.resume?.(),
    });
    c.streams.set(id, entry);
    frame(c, id, OPEN, ENC.encode(target));
    // `target` here is the dial string the SOCKS proxy built for us, not anything the peer sent.
    emit({ state: "stream", id, target });
    joinPause(c, entry);
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
      c = { handle, streams: new Map(), cdps: new Set(), nextEven: 2, paused: false, drained: null, closed: false };
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
        // The code, and this file's word for it. `end.reason` is the peer's string and stops here.
        emit({ state: "closed", code: end.code, reason: closeKind(end.code) });
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
