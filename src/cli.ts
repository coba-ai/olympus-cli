import { parseArgs } from "node:util";
import { homedir, hostname } from "node:os";
import {
  CliError, DEFAULT_HOST, api, defaultOrg, envKey, deleteCreds, deviceLogin, fail, loginWithToken, print, readCreds,
  resolveHost, resolveOrg, resolveToken, usage, writeCreds, type Api, type Creds, type Exit, type Io, type Me, type OrgSource,
} from "./core";
import { taskPlan } from "./tasks";
import { ago, clean, delivery, keyValue, table, when } from "./format";

const USAGE = `usage: olympus <command> [flags]
  login [--with-token | --no-browser]   device login (browser approval), or read a token on stdin
  logout | whoami | org list | org use <slug> | agents list
  webhook list | get <id> | delete <id> --yes
  webhook create --name N --agent PROFILE (--instructions T | --instructions-file PATH|-) [--full-tools]
  webhook update <id> [--name N] [--agent P] [--instructions T | --instructions-file PATH|-] [--[no-]full-tools]
  people | tasks [--week D] [--mine | --who ID|me|EMAIL] [--open | --done] [--today]   (alias: task list)
  task get <id> | add TEXT | update <id> | done <id> | undone <id> | today <id> | star <id> | delete <id> --yes
  task sub add <id> TEXT | sub done <id> <sid> | sub delete <id> <sid> --yes   (all accept --week D)
global flags: --json --host URL --org SLUG -h
env: OLYMPUS_API_KEY OLYMPUS_HOST OLYMPUS_ORG
exit: 0 ok, 1 usage, 2 auth, 3 not found, 4 forbidden, 5 server/network, 6 invalid, 130 cancelled
`;

const OPTIONS = {
  json: { type: "boolean" }, host: { type: "string" }, org: { type: "string" },
  help: { type: "boolean", short: "h" }, yes: { type: "boolean" }, name: { type: "string" },
  agent: { type: "string" }, instructions: { type: "string" }, "instructions-file": { type: "string" },
  "full-tools": { type: "boolean" }, "with-token": { type: "boolean" }, browser: { type: "boolean" },
  week: { type: "string" }, who: { type: "string" }, desc: { type: "string" }, assign: { type: "string" },
  text: { type: "string" }, section: { type: "string" }, tag: { type: "string", multiple: true },
  mine: { type: "boolean" }, open: { type: "boolean" }, done: { type: "boolean" }, today: { type: "boolean" },
  backlog: { type: "boolean" }, star: { type: "boolean" }, unassign: { type: "boolean" }, off: { type: "boolean" },
  undo: { type: "boolean" }, tags: { type: "boolean" },
} as const;
// Flags that belong to the people/tasks/task family; any other command rejects them.
const TASK_FLAGS = ["week", "who", "desc", "assign", "text", "section", "tag", "mine", "open", "done", "today", "backlog", "star", "unassign", "off", "undo", "tags"];

const enc = encodeURIComponent;
const SOURCE: Record<OrgSource, string> = {
  flag: "--org", env: "OLYMPUS_ORG", pin: "token pin", stored: "saved by olympus org use", only: "only membership",
};
const SIGNING = 'See "Delivering to a webhook" in docs/API.md: https://github.com/coba-ai/olympus-cli/blob/main/docs/API.md#delivering-to-a-webhook';
const KNOWN = new Set(["id", "name", "agent", "full_tools", "url", "last_delivery_at", "last_delivery_status", "created_at", "instructions"]);

