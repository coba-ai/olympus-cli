// The browser-relay multiplex frame (§4 of the browser-relay contract): one frame per WebSocket
// binary message, carrying one stream's bytes.
//
//     [u32 BE stream id][u8 op][payload ≤ 256 KiB]
//
// The four op numbers below are BINDING on the other side of the protocol — the Rafita workbench
// bridge, which does not exist yet. §4 calls 0/1/2 "a proposal" and has no ACK at all; this module
// pins all four, and a bridge that picks other values interoperates with nothing.
export const OPEN = 0;
export const DATA = 1;
export const CLOSE = 2;
// The workbench's "my dial succeeded", payload empty, on a `tcp:` stream the laptop opened. MEASURED
// by unit 2.3: without it the SOCKS proxy cannot answer a CONNECT at all until the far end speaks
// first, which no protocol Chromium uses does — real Chromium through a real workbench failed every
// page with ERR_SOCKS_CONNECTION_FAILED. `browser-socks.ts` keys its success reply on this.
export const ACK = 3;
export type Op = typeof OPEN | typeof DATA | typeof CLOSE | typeof ACK;

// Why a frame never needs checking against the hub's 1 MiB message limit (§1.4): 256 KiB + the
// 5-byte header is 262149 bytes and cannot reach it. The test pins that arithmetic.
export const MAX_PAYLOAD = 256 * 1024;

const HEADER = 5;
const ENC = new TextEncoder();
// `fatal` so a byte sequence that is not UTF-8 raises instead of becoming replacement characters.
// `cdpReader` is the only user; a CDP message is JSON and the workbench is the untrusted side (§3).
const DEC = new TextDecoder("utf-8", { fatal: true });
const isOp = (n: number): n is Op => n === OPEN || n === DATA || n === CLOSE || n === ACK;

export type Frame = { id: number; op: Op; payload: Uint8Array };

export function encodeFrame(id: number, op: Op, payload?: Uint8Array): Uint8Array {
  const body = payload ?? new Uint8Array(0);
  if (body.length > MAX_PAYLOAD) throw new Error(`frame payload is ${body.length} bytes; the limit is ${MAX_PAYLOAD}`);
  const frame = new Uint8Array(HEADER + body.length);
  new DataView(frame.buffer).setUint32(0, id);
  frame[4] = op;
  frame.set(body, HEADER);
  return frame;
}

// Anything shorter than a header, an op §4 does not define, or a payload past the same cap
// `encodeFrame` refuses, is an error — never a partial frame. The cap is applied on the way IN as
// well as out because inbound frames come from the workbench, which is the untrusted side (§3).
// `payload` is a view into `buf`, not a copy; a WebSocket message's buffer belongs to its handler.
export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.length < HEADER) throw new Error(`frame is ${buf.length} bytes; a frame is at least ${HEADER}`);
  if (buf.length - HEADER > MAX_PAYLOAD)
    throw new Error(`frame payload is ${buf.length - HEADER} bytes; the limit is ${MAX_PAYLOAD}`);
  const op = buf[4]!;
  if (!isOp(op)) throw new Error(`unknown frame op ${op}`);
  return { id: new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0), op, payload: buf.subarray(HEADER) };
}

// §4: odd ids are opened by the workbench (`cdp` streams), even ids by us (`tcp:`, from the SOCKS proxy).
export const isWorkbenchStream = (id: number) => id % 2 === 1;
export const isLaptopStream = (id: number) => id % 2 === 0;

/** Splits stream bytes into DATA payloads. Empty input sends nothing; the chunks are views, not copies. */
export function chunkPayload(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += MAX_PAYLOAD) out.push(bytes.subarray(i, i + MAX_PAYLOAD));
  return out;
}

