import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { clean } from "./format";

export type Io = {
  env: Record<string, string | undefined>;
  home: string;
  stdin: () => Promise<string>;
  out: (s: string) => void;
  err: (s: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  tty?: boolean;
  openBrowser?: (url: string) => void;
};
export type Exit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 130;
export type ApiErrorBody = { error: { code: string; message: string; details?: unknown } };

// `location` (host of an unfollowed 3xx) and `status` (HTTP status) are additions to the pin; fail() uses them.
export class CliError extends Error {
  constructor(
    readonly exit: Exit,
    readonly body: ApiErrorBody,
    readonly retryAfter?: string,
    readonly location?: string,
    readonly status?: number,
  ) {
    super(body.error.message);
  }
}
export const usage = (message: string) => new CliError(1, { error: { code: "usage", message } });

export const DEFAULT_HOST = "https://app.tryolympus.ai";
export type Creds = { host?: string; token?: string; org?: string };

const credsDir = (io: Io) => join(io.home, ".config", "olympus");
const credsPath = (io: Io) => join(credsDir(io), "credentials.json");
const ioError = (e: any, path: string) =>
  new CliError(1, { error: { code: "credentials_io", message: `${e?.code ?? "EIO"} ${path}` } });

export async function readCreds(io: Io): Promise<Creds> {
  const path = credsPath(io);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw ioError(e, path);
  }
  const bad = () =>
    new CliError(1, { error: { code: "credentials_malformed", message: `malformed credentials file ${path}; run \`olympus logout\` to remove it` } });
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    throw bad();
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad();
  for (const k of ["host", "token", "org"]) if (v[k] !== undefined && typeof v[k] !== "string") throw bad();
  return { host: v.host, token: v.token, org: v.org };
}

export async function writeCreds(io: Io, c: Creds): Promise<void> {
  const dir = credsDir(io);
  const path = credsPath(io);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(JSON.stringify(c) + "\n");
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e: any) {
    await unlink(tmp).catch(() => {});
    throw ioError(e, path);
  }
}

export async function deleteCreds(io: Io): Promise<boolean> {
  const path = credsPath(io);
  try {
    await unlink(path);
    return true;
  } catch (e: any) {
    if (e?.code === "ENOENT") return false;
    throw ioError(e, path);
  }
}

const set = (v: string | undefined) => (v ? v : undefined); // empty env var == unset
// Trimmed (a pasted key often ends in "\n"); whitespace-only counts as unset.
export const envKey = (io: Io) => io.env.OLYMPUS_API_KEY?.trim() || undefined;

export function resolveHost(flag: string | undefined, io: Io, creds: Creds): string {
  const raw =
    set(flag) ?? set(io.env.OLYMPUS_HOST) ?? (envKey(io) ? undefined : creds.host) ?? DEFAULT_HOST;
  const host = raw.replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(host);
  } catch {
    throw usage(`invalid host: ${host}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw usage(`invalid host: ${host}`);
  const loopback = u.hostname === "localhost" || u.hostname === "[::1]" || /^127\./.test(u.hostname);
  if (u.protocol === "http:" && !loopback) throw usage("refusing http:// to a non-loopback host; use https://");
  return host;
}

export function resolveToken(host: string, io: Io, creds: Creds): string {
  const t = envKey(io) ?? (creds.host === host ? set(creds.token) : undefined);
  if (t) return t;
  throw new CliError(2, {
    error: {
      code: "no_token",
      message: `no API token for ${host}; run \`olympus login [--host H]\` or set OLYMPUS_API_KEY`,
    },
  });
}

export type Me = {
  user: { email: string };
  memberships: { org: { slug: string; name: string }; role: string }[];
  token: { name: string; last4: string; organization: { slug: string; name: string } | null };
};
export type Api = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => Promise<any>;

export function exitForStatus(status: number): Exit {
  if (status === 401) return 2;
  if (status === 404) return 3;
  if (status === 403) return 4;
  if (status === 400 || status === 422) return 6;
  return 5;
}

const cancelled = () => new CliError(130, { error: { code: "cancelled", message: "login cancelled" } });

