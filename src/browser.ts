// `olympus browser attach [CODE]` — the command, and nothing else: every part it wires together is
// built and tested in its own module (the pair call and token file, the relay client and its
// reconnect policy, the CDP filter, the SOCKS proxy, the Chromium launcher).
//
// The order here is the contract between those parts:
//   1. the SOCKS proxy listens FIRST, because its port is one of Chromium's flags;
//   2. Chromium launches on the FIRST ACCEPTED `cdp` stream, never on attach (PLAN Assumption 7) —
//      until the Rafita workbench bridge exists nothing opens one, so a healthy attach sits there
//      with no browser window, which is the feature working, not a stall;
//   3. each accepted `cdp` stream gets its OWN connection to Chromium and its OWN filter.
import { cdpFilter } from "./browser-cdp";
import { discoverChrome, launchChrome, type Chrome, type ChromeProcess } from "./browser-chrome";
import { createRelay, type CdpChannel, type RelayConnect, type RelayEvent } from "./browser-relay";
import { parseAllowOrigin, startSocksProxy } from "./browser-socks";
import { pairBrowser, readBrowserMachine, type BrowserMachine } from "./browser-store";
import { CliError, fail, usage, type Io } from "./core";
import { clean } from "./format";
import { checkFlags } from "./tasks";

/** One CDP connection to the launched Chromium. `onMessage`/`onClose` are set by the caller after it resolves. */
export type CdpSocket = {
  send: (message: string) => void;
  close: () => void;
  onMessage?: (message: string) => void;
  onClose?: () => void;
};

/** Everything that would otherwise reach the network or a real browser, so no test reaches either. */
export type AttachSeams = {
  connect?: RelayConnect;
  spawn?: (argv: string[]) => ChromeProcess;
  mkProfile?: () => Promise<string>;
  connectCdp?: (port: number) => Promise<CdpSocket>;
  jitter?: () => number;
  ackMs?: number;
};

const chromeFailed = (message: string) => new CliError(5, { error: { code: "chrome_failed", message } });

/**
 * CDP messages one stream's FILTER may buffer while Chromium starts — its own setup commands, not the
 * workbench's, which the filter refuses until that setup succeeds. Past it the stream is closed.
 */
const QUEUE_MAX = 256;

/**
 * The BROWSER-level CDP endpoint, read from `/json/version` — never a page's. A page endpoint has no
 * sessions at all, and the filter forwards a page command only on a flattened sessionId it watched
 * attach to a page target (`browser-cdp.ts`'s "needs a flattened page session"), so on a page
 * endpoint every command would be refused.
 */
export async function connectBrowserCdp(port: number): Promise<CdpSocket> {
  let url: unknown;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    url = ((await res.json()) as any)?.webSocketDebuggerUrl;
  } catch (e: any) {
    throw chromeFailed(`could not read the browser's debugging port: ${e?.message ?? "the request failed"}`);
  }
  if (typeof url !== "string") throw chromeFailed("the browser's debugging port reported no browser WebSocket url");
  const ws = new WebSocket(url);
  const sock: CdpSocket = { send: (m) => ws.send(m), close: () => ws.close() };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    // Before `open`, either of these is a connection that never happened; both are reassigned below.
    ws.onerror = () => reject(chromeFailed("the browser's debugging socket refused the connection"));
    ws.onclose = () => reject(chromeFailed("the browser's debugging socket closed before it opened"));
  });
  ws.onerror = () => {};
  ws.onclose = () => sock.onClose?.();
  // CDP is a text protocol; anything else is not a CDP message.
  ws.onmessage = (e) => {
    if (typeof e.data === "string") sock.onMessage?.(e.data);
  };
  return sock;
}

const spawnChrome = (argv: string[], env: Record<string, string>): ChromeProcess =>
  Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"], env });

export type BrowserPlan = (host: string, signal: AbortSignal, seams?: AttachSeams) => Promise<void>;

