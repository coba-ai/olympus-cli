// The browser-relay multiplex frame (§4 of the browser-relay contract): one frame per WebSocket
// binary message, carrying one stream's bytes.
//
//     [u32 BE stream id][u8 op][payload ≤ 256 KiB]
//
// The three op numbers below are BINDING on the other side of the protocol — the Rafita workbench
// bridge, which does not exist yet. §4 calls them "a proposal"; this module pins them, and a bridge
// that picks other values interoperates with nothing.
export const OPEN = 0;
export const DATA = 1;
export const CLOSE = 2;
export type Op = typeof OPEN | typeof DATA | typeof CLOSE;

// Why a frame never needs checking against the hub's 1 MiB message limit (§1.4): 256 KiB + the
// 5-byte header is 262149 bytes and cannot reach it. The test pins that arithmetic.
export const MAX_PAYLOAD = 256 * 1024;

const HEADER = 5;
const ENC = new TextEncoder();
const DEC = new TextDecoder();
const isOp = (n: number): n is Op => n === OPEN || n === DATA || n === CLOSE;

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

// Anything shorter than a header, or an op §4 does not define, is an error — never a partial frame.
// `payload` is a view into `buf`, not a copy; a WebSocket message's buffer belongs to its handler.
export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.length < HEADER) throw new Error(`frame is ${buf.length} bytes; a frame is at least ${HEADER}`);
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
  /** Whole messages in arrival order; a partial tail is held for the next call. Nothing, once closed. */
  push: (bytes: Uint8Array) => string[];
  /** Drops the half-assembled tail, so a fragment arriving after it is dropped rather than buffered. */
  close: () => void;
};

// Nothing bounds how much an open stream can make this hold: the length prefix is trusted, and the
// workbench is the untrusted side (§3). No cap is in the contract, so none is imposed here.
export function cdpReader(): CdpReader {
  let buf = new Uint8Array(0);
  let closed = false;
  return {
    push(bytes) {
      if (closed) return [];
      const next = new Uint8Array(buf.length + bytes.length);
      next.set(buf);
      next.set(bytes, buf.length);
      buf = next;
      const out: string[] = [];
      for (;;) {
        if (buf.length < 4) break;
        const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0);
        if (buf.length < 4 + len) break;
        out.push(DEC.decode(buf.subarray(4, 4 + len)));
        buf = buf.slice(4 + len);
      }
      return out;
    },
    close() {
      closed = true;
      buf = new Uint8Array(0);
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
  /** Called once when the peer sends CLOSE or the socket drops. */
  onClose?: () => void;
};

/** Opens a laptop-side stream — `tcp:<host>:<port>`, since `cdp` is the workbench's to open — and sends its OPEN. The implementation allocates the EVEN id; a caller never picks one. */
export type StreamOpener = (target: string) => Stream;

/** Sends one whole CDP JSON message. The implementation decides where it goes — on to Chromium, or back through the relay length-prefixed. */
export type CdpSend = (message: string) => void;
