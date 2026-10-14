import { afterEach, describe, expect, test } from "bun:test";
import { ACK, encodeFrame, type Stream, type StreamOpener } from "../src/browser-frame";
import { createRelay, type RelayHandlers } from "../src/browser-relay";
import { parseAllowOrigin, startSocksProxy, type SocksOptions, type SocksProxy } from "../src/browser-socks";
import { CliError, type Io } from "../src/core";

// Driven over a real loopback socket against the real Bun.listen server, with the stream opener
// injected as a spy: nothing here fakes the protocol, so a parser that mis-reads a byte fails.
const ENC = new TextEncoder();
const u8 = (...n: number[]) => new Uint8Array(n);
const NO_AUTH = [0x05, 0x01, 0x00];
const REPLY = (rep: number) => u8(0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0);

/** The even-id `tcp:` stream the proxy opened, and what it did with it. */
type Opened = { target: string; written: Uint8Array[]; closed: boolean; stream: Stream };

function spy() {
  const opened: Opened[] = [];
  const waiting: ((o: Opened) => void)[] = [];
  let read = 0;
  // The real opener sends CLOSE and never calls `onClose` back on its own caller, so neither does this.
  const open: StreamOpener = (target) => {
    const stream: Stream = { write: () => {}, close: () => {} };
    const rec: Opened = { target, written: [], closed: false, stream };
    stream.write = (b) => void rec.written.push(new Uint8Array(b));
    stream.close = () => void (rec.closed = true);
    opened.push(rec);
    const next = waiting.shift();
    if (next) {
      read++;
      next(rec);
    }
    return stream;
  };
  return {
    opened,
    open,
    /** The next stream the proxy opens that this has not already returned. */
    next: () => (read < opened.length ? Promise.resolve(opened[read++]!) : new Promise<Opened>((r) => void waiting.push(r))),
  };
}

type Client = {
  send: (bytes: number[] | Uint8Array) => void;
  read: (n: number) => Promise<Uint8Array>;
  /** Stops taking bytes off the socket, which is how a slow browser is driven here. */
  pause: () => void;
  end: () => void;
};

const until = async (p: () => boolean) => {
  for (let i = 0; i < 500 && !p(); i++) await Bun.sleep(1);
  expect(p()).toBe(true);
};

const started: SocksProxy[] = [];
const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.end();
  for (const p of started.splice(0)) p.stop();
});

function proxy(opts: Omit<SocksOptions, "open"> = {}) {
  const s = spy();
  const p = startSocksProxy({ open: s.open, ...opts });
  started.push(p);
  return { ...s, port: p.port };
}

async function connect(port: number): Promise<Client> {
  const buf: number[] = [];
  let want: { n: number; resolve: (b: Uint8Array) => void } | null = null;
  const pump = () => {
    if (want && buf.length >= want.n) {
      const { n, resolve } = want;
      want = null;
      resolve(new Uint8Array(buf.splice(0, n)));
    }
  };
  const sock = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, d) {
        for (const b of d) buf.push(b);
        pump();
      },
      error() {},
      close() {},
    },
  });
  const client: Client = {
    send: (bytes) => void sock.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
    read: (n) => new Promise<Uint8Array>((resolve) => ((want = { n, resolve }), pump())),
    pause: () => sock.pause(),
    end: () => sock.end(),
  };
  clients.push(client);
  return client;
}

/** Connects and completes the method negotiation, leaving the socket ready for one request. */
async function greeted(port: number): Promise<Client> {
  const c = await connect(port);
  c.send(NO_AUTH);
  expect(await c.read(2)).toEqual(u8(0x05, 0x00));
  return c;
}

const CONNECT = 0x01;
const BIND = 0x02;
const UDP = 0x03;
const request = (cmd: number, atyp: number, addr: number[], port: number) => [0x05, cmd, 0x00, atyp, ...addr, port >> 8, port & 0xff];
const name = (host: string, port: number, cmd = CONNECT) => request(cmd, 0x03, [host.length, ...ENC.encode(host)], port);
const ipv4 = (dotted: string, port: number, cmd = CONNECT) => request(cmd, 0x01, dotted.split(".").map(Number), port);
/** Sixteen bytes from colon groups: `v6("fdaa::1")`. */
const ipv6 = (addr: string, port: number, cmd = CONNECT) => request(cmd, 0x04, v6bytes(addr), port);
/** `::ffff:a.b.c.d`, the spelling that must be normalised to IPv4 before the ranges are applied. */
const mapped = (dotted: string, port: number) =>
  request(CONNECT, 0x04, [...new Array<number>(10).fill(0), 0xff, 0xff, ...dotted.split(".").map(Number)], port);

