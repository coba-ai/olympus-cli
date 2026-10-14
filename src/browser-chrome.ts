import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, realSleep, usage, type Io } from "./core";

// Chromium for the browser relay: discovery, the flag list (§5.1/§5.4 of the browser-relay contract),
// the throwaway profile, and the CDP port the workbench's stream is terminated against.
//
// THE CDP PORT IS LOOPBACK-ONLY AND UNAUTHENTICATED. Chromium's DevTools socket has no credential of
// any kind, so ANY process running as the member can connect to it and drive this browser — every
// command the CDP allowlist refuses included, because the allowlist lives in the relay, not in the
// browser. Nothing here enforces otherwise and nothing can: the filter guards the relay, not the port.
//
// Launch is triggered by the first accepted `cdp` stream (unit 3.1 calls `launchChrome`), never by
// `attach` itself. Until the workbench bridge exists nothing calls it, and that is deliberate: the hub
// drops laptop frames while no workbench is connected (§1.4), so an eager launch would put a window on
// screen that cannot load a page.

// The SOCKS scheme is one constant because the choice is coupled to unit 2.3's CONNECT matching rules:
// 2.3 matches its allowlist on the name as sent in CONNECT and does no DNS of its own, so whether
// Chromium sends a hostname or an address it resolved itself decides whether a hostname allowlist can
// match at all. Unit 2.3 MEASURED the answer on Chromium 152.0.7977.82: `socks5://` sends the
// hostname as ATYP 0x03 DOMAINNAME and resolves nothing locally, so the hostname allowlist matches
// (`browser-socks.ts`'s header has the drive). `socks5h` is NOT the fallback it was assumed to be —
// Chromium refuses that scheme with ERR_NO_SUPPORTED_PROXIES and dials no proxy at all.
export const PROXY_SCHEME = "socks5";