/** Validates the whole command line synchronously — before the pair request, which spends the code. */
export function browserPlan(pos: string[], v: Record<string, unknown>, io: Io, json: boolean): BrowserPlan {
  if (pos.length === 1) throw usage("browser needs a subcommand: browser attach [CODE]");
  if (pos[1] !== "attach") throw usage(`unknown browser command: ${pos.slice(1).join(" ")}`);
  if (pos.length > 3) throw usage(`expected at most 3 argument(s) in: ${pos.join(" ")}`);
  checkFlags(v, ["name", "allow-origin"], "browser attach");
  const code = pos[2];
  if (code !== undefined && !code.trim()) throw usage("browser attach needs a pairing code, or no argument at all to re-attach");
  const name = v.name as string | undefined;
  if (name !== undefined && code === undefined) throw usage("--name is read only when pairing; give the CODE from Settings → Rafita");
  const allowOrigins = (v["allow-origin"] as string[] | undefined) ?? [];
  // Parsed here and again by the proxy: a typo must not spend the pairing code before it is noticed.
  for (const o of allowOrigins) parseAllowOrigin(o);
  return (host, signal, seams = {}) => attach(io, json, { host, code, name, allowOrigins }, signal, seams);
}

type Attach = { host: string; code?: string; name?: string; allowOrigins: string[] };
/** A11/Assumption 11: one JSON object per line on stdout. Human status goes to stderr, short. Neither ever carries the obm_ token. */
type Line = (event: Record<string, unknown>) => void;
type Say = (s: string) => void;

/** The last `--json` line of every run, pair failures included, is the exit code the process will use. */
async function attach(io: Io, json: boolean, o: Attach, signal: AbortSignal, seams: AttachSeams): Promise<void> {
  const line: Line = (e) => void (json && io.out(JSON.stringify(e) + "\n"));
  try {
    await hold(io, line, (s) => void (!json && io.err(s + "\n")), o, signal, seams);
    line({ state: "exit", code: 0 });
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    // The reason is printed HERE, before the exit line, rather than by cli.ts's catch after it: a
    // consumer reading `--json` line by line would otherwise read the exit code before knowing why.
    // cli.ts's `browser` branch returns the exit code without calling fail() again, which is the only
    // thing keeping this from printing twice.
    fail(io, json, e);
    line({ state: "exit", code: e.exit });
    throw e;
  }
}