function v6bytes(addr: string): number[] {
  const [head, tail] = addr.split("::") as [string, string | undefined];
  const groups = (s: string) => (s ? s.split(":") : []);
  const h = groups(head);
  const t = groups(tail ?? "");
  const full = [...h, ...new Array<string>(8 - h.length - t.length).fill("0"), ...t];
  return full.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

describe("A9 method negotiation", () => {
  test("accepts the no-auth method and nothing else", async () => {
    const p = proxy();
    const c = await connect(p.port);
    c.send([0x05, 0x02, 0x01, 0x02]); // GSSAPI and username/password only
    expect(await c.read(2)).toEqual(u8(0x05, 0xff));
    expect(p.opened).toEqual([]);
  });
});

describe("A9 refusals", () => {
  // Every case asserts the reply byte AND that no stream was opened. `allow` empty is the default:
  // any public host on 80/443.
  const cases: [string, number[], string[], number][] = [
    ["a host off the list", name("evil.example", 443), ["app.example.com"], 0x02],
    ["a disallowed port on an allowed host", name("app.example.com", 8080), ["app.example.com"], 0x02],
    ["a non-default port with no list at all", name("example.com", 8080), [], 0x02],
    ["an allowed host on a port the list did not name", name("app.example.com", 443), ["app.example.com:8443"], 0x02],
    ["a private IPv4 literal, list or no list", ipv4("10.0.0.5", 443), ["10.0.0.5"], 0x02],
    ["an IPv4-mapped IPv6 spelling of loopback", mapped("127.0.0.1", 443), [], 0x02],
    ["an IPv4-mapped IPv6 spelling of a private range", mapped("192.168.1.10", 80), [], 0x02],
    ["IPv6 loopback ::1", ipv6("::1", 443), [], 0x02],
    ["the unspecified address ::", ipv6("::", 443), [], 0x02],
    ["fdaa::/16, Fly's internal network inside fc00::/7", ipv6("fdaa:0:1::2", 443), [], 0x02],
    ["IPv6 link-local fe80::/10", ipv6("fe80::1", 443), [], 0x02],
    ["a BIND command", name("app.example.com", 443, BIND), ["app.example.com"], 0x07],
    ["a UDP ASSOCIATE command", name("app.example.com", 443, UDP), ["app.example.com"], 0x07],
    ["an address type that is not IPv4, IPv6 or a name", request(CONNECT, 0x09, [1, 2, 3, 4], 443), [], 0x08],
  ];

  for (const [what, req, allowOrigins, rep] of cases) {
    test(`refuses ${what} with 0x0${rep.toString(16)} and opens no stream`, async () => {
      const p = proxy({ allowOrigins });
      const c = await greeted(p.port);
      c.send(req);
      expect(await c.read(10)).toEqual(REPLY(rep));
      expect(p.opened).toEqual([]);
    });
  }

  test("refuses every Assumption 8 IPv4 range on an otherwise allowed port", async () => {
    const p = proxy();
    const refused = [
      "0.0.0.1", "10.1.2.3", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.255.254", "192.168.1.1",
      "100.64.0.1", "100.127.255.255", "192.0.2.5", "224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255",
    ];
    for (const address of refused) {
      const c = await greeted(p.port);
      c.send(ipv4(address, 443));
      expect([address, await c.read(10)]).toEqual([address, REPLY(0x02)]);
    }
    expect(p.opened).toEqual([]);
  });
});

// Chromium sends every host as ATYP 0x03 (the header's measurement), so the name field is the field an
// attacker holding the companion token reaches for. A numeric spelling there is an address literal
// wearing the name type, not the DNS uncertainty the header accepts, and every one of these opened an
// allowed `tcp:` stream on a default port before this round.
describe("A9 an address literal in the ATYP 0x03 name field", () => {
  const refused: [string, string, string[]][] = [
    ["dotted-quad loopback", "127.0.0.1", []],
    ["dotted-quad loopback even when the list names it", "127.0.0.1", ["127.0.0.1"]],
    ["the cloud metadata address", "169.254.169.254", []],
    ["a bare decimal literal", "2130706433", []],
    ["an octal literal", "0177.0.0.1", []],
    ["a hex literal with a short tail", "0x7f.1", []],
    ["a wholly hex literal", "0x7f000001", []],
    ["the two-part short form", "127.1", []],
    ["a private range in dotted-quad", "10.0.0.5", []],
    ["a bare IPv6 loopback literal", "::1", []],
    ["a bracketed IPv6 loopback literal", "[::1]", []],
    ["an IPv4-mapped IPv6 spelling of loopback", "::ffff:127.0.0.1", []],
    ["an IPv4-mapped IPv6 spelling of a private range", "::ffff:192.168.1.10", []],
    ["fdaa::/16, Fly's internal network", "fdaa:0:1::2", []],
    ["the unspecified address", "::", []],
  ];

  // Not an address and not a hostname either: refused rather than handed on as a name.
  const malformed: [string, string][] = [
    ["a value carrying a path", "example.com/evil"],
    ["a value carrying userinfo", "user@example.com"],
    ["an out-of-range dotted-quad", "256.0.0.1"],
    ["five dotted parts", "1.2.3.4.5"],
    ["a truncated hex literal", "0x"],
    ["an octal part with a non-octal digit", "0199.0.0.1"],
    ["an unterminated bracket", "[::1"],
    ["a name with whitespace in it", "exa mple.com"],
    ["an empty name", ""],
  ];

  for (const [what, host, allowOrigins] of [...refused, ...malformed.map(([w, h]) => [w, h, []] as [string, string, string[]])]) {
    test(`refuses ${what} with 0x02 and opens no stream`, async () => {
      const p = proxy({ allowOrigins });
      const c = await greeted(p.port);
      c.send(name(host, 443));
      expect(await c.read(10)).toEqual(REPLY(0x02));
      expect(p.opened).toEqual([]);
    });
  }
});

describe("A9 allowed CONNECTs", () => {
  // The target carries the name or literal exactly as matched; an IPv6 literal is bracketed so
  // `tcp:<host>:<port>` stays parseable at the workbench end.
  const cases: [string, number[], string[], string][] = [
    ["any public host on 443 by default", name("example.com", 443), [], "tcp:example.com:443"],
    ["any public host on 80 by default", name("example.com", 80), [], "tcp:example.com:80"],
    ["a host the list names", name("app.example.com", 443), ["app.example.com", "cdn.example.com"], "tcp:app.example.com:443"],
    ["the explicit port the list names", name("app.example.com", 8443), ["app.example.com:8443"], "tcp:app.example.com:8443"],
    ["a public IPv4 literal", ipv4("93.184.216.34", 80), [], "tcp:93.184.216.34:80"],
    ["an address just outside 172.16/12", ipv4("172.32.0.1", 443), [], "tcp:172.32.0.1:443"],
    ["an address just outside 100.64/10", ipv4("100.63.255.255", 443), [], "tcp:100.63.255.255:443"],
    ["a public IPv6 literal, bracketed in the target", ipv6("2606:4700::1111", 443), [], "tcp:[2606:4700::1111]:443"],
    // A literal the ranges do not refuse is still allowed when it arrives in the name field, and
    // reaches the workbench in the same canonical spelling an ATYP 0x01/0x04 request would.
    ["a public IPv4 literal sent as a name", name("93.184.216.34", 80), [], "tcp:93.184.216.34:80"],
    ["a public IPv6 literal sent as a bracketed name", name("[2606:4700::1111]", 443), [], "tcp:[2606:4700::1111]:443"],
    ["a public IPv4 literal in its short form", name("93.184.55330", 80), [], "tcp:93.184.216.34:80"],
  ];

  for (const [what, req, allowOrigins, target] of cases) {
    test(`opens one ${what}`, async () => {
      const p = proxy({ allowOrigins });
      const c = await greeted(p.port);
      c.send(req);
      expect((await p.next()).target).toBe(target);
      expect(p.opened.length).toBe(1);
    });
  }

  test("parses a greeting and request that arrive one byte at a time", async () => {
    const p = proxy();
    const c = await connect(p.port);
    for (const b of NO_AUTH) c.send([b]);
    expect(await c.read(2)).toEqual(u8(0x05, 0x00));
    for (const b of name("example.com", 443)) c.send([b]);
    expect((await p.next()).target).toBe("tcp:example.com:443");
  });
});

describe("A9 the stream", () => {
  // THE DEADLOCK TEST. Keying the reply on the stream's first byte passed every test in this file
  // and could not load one page: unit 2.3 measured real Chromium failing with
  // ERR_SOCKS_CONNECTION_FAILED, because a TCP connect produces no byte and the browser will not
  // send its request before the reply. So this asserts that NOTHING flowed on the stream before the
  // 0x00 went out — an implementation that waits for a byte cannot pass it.
  test("answers 0x00 on the ACK alone, with no stream bytes at all, and only then passes the request", async () => {
    const p = proxy();
    const c = await greeted(p.port);
    c.send(name("example.com", 443));
    const s = await p.next();

    // The browser's request is already here, and is held: there is no success reply on the wire yet.
    c.send([0x47, 0x45, 0x54]);
    await Bun.sleep(5);
    expect(s.written).toEqual([]);

    s.stream.onAck!();
    expect(await c.read(10)).toEqual(REPLY(0x00));
    await Bun.sleep(5);
    expect(s.written).toEqual([u8(0x47, 0x45, 0x54)]);

    // And bytes pump both ways from there.
    s.stream.onData!(u8(0x16, 0x03, 0x01));
    expect(await c.read(3)).toEqual(u8(0x16, 0x03, 0x01));
    c.send([0x0d, 0x0a]);
    await Bun.sleep(5);
    expect(s.written).toEqual([u8(0x47, 0x45, 0x54), u8(0x0d, 0x0a)]);
    expect(s.closed).toBe(false);
  });

  test("holds stream bytes that arrive before the ACK until the reply has gone out", async () => {
    const p = proxy();
    const c = await greeted(p.port);
    c.send(name("example.com", 443));
    const s = await p.next();

    s.stream.onData!(u8(0x16, 0x03, 0x01)); // §4 does not forbid the workbench sending DATA first
    s.stream.onAck!();
    expect(await c.read(13)).toEqual(new Uint8Array([...REPLY(0x00), 0x16, 0x03, 0x01]));
  });

  test("concatenates several pre-ACK chunks once, in order, behind the reply", async () => {
    const p = proxy();
    const c = await greeted(p.port);
    c.send(name("example.com", 443));
    const s = await p.next();

    s.stream.onData!(u8(0x16, 0x03));
    s.stream.onData!(u8(0x01));
    s.stream.onData!(u8(0x02, 0x03));
    s.stream.onAck!();
    expect(await c.read(15)).toEqual(new Uint8Array([...REPLY(0x00), 0x16, 0x03, 0x01, 0x02, 0x03]));
  });

  // The remote side is whatever holds the org's companion token, and it can send DATA the browser never
  // asked for. Both windows are driven: before the ACK, where nothing can go out at all, and after it,
  // where a browser that stops reading is the same unbounded queue.
  test("answers 0x04 and closes a stream that floods DATA past the cap before its ACK", async () => {
    const p = proxy({ ackMs: 10_000 });
    const c = await greeted(p.port);
    c.send(name("example.com", 443));
    const s = await p.next();

    const chunk = new Uint8Array(256 * 1024);
    for (let i = 0; i < 8 && !s.closed; i++) s.stream.onData!(chunk);
    await until(() => s.closed);
    expect(await c.read(10)).toEqual(REPLY(0x04));
  });

  test("closes an open stream when the browser socket stops taking the bytes", async () => {
    const p = proxy();
    const c = await greeted(p.port);
    c.send(name("example.com", 443));
    const s = await p.next();
    s.stream.onAck!();
    expect(await c.read(10)).toEqual(REPLY(0x00));

    c.pause(); // a browser that has stopped reading; the kernel buffers fill and `write` goes partial
    const chunk = new Uint8Array(256 * 1024);
    for (let i = 0; i < 256 && !s.closed; i++) s.stream.onData!(chunk);
    await until(() => s.closed);
  });

  test("answers 0x04 and closes the stream when no ACK arrives in time", async () => {
    const p = proxy({ ackMs: 20 });
    const c = await greeted(p.port);
    c.send(name("example.com", 443));
    const s = await p.next();
    expect(await c.read(10)).toEqual(REPLY(0x04));
    expect(s.closed).toBe(true);
  });

  test("answers 0x04 when the stream closes before its ACK", async () => {
    const p = proxy();
    const c = await greeted(p.port);
    c.send(name("example.com", 443));
    const s = await p.next();
    s.stream.onClose!();
    expect(await c.read(10)).toEqual(REPLY(0x04));
  });

  test("closes the stream when the browser hangs up", async () => {
    const p = proxy();
    const c = await greeted(p.port);
    c.send(name("example.com", 443));
    const s = await p.next();
    c.end();
    await Bun.sleep(10);
    expect(s.closed).toBe(true);
  });
});

describe("A9 --allow-origin parsing", () => {
  test("takes HOST, HOST:PORT, a bracketed v6 and an IDN", () => {
    expect(parseAllowOrigin("App.Example.COM")).toEqual({ host: "app.example.com", port: undefined });
    expect(parseAllowOrigin("app.example.com:8443")).toEqual({ host: "app.example.com", port: 8443 });
    expect(parseAllowOrigin("[2001:db8::1]:443")).toEqual({ host: "2001:db8::1", port: 443 });
    expect(parseAllowOrigin("café.example")).toEqual({ host: "xn--caf-dma.example", port: undefined }); // Chromium sends the A-label
  });

  test("reads a bare IPv6 literal as a host, not a host with a port, and canonicalises it", () => {
    expect(parseAllowOrigin("2001:0db8:0000:0000:0000:0000:0000:0001")).toEqual({ host: "2001:db8::1", port: undefined });
  });

  test("refuses a malformed origin as a usage error", () => {
    const bads = [
      "", "app.example.com:0", "app.example.com:99999", "app.example.com:http", "[::1", "a b.example",
      // HOST[:PORT] and nothing else: a value carrying URL syntax is not silently reduced to its host.
      "example.com/path", "example.com/", "http://example.com", "user@example.com", "user:pass@example.com",
      "example.com?q=1", "example.com#frag", "example.com:443/x", "%65xample.com", "exam\tple.com",
    ];
    for (const bad of bads) {
      let e: unknown;
      try {
        parseAllowOrigin(bad);
      } catch (err) {
        e = err;
      }
      expect([bad, e instanceof CliError && e.exit]).toEqual([bad, 1]);
    }
  });
});

// A5's pause/resume, end to end. The `Stream` seam is the only path the relay's backpressure has to
// a browser socket: unit 2.3 reported that with write/close/onData/onClose alone, `onBackpressure`
// fired and this server went on reading. Driven with the REAL relay client over a fake WebSocket
// whose `bufferedAmount` the test sets, against a real loopback socket — a callback that fires
// without reaching `sock.pause()` cannot pass this.
test("a backed-up relay pauses the real browser socket, and the bytes flow again once it drains", async () => {
  const PAUSE_ABOVE = 4 * 1024 * 1024; // the relay's own threshold, duplicated so a change is deliberate
  let buffered = 0;
  const sent: Uint8Array[] = [];
  let peer!: RelayHandlers;
  let up = false;
  const io: Io = {
    env: {},
    home: "/nonexistent",
    stdin: async () => "",
    out: () => {},
    err: () => {},
    sleep: async () => void (await Bun.sleep(0)), // the drain poll, without the 50 ms wait
  };
  const ac = new AbortController();
  const r = createRelay(io, "http://127.0.0.1:3111", { machine_id: "bm_0123456789abcdef", name: "laptop", token: "obm_t" }, {
    onCdpStream: () => {},
    onEvent: (e) => void (e.state === "online" && (up = true)),
    signal: ac.signal,
    connect: (_url, _headers, h) => {
      peer = h;
      queueMicrotask(() => h.open()); // as Bun's own client does: never from inside the constructor
      return {
        get bufferedAmount() {
          return buffered;
        },
        send: (b) => void sent.push(b),
        close: () => {},
      };
    },
  });
  const run = r.run();

  try {
    await until(() => up);
    const p = startSocksProxy({ open: r.open, ackMs: 10_000 });
    started.push(p);
    const c = await greeted(p.port);
    c.send(name("example.com", 443));
    await until(() => sent.length === 1); // the OPEN frame, on the first even id
    peer.message(encodeFrame(2, ACK));
    expect(await c.read(10)).toEqual(REPLY(0x00));

    const kib = new Uint8Array(1024).fill(7);
    buffered = PAUSE_ABOVE + 1;
    c.send(kib); // the write the relay notices its queue on, and pauses this socket for
    await Bun.sleep(50);
    // Whether that write goes out before the pause or waits with the queue is the relay's business, so
    // this reads the count rather than naming it: measured 2 when the relay sent it, 1 once it held it.
    const stalled = sent.length;

    for (let i = 0; i < 64; i++) c.send(kib);
    await Bun.sleep(50);
    expect(sent.length).toBe(stalled); // 64 KiB into a paused socket reached the relay as nothing

    buffered = 0;
    await until(() => sent.length > stalled);
  } finally {
    ac.abort();
    await run;
  }
});

test("listens on an ephemeral loopback port, so 2.4 can build --proxy-server=socks5://127.0.0.1:<port>", async () => {
  const p = proxy();
  expect(p.port).toBeGreaterThan(0);
  const c = await connect(p.port); // reachable on loopback, which is the only address it binds
  expect(c).toBeTruthy();
});
