import { parseArgs } from "node:util";
import { homedir, hostname } from "node:os";
import {
  CliError, DEFAULT_HOST, api, envKey, deleteCreds, deviceLogin, fail, loginWithToken, print, readCreds, resolveHost,
  resolveOrg, resolveToken, usage, writeCreds, type Api, type Creds, type Exit, type Io, type Me,
} from "./core";

const USAGE = `usage: olympus <command> [flags]
  login [--with-token | --no-browser]   device login (browser approval), or read a token on stdin
  logout | whoami | org list | org use <slug> | agents list
  webhook list | get <id> | delete <id> --yes
  webhook create --name N --agent PROFILE (--instructions T | --instructions-file PATH|-) [--full-tools]
  webhook update <id> [--name N] [--agent P] [--instructions T | --instructions-file PATH|-] [--[no-]full-tools]
global flags: --json --host URL --org SLUG -h
env: OLYMPUS_API_KEY OLYMPUS_HOST OLYMPUS_ORG
exit: 0 ok, 1 usage, 2 auth, 3 not found, 4 forbidden, 5 server/network, 6 invalid, 130 cancelled
`;

const OPTIONS = {
  json: { type: "boolean" }, host: { type: "string" }, org: { type: "string" },
  help: { type: "boolean", short: "h" }, yes: { type: "boolean" }, name: { type: "string" },
  agent: { type: "string" }, instructions: { type: "string" }, "instructions-file": { type: "string" },
  "full-tools": { type: "boolean" }, "with-token": { type: "boolean" }, browser: { type: "boolean" },
} as const;

const enc = encodeURIComponent;

