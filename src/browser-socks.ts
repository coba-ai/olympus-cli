// The laptop's SOCKS5 proxy (A9; contract §5.4). Chromium is launched with
// `--proxy-server=socks5://127.0.0.1:<port>` (unit 2.4), so every connection it makes arrives here as
// a SOCKS5 CONNECT, becomes one even-id `tcp:<host>:<port>` stream through the injected opener, and
// is dialled by the workbench — never from the member's own network.
//
// MEASURED, which A9 left UNVERIFIED: Chromium 152.0.7977.82 with `--proxy-server=socks5://…` sends
// the HOSTNAME as ATYP 0x03 DOMAINNAME. It does NOT resolve locally and does NOT send a pre-resolved
// address, so a hostname allowlist does match. Driven headless against this very server: every
// CONNECT arrived as ATYP 0x03 — the navigated `example.com:80`/`:443` and Chromium's own
// `www.google.com:443`, `accounts.google.com:443` and `clients2.google.com:80` background calls.
// `socks5h://` is not an alternative and must not be used: Chromium refuses that scheme with
// ERR_NO_SUPPORTED_PROXIES and dials no proxy at all (measured the same way: zero connections).
//
// This server performs NO DNS (§5.4): a query here would leave the member's machine and put the
// browsed name on their LAN, and the workbench resolves the name again at its end anyway. So a
// DOMAINNAME is matched as the name was sent, and an address literal as the literal; a name is never
// resolved to compare against the address rules below. A name field carrying an ADDRESS is not that
// case — `2130706433` and `::1` are loopback with no query asked — so `classifyName` canonicalises
// those spellings and the address rules apply whichever ATYP carried them. The consequence of the real
// limit, stated rather than hidden: a NAME that resolves to a private or loopback address at the far
// end is NOT caught here, and nothing in this file could catch it. The workbench-side allowlist on the
// resolved address (§6.3) is what
// covers that, and it does not exist yet (loop D).
import type { Socket } from "bun";
import type { Stream, StreamOpener } from "./browser-frame";
import { usage } from "./core";

const VERSION = 0x05;
const CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_NAME = 0x03;
const ATYP_IPV6 = 0x04;
const NO_ACCEPTABLE_METHODS = 0xff;

// RFC 1928 §6 replies. 0x02 is A9's answer to an address or port the rules refuse; 0x04 is its answer
// to a `tcp:` stream that was never ACKed; 0x07 and 0x08 fall out of parsing.
const SUCCESS = 0x00;
const NOT_ALLOWED = 0x02;
const UNREACHABLE = 0x04;
const BAD_COMMAND = 0x07;
const BAD_ATYP = 0x08;

const DEFAULT_PORTS = new Set([80, 443]);
const ACK_MS = 30_000;
const EMPTY = new Uint8Array(0);
const DEC = new TextDecoder();

// Ceiling on remote `tcp:` bytes this process holds for ONE browser socket: payloads that arrived
// before the ACK plus whatever a partial `sock.write` left behind. Over it the stream is closed and
// the browser socket goes with it — 0x04 before the reply, a hang-up after it — instead of the queue
// growing. Held bytes peak at this plus the one payload that crossed it, since the check follows the
// write attempt. Enforced by `toClient` and `onData`. It bounds this direction only; the browser's own
// bytes are bounded by A5's `sock.pause()` on the relay's queue, and `c.buf` by nothing.
const MAX_PENDING = 1024 * 1024;

