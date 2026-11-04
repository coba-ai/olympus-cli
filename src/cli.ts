import { parseArgs } from "node:util";
import { createInterface, type Interface } from "node:readline";
import { homedir, hostname } from "node:os";
import {
  CliError, DEFAULT_HOST, api, defaultOrg, envKey, deleteCreds, deviceLogin, fail, loginWithToken, print, readCreds,
  resolveHost, resolveOrg, resolveToken, seg, usage, writeCreds, type Api, type Creds, type Exit, type Io, type Me, type OrgSource,
} from "./core";
import { askPlan } from "./ask";
import { briefingPlan } from "./briefing";
import { browserPlan } from "./browser";
import { crmPlan } from "./crm";
import { dayPlan } from "./days";
import { sessionsPlan } from "./sessions";
import { subscriptionPlan } from "./subscriptions";
import { checkFlags, taskPlan } from "./tasks";
import { ago, clean, delivery, keyValue, table, when } from "./format";

const USAGE = `usage: olympus <command> [flags]
  login [--with-token | --no-browser]   device login (browser approval), or read a token on stdin
  logout | whoami | org list | org use <slug> | agents list
  webhook list | get <id> | delete <id> --yes
  webhook create --name N --agent PROFILE (--instructions T | --instructions-file PATH|-) [--full-tools]
      [--mode run|inbox] [--signature PRESET | --signature-file PATH] [--provider-secret-file PATH|-]
  webhook update <id> [--name N] [--agent P] [--instructions T | --instructions-file PATH|-] [--[no-]full-tools]
      [--mode run|inbox] [--signature PRESET | --signature-file PATH] [--provider-secret-file PATH|-]
  people | tasks [--week D] [--mine | --who ID|me|EMAIL] [--open | --done] [--today] [--tag T]... [--backlog]   (alias: task list)
  tags   (org tags, most used first)
  task get <id> | add TEXT | update <id> | done <id> | undone <id> | today <id> | star <id> | delete <id> --yes
  task update <id> [--text T] [--desc T] [--assign W | --unassign] [--section S] [--tag T]... [--no-tags] [--add-tag T]... [--remove-tag T]...
  task sub add <id> TEXT | sub done <id> <sid> | sub delete <id> <sid> --yes   (all accept --week D)
  task delegate <id> [--to AGENT] | task breakdown <id> [--agent AGENT]   (both accept --week D)
  day [DATE] | day show [DATE] | day list [--week D]   (DATE: YYYY-MM-DD, default today)
  day close [DATE] [--shipped T] [--blocker T]... [--learning T]... [--reflection T] [--draft]
  crm pipelines | crm tags [--entity E] | crm search QUERY [--entity E]
  crm deals [--pipeline ID] [--stage ID|none] [--status S] [--owner EMAIL|me|none] [--q T] [--archived] [--sort S] [--page N]
  crm deal get <id> | add NAME | update <id> | move <id> STAGE_ID | owner <id> EMAIL|me|--none | archive <id> [--undo]
  crm deal add NAME [--pipeline ID] [--stage ID] [--amount N] [--currency C] [--next T] [--owner W] [--company ID | --new-company NAME] [--person ID | --new-person NAME [--person-email E]]
  crm deal update <id> [--name T] [--amount N] [--currency C] [--next T] [--lost-reason T] [--tag T]... | [--no-tags] | [--add-tag T]... [--remove-tag T]... [--version V]
  crm deal company <id> COMPANY_ID | --new NAME   crm deal person <id> PERSON_ID | --new NAME [--email E]
  crm deal note <id> TEXT|-   crm deal task add <id> TITLE [--due ISO] [--assign W]   crm deal task done <id> <task_id> [--undo]
  crm people | companies [--q T] [--archived] [--sort S] [--page N]   crm person|company get <id> | archive <id> [--undo]
  crm person add NAME [--email E] [--phone P] [--job-title T] [--linkedin-url U] [--company ID | --new-company NAME]
  crm company add NAME [--domain D] [--website U] [--industry T] [--linkedin-url U] [--phone P] [--city C]
  crm person|company update <id> [--name T] [field flags as add] [--notes T] [tag flags] [--version V]   (--add/--remove-tag: read then write, not atomic)
  crm deal|person|company delete <id> --yes | deletion-preview <id>   (delete prints the preview first on a terminal)
  crm deal unlink-company <id> | unlink-person <id>   crm task done <task_id> [--undo]
  crm person|company task add <id> TITLE [--due ISO] [--assign W]
  crm pipelines [--archived]   crm pipeline get <id> | archive <id> [--undo]
  crm pipeline add NAME --stage NAME:KIND... [--currency C]...
  crm pipeline update <id> [--name T] [--stage [ID=]NAME:KIND]... [--remove STAGE_ID:MOVE_TO_ID]... [--restore ID]... [--currency C]... [--version V]
  crm creates (add, note, task add, pipeline add) take [--idempotency-key K]; a retry with the same K replays the first result (once the agent machine is updated)
  subscription list | get <id> | delete <id> --yes | rotate-secret <id> | ping <id>
  subscription create --name N --url URL --event T... ('*' = all) | update <id> [--name N] [--url URL] [--event T]... [--active | --inactive]
  event-types   (event names for --event)
  ask AGENT TEXT|- [--session ID] [--timeout SECONDS] [--no-wait]   (exit 1 turn failed, 5 timeout, 6 no agent or session closed)
  sessions [--closed | --all] [--agent SLUG] [--page N]   session get <id> [--after MSG_ID] | session close <id>
  browser attach [CODE] [--name N] [--allow-origin HOST[:PORT]]...   lend this computer's browser to the org's agent
    CODE comes from Settings → Rafita; omit it to re-attach this computer. Holds the connection until Ctrl-C.
    The browser starts when the agent's workbench connects, in a throwaway profile, and all of its traffic leaves through the organization.
  briefing [--day YYYY-MM-DD] [--request]   version | --version
global flags: --json --host URL --org SLUG -h
env: OLYMPUS_API_KEY OLYMPUS_HOST OLYMPUS_ORG OLYMPUS_CHROME
exit: 0 ok, 1 usage, 2 auth, 3 not found, 4 forbidden, 5 server/network, 6 invalid or conflict, 130 cancelled
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
  "add-tag": { type: "string", multiple: true }, "remove-tag": { type: "string", multiple: true },
  to: { type: "string" }, shipped: { type: "string" }, reflection: { type: "string" },
  blocker: { type: "string", multiple: true }, learning: { type: "string", multiple: true }, draft: { type: "boolean" },
  stage: { type: "string", multiple: true }, currency: { type: "string", multiple: true },
  remove: { type: "string", multiple: true }, restore: { type: "string", multiple: true }, "idempotency-key": { type: "string" },
  ...Object.fromEntries(("entity pipeline status owner q sort page amount next company new-company person new-person " +
    "person-email lost-reason version new email due phone job-title linkedin-url notes domain website industry city url").split(" ")
    .map((k) => [k, { type: "string" }])),
  mode: { type: "string" }, signature: { type: "string" }, "signature-file": { type: "string" }, "provider-secret-file": { type: "string" },
  event: { type: "string", multiple: true }, "allow-origin": { type: "string", multiple: true },
  session: { type: "string" }, timeout: { type: "string" }, after: { type: "string" }, day: { type: "string" },
  wait: { type: "boolean" }, closed: { type: "boolean" }, all: { type: "boolean" }, request: { type: "boolean" },
  archived: { type: "boolean" }, none: { type: "boolean" }, active: { type: "boolean" }, inactive: { type: "boolean" },
} as const;
const LEGACY = ["yes", "name", "agent", "instructions", "instructions-file", "full-tools", "with-token", "browser"];
// Set by `bun build --define OLYMPUS_VERSION=...` on a tagged release; source and local builds report "dev".
declare const OLYMPUS_VERSION: string;
const VERSION = typeof OLYMPUS_VERSION === "string" ? OLYMPUS_VERSION : "dev";
const SOURCE: Record<OrgSource, string> = {
  flag: "--org", env: "OLYMPUS_ORG", pin: "token pin", stored: "saved by olympus org use", only: "only membership",
};
const SIGNING = 'See "Delivering to a webhook" in docs/API.md: https://github.com/coba-ai/olympus-cli/blob/main/docs/API.md#delivering-to-a-webhook';
const KNOWN = new Set(["id", "name", "agent", "full_tools", "url", "last_delivery_at", "last_delivery_status", "created_at", "instructions", "mode", "signature", "secret_set", "approval", "approved_at", "created_via", "provider_secret"]);
// Piped text prints only these, in the order the server sent them. A field the server adds cannot change that stdout.
const PIPED_KEYS = new Set(["id", "name", "agent", "full_tools", "url", "last_delivery_at", "last_delivery_status", "created_at", "instructions"]);
const PRESETS = ["olympus", "svix", "standard-webhooks", "github", "stripe", "linear", "calcom", "circleback", "gitlab-token"];
const PENDING_HINT = "an owner must approve this in Olympus → Webhooks";
const REJECTED_HINT = "an owner rejected this; fix it and update to resubmit";
// Same names the companion's parseSignature rejects, except `authorization`: a token scheme names that header, and the platform reads the inbound Authorization value under another name.
const DENIED_HEADERS = new Set(["cookie", "proxy-authorization", "host", "connection", "keep-alive", "content-length", "transfer-encoding", "te", "trailer", "upgrade", "expect", "via", "forwarded", "x-real-ip", "version"]);

function refuseSecretOnArgv(argv: string[]): void {
  for (const a of argv) {
    if (a === "--provider-secret" || a.startsWith("--provider-secret="))
      throw usage("pass the provider secret with --provider-secret-file PATH|- (never on the command line)");
  }
}

function stripOneTrailingNewline(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  return s;
}

function validHeaderName(value: unknown): value is string {
  return typeof value === "string" && value === value.toLowerCase() && /^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(value) &&
    !DENIED_HEADERS.has(value) && !value.startsWith("x-forwarded-") && !value.startsWith("fly-") && !value.startsWith("x-olympus-");
}

// Preset names stay on --signature. A file is only a custom object, checked the same way the platform parses one.
function customSignature(input: unknown): Record<string, unknown> {
  if (typeof input === "string") throw usage("a signature file must be a custom scheme object; pass a preset with --signature");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw usage("signature file must be a JSON object");
  const value = input as Record<string, unknown>;
  if (value.kind === "token") {
    if (Object.keys(value).some((k) => k !== "kind" && k !== "header" && k !== "prefix") || !validHeaderName(value.header))
      throw usage("token signature needs {kind:\"token\", header} with a lowercase header name");
    if (value.prefix !== undefined && (typeof value.prefix !== "string" || value.prefix.length > 32 || !/^[\x20-\x7e]*$/.test(value.prefix)))
      throw usage("token signature prefix must be a string of at most 32 printable ASCII characters");
    return { kind: "token", header: value.header, ...(value.prefix === undefined ? {} : { prefix: value.prefix }) };
  }
  if (value.kind !== "hmac") throw usage("signature kind must be hmac or token");
  const allowed = ["kind", "header", "encoding", "prefix", "signed", "timestamp_header", "id_header", "tolerance_s"];
  if (Object.keys(value).some((k) => !allowed.includes(k))) throw usage("signature object has an unknown field");
  if (!validHeaderName(value.header)) throw usage("signature header must be a lowercase header name");
  if (value.encoding !== "hex" && value.encoding !== "base64") throw usage("signature encoding must be hex or base64");
  if (value.signed !== "body" && value.signed !== "ts.body" && value.signed !== "id.ts.body")
    throw usage("signature signed must be body, ts.body or id.ts.body");
  if (value.prefix !== undefined && typeof value.prefix !== "string") throw usage("signature prefix must be a string");
  if (value.signed !== "body" && !validHeaderName(value.timestamp_header)) throw usage("signature timestamp_header must be a lowercase header name");
  if (value.signed === "id.ts.body" && !validHeaderName(value.id_header)) throw usage("signature id_header must be a lowercase header name");
  if (value.signed === "body" && (value.timestamp_header !== undefined || value.id_header !== undefined))
    throw usage("a body signature does not take timestamp_header or id_header");
  if (value.signed === "ts.body" && value.id_header !== undefined) throw usage("a ts.body signature does not take id_header");
  if (value.tolerance_s !== undefined && (!Number.isSafeInteger(value.tolerance_s) || (value.tolerance_s as number) < 0))
    throw usage("signature tolerance_s must be a non-negative integer");
  return {
    kind: "hmac", header: value.header, encoding: value.encoding,
    ...(value.prefix === undefined ? {} : { prefix: value.prefix }), signed: value.signed,
    ...(value.timestamp_header === undefined ? {} : { timestamp_header: value.timestamp_header }),
    ...(value.id_header === undefined ? {} : { id_header: value.id_header }),
    ...(value.tolerance_s === undefined ? {} : { tolerance_s: value.tolerance_s }),
  };
}

function approvalHints(body: any): string[] {
  const data = body?.data;
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  const states = new Set(rows.map((w) => w?.approval));
  const hints: string[] = [];
  if (states.has("pending")) hints.push(PENDING_HINT);
  if (states.has("rejected")) hints.push(REJECTED_HINT);
  return hints;
}

// Drop a provider secret if a server ever echoes one. No such key leaves the same body, so --json stays byte-identical.
function withoutProviderSecret(body: any): any {
  if (!body || typeof body !== "object") return body;
  const has = (w: any) => !!w && typeof w === "object" && !Array.isArray(w) && Object.prototype.hasOwnProperty.call(w, "provider_secret");
  const drop = (w: any) => { const { provider_secret, ...rest } = w; return rest; };
  const leaked = has(body) || (Array.isArray(body.data) ? body.data.some(has) : has(body.data));
  if (!leaked) return body;
  const data = Array.isArray(body.data) ? body.data.map((w: any) => has(w) ? drop(w) : w) : has(body.data) ? drop(body.data) : body.data;
  const { provider_secret, ...rest } = body;
  return body.data === undefined ? rest : { ...rest, data };
}

// TTY text puts the hint on stdout. Piped text leaves stdout alone and prints the hint on stderr. --json carries `hint` and also prints it on stderr.
function emitWebhook(io: Io, json: boolean, body: any, human: () => string, rich?: () => string): void {
  const shown = withoutProviderSecret(body);
  const hints = approvalHints(shown);
  const hintText = hints.join("\n");
  if (hintText && (json || !io.tty)) io.err(hintText + "\n");
  const onStdout = hintText && !json && io.tty ? `\n${hintText}` : "";
  print(io, json, hintText ? { ...shown, hint: hintText } : shown, () => human() + onStdout, rich ? () => rich() + onStdout : undefined);
}

// TTY block: known keys in a fixed order, then any key the server added, then instructions. Piped text does not use this.
function webhookBlock(w: any, now: number): string {
  const pairs: [string, string | null | undefined][] = [];
  const has = (k: string) => w[k] !== undefined;
  for (const k of ["id", "name", "agent"]) if (has(k)) pairs.push([k, clean(w[k])]);
  if (has("full_tools")) pairs.push(["full tools", w.full_tools ? "yes" : "no"]);
  if (has("mode")) pairs.push(["mode", clean(w.mode)]);
  if (has("signature")) pairs.push(["signature", w.signature !== null && typeof w.signature === "object" ? JSON.stringify(w.signature) : clean(w.signature)]);
  if (has("secret_set")) pairs.push(["secret set", w.secret_set == null ? null : clean(w.secret_set)]);
  if (has("approval")) pairs.push(["approval", clean(w.approval)]);
  if (has("approved_at")) pairs.push(["approved at", w.approved_at == null ? null : when(w.approved_at, now)]);
  if (has("created_via")) pairs.push(["created via", w.created_via == null ? null : clean(w.created_via)]);
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
  // `ask` and `browser attach` only: aborted by Ctrl-C (a listener around each) or by io.signal; other commands never see it.
  const ctl = new AbortController();
  const signal = io.signal ? AbortSignal.any([ctl.signal, io.signal]) : ctl.signal;
  if (argv.length === 1 && argv[0] === "--version") { io.out(`olympus ${VERSION}\n`); return 0; }
  let byId = false; // webhook <verb> <id>: a 404 may be the webhook, not the org, so no stored-org hint
  try {
    refuseSecretOnArgv(argv);
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true, allowNegative: true });
    } catch (e) {
      throw usage((e as Error).message);
    }
    const { values: v, positionals: pos } = parsed;
    json = !!v.json;
    // stage/currency repeat only for `crm pipeline`; everywhere else the last one wins and stays a string.
    if (!(pos[0] === "crm" && pos[1] === "pipeline"))
      for (const k of ["stage", "currency"] as const) if (v[k]) (v as Record<string, unknown>)[k] = v[k]!.at(-1);
    // These commands validate no flags of their own: only global + legacy flags are theirs; the modules check the rest.
    const head = pos[0] ?? "";
    if (head === "webhook") {
      const writing = pos[1] === "create" || pos[1] === "update";
      checkFlags(v, writing ? [...LEGACY, "mode", "signature", "signature-file", "provider-secret-file"] : LEGACY);
    } else if (["login", "logout", "whoami", "org", "agents"].includes(head)) {
      checkFlags(v, LEGACY);
    }
    if (v.help) { io.out(USAGE); return 0; }
    if (!pos.length) { io.err(USAGE); return 1; }
    const [cmd, sub, arg] = pos;
    byId = (cmd === "webhook" && arg !== undefined) || (cmd === "task" && pos.length >= 3 && sub !== "list" && sub !== "add") ||
      (cmd === "crm" && pos.length >= 4 && pos[2] !== "add") || (cmd === "subscription" && pos.length >= 3 && sub !== "create") ||
      (cmd === "session" && pos.length >= 3) || (cmd === "ask" && v.session !== undefined);
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

    if (cmd === "version") {
      want(1);
      checkFlags(v, []);
      print(io, json, { data: { version: VERSION } }, () => `olympus ${VERSION}`);
      return 0;
    }

    // Pre-authentication, like login: pairing reads no bearer and attaching carries the obm_ machine
    // token, so the authenticated path below would exit 2 on resolveToken before the command ran.
    if (cmd === "browser") {
      const attach = browserPlan(pos, v, io, json);
      host = resolveHost(v.host, io, await readCreds(io));
      // Ctrl-C is the normal way to end a long-running attach; `ask` wires it the same way.
      const abort = () => ctl.abort();
      process.once("SIGINT", abort);
      try {
        await attach(host, signal);
      } catch (e) {
        // attach() has already printed this one, ahead of its final `--json` exit line; fail() here
        // would print it a second time and put the reason after the exit code.
        if (e instanceof CliError) return e.exit;
        throw e;
      } finally {
        process.off("SIGINT", abort);
      }
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
        const body = await call("GET", `/orgs/${seg(slug)}/agents`);
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
      const wh = async (org: () => Promise<string>, id?: string) => `/orgs/${seg(await org())}/webhooks${id === undefined ? "" : `/${seg(id)}`}`;
      const rich = (w: any) => webhookBlock(w, now());
      const detail = (w: any) => Object.entries(w).filter(([k]) => PIPED_KEYS.has(k)).map(([k, x]) => `${k}: ${x !== null && typeof x === "object" ? JSON.stringify(x) : x}`).join("\n");
      const readPath = async (path: string, label: string) => {
        if (path === "-") return io.stdin();
        try { return await Bun.file(path).text(); } catch { throw usage(`cannot read ${label} file: ${path}`); }
      };
      const instr = async () => {
        const [t, f] = [v.instructions, v["instructions-file"]];
        if (t !== undefined && f !== undefined) throw usage("give only one of --instructions / --instructions-file");
        if (f === undefined) return t;
        if (f === "-") return io.stdin();
        try { return await Bun.file(f).text(); } catch { throw usage(`cannot read instructions file: ${f}`); }
      };
      // Create and update only. Reads happen before any request; a usage error leaves the server untouched.
      const writeOpts = async () => {
        if (v.mode !== undefined && v.mode !== "run" && v.mode !== "inbox") throw usage("--mode must be run or inbox");
        const [sig, sigFile] = [v.signature, v["signature-file"]];
        if (sig !== undefined && sigFile !== undefined) throw usage("give only one of --signature / --signature-file");
        if (sig !== undefined && !PRESETS.includes(sig)) throw usage(`--signature must be one of: ${PRESETS.join(", ")}`);
        if (v["instructions-file"] === "-" && v["provider-secret-file"] === "-")
          throw usage("stdin can only supply one of --instructions-file / --provider-secret-file");
        let signature: string | Record<string, unknown> | undefined = sig;
        if (sigFile !== undefined) {
          if (sigFile === "-") throw usage("--signature-file reads a path, not stdin");
          let parsed: unknown;
          try { parsed = JSON.parse(await readPath(sigFile, "signature")); } catch (e) { if (e instanceof CliError) throw e; throw usage("signature file is not valid JSON"); }
          signature = customSignature(parsed);
        }
        let providerSecret: string | undefined;
        const secretFile = v["provider-secret-file"];
        if (secretFile !== undefined) {
          if (secretFile === "") throw usage("--provider-secret-file needs a path or -");
          providerSecret = stripOneTrailingNewline(await readPath(secretFile, "provider secret"));
          if (providerSecret === "") throw usage("provider secret file is empty");
        }
        return {
          ...(v.mode !== undefined && { mode: v.mode }),
          ...(signature !== undefined && { signature }),
          ...(providerSecret !== undefined && { provider_secret: providerSecret }),
        };
      };
      const secretLine = (b: any) => (b.secret == null ? "" : `\nsecret (shown once): ${b.secret}`);
      const secretRich = (b: any) => (b.secret == null ? "" : `\n\nSigning secret (shown once — store it now; it cannot be read again):\n  ${clean(b.secret)}\n${SIGNING}`);
      if (sub === "list") {
        want(2);
        plan = async (call, org) => {
          const slug = await org();
          const b = await call("GET", await wh(async () => slug));
          const rows: any[] = b.data;
          const showApproval = rows.some((w) => w.approval !== undefined);
          const line = (w: any) => [w.id, w.name, w.agent, w.full_tools ? "full-tools" : "-", w.last_delivery_status ?? "-"].join("\t");
          const none = `No webhooks in ${clean(slug)} yet. Create one:\n  olympus webhook create --name NAME --agent PROFILE --instructions TEXT`;
          emitWebhook(io, json, b, () => rows.length ? rows.map(line).join("\n") : "", () => rows.length
            ? table(["ID", "NAME", "AGENT", "TOOLS", "LAST DELIVERY", ...(showApproval ? ["APPROVAL"] : [])], rows.map((w) => [w.id, w.name, w.agent, w.full_tools ? "full" : "-", delivery(w.last_delivery_status, w.last_delivery_at, now()), ...(showApproval ? [w.approval ?? null] : [])]))
            : none);
        };
      } else if (sub === "get") {
        want(3);
        seg(arg!);
        plan = async (call, org) => { const b = await call("GET", await wh(org, arg)); emitWebhook(io, json, b, () => detail(b.data), () => rich(b.data)); };
      } else if (sub === "create") {
        want(2);
        if (!v.name || !v.agent) throw usage("webhook create needs --name and --agent");
        const instructions = await instr();
        if (instructions === undefined) throw usage("webhook create needs --instructions or --instructions-file");
        const extra = await writeOpts();
        const body = { name: v.name, agent: v.agent, instructions, ...(v["full-tools"] === undefined ? {} : { full_tools: v["full-tools"] }), ...extra };
        plan = async (call, org) => {
          const b = await call("POST", await wh(org), body);
          emitWebhook(io, json, b, () => detail(b.data) + secretLine(b), () => rich(b.data) + secretRich(b));
        };
      } else if (sub === "update") {
        want(3);
        seg(arg!);
        const instructions = await instr();
        const extra = await writeOpts();
        const body = {
          ...(v.name !== undefined && { name: v.name }), ...(v.agent !== undefined && { agent: v.agent }),
          ...(instructions !== undefined && { instructions }), ...(v["full-tools"] !== undefined && { full_tools: v["full-tools"] }),
          ...extra,
        };
        if (!Object.keys(body).length) throw usage("webhook update needs at least one field to change");
        plan = async (call, org) => { const b = await call("PATCH", await wh(org, arg), body); emitWebhook(io, json, b, () => detail(b.data), () => `Updated webhook ${clean(arg)}.\n\n${rich(b.data)}`); };
      } else if (sub === "delete") {
        want(3);
        seg(arg!);
        if (!v.yes) throw usage("webhook delete needs --yes");
        plan = async (call, org) => {
          await call("DELETE", await wh(org, arg));
          print(io, json, { data: { id: arg, deleted: true } }, () => `deleted ${arg}`, () => `Deleted webhook ${clean(arg)}.`);
        };
      } else throw usage(`unknown webhook command: ${sub ?? ""}`);
    } else if (cmd === "people" || cmd === "tasks" || cmd === "task" || cmd === "tags") {
      plan = taskPlan(pos, v, io, json, now);
    } else if (cmd === "day") {
      plan = dayPlan(pos, v, io, json, now);
    } else if (cmd === "crm") {
      plan = crmPlan(pos, v, io, json, now);
    } else if (cmd === "subscription" || cmd === "event-types") {
      plan = subscriptionPlan(pos, v, io, json, now);
    } else if (cmd === "sessions" || cmd === "session") {
      plan = sessionsPlan(pos, v, io, json, now);
    } else if (cmd === "briefing") {
      plan = briefingPlan(pos, v, io, json, now);
    } else if (cmd === "ask") {
      plan = await askPlan(pos, v, io, json, now, signal);
    } else throw usage(`unknown command: ${pos.join(" ")}`);

    // An env key makes a malformed file irrelevant, except to `org use`, which would overwrite what it cannot read.
    const creds = await readCreds(io).catch((e) => {
      if (e instanceof CliError && e.body.error.code === "credentials_malformed" && envKey(io) && !(cmd === "org" && sub === "use")) return {} as Creds;
      throw e;
    });
    host = resolveHost(v.host, io, creds);
    // A stored org belongs to the host it was saved for.
    const scoped: Creds = { ...creds, org: creds.host === host ? creds.org : undefined };
    const call = api(host, resolveToken(host, io, creds), undefined, cmd === "ask" ? signal : undefined);
    let meCache: Promise<Me> | undefined;
    const me = () => (meCache ??= call("GET", "/me").then((b) => b.data as Me));
    const org = async () => {
      const r = await defaultOrg(v.org, io, scoped, me);
      if (!r) return resolveOrg(v.org, io, scoped, me); // nothing resolved: throws resolveOrg's usage error
      if (r.from === "stored") orgFromCreds = r.slug;
      return r.slug;
    };
    if (cmd !== "ask") {
      await plan(call, org, creds, me, scoped);
      return 0;
    }
    // Attached only here: askPlan has already read stdin, so Ctrl-C while typing keeps its default behaviour.
    const abort = () => ctl.abort();
    process.once("SIGINT", abort);
    try {
      await plan(call, org, creds, me, scoped);
    } finally {
      process.off("SIGINT", abort);
    }
    return 0;
  } catch (e) {
    if (e instanceof CliError) return fail(io, json, e, { orgFromCreds: byId ? undefined : orgFromCreds });
    throw e;
  }
}

type LineReader = Pick<Interface, "on" | "setPrompt" | "prompt" | "close">;

// Measured on Bun 1.3: question() drops lines that arrive between questions and a pending one never settles on close,
// so lines are queued here instead. Ctrl-C reaches readline as a "SIGINT" event only once the tty is raw; before that
// the default signal kills the process (also 130).
const cancel = () => new CliError(130, { error: { code: "cancelled", message: "cancelled; nothing was saved" } });

export function lineAsker(rl: LineReader): (prompt: string) => Promise<string | null> {
  let closed = false;
  let cancelled = false; // sticky: Ctrl-C also voids answers that were typed ahead
  const typed: string[] = []; // lines that arrived while no question was pending (type-ahead, paste)
  let pending: { res: (s: string | null) => void; rej: (e: Error) => void } | undefined;
  rl.on("line", (l) => { const p = pending; pending = undefined; if (p) p.res(l); else typed.push(l); });
  rl.on("close", () => { closed = true; const p = pending; pending = undefined; p?.res(null); });
  rl.on("SIGINT", () => {
    const p = pending;
    pending = undefined;
    cancelled = true;
    typed.length = 0;
    rl.close();
    p?.rej(cancel());
  });
  return (prompt) => {
    if (cancelled) return Promise.reject(cancel());
    if (typed.length) return Promise.resolve(typed.shift()!);
    if (closed) return Promise.resolve(null);
    const p = new Promise<string | null>((res, rej) => { pending = { res, rej }; });
    rl.setPrompt(prompt); // pending is set first so an event emitted synchronously by prompt() settles this ask
    rl.prompt();
    return p;
  };
}

export function processIo(): Io {
  let rl: Interface | undefined;
  let asker: ReturnType<typeof lineAsker> | undefined;
  const ask = (prompt: string) => {
    if (!asker) {
      rl = createInterface({ input: process.stdin, output: process.stderr });
      asker = lineAsker(rl);
    }
    return asker(prompt);
  };
  return {
    env: process.env, home: homedir(), tty: process.stdout.isTTY === true, stdin: () => Bun.stdin.text(),
    out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s),
    ...(process.stdin.isTTY && process.stderr.isTTY ? { ask } : {}), close: () => rl?.close(),
    openBrowser: (url) => {
      try {
        Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
      } catch {}
    },
  };
}

if (import.meta.main) {
  const io = processIo();
  try {
    process.exitCode = await run(process.argv.slice(2), io);
  } catch (e) {
    process.stderr.write(`error: internal: ${(e as Error)?.message ?? String(e)}\n`);
    process.exitCode = 5;
  } finally {
    io.close?.();
  }
}
