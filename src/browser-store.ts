import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { api, CliError, configPath, ioError, writeSecretFile, type Io } from "./core";

// Beside credentials.json, and deliberately NOT in it: the obm_ machine token has its own lifetime, and
// `olympus logout` must not silently detach a computer from the organization.
const FILE = "browser.json";

export type BrowserMachine = { machine_id: string; token: string; name: string };

// {"machines": {"<host>": {...}}} — one record per host, so pairing against a second host adds a record
// instead of replacing the first.
type Machines = Record<string, BrowserMachine>;

const bad = (message: string) => new CliError(5, { error: { code: "bad_response", message } });
const cancelled = () => new CliError(130, { error: { code: "cancelled", message: "pairing cancelled; nothing was saved" } });
// `bm_` and then url-safe characters. The prefix is what makes a token-shaped `obm_…` value fail this
// check rather than be stored and then printed in the `paired` line — the one place a string the server
// chose reaches stdout. Driven in browser-store.test.ts "a token-shaped string the server controls
// reaches no sink" and browser.test.ts "a token-shaped machine id is refused".
const MACHINE_ID = /^bm_[A-Za-z0-9_-]{1,64}$/;
// The shape readCreds raises for a malformed credentials file, with its own remedy: `olympus logout`
// removes credentials.json, not this file.
const malformed = (path: string) =>
  new CliError(1, { error: { code: "credentials_malformed", message: `malformed browser file ${path}; remove it and pair again` } });

async function readAll(io: Io): Promise<Machines> {
  const path = configPath(io, FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw ioError(e, path);
  }
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    throw malformed(path);
  }
  const obj = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
  if (!obj(v)) throw malformed(path);
  if (v.machines === undefined) return {};
  if (!obj(v.machines)) throw malformed(path);
  const out: Machines = {};
  for (const [host, r] of Object.entries<any>(v.machines)) {
    if (!obj(r)) throw malformed(path);
    for (const k of ["machine_id", "token", "name"]) if (typeof r[k] !== "string") throw malformed(path);
    out[host] = { machine_id: r.machine_id, token: r.token, name: r.name };
  }
  return out;
}

export async function readBrowserMachine(io: Io, host: string): Promise<BrowserMachine | undefined> {
  return (await readAll(io))[host];
}

// Mirrors resolveHost's rule — ws: only to a loopback host — and adds the one this file exists for: the
// relay must be on the host we just paired with, because the obm_ token travels to it as a bearer.
export function checkRelayUrl(host: string, relayUrl: unknown): string {
  if (typeof relayUrl !== "string") throw bad("the pair response carried no relay url");
  // The url itself is never interpolated. A refused one is exactly the case where it may carry anything
  // — a token in its query, a hostname picked to be echoed — and this message is printed. `host` is the
  // CLI's own resolved host (--host / OLYMPUS_HOST / credentials.json), not a string the server sent.
  const refuse = bad(`the pair response carried a relay url that is not a WebSocket url on ${host}`);
  let u: URL;
  try {
    u = new URL(relayUrl);
  } catch {
    throw refuse;
  }
  const loopback = u.hostname === "localhost" || u.hostname === "[::1]" || /^127\./.test(u.hostname);
  if (u.protocol !== "wss:" && !(u.protocol === "ws:" && loopback)) throw refuse;
  if (u.host !== new URL(host).host) throw refuse;
  return relayUrl;
}

// Claims a pairing code and stores the machine token. The endpoint is unauthenticated, so no bearer is
// sent; the whole response is checked before anything reaches disk, because a response we refuse is not
// one whose token we want to keep.
export async function pairBrowser(
  io: Io,
  host: string,
  o: { code: string; name?: string },
  signal?: AbortSignal,
): Promise<{ machine: BrowserMachine; relayUrl: string }> {
  const name = o.name ?? hostname();
  // Read the file first: a pairing code is spent by the request, so a file we cannot parse has to fail
  // before the claim, not after it.
  const existing = await readAll(io);
  let body: any;
  try {
    body = await api(host, undefined, undefined, signal)("POST", "/browser/pair", { code: o.code, name });
  } catch (e) {
    if (signal?.aborted) throw cancelled();
    // Anything with no status was built by api() from `host`, not by the server: network, timeout.
    if (!(e instanceof CliError) || e.status === undefined) throw e;
    // Every HTTP refusal gets a message written here, and the server's own body is dropped — message,
    // details.fields, Retry-After and a 3xx Location, all of which fail() prints. This route is
    // unauthenticated, so each of them is a string a stranger chose. Only the exit code is kept, so
    // exitForStatus still decides it.
    //
    // The server answers one 404 for every refusal — unknown, expired, already claimed, the feature off
    // for the organization, or an owner who is no longer a member — so the message names all of them.
    const error =
      e.status === 404
        ? {
            code: "not_found",
            message: "that pairing code was not accepted; it may be unknown, expired or already used, or browser attach may not be on for your organization — get a fresh code from Settings → Rafita",
          }
        : { code: "pair_failed", message: `pairing with ${host} failed (HTTP ${e.status})` };
    throw new CliError(e.exit, { error }, undefined, undefined, e.status);
  }
  const d = body?.data;
  const token = d?.token;
  if (typeof token !== "string" || !token.startsWith("obm_") || token.length <= 4) throw bad("the pair response carried no machine token");
  if (typeof d.machine_id !== "string" || !MACHINE_ID.test(d.machine_id)) throw bad("the pair response carried no machine id");
  const relayUrl = checkRelayUrl(host, d.relay_url);
  // `name` is the one the CLI sent, never one read back from the response.
  const machine: BrowserMachine = { machine_id: d.machine_id, token, name };
  // Checked again after the response: Ctrl-C can land while the server is already answering, and a
  // pairing the member cancelled must leave no credential on disk. The code itself is spent either way
  // — nothing on this side can unspend it.
  if (signal?.aborted) throw cancelled();
  try {
    // The signal goes in as well, because this check cannot cover the write: `writeSecretFile` awaits
    // mkdir, open, write and close before its rename, and reads the signal again just before it.
    await writeSecretFile(io, FILE, JSON.stringify({ machines: { ...existing, [host]: machine } }) + "\n", signal);
  } catch (e) {
    // Only the cancellation is rewritten — it arrives carrying login's message — and an IO failure
    // that happens to coincide with a Ctrl-C still reports itself.
    if (e instanceof CliError && e.exit === 130) throw cancelled();
    throw e;
  }
  return { machine, relayUrl };
}