// [VER][REP][RSV][ATYP IPv4][BND.ADDR 0.0.0.0][BND.PORT 0]. The bound address means nothing for a
// CONNECT that is really a tunnel; Chromium accepted this exact shape in the probe above.
const reply = (rep: number) => new Uint8Array([VERSION, rep, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** One copy for the whole queue, rather than one per arriving chunk (as `cdpReader` was already fixed). */
const concatAll = (chunks: Uint8Array[], total: number) => {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

/** One `--allow-origin` entry. `port` unset means the two default ports, not every port. */
export type AllowOrigin = { host: string; port?: number };

/**
 * The characters a `HOST` may be built from: anything that is not a URL delimiter, whitespace or a
 * control. It keeps a path, userinfo, query, fragment or embedded space out of the host BEFORE
 * `new URL` gets a chance to quietly accept the whole URL and hand back only its hostname. Non-ASCII
 * is deliberately inside the class: an IDN has to survive as far as the punycoding below.
 */
const HOST_CHARS = /^[^\u0000-\u0020\u007f/\\?#@[\]:%<>"{}|^`]+$/;

/**
 * `HOST`, `HOST:PORT`, `[v6]` or `[v6]:PORT`. A bare IPv6 literal is several colons with no brackets,
 * so `2001:db8::1` is a host and not a host with port 1. The grammar is checked first; only then do
 * hosts go through `new URL`, which lowercases, punycodes an IDN (Chromium sends the A-label, so
 * `café.example` would otherwise never match) and canonicalises an IPv6 literal (so `2001:db8::1` and
 * its expanded spelling are the same entry).
 */
export function parseAllowOrigin(raw: string): AllowOrigin {
  const s = raw.trim();
  const bad = () => usage(`invalid --allow-origin "${raw}"; expected HOST, HOST:PORT or [v6]:PORT`);
  const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::(\d+))?$/.exec(s);
  let host: string;
  let port: string | undefined;
  if (bracketed) {
    host = bracketed[1]!;
    port = bracketed[2];
  } else if (s.includes(":") && s.indexOf(":") !== s.lastIndexOf(":")) {
    // Several colons and no brackets: a bare IPv6 literal, which `new URL` below is what validates.
    if (!/^[0-9A-Fa-f:.]+$/.test(s)) throw bad();
    host = s;
  } else {
    const i = s.lastIndexOf(":");
    host = i === -1 ? s : s.slice(0, i);
    port = i === -1 ? undefined : s.slice(i + 1);
    if (!HOST_CHARS.test(host)) throw bad();
  }
  if (port !== undefined && !/^\d{1,5}$/.test(port)) throw bad();
  const n = port === undefined ? undefined : Number(port);
  if (n !== undefined && !(n >= 1 && n <= 65535)) throw bad();
  let canonical: string;
  try {
    const u = new URL(`http://${host.includes(":") ? `[${host}]` : host}/`);
    canonical = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  } catch {
    throw bad();
  }
  if (!canonical) throw bad();
  return { host: canonical, port: n };
}

// Assumption 8's always-refused IPv4 ranges. Refused whatever the allowlist says: `--allow-origin`
// narrows the public default, it does not open a private address.
const privateIPv4 = (a: number, b: number, c: number) =>
  a === 0 || // 0.0.0.0/8
  a === 10 || // 10/8
  a === 127 || // 127/8 loopback
  (a === 169 && b === 254) || // 169.254/16 link-local
  (a === 172 && (b & 0xf0) === 16) || // 172.16/12
  (a === 192 && b === 168) || // 192.168/16
  (a === 100 && (b & 0xc0) === 64) || // 100.64/10 CGNAT
  (a === 192 && b === 0 && c === 2) || // 192.0.2/24 TEST-NET-1
  (a & 0xf0) === 224 || // 224/4 multicast
  (a & 0xf0) === 240; // 240/4 reserved, 255.255.255.255 included

// ::1, ::, fc00::/7 and fe80::/10. fdaa::/16 is Fly's internal network and needs no line of its own:
// it is inside fc00::/7, which §6.3 names it under.
const privateIPv6 = (b: Uint8Array) =>
  b.every((x) => x === 0) || // ::
  (b[15] === 1 && b.subarray(0, 15).every((x) => x === 0)) || // ::1
  (b[0]! & 0xfe) === 0xfc || // fc00::/7 ULA (fdaa::/16 is in here)
  (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80); // fe80::/10 link-local

/** `::ffff:a.b.c.d` — the spelling that would otherwise walk an IPv4 range straight past the check. */
const ipv4Mapped = (b: Uint8Array) => b[10] === 0xff && b[11] === 0xff && b.subarray(0, 10).every((x) => x === 0);

/** The host string and the verdict for one address, whichever ATYP (or name field) delivered it. */
type Verdict = { host: string; denied: boolean };

const fromIPv4 = (a: number, b: number, c: number, d: number): Verdict => ({
  host: `${a}.${b}.${c}.${d}`,
  denied: privateIPv4(a, b, c),
});

const canonicalIPv6 = (v6: Uint8Array) => {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((v6[i]! << 8) | v6[i + 1]!) >>> 0).toString(16));
  return new URL(`http://[${groups.join(":")}]/`).hostname.slice(1, -1); // canonical, so it matches an --allow-origin entry
};

const fromIPv6 = (v6: Uint8Array): Verdict =>
  // Normalised to its IPv4 form before the ranges are applied.
  ipv4Mapped(v6) ? fromIPv4(v6[12]!, v6[13]!, v6[14]!, v6[15]!) : { host: canonicalIPv6(v6), denied: privateIPv6(v6) };

/** The 16 bytes of an already-canonical IPv6 string (hex groups, at most one `::`, no embedded IPv4). */
function expandIPv6(canonical: string): Uint8Array | null {
  const halves = canonical.split("::");
  if (halves.length > 2) return null;
  const split = (s: string) => (s ? s.split(":") : []);
  const head = split(halves[0]!);
  const tail = halves.length === 2 ? split(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const n = parseInt(groups[i]!, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

/** `new URL` is the IPv6 grammar here, and it folds `::ffff:127.0.0.1` into hex groups on the way. */
function ipv6FromText(text: string): Uint8Array | null {
  let canonical: string;
  try {
    canonical = new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  return canonical ? expandIPv6(canonical) : null;
}

/** One dotted part, with C's base prefixes: `0x7f` is 127, `0177` is 127, `127` is 127. */
function ipv4Part(p: string): number | null {
  if (p.startsWith("0x")) return /^[0-9a-f]{1,8}$/.test(p.slice(2)) ? parseInt(p.slice(2), 16) : null;
  if (p.length > 1 && p.startsWith("0")) return /^[0-7]{1,11}$/.test(p.slice(1)) ? parseInt(p.slice(1), 8) : null;
  return /^[0-9]{1,10}$/.test(p) ? Number(p) : null;
}

/** A label is an IPv4 attempt once its LAST part is numeric; `0x` is an attempt and a failed one. */
const NUMERIC_PART = /^(0x[0-9a-f]*|[0-9]+)$/;
const NAME_LABEL = /^[a-z0-9_-]{1,63}$/;

/**
 * What arrived in the ATYP 0x03 name field. `2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1`, `::1` and
 * `[::1]` are spellings of an address, not names, and recognising them costs no DNS — so they return a
 * `Verdict` and go through the same ranges as a literal that arrived under ATYP 0x01 or 0x04.
 * `"name"` is a name, which this server still never resolves (see the header). `"bad"` is neither, and
 * is refused rather than handed to the workbench as a name. Enforced by the ATYP 0x03 cases in
 * `test/browser-socks.test.ts`; which spellings of an address exist is not something this file can
 * assert it has enumerated.
 */
function classifyName(raw: string): Verdict | "name" | "bad" {
  const s = raw.toLowerCase();
  const inner = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s.includes(":") ? s : null;
  if (inner !== null) {
    const v6 = ipv6FromText(inner);
    return v6 ? fromIPv6(v6) : "bad";
  }

  const labels = s.split(".");
  if (labels.length > 1 && labels[labels.length - 1] === "") labels.pop(); // a name's one trailing dot
  const last = labels[labels.length - 1];
  if (last === undefined || !NUMERIC_PART.test(last)) {
    return labels.length > 0 && s.length <= 253 && labels.every((l) => NAME_LABEL.test(l)) ? "name" : "bad";
  }
  if (labels.length > 4) return "bad";
  const parts: number[] = [];
  for (const l of labels) {
    const n = ipv4Part(l);
    if (n === null) return "bad";
    parts.push(n);
  }
  // inet_aton: every part but the last is one byte, and the last absorbs the bytes nobody named.
  const tail = parts.pop()!;
  if (parts.some((n) => n > 255) || tail >= 256 ** (4 - parts.length)) return "bad";
  const v = parts.reduce((acc, n, i) => acc + n * 256 ** (3 - i), tail);
  return fromIPv4(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

export type SocksProxy = {
  /** The ephemeral loopback port 2.4 puts in `--proxy-server=socks5://127.0.0.1:<port>`. */
  readonly port: number;
  stop(): void;
};

export type SocksOptions = {
  /** Allocates the even stream id and sends OPEN; this module never picks an id. */
  open: StreamOpener;
  /** Raw `--allow-origin` values. Empty is the default: any public host on 80/443. */
  allowOrigins?: string[];
  /** A9's 30 s wait for the stream's ACK, injectable so a test need not wait it out. */
  ackMs?: number;
};

type Conn = {
  phase: "greeting" | "request" | "connecting" | "open" | "dead";
  /** Client bytes not yet parsed, or held until the success reply lets them go to the stream. */
  buf: Uint8Array;
  stream: Stream | null;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Stream bytes the client socket has not taken: held until the ACK puts the success reply on the
   * wire ahead of them, or left over from a partial write and sent again from `drain`. A chunk list,
   * concatenated once when it goes out, and capped at `MAX_PENDING` by `pendingBytes`.
   */
  pending: Uint8Array[];
  /** `pending`'s total length, kept beside it so the cap costs no walk of the list. */
  pendingBytes: number;
};

export function startSocksProxy(o: SocksOptions): SocksProxy {
  const allow = (o.allowOrigins ?? []).map(parseAllowOrigin);
  const ackMs = o.ackMs ?? ACK_MS;

  // Public by default on 80/443; any --allow-origin narrows that to exactly the listed set.
  const permitted = (host: string, port: number) =>
    allow.length
      ? allow.some((a) => a.host === host && (a.port === undefined ? DEFAULT_PORTS.has(port) : a.port === port))
      : DEFAULT_PORTS.has(port);

  const server = Bun.listen<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(sock) {
        sock.data = { phase: "greeting", buf: EMPTY, stream: null, timer: null, pending: [], pendingBytes: 0 };
      },
      data(sock, chunk) {
        const c = sock.data;
        if (c.phase === "dead") return;
        if (c.phase === "open") return void c.stream!.write(chunk);
        c.buf = c.buf.length ? concat(c.buf, chunk) : chunk;
        if (c.phase === "greeting" && !greet(sock)) return;
        if (c.phase === "request") request(sock);
      },
      drain(sock) {
        // Only once the success reply has gone out: while `connecting`, `pending` is holding stream
        // bytes that must not reach the browser ahead of it.
        if (sock.data.phase === "open" && sock.data.pending.length) toClient(sock, EMPTY);
      },
      close(sock) {
        kill(sock);
      },
      error(sock) {
        kill(sock);
      },
    },
  });

  type Sock = Socket<Conn>;

  function kill(sock: Sock) {
    const c = sock.data;
    if (c.phase === "dead") return;
    c.phase = "dead";
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    c.stream?.close();
    sock.end();
  }

  /** A reply the client will not be able to act on, so the connection ends with it. */
  function refuse(sock: Sock, rep: number) {
    sock.write(reply(rep));
    kill(sock);
  }

  /** Stream bytes to the browser. `write` can take fewer bytes than offered; the rest waits for `drain`. */
  function toClient(sock: Sock, bytes: Uint8Array) {
    const c = sock.data;
    if (c.phase === "dead") return;
    if (bytes.length) {
      c.pending.push(bytes);
      c.pendingBytes += bytes.length;
    }
    if (!c.pendingBytes) return;
    const out = concatAll(c.pending, c.pendingBytes);
    const n = sock.write(out);
    if (n >= out.length) {
      c.pending = [];
      c.pendingBytes = 0;
      return;
    }
    c.pending = [new Uint8Array(out.subarray(n))];
    c.pendingBytes = out.length - n;
    if (c.pendingBytes > MAX_PENDING) kill(sock); // the browser socket is not keeping up
  }

  /** `[VER][NMETHODS][METHODS…]`. A9: no authentication method but 0x00. */
  function greet(sock: Sock): boolean {
    const c = sock.data;
    const b = c.buf;
    if (b.length < 2) return false;
    if (b[0] !== VERSION) return (kill(sock), false);
    const n = b[1]!;
    if (b.length < 2 + n) return false;
    if (!b.subarray(2, 2 + n).includes(0x00)) {
      sock.write(new Uint8Array([VERSION, NO_ACCEPTABLE_METHODS]));
      return (kill(sock), false);
    }
    sock.write(new Uint8Array([VERSION, 0x00]));
    c.buf = b.subarray(2 + n);
    c.phase = "request";
    return true;
  }

  /** `[VER][CMD][RSV][ATYP][ADDR][PORT u16 BE]`. */
  function request(sock: Sock) {
    const c = sock.data;
    const b = c.buf;
    if (b.length < 5) return;
    if (b[0] !== VERSION) return kill(sock);
    const atyp = b[3]!;
    const addrLen = atyp === ATYP_IPV4 ? 4 : atyp === ATYP_NAME ? 1 + b[4]! : atyp === ATYP_IPV6 ? 16 : 0;
    if (!addrLen) return refuse(sock, BAD_ATYP); // an ATYP we cannot even measure: the rest is unparseable
    const size = 4 + addrLen + 2;
    if (b.length < size) return;
    const port = (b[size - 2]! << 8) | b[size - 1]!;
    c.buf = b.subarray(size);
    // A9: CONNECT only. BIND and UDP ASSOCIATE are refused here, before any address rule and with no
    // stream opened.
    if (b[1] !== CONNECT) return refuse(sock, BAD_COMMAND);

    let host: string;
    let denied: boolean;
    if (atyp === ATYP_IPV4) {
      ({ host, denied } = fromIPv4(b[4]!, b[5]!, b[6]!, b[7]!));
    } else if (atyp === ATYP_IPV6) {
      ({ host, denied } = fromIPv6(b.subarray(4, 20)));
    } else {
      const raw = DEC.decode(b.subarray(5, 4 + addrLen));
      const what = classifyName(raw);
      if (what === "bad") return refuse(sock, NOT_ALLOWED);
      if (what === "name") {
        host = raw.toLowerCase(); // the name as sent; never resolved
        denied = false;
      } else {
        ({ host, denied } = what); // an address literal that merely arrived wearing ATYP 0x03
      }
    }

    if (denied || !permitted(host, port)) return refuse(sock, NOT_ALLOWED);
    dial(sock, `tcp:${host.includes(":") ? `[${host}]` : host}:${port}`);
  }

  function dial(sock: Sock, target: string) {
    const c = sock.data;
    c.phase = "connecting";
    const stream = o.open(target);
    c.stream = stream;
    // The success reply keys on the stream's ACK (§4 op 3), which the workbench sends when its dial
    // succeeds.
    //
    // It keyed on the stream's FIRST BYTE until unit 2.3 MEASURED what that does: a TCP connect
    // produces no byte, so no 0x00 went out, so the browser never sent its request, so the server
    // never spoke — every client-speaks-first protocol, which is all of HTTP and HTTPS. Driven with a
    // faithful workbench that really dialled example.com:80 and pumped both ways, real Chromium
    // failed every page with ERR_SOCKS_CONNECTION_FAILED. The 0x04 answers below are unchanged: an
    // ACK that never comes is the same "never answered" as a byte that never came.
    stream.onAck = () => {
      if (c.phase !== "connecting") return;
      if (c.timer) clearTimeout(c.timer);
      c.timer = null;
      c.phase = "open";
      sock.write(reply(SUCCESS));
      // The browser's own request bytes, held since the CONNECT, go to the stream now...
      if (c.buf.length) {
        stream.write(c.buf);
        c.buf = EMPTY;
      }
      // ...and anything the far end sent before its ACK reached us goes to the browser, behind the reply.
      if (c.pending.length) toClient(sock, EMPTY);
    };
    stream.onData = (bytes) => {
      // Stream bytes before the ACK cannot go out: they would land in front of the success reply.
      // Held for `onAck` to flush. Nothing in §4 stops the workbench sending DATA before its ACK, and
      // nothing stops it sending more than the browser ever asked for — past `MAX_PENDING` the stream
      // gets the same 0x04 as the other two ways it can fail to answer.
      if (c.phase !== "connecting") return toClient(sock, bytes);
      c.pending.push(bytes);
      c.pendingBytes += bytes.length;
      if (c.pendingBytes > MAX_PENDING) refuse(sock, UNREACHABLE);
    };
    // A5: the relay calls these when its own send queue is over the threshold, so the browser gets TCP
    // backpressure instead of this process buffering the page it is uploading.
    stream.pause = () => {
      if (c.phase !== "dead") sock.pause();
    };
    stream.resume = () => {
      if (c.phase !== "dead") sock.resume();
    };
    // CLOSE before the ACK is the same "never answered" case as the timeout — the workbench refusing
    // the target under §6.3 looks exactly like this — so it gets the same 0x04.
    stream.onClose = () => (c.phase === "connecting" ? refuse(sock, UNREACHABLE) : kill(sock));
    c.timer = setTimeout(() => {
      if (c.phase === "connecting") refuse(sock, UNREACHABLE);
    }, ackMs);
    c.timer.unref?.(); // A11: a pending timer must not be what keeps the process alive
  }

  return { port: server.port, stop: () => server.stop(true) };
}