export async function run(argv: string[], io: Io): Promise<Exit> {
  let json = argv.includes("--json");
  let host = "";
  let orgFromCreds: string | undefined;
  let byId = false; // webhook <verb> <id>: a 404 may be the webhook, not the org, so no stored-org hint
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true, allowNegative: true });
    } catch (e) {
      throw usage((e as Error).message);
    }
    const { values: v, positionals: pos } = parsed;
    json = !!v.json;
    if (v.help) { io.out(USAGE); return 0; }
    if (!pos.length) { io.err(USAGE); return 1; }
    const [cmd, sub, arg] = pos;
    byId = cmd === "webhook" && arg !== undefined;
    const want = (n: number) => { if (pos.length !== n) throw usage(`expected ${n} argument(s) in: ${pos.join(" ")}`); };
    const warnEnv = () => { if (envKey(io)) io.err("warning: OLYMPUS_API_KEY is set and overrides stored credentials\n"); };

    if (cmd === "login") {
      want(1);
      if (!v["with-token"]) {
        warnEnv();
        const host = resolveHost(v.host, io, {});
        const ac = new AbortController();
        const abort = () => ac.abort();
        process.once("SIGINT", abort);
        let me: Me;
        try {
          me = await deviceLogin(io, host, { clientName: `olympus-cli on ${hostname()}`, browser: v.browser !== false, signal: ac.signal });
        } finally {
          process.off("SIGINT", abort);
        }
        print(io, json, { data: me }, () => `logged in to ${host} as ${me.user.email}`);
        return 0;
      }
      const token = (await io.stdin()).trim();
      if (!token) throw usage("no token on stdin");
      warnEnv();
      const host = resolveHost(v.host, io, {});
      const me = await loginWithToken(io, host, token);
      print(io, json, { data: me }, () => `logged in to ${host} as ${me.user.email}`);
      return 0;
    }
    if (cmd === "logout") {
      want(1);
      warnEnv();
      const deleted = await deleteCreds(io);
      print(io, json, { data: { deleted } }, () => (deleted ? "logged out" : "no stored credentials"));
      return 0;
    }

    // Everything else is authenticated; validate arguments before any request.
    let plan: (call: Api, org: () => Promise<string>, creds: Creds, me: () => Promise<Me>) => Promise<void>;
    if (cmd === "whoami") {
      want(1);
      plan = async (call) => {
        const body = await call("GET", "/me");
        const m: Me = body.data;
        const pin = m.token.organization?.slug;
        print(io, json, body, () => [
          m.user.email, `token ${m.token.name} …${m.token.last4}${pin ? ` (pinned to ${pin})` : ""}`,
          ...m.memberships.map((x) => `${x.org.slug}\t${x.org.name}\t${x.role}`),
        ].join("\n"));
      };
    } else if (cmd === "org" && sub === "list") {
      want(2);
      plan = async (_c, _o, _cr, me) => {
        const ms = (await me()).memberships;
        print(io, json, { data: ms }, () => ms.map((x) => `${x.org.slug}\t${x.org.name}\t${x.role}`).join("\n"));
      };
    } else if (cmd === "org" && sub === "use") {
      want(3);
      plan = async (_c, _o, creds, me) => {
        if (creds.host !== host && (creds.host || creds.token)) {
          throw usage(`stored credentials ${creds.host ? `are for ${creds.host}, not ${host}` : "have a token but no host"}; run \`olympus login --host ${host}\` first`);
        }
        const m = await me();
        const pin = m.token.organization?.slug;
        if (pin && pin !== arg) throw new CliError(3, { error: { code: "not_found", message: `token is pinned to org "${pin}"; cannot use "${arg}"` } });
        if (!m.memberships.some((x) => x.org.slug === arg)) throw new CliError(3, { error: { code: "not_found", message: `not a member of org "${arg}"` } });
        // Re-read: someone may have run login/logout/org use while /me was in flight.
        const now = await readCreds(io);
        if (now.host !== creds.host || now.token !== creds.token || now.org !== creds.org)
          throw new CliError(1, { error: { code: "credentials_changed", message: "credentials changed while running; nothing was written, try again" } });
        // ponytail: a few ms remain between this re-read and the rename; a lock file is the upgrade path.
        await writeCreds(io, { ...creds, host, org: arg });
        print(io, json, { data: { org: arg } }, () => `default org: ${arg}`);
      };
    } else if (cmd === "agents" && sub === "list") {
      want(2);
      plan = async (call, org) => {
        const body = await call("GET", `/orgs/${enc(await org())}/agents`);
        print(io, json, body, () => body.data.map((a: any) => `${a.profile_name}\t${a.name}\t${a.paused ? "paused" : "active"}`).join("\n"));
      };
    } else if (cmd === "webhook") {
      const wh = async (org: () => Promise<string>, id?: string) => `/orgs/${enc(await org())}/webhooks${id ? `/${enc(id)}` : ""}`;
      const row = (w: any) => `${w.id}\t${w.name}\t${w.agent}\t${w.full_tools ? "full-tools" : "-"}\t${w.last_delivery_status ?? "-"}`;
      const detail = (w: any) => Object.entries(w).map(([k, x]) => `${k}: ${x}`).join("\n");
      const instr = async () => {
        const [t, f] = [v.instructions, v["instructions-file"]];
        if (t !== undefined && f !== undefined) throw usage("give only one of --instructions / --instructions-file");
        if (f === undefined) return t;
        if (f === "-") return io.stdin();
        try { return await Bun.file(f).text(); } catch { throw usage(`cannot read instructions file: ${f}`); }
      };
      if (sub === "list") {
        want(2);
        plan = async (call, org) => { const b = await call("GET", await wh(org)); print(io, json, b, () => b.data.map(row).join("\n")); };
      } else if (sub === "get") {
        want(3);
        plan = async (call, org) => { const b = await call("GET", await wh(org, arg)); print(io, json, b, () => detail(b.data)); };
      } else if (sub === "create") {
        want(2);
        if (!v.name || !v.agent) throw usage("webhook create needs --name and --agent");
        const instructions = await instr();
        if (instructions === undefined) throw usage("webhook create needs --instructions or --instructions-file");
        const body = { name: v.name, agent: v.agent, instructions, ...(v["full-tools"] === undefined ? {} : { full_tools: v["full-tools"] }) };
        plan = async (call, org) => {
          const b = await call("POST", await wh(org), body);
          print(io, json, b, () => `${detail(b.data)}\nsecret (shown once): ${b.secret}`);
        };
      } else if (sub === "update") {
        want(3);
        const instructions = await instr();
        const body = {
          ...(v.name !== undefined && { name: v.name }), ...(v.agent !== undefined && { agent: v.agent }),
          ...(instructions !== undefined && { instructions }), ...(v["full-tools"] !== undefined && { full_tools: v["full-tools"] }),
        };
        if (!Object.keys(body).length) throw usage("webhook update needs at least one field to change");
        plan = async (call, org) => { const b = await call("PATCH", await wh(org, arg), body); print(io, json, b, () => detail(b.data)); };
      } else if (sub === "delete") {
        want(3);
        if (!v.yes) throw usage("webhook delete needs --yes");
        plan = async (call, org) => {
          await call("DELETE", await wh(org, arg));
          print(io, json, { data: { id: arg, deleted: true } }, () => `deleted ${arg}`);
        };
      } else throw usage(`unknown webhook command: ${sub ?? ""}`);
    } else throw usage(`unknown command: ${pos.join(" ")}`);

    // An env key makes a malformed file irrelevant, except to `org use`, which would overwrite what it cannot read.
    const creds = await readCreds(io).catch((e) => {
      if (e instanceof CliError && e.body.error.code === "credentials_malformed" && envKey(io) && !(cmd === "org" && sub === "use")) return {} as Creds;
      throw e;
    });
    host = resolveHost(v.host, io, creds);
    // A stored org belongs to the host it was saved for.
    const scoped: Creds = { ...creds, org: creds.host === host ? creds.org : undefined };
    const call = api(host, resolveToken(host, io, creds));
    let meCache: Promise<Me> | undefined;
    const me = () => (meCache ??= call("GET", "/me").then((b) => b.data as Me));
    const org = async () => {
      const r = await resolveOrg(v.org, io, scoped, me);
      if (!v.org && !io.env.OLYMPUS_ORG && r === scoped.org && !(await me()).token.organization?.slug) orgFromCreds = r;
      return r;
    };
    await plan(call, org, creds, me);
    return 0;
  } catch (e) {
    if (e instanceof CliError) return fail(io, json, e, { orgFromCreds: byId ? undefined : orgFromCreds });
    throw e;
  }
}

export function processIo(): Io {
  return {
    env: process.env, home: homedir(), stdin: () => Bun.stdin.text(),
    out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s),
    openBrowser: (url) => {
      try {
        Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
      } catch {}
    },
  };
}

if (import.meta.main) {
  try {
    process.exitCode = await run(process.argv.slice(2), processIo());
  } catch (e) {
    process.stderr.write(`error: internal: ${(e as Error)?.message ?? String(e)}\n`);
    process.exitCode = 5;
  }
}