export function api(host: string, token?: string, timeoutMs = 30_000, signal?: AbortSignal): Api {
  return async (method, path, body) => {
    const url = `${host}/api/v1${path}`;
    const headers: Record<string, string> = { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e: any) {
      if (signal?.aborted) throw cancelled();
      const message = e?.name === "TimeoutError" ? `request to ${host} timed out` : `could not reach ${host}`;
      throw new CliError(5, { error: { code: "network_error", message } });
    }
    const { status } = res;
    if (status >= 200 && status < 300) {
      if (status === 204) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new CliError(5, { error: { code: `http_${status}`, message: "response was not JSON" } }, undefined, undefined, status);
      }
    }
    if (status >= 300 && status < 400) {
      let loc: string | undefined;
      try {
        const l = res.headers.get("location");
        if (l) loc = new URL(l, url).host;
      } catch {}
      throw new CliError(5, { error: { code: `http_${status}`, message: "unexpected redirect" } }, undefined, loc, status);
    }
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const e = parsed?.error;
    const errBody: ApiErrorBody =
      e && typeof e === "object" && !Array.isArray(e)
        ? parsed
        : { error: { code: `http_${status}`, message: `HTTP ${status}` } };
    throw new CliError(exitForStatus(status), errBody, res.headers.get("retry-after") ?? undefined, undefined, status);
  };
}

export type OrgSource = "flag" | "env" | "pin" | "stored" | "only";

// Same precedence resolveOrg always had; flag/env never call `me`. `slugs` is set only when nothing resolved.
async function pickOrg(
  flag: string | undefined,
  io: Io,
  creds: Creds,
  me: () => Promise<Me>,
): Promise<{ slug: string; from: OrgSource } | { slugs: string[] }> {
  const f = set(flag);
  if (f) return { slug: f, from: "flag" };
  const e = set(io.env.OLYMPUS_ORG);
  if (e) return { slug: e, from: "env" };
  const m = await me();
  const pin = m.token.organization?.slug;
  if (pin) return { slug: pin, from: "pin" };
  if (creds.org) return { slug: creds.org, from: "stored" };
  const slugs = m.memberships.map((x) => x.org.slug);
  if (slugs.length === 1) return { slug: slugs[0]!, from: "only" };
  return { slugs };
}

export async function defaultOrg(
  flag: string | undefined,
  io: Io,
  creds: Creds,
  me: () => Promise<Me>,
): Promise<{ slug: string; from: OrgSource } | undefined> {
  const r = await pickOrg(flag, io, creds, me);
  return "slug" in r ? r : undefined;
}

export async function resolveOrg(
  flag: string | undefined,
  io: Io,
  creds: Creds,
  me: () => Promise<Me>,
): Promise<string> {
  const r = await pickOrg(flag, io, creds, me);
  if ("slug" in r) return r.slug;
  throw usage(
    r.slugs.length ? `multiple organizations (${r.slugs.join(", ")}); pass --org or run \`olympus org use <slug>\`` : "no organizations",
  );
}

export async function loginWithToken(io: Io, host: string, token: string, signal?: AbortSignal): Promise<Me> {
  const r = await api(host, token, undefined, signal)("GET", "/me");
  const me = r?.data;
  if (typeof me?.user?.email !== "string") throw new CliError(5, { error: { code: "bad_response", message: "unexpected /me response" } });
  if (signal?.aborted) throw cancelled();
  await writeCreds(io, { host, token });
  return me;
}

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const done = () => (clearTimeout(t), signal?.removeEventListener("abort", done), res());
    const t = setTimeout(done, ms);
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });

