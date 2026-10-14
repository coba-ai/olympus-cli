import { randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";

// olympus2-web's GET /api/v1/browser/relay (CONTRACT §1.2) and the companion hub behind it (§1.4)
// as one double, because from the laptop the two are one socket.
//
// Like Rails and the hub, it forwards bytes and never parses a §4 frame: a test builds the frames
// it wants and asserts on the bytes that come back. It therefore shares nothing with the codec.
//
// Not modelled, because no test needs it and the double tracks no machine id: the hub evicting a
// first laptop with 4409 when a second one connects. Every §1.5 close code is commanded instead
// (`close`, `drop`). The one hub behaviour that fires on its own is the 1003 for a text frame,
// because a client that sends text must be punished by the double, not by the test.

export const RELAY_PATH = "/api/v1/browser/relay";

/**
 * Every status the laptop can see instead of a 101 (§1.2). 502 is hand-written by Rails *after*
 * the hijack, which the laptop still reads as a non-101 HTTP response on the same socket, so the
 * double answers it like the rest. The body is `{"error":"<code>"}` as §1.2 describes; the exact
 * code strings are not pinned by the contract and the client reads the status only (PLAN A12).
 */
export type RelayStatus = 400 | 401 | 404 | 501 | 502 | 503;

const ERROR_CODE: Record<RelayStatus, string> = {
  400: "bad_handshake",
  401: "unauthorized",
  404: "not_found",
  501: "no_hijack",
  502: "bad_gateway",
  503: "companion_unavailable",
};

/** What the double saw on one handshake, for asserting where the token travelled. */
export type Handshake = { auth: string | null; cookie: string | null; search: string; upgraded: boolean };

export type FakeRelayState = {
  /** Answered before the upgrade until a test clears it, so a backoff sequence can be driven. */
  status?: RelayStatus;
  handshakes: Handshake[];
};

/** The double's side of an upgraded socket: the hub, and the workbench behind it. */
export type Laptop = {
  /** Every binary message the laptop has sent, in arrival order. */
  readonly received: Uint8Array[];
  /** Workbench → laptop: one binary message, verbatim. A `cdp` stream is opened by sending its OPEN frame. */
  send(bytes: Uint8Array): void;
  /** The next message the laptop sends that `next()` has not already returned. */
  next(): Promise<Uint8Array>;
  /** §1.5: 4401 revoked, 4409 replaced, 4410 other end gone, 1003 text frame, 1009 backpressure. */
  close(code: number, reason?: string): void;
  /** No close frame, so the laptop sees an abnormal 1006 (§1.5). */
  drop(): void;
};

export type FakeRelay = {
  /** `ws://127.0.0.1:<ephemeral>/api/v1/browser/relay` — loopback only, as a public repo requires. */
  url: string;
  /** The one bearer this double accepts. */
  token: string;
  state: FakeRelayState;
  /** The attached laptop, or the next one to attach. */
  laptop(): Promise<Laptop>;
  stop(): void;
};

type Conn = { ws: ServerWebSocket<Conn> | null; laptop: Laptop; deliver(bytes: Uint8Array): void };

function newConn(): Conn {
  const received: Uint8Array[] = [];
  const waiting: ((bytes: Uint8Array) => void)[] = [];
  let read = 0;
  const conn: Conn = {
    ws: null,
    deliver(bytes) {
      received.push(bytes);
      const next = waiting.shift();
      if (next) {
        read++;
        next(bytes);
      }
    },
    laptop: {
      received,
      send: (bytes) => void conn.ws?.sendBinary(bytes),
      next: () =>
        read < received.length
          ? Promise.resolve(received[read++]!)
          : new Promise<Uint8Array>((resolve) => void waiting.push(resolve)),
      close: (code, reason) => conn.ws?.close(code, reason),
      drop: () => conn.ws?.terminate(),
    },
  };
  return conn;
}

export function startFakeRelay(opts: { token?: string; status?: RelayStatus } = {}): FakeRelay {
  const token = opts.token ?? `obm_${randomBytes(16).toString("base64url")}`;
  const state: FakeRelayState = { status: opts.status, handshakes: [] };
  let current: Conn | null = null;
  const waiting: ((laptop: Laptop) => void)[] = [];

  const server = Bun.serve<Conn, never>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const u = new URL(req.url);
      const auth = req.headers.get("authorization");
      const handshake: Handshake = { auth, cookie: req.headers.get("cookie"), search: u.search, upgraded: false };
      state.handshakes.push(handshake);
      const error = (status: RelayStatus) =>
        new Response(JSON.stringify({ error: ERROR_CODE[status] }), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (u.pathname !== RELAY_PATH) return error(404);
      if (state.status) return error(state.status);
      // The bearer header is the only credential: a session cookie and a ?token= are never read (§1.2).
      if (auth !== `Bearer ${token}`) return error(401);
      const conn = newConn();
      // 400 is what a request that is not a valid handshake gets (§1.2); Bun decides that here.
      if (!server.upgrade(req, { data: conn })) return error(400);
      handshake.upgraded = true;
      return undefined;
    },
    websocket: {
      // The hub's own settings (§1.4): binary only, no compression, 1 MiB messages, native liveness.
      perMessageDeflate: false,
      maxPayloadLength: 1024 * 1024,
      idleTimeout: 45,
      sendPings: true,
      open(ws) {
        ws.data.ws = ws;
        current = ws.data;
        for (const resolve of waiting.splice(0)) resolve(ws.data.laptop);
      },
      message(ws, message) {
        // §1.4/§1.5: a text frame closes the sender with 1003. Binary is forwarded unread.
        if (typeof message === "string") return void ws.close(1003, "text");
        ws.data.deliver(new Uint8Array(message));
      },
      close(ws) {
        if (current === ws.data) current = null;
      },
    },
  });

  return {
    url: `ws://${server.hostname}:${server.port}${RELAY_PATH}`,
    token,
    state,
    laptop: () =>
      current ? Promise.resolve(current.laptop) : new Promise<Laptop>((resolve) => void waiting.push(resolve)),
    stop: () => void server.stop(true),
  };
}