// A SECOND framing layer, inside a `cdp` stream's DATA bytes only: [u32 BE byte length][UTF-8 CDP JSON].
// DATA frames are not message boundaries — a screenshot response is many times MAX_PAYLOAD and arrives
// as several of them — so the prefix is what says where one CDP message ends. A `tcp:` stream is a raw
// byte stream with no prefix: do not put one on it.
export function encodeCdp(message: string): Uint8Array {
  const body = ENC.encode(message);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

export type CdpReader = {
  /**
   * Whole messages in arrival order; a partial tail is held for the next call. Nothing, once closed.
   * The tail is held BY REFERENCE, so a caller that reuses its buffer must copy before pushing —
   * `browser-relay.ts` already does (its COPY comment), and nothing else calls this.
   *
   * THROWS on a prefix declaring more than `max`, and on a completed message that is not valid
   * UTF-8. Both are the untrusted peer's input (§3); `browser-relay.ts` kills the stream on either.
   * The tail is in whatever state the throw left it, so a reader that has thrown is not reused.
   */
  push: (bytes: Uint8Array) => string[];
  /**
   * WIRE bytes — the 4-byte prefix included — held for a message that has not completed. This is
   * the only quantity a ceiling may be counted in: it is what arrived, not what a decode produced.
   */
  readonly held: number;
  /** Drops the half-assembled tail, so a fragment arriving after it is dropped rather than buffered. */
  close: () => void;
};

// `max` is the largest message, in wire bytes, this reader will assemble. A prefix declaring more
// throws the moment the prefix is whole, so the body is never buffered at all — which is why `held`
// is always under `max` when `push` returns, and why no caller has to bound the tail itself. The
// default is unbounded, for a caller reading messages it produced (`test/browser.test.ts`).
//
// The held tail is a LIST of chunks, concatenated only when a whole message is there, so each byte
// is copied once. Holding one buffer and rebuilding it on every push was quadratic: unit 2.1
// measured ~330 ms to feed 16 MiB in 256 KiB frames that way.
export function cdpReader(max = Infinity): CdpReader {
  let chunks: Uint8Array[] = [];
  let held = 0; // bytes across `chunks`
  let closed = false;

  // The byte at logical offset `i` across the chunk list; only ever called with `i` < held.
  const at = (i: number) => {
    let n = i;
    for (const c of chunks) {
      if (n < c.length) return c[n]!;
      n -= c.length;
    }
    return 0;
  };
  // The first `n` bytes, removed from the list and copied once into one buffer.
  const take = (n: number) => {
    const out = new Uint8Array(n);
    let wrote = 0;
    while (wrote < n) {
      const c = chunks[0]!;
      const want = Math.min(n - wrote, c.length);
      out.set(want === c.length ? c : c.subarray(0, want), wrote);
      wrote += want;
      if (want === c.length) chunks.shift();
      else chunks[0] = c.subarray(want);
    }
    held -= n;
    return out;
  };

  return {
    push(bytes) {
      if (closed) return [];
      if (bytes.length) {
        chunks.push(bytes);
        held += bytes.length;
      }
      const out: string[] = [];
      for (;;) {
        if (held < 4) break;
        const len = ((at(0) << 24) | (at(1) << 16) | (at(2) << 8) | at(3)) >>> 0;
        // Before the body is buffered, not after: refusing on what the prefix declares is what
        // keeps the tail bounded regardless of how many bytes actually arrive behind it.
        if (4 + len > max) throw new Error(`a cdp message declaring ${4 + len} bytes; the limit is ${max}`);
        if (held < 4 + len) break;
        const body = take(4 + len).subarray(4);
        try {
          out.push(DEC.decode(body));
        } catch {
          throw new Error(`a cdp message of ${body.length} bytes that is not valid UTF-8`);
        }
      }
      return out;
    },
    get held() {
      return held;
    },
    close() {
      closed = true;
      chunks = [];
      held = 0;
    },
  };
}

// The seam the relay client hands to its consumers. One multiplexed stream, in either direction.
export type Stream = {
  /** Raw stream bytes. The implementation fragments them into DATA frames; a `cdp` caller has already applied `encodeCdp`. */
  write: (bytes: Uint8Array) => void;
  /** Sends CLOSE and releases the id. An implementation must make this idempotent, and a no-op once the peer has closed. */
  close: () => void;
  /** Set by the consumer on the tick the stream is opened; called with each DATA payload, in order. */
  onData?: (bytes: Uint8Array) => void;
  /** Called once when the peer ACKs this stream (op 3, `tcp:` streams only — a `cdp` stream is never ACKed). */
  onAck?: () => void;
  /** Called once when the peer sends CLOSE or the socket drops. */
  onClose?: () => void;
  /**
   * Set by the consumer alongside `onData`: stop and restart reading from whatever local socket
   * feeds this stream. The relay calls them while its own `bufferedAmount` is over A5's threshold
   * and when it drains, which is the only way that backpressure reaches a local socket at all.
   */
  pause?: () => void;
  resume?: () => void;
};

/** Opens a laptop-side stream — `tcp:<host>:<port>`, since `cdp` is the workbench's to open — and sends its OPEN. The implementation allocates the EVEN id; a caller never picks one. */
export type StreamOpener = (target: string) => Stream;

/** Sends one whole CDP JSON message. The implementation decides where it goes — on to Chromium, or back through the relay length-prefixed. */
export type CdpSend = (message: string) => void;