async function hold(io: Io, line: Line, say: Say, o: Attach, signal: AbortSignal, seams: AttachSeams): Promise<void> {
  // Before the pair request, because a computer with no browser cannot serve a workbench and the
  // member should hear that while the code is still unspent. This only LOOKS for the binary;
  // launching it is Assumption 7's job, below.
  discoverChrome(io);

  let machine: BrowserMachine;
  if (o.code !== undefined) {
    // Sent verbatim: the server normalises the code itself (`BrowserMachine.claim!` upcases and
    // strips non-letters), so a second normalisation here could only disagree with it.
    ({ machine } = await pairBrowser(io, o.host, { code: o.code, name: o.name }, signal));
    line({ state: "paired", machine_id: machine.machine_id, name: machine.name });
    say(`Paired this computer as ${clean(machine.name)}.`);
  } else {
    const stored = await readBrowserMachine(io, o.host);
    if (!stored)
      throw usage(`no paired computer for ${o.host}; get a pairing code from Settings → Rafita and run \`olympus browser attach CODE\``);
    machine = stored;
  }

  // Chromium's exit ends the command cleanly (Assumption 7); a failure we cannot carry on past ends
  // it with its own exit code. Both stop the relay through this, never by throwing into it.
  const ctl = new AbortController();
  const stopping = AbortSignal.any([signal, ctl.signal]);
  let failure: CliError | undefined;
  const stop = (e?: CliError) => {
    failure ??= e;
    ctl.abort();
  };

  let chrome: Promise<Chrome> | undefined;

  const relay = createRelay(io, o.host, machine, {
    onCdpStream,
    // A5: the pause that reaches a local socket is per-stream, inside the relay and the proxy. This
    // callback only says it happened, so `--json` shows a stall that is ours and not the network's.
    onBackpressure: (paused) => line({ state: "backpressure", paused }),
    onEvent: event,
    signal: stopping,
    jitter: seams.jitter,
    connect: seams.connect,
  });

  // Listening BEFORE Chromium is launched, because its port is one of Chromium's flags; `relay.open`
  // is live from here, and nothing opens a stream until `run()` below.
  const socks = startSocksProxy({ open: relay.open, allowOrigins: o.allowOrigins, ackMs: seams.ackMs });

  const launch = () =>
    (chrome ??= launchChrome(io, { socksPort: socks.port }, { spawn: seams.spawn ?? spawnChrome, mkProfile: seams.mkProfile }).then((c) => {
      void c.exited.then(() => stop());
      return c;
    }));

  function event(e: RelayEvent) {
    line(e);
    if (e.state === "online") say(`Attached to ${o.host} as ${clean(machine.name)}. No browser window until the workbench connects.`);
    else if (e.state === "stalled") say(e.message);
    else if (e.state === "backoff") say(`Not connected; retrying in ${Math.max(1, Math.round(e.ms / 1000))}s.`);
    else if (e.state === "stream" && e.target === "cdp") say("The workbench connected; starting the browser.");
  }

  function onCdpStream(cdp: CdpChannel) {
    // ONE filter per CDP connection. The filter holds the set of sessions it watched attach to a page
    // target, so two workbench streams sharing one would share that set.
    let sock: CdpSocket | undefined;
    const queued: string[] = [];
    let dropped = false;
    // Everything this stream still holds: the buffer, and the socket if it got one. Called on close and
    // on overflow, so neither leaves a queue behind.
    const drop = () => {
      dropped = true;
      queued.length = 0;
      sock?.close();
    };
    const filter = cdpFilter(
      (m) => {
        if (sock) return sock.send(m);
        if (dropped) return;
        // `queued` holds what the filter emits before Chromium's socket exists. At QUEUE_MAX the
        // stream is closed and the buffer dropped rather than grown; the workbench opens another when
        // it wants one. Nothing here measures how full it gets — this is a bound, not a tuning. The
        // relay's own per-stream caps are a different thing, in browser-relay.ts.
        if (queued.length >= QUEUE_MAX) {
          drop();
          return cdp.close();
        }
        queued.push(m);
      },
      (m) => cdp.send(m),
    );
    // Set on the tick the stream is handed over, as `CdpChannel` requires. A command arriving before
    // Chromium is up does NOT wait in `queued`: the filter answers it with a -32000 error back to the
    // workbench until the setup it emits on construction has succeeded, and with no browser socket yet
    // that setup is itself what `queued` is holding, so nothing can have answered it. Measured by
    // driving `cdpFilter` with no browser attached — browser-cdp.ts's gate is what does this, and
    // nothing in this file would stop a future filter from queueing instead.
    cdp.onMessage = filter.fromWorkbench;
    cdp.onClose = drop;
    void (async () => {
      try {
        const c = await launch();
        // The stream went away while Chromium was starting, so no connection is opened for it. Nothing
        // cancels a connectCdp already in flight; the check below closes the socket it resolves.
        if (dropped) return;
        const s = await (seams.connectCdp ?? connectBrowserCdp)(c.port);
        if (dropped) return s.close();
        s.onMessage = filter.fromBrowser;
        s.onClose = () => cdp.close();
        sock = s;
        for (const m of queued.splice(0)) s.send(m);
      } catch (e) {
        // There is no browser to serve this stream or any other, so the command ends rather than
        // holding a socket it cannot answer on.
        cdp.close();
        stop(e instanceof CliError ? e : chromeFailed(`could not start the browser: ${(e as Error)?.message ?? String(e)}`));
      }
    })();
  }

  try {
    await relay.run();
    if (failure) throw failure;
    if (signal.aborted) throw new CliError(130, { error: { code: "cancelled", message: "detached" } });
    // The only other thing that ends `run` without throwing: Chromium exited (Assumption 7).
    say("The browser closed; detached.");
  } finally {
    socks.stop();
    // `launchChrome` removes the profile directory on every exit path; `close()` kills and waits for it.
    await chrome?.then((c) => c.close(), () => {});
  }
}