// Assumption 3: no download and no bundled browser. `$OLYMPUS_CHROME` first, then PATH, then the two
// standard macOS install paths.
const CANDIDATES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
export const MAC_CHROME_PATHS = [
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function discoverChrome(io: Io): string {
  // Taken verbatim, not checked for existence: a path that does not run surfaces as launchChrome's
  // spawn error, which names it, rather than as a second message about the same mistake.
  const pinned = io.env.OLYMPUS_CHROME?.trim();
  if (pinned) return pinned;
  // `Bun.which(name, {PATH: undefined})` falls back to the real process PATH (measured), which would
  // make a test's env irrelevant, so an unset PATH is passed as "" and finds nothing.
  const PATH = io.env.PATH ?? "";
  for (const name of CANDIDATES) {
    const found = Bun.which(name, { PATH });
    if (found) return found;
  }
  // `process.platform` is not a seam, so this branch does not run under the suite on Linux; the paths
  // themselves are pinned by a test, the darwin gate is not.
  if (process.platform === "darwin") for (const p of MAC_CHROME_PATHS) if (existsSync(p)) return p;
  throw usage(
    "no browser found: install Chromium or Google Chrome, or set OLYMPUS_CHROME to the browser's path",
  );
}

/** The argv Chromium is launched with, as a pure function, so the test asserts it string by string. */
export function chromeFlags(o: { profileDir: string; socksPort: number }): string[] {
  return [
    // A throwaway profile, never the member's own: signed out, no extensions and no sync hold because
    // the directory is empty, not because a flag says so.
    `--user-data-dir=${o.profileDir}`,
    // 0 = pick a free port; Chromium writes the one it bound to DevToolsActivePort.
    "--remote-debugging-port=0",
    // A10 asks for that port on loopback. Chromium's default was never verified here (nothing in this
    // repo launches a browser), so it is stated rather than assumed.
    "--remote-debugging-address=127.0.0.1",
    // All egress leaves through the tunnel (§5.4): the SOCKS server is unit 2.3's, on loopback.
    `--proxy-server=${PROXY_SCHEME}://127.0.0.1:${o.socksPort}`,
    // Removes the implicit loopback bypass, so a page cannot reach this computer's own services.
    "--proxy-bypass-list=<-loopback>",
    // No WebRTC path that would leave the member's LAN instead of the proxy.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--no-first-run",
    "--no-default-browser-check",
    // Chromium's own calls home leave through the tunnel, from the organization's IP, because every
    // connection does (§5.4) and the default rule is allow.
    //
    // THESE TWO FLAGS DO NOT STOP THAT, and the comment that used to stand here said they did. Run
    // against Chromium 152.0.7977.82 with a SOCKS server logging every CONNECT, a fresh signed-out
    // profile on `about:blank` reaches for six hosts — `clients2.google.com:80`,
    // `redirector.gvt1.com`, `www.google.com`, `accounts.google.com`, `android.clients.google.com`,
    // `optimizationguide-pa.googleapis.com` — and the list is BYTE-IDENTICAL with the flags and
    // without them. A live drive against production saw two of those six arrive as `tcp:` streams,
    // so this is not an artefact of the local harness.
    //
    // They stay because they cost nothing and other Chrome builds may honour them, but nothing here
    // enforces any bound on what a launched browser contacts: the only real control is the tunnel's
    // own origin policy (§5.5), and its default is allow. A member who needs that bound passes
    // `--allow-origin`, which refuses all six.
    "--disable-background-networking",
    "--disable-component-update",
    // A start page that needs no network. Chromium's new-tab page would otherwise be the first thing
    // the tunnel is asked to fetch.
    "about:blank",
  ];
}

/** Just enough of a spawned process for this module; `Bun.spawn`'s return satisfies it. */
export type ChromeProcess = { exited: Promise<unknown>; kill: () => void };
export type ChromeSeams = {
  spawn: (argv: string[]) => ChromeProcess;
  /** Defaults to a `mkdtemp` under the system temp dir. The test supplies a directory it writes itself. */
  mkProfile?: () => Promise<string>;
};
export type Chrome = {
  port: number;
  /** Resolves when Chromium has exited and the profile directory has been removed. Never rejects. */
  exited: Promise<void>;
  /** Kills Chromium and awaits `exited`. Idempotent. */
  close: () => Promise<void>;
};

const PORT_FILE = "DevToolsActivePort";
const POLL_MS = 100;
const POLL_TRIES = 100; // 10 s, the same order as core's other waits

const failed = (message: string) => new CliError(5, { error: { code: "chrome_failed", message } });

// Chromium writes the port it actually bound on the FIRST line of DevToolsActivePort once the DevTools
// socket is listening; the second line is the browser target path, which nothing here needs. A file
// caught mid-write parses as nothing and is retried rather than treated as a failure.
async function readDevToolsPort(profileDir: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(join(profileDir, PORT_FILE), "utf8");
  } catch {
    return 0;
  }
  const n = Number(text.split("\n", 1)[0]!.trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0;
}

/** Launches Chromium against unit 2.3's SOCKS port and waits for its CDP port. */
export async function launchChrome(io: Io, o: { socksPort: number }, seams: ChromeSeams): Promise<Chrome> {
  const bin = discoverChrome(io);
  // After discovery, so the "no browser found" path has no directory to remove.
  const profileDir = await (seams.mkProfile ?? (() => mkdtemp(join(tmpdir(), "olympus-browser-"))))();
  const sweep = async () => {
    try {
      await rm(profileDir, { recursive: true, force: true });
    } catch (e: any) {
      // The profile holds whatever the browser did; a member who cannot remove it should hear which
      // directory it is.
      io.err(`could not remove the browser profile ${profileDir}: ${e?.code ?? e?.message ?? "failed"}\n`);
    }
  };

  let proc: ChromeProcess;
  try {
    proc = seams.spawn([bin, ...chromeFlags({ profileDir, socksPort: o.socksPort })]);
  } catch (e: any) {
    await sweep();
    throw failed(`could not start ${bin}: ${e?.code ?? e?.message ?? "spawn failed"}`);
  }

  // Every exit path removes the profile, because every exit path ends in the process exiting: a browser
  // that never listened is killed below, and close() kills too.
  let gone = false;
  const onExit = () => ((gone = true), sweep());
  const exited = proc.exited.then(onExit, onExit);
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= (proc.kill(), exited));

  const sleep = io.sleep ?? realSleep;
  let port = 0;
  for (let i = 0; i < POLL_TRIES && !port; i++) {
    if (i) await sleep(POLL_MS);
    port = await readDevToolsPort(profileDir);
    if (!port && gone) break;
  }
  if (!port) {
    const early = gone; // read before close(), whose own kill would make every failure look like an early exit
    await close();
    throw failed(early ? `${bin} exited before it was listening` : `${bin} did not report a debugging port`);
  }
  return { port, exited, close };
}
