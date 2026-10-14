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
  const refuse = bad(`refusing the relay url ${relayUrl}: it is not a WebSocket url on ${host}`);
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
export async function pairBrowser(io: Io, host: string, o: { code: string; name?: string }): Promise<{ machine: BrowserMachine; relayUrl: string }> {
  const name = o.name ?? hostname();
  // Read the file first: a pairing code is spent by the request, so a file we cannot parse has to fail
  // before the claim, not after it.
  const existing = await readAll(io);
  let body: any;
  try {
    body = await api(host, undefined)("POST", "/browser/pair", { code: o.code, name });
  } catch (e) {
    // The server answers one 404 for every refusal — unknown, expired, already claimed, the feature off for
    // the organization, or an owner who is no longer a member — so the message names all of them.
    if (e instanceof CliError && e.status === 404)
      throw new CliError(e.exit, {
        error: {
          code: "not_found",
          message: "that pairing code was not accepted; it may be unknown, expired or already used, or browser attach may not be on for your organization — get a fresh code from Settings → Rafita",
        },
      });
    throw e;
  }
  const d = body?.data;
  const token = d?.token;
  if (typeof token !== "string" || !token.startsWith("obm_") || token.length <= 4) throw bad("the pair response carried no machine token");
  if (typeof d.machine_id !== "string" || !d.machine_id) throw bad("the pair response carried no machine id");
  const relayUrl = checkRelayUrl(host, d.relay_url);
  const machine: BrowserMachine = { machine_id: d.machine_id, token, name };
  await writeSecretFile(io, FILE, JSON.stringify({ machines: { ...existing, [host]: machine } }) + "\n");
  return { machine, relayUrl };
}