// RFC 8628 device grant. Server error text is never printed (it could echo device_code): bodies are rebuilt here.
export async function deviceLogin(
  io: Io,
  host: string,
  o: { clientName: string; browser: boolean; signal?: AbortSignal },
): Promise<Me> {
  const { signal } = o;
  const sleep = io.sleep ?? realSleep;
  const now = io.now ?? Date.now;
  const a = api(host, undefined, 30_000, signal);
  let dc = "";
  const call = async (path: string, body: unknown, notFound?: string) => {
    try {
      return await a("POST", path, body);
    } catch (e) {
      if (!(e instanceof CliError) || !e.status || e.status < 400) throw e;
      const c = e.body?.error?.code;
      const code = typeof c === "string" && /^[a-z0-9_]{1,40}$/.test(c) && !(dc && c.includes(dc)) ? c : `http_${e.status}`;
      const message = e.status === 404 && notFound ? notFound : `device login failed (HTTP ${e.status})`;
      const ra = e.retryAfter && /^\d+$/.test(e.retryAfter) ? e.retryAfter : undefined;
      throw new CliError(e.exit, { error: { code, message } }, ra, undefined, e.status);
    }
  };
  const bad = (m: string) => new CliError(5, { error: { code: "bad_response", message: m } });
  const c = await call("/device/code", { client_name: o.clientName }, "this server does not support device login; use `olympus login --with-token`");
  if (
    typeof c?.device_code !== "string" || typeof c.user_code !== "string" || typeof c.verification_uri !== "string" ||
    typeof c.expires_in !== "number" || !(c.expires_in > 0)
  )
    throw bad("unexpected device code response");
  dc = c.device_code;
  let interval = Math.max(1, Number.isFinite(c.interval) ? c.interval : 5) * 1000;
  const deadline = now() + Math.min(c.expires_in, 86_400) * 1000; // cap keeps every sleep far below setTimeout's 2^31-1 ms limit
  const url: string = typeof c.verification_uri_complete === "string" ? c.verification_uri_complete : c.verification_uri;
  io.err(`Open ${url} and enter code ${c.user_code} to log in\nwaiting for approval...\n`);
  const display = io.env.DISPLAY || io.env.WAYLAND_DISPLAY || process.platform === "darwin";
  if (o.browser && display && io.openBrowser && /^https?:\/\//i.test(url)) {
    try {
      io.openBrowser(url);
    } catch {}
  }
  let wait = interval;
  for (;;) {
    await sleep(Math.min(wait, Math.max(0, deadline - now())), signal);
    wait = interval;
    if (signal?.aborted) throw cancelled();
    if (now() >= deadline) throw new CliError(2, { error: { code: "expired_token", message: "device code expired; run `olympus login` again" } });
    let r: any;
    try {
      r = await call("/device/token", { device_code: c.device_code });
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      if (e.status === 429) {
        wait = Math.max((interval += 5000), e.retryAfter ? Number(e.retryAfter) * 1000 : 0);
        continue;
      }
      const code = e.status === 400 ? e.body.error.code : "";
      if (code === "slow_down") wait = interval += 5000;
      else if (code === "expired_token") throw new CliError(2, { error: { code, message: "device code expired; run `olympus login` again" } });
      else if (code === "access_denied") throw new CliError(2, { error: { code, message: "login was denied" } });
      else if (code !== "authorization_pending") throw e;
      continue;
    }
    if (signal?.aborted) throw cancelled();
    const token = r?.data?.token;
    if (typeof token !== "string" || !token) throw bad("unexpected device token response");
    return loginWithToken(io, host, token, signal);
  }
}

export function print(io: Io, json: boolean, body: unknown, human: () => string, rich?: () => string): void {
  if (json) return io.out(JSON.stringify(body) + "\n");
  const s = (io.tty && rich ? rich : human)();
  if (s === "") return; // an empty list prints nothing, not a blank line
  io.out(s.endsWith("\n") ? s : s + "\n");
}

// `hint.orgFromCreds` is an addition to the pin: pass the org slug when it came from credentials.json.
export function fail(io: Io, json: boolean, e: CliError, hint?: { orgFromCreds?: string }): Exit {
  if (json) {
    io.err(JSON.stringify(e.body) + "\n");
    return e.exit;
  }
  const err: any = e.body?.error;
  const msg = typeof err?.message === "string" && err.message ? err.message : null;
  let line = msg ? `error: ${clean(msg)}` : `error: HTTP ${e.status ?? "error"}`;
  if (e.retryAfter) line += ` (retry after ${/^\d+$/.test(e.retryAfter) ? e.retryAfter + "s" : clean(e.retryAfter)})`;
  if (e.location) line += ` (redirected to ${e.location}; check --host)`;
  if (e.exit === 3 && hint?.orgFromCreds) line += ` (org "${hint.orgFromCreds}" from credentials.json; override with --org)`;
  const fields = err?.details?.fields;
  if (fields && typeof fields === "object")
    for (const [k, v] of Object.entries(fields)) line += `\n  ${clean(k)}: ${clean(Array.isArray(v) ? v.join(", ") : String(v))}`;
  io.err(line + "\n");
  return e.exit;
}