// Rich webhook block: known keys in a fixed order, then unknown ones, then instructions as an indented section.
function webhookBlock(w: any, now: number): string {
  const pairs: [string, string | null | undefined][] = [];
  const has = (k: string) => w[k] !== undefined;
  for (const k of ["id", "name", "agent"]) if (has(k)) pairs.push([k, clean(w[k])]);
  if (has("full_tools")) pairs.push(["full tools", w.full_tools ? "yes" : "no"]);
  if (has("url")) pairs.push(["url", clean(w.url)]);
  const [st, at] = [w.last_delivery_status ?? null, w.last_delivery_at ?? null];
  pairs.push(["last delivery", delivery(st, null, now) + (st !== null && at ? ", " + when(at, now) : "")]);
  if (has("created_at")) pairs.push(["created", when(w.created_at, now)]);
  for (const [k, x] of Object.entries(w)) if (!KNOWN.has(k)) pairs.push([k, clean(x)]);
  const instr = w.instructions === undefined || w.instructions === null ? "" :
    "\n\ninstructions:\n" + clean(w.instructions, true).split("\n").map((l) => ("  " + l).trimEnd()).join("\n");
  return keyValue(pairs) + instr;
}

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
    if (!["people", "tasks", "task"].includes(parsed.positionals[0] ?? "")) {
      const f = TASK_FLAGS.find((k) => (v as Record<string, unknown>)[k] !== undefined);
      if (f) throw usage(`unknown option '--${f}'`);
    }
    if (v.help) { io.out(USAGE); return 0; }
    if (!pos.length) { io.err(USAGE); return 1; }
    const [cmd, sub, arg] = pos;
    byId = (cmd === "webhook" && arg !== undefined) || (cmd === "task" && pos.length >= 3 && sub !== "list" && sub !== "add");
    const want = (n: number) => { if (pos.length !== n) throw usage(`expected ${n} argument(s) in: ${pos.join(" ")}`); };
    const now = () => (io.now ?? Date.now)();
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
        print(io, json, { data: me }, () => `logged in to ${host} as ${me.user.email}`,
          () => `Logged in to ${clean(host)} as ${clean(me.user.email)}.`);
        return 0;
      }
      const token = (await io.stdin()).trim();
      if (!token) throw usage("no token on stdin");
      warnEnv();
      const host = resolveHost(v.host, io, {});
      const me = await loginWithToken(io, host, token);
      print(io, json, { data: me }, () => `logged in to ${host} as ${me.user.email}`,
          () => `Logged in to ${clean(host)} as ${clean(me.user.email)}.`);
      return 0;
    }
    if (cmd === "logout") {
      want(1);
      warnEnv();
      const deleted = await deleteCreds(io);
      print(io, json, { data: { deleted } }, () => (deleted ? "logged out" : "no stored credentials"),
        () => (deleted ? "Logged out; stored credentials removed." : "Not logged in; no stored credentials."));
      return 0;
    }

    // Everything else is authenticated; validate arguments before any request.
    let plan: (call: Api, org: () => Promise<string>, creds: Creds, me: () => Promise<Me>, scoped: Creds) => Promise<void>;
    if (cmd === "whoami") {
      want(1);
      plan = async (call, _o, _cr, _me, scoped) => {
        const body = await call("GET", "/me");
        const m: Me = body.data;
        const pin = m.token.organization?.slug;
        const d = io.tty && !json ? await defaultOrg(v.org, io, scoped, async () => m) : undefined;
        print(io, json, body, () => [
          m.user.email, `token ${m.token.name} …${m.token.last4}${pin ? ` (pinned to ${pin})` : ""}`,
          ...m.memberships.map((x) => `${x.org.slug}\t${x.org.name}\t${x.role}`),
        ].join("\n"), () => keyValue([
          ["host", clean(host)],
          ["user", clean(m.user.email)],
          ["token", `${clean(m.token.name)} …${m.token.last4} (from ${envKey(io) ? "OLYMPUS_API_KEY" : "credentials.json"})`],
          ["scope", pin ? `${clean(pin)} (pinned)` : "all organizations"],
          ["default org", d ? `${clean(d.slug)} (${SOURCE[d.from]})` : "none"],
          ["organizations", m.memberships.map((x) => `${clean(x.org.slug)} (${clean(x.org.name)}, ${clean(x.role)})`).join("\n") || "none"],
        ]));
      };
    } else if (cmd === "org" && sub === "list") {
      want(2);
      plan = async (_c, _o, _cr, me, scoped) => {
        const ms = (await me()).memberships;
        const d = io.tty && !json ? await defaultOrg(v.org, io, scoped, me) : undefined;
        const mark = d && ms.some((x) => x.org.slug === d.slug) ? d : undefined;
        print(io, json, { data: ms }, () => ms.map((x) => `${x.org.slug}\t${x.org.name}\t${x.role}`).join("\n"), () => {
          if (!ms.length) return "You are not a member of any organization.";
          const t = table(["", "SLUG", "NAME", "ROLE"], ms.map((x) => [x.org.slug === mark?.slug ? "*" : " ", x.org.slug, x.org.name, x.role]));
          const foot = mark ? `* default org (${SOURCE[mark.from]})`
            : d ? `default org ${clean(d.slug)} (${SOURCE[d.from]}) is not one of your organizations`
            : "No default org; pick one with `olympus org use <slug>` or pass --org.";
          return `${t}\n\n${foot}`;
        });
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
        print(io, json, { data: { org: arg } }, () => `default org: ${arg}`, () => `Default org is now ${clean(arg)}.`);
      };
    } else if (cmd === "agents" && sub === "list") {
      want(2);
      plan = async (call, org) => {
        const slug = await org();
        const body = await call("GET", `/orgs/${enc(slug)}/agents`);
        print(io, json, body, () => body.data.map((a: any) => `${a.profile_name}\t${a.name}\t${a.paused ? "paused" : "active"}`).join("\n"), () => {
          const rows: any[] = body.data;
          if (!rows.length) return `No agents in ${clean(slug)} yet. Agents are created in the Olympus app.`;
          const has = (k: string) => rows.some((a) => a[k] !== null && a[k] !== undefined);
          const [created, role] = [has("created_at"), has("role_line")];
          return table(
            ["PROFILE", "NAME", "STATUS", ...(created ? ["CREATED"] : []), ...(role ? ["ROLE"] : [])],
            rows.map((a) => [
              a.profile_name, `${clean(a.name)}${a.primary === true ? " (primary)" : ""}`, a.paused ? "paused" : "active",
              ...(created ? [a.created_at == null ? null : ago(a.created_at, now())] : []), ...(role ? [a.role_line] : []),
            ]),
          );
        });
      };
    } else if (cmd === "webhook") {
      const wh = async (org: () => Promise<string>, id?: string) => `/orgs/${enc(await org())}/webhooks${id ? `/${enc(id)}` : ""}`;
      const row = (w: any) => `${w.id}\t${w.name}\t${w.agent}\t${w.full_tools ? "full-tools" : "-"}\t${w.last_delivery_status ?? "-"}`;
      const rich = (w: any) => webhookBlock(w, now());
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
        plan = async (call, org) => {
          const slug = await org();
          const b = await call("GET", await wh(async () => slug));
          print(io, json, b, () => b.data.map(row).join("\n"), () => b.data.length
            ? table(["ID", "NAME", "AGENT", "TOOLS", "LAST DELIVERY"], b.data.map((w: any) => [w.id, w.name, w.agent, w.full_tools ? "full" : "-", delivery(w.last_delivery_status, w.last_delivery_at, now())]))
            : `No webhooks in ${clean(slug)} yet. Create one:\n  olympus webhook create --name NAME --agent PROFILE --instructions TEXT`);
        };
      } else if (sub === "get") {
        want(3);
        plan = async (call, org) => { const b = await call("GET", await wh(org, arg)); print(io, json, b, () => detail(b.data), () => rich(b.data)); };
      } else if (sub === "create") {
        want(2);
        if (!v.name || !v.agent) throw usage("webhook create needs --name and --agent");
        const instructions = await instr();
        if (instructions === undefined) throw usage("webhook create needs --instructions or --instructions-file");
        const body = { name: v.name, agent: v.agent, instructions, ...(v["full-tools"] === undefined ? {} : { full_tools: v["full-tools"] }) };
        plan = async (call, org) => {
          const b = await call("POST", await wh(org), body);
          print(io, json, b, () => `${detail(b.data)}\nsecret (shown once): ${b.secret}`, () =>
            `${rich(b.data)}\n\nSigning secret (shown once — store it now; it cannot be read again):\n  ${clean(b.secret)}\n${SIGNING}`);
        };
      } else if (sub === "update") {
        want(3);
        const instructions = await instr();
        const body = {
          ...(v.name !== undefined && { name: v.name }), ...(v.agent !== undefined && { agent: v.agent }),
          ...(instructions !== undefined && { instructions }), ...(v["full-tools"] !== undefined && { full_tools: v["full-tools"] }),
        };
        if (!Object.keys(body).length) throw usage("webhook update needs at least one field to change");
        plan = async (call, org) => { const b = await call("PATCH", await wh(org, arg), body); print(io, json, b, () => detail(b.data), () => `Updated webhook ${clean(arg)}.\n\n${rich(b.data)}`); };
      } else if (sub === "delete") {
        want(3);
        if (!v.yes) throw usage("webhook delete needs --yes");
        plan = async (call, org) => {
          await call("DELETE", await wh(org, arg));
          print(io, json, { data: { id: arg, deleted: true } }, () => `deleted ${arg}`, () => `Deleted webhook ${clean(arg)}.`);
        };
      } else throw usage(`unknown webhook command: ${sub ?? ""}`);
    } else if (cmd === "people" || cmd === "tasks" || cmd === "task") {
      plan = taskPlan(pos, v, io, json, now);
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
      const r = await defaultOrg(v.org, io, scoped, me);
      if (!r) return resolveOrg(v.org, io, scoped, me); // nothing resolved: throws resolveOrg's usage error
      if (r.from === "stored") orgFromCreds = r.slug;
      return r.slug;
    };
    await plan(call, org, creds, me, scoped);
    return 0;
  } catch (e) {
    if (e instanceof CliError) return fail(io, json, e, { orgFromCreds: byId ? undefined : orgFromCreds });
    throw e;
  }
}

export function processIo(): Io {
  return {
    env: process.env, home: homedir(), tty: process.stdout.isTTY === true, stdin: () => Bun.stdin.text(),
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
