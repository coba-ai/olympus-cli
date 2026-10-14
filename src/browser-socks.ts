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
// resolved to compare against the address rules below. The consequence, stated rather than hidden: a
// name that resolves to a private or loopback address at the far end is NOT caught here, and nothing
// in this file could catch it. The workbench-side allowlist on the resolved address (§6.3) is what
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

// [VER][REP][RSV][ATYP IPv4][BND.ADDR 0.0.0.0][BND.PORT 0]. The bound address means nothing for a
// CONNECT that is really a tunnel; Chromium accepted this exact shape in the probe above.
const reply = (rep: number) => new Uint8Array([VERSION, rep, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** One `--allow-origin` entry. `port` unset means the two default ports, not every port. */
export type AllowOrigin = { host: string; port?: number };

/**
 * `HOST`, `HOST:PORT`, `[v6]` or `[v6]:PORT`. A bare IPv6 literal is several colons with no brackets,
 * so `2001:db8::1` is a host and not a host with port 1. Hosts go through `new URL`, which lowercases,
 * punycodes an IDN (Chromium sends the A-label, so `café.example` would otherwise never match) and
 * canonicalises an IPv6 literal (so `2001:db8::1` and its expanded spelling are the same entry).
 */
export function parseAllowOrigin(raw: string): AllowOrigin {
  const s = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  let host = s;
  let port: string | undefined;
  if (bracketed) {
    host = bracketed[1]!;
    port = bracketed[2];
  } else if (s.includes(":") && s.indexOf(":") === s.lastIndexOf(":")) {
    host = s.slice(0, s.lastIndexOf(":"));
    port = s.slice(s.lastIndexOf(":") + 1);
  }
  const bad = () => usage(`invalid --allow-origin "${raw}"; expected HOST, HOST:PORT or [v6]:PORT`);
  const n = port === undefined ? undefined : Number(port);
  if (n !== undefined && !(Number.isInteger(n) && n >= 1 && n <= 65535)) throw bad();
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
   * wire ahead of them, or left over from a partial write and sent again from `drain`.
   */
  pending: Uint8Array;
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
        sock.data = { phase: "greeting", buf: EMPTY, stream: null, timer: null, pending: EMPTY };
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
    const out = c.pending.length ? concat(c.pending, bytes) : bytes;
    const n = sock.write(out);
    c.pending = n >= out.length ? EMPTY : new Uint8Array(out.subarray(n));
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
      const [w, x, y, z] = [b[4]!, b[5]!, b[6]!, b[7]!];
      host = `${w}.${x}.${y}.${z}`;
      denied = privateIPv4(w, x, y);
    } else if (atyp === ATYP_IPV6) {
      const v6 = b.subarray(4, 20);
      if (ipv4Mapped(v6)) {
        const [w, x, y, z] = [v6[12]!, v6[13]!, v6[14]!, v6[15]!];
        host = `${w}.${x}.${y}.${z}`; // normalised to its IPv4 form before the ranges are applied
        denied = privateIPv4(w, x, y);
      } else {
        const groups: string[] = [];
        for (let i = 0; i < 16; i += 2) groups.push((((v6[i]! << 8) | v6[i + 1]!) >>> 0).toString(16));
        host = new URL(`http://[${groups.join(":")}]/`).hostname.slice(1, -1); // canonical, so it matches an --allow-origin entry
        denied = privateIPv6(v6);
      }
    } else {
      host = DEC.decode(b.subarray(5, 4 + addrLen)).toLowerCase(); // the name as sent; never resolved
      denied = false;
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
      // Held for `onAck` to flush. Nothing in §4 stops the workbench sending DATA before its ACK.
      if (c.phase === "connecting") c.pending = c.pending.length ? concat(c.pending, bytes) : bytes;
      else toClient(sock, bytes);
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
