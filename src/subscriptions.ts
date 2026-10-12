import { print, seg, usage, type Io } from "./core";
import { clean, delivery, keyValue, table, when } from "./format";
import { dash, GLOBAL, type Plan } from "./tasks";

type Opts = Record<string, unknown>;
type Ctx = { pos: string[]; v: Opts; io: Io; json: boolean; now: () => number };

const SIGNING = 'See "Receiving events" in docs/API.md: https://github.com/coba-ai/olympus-cli/blob/main/docs/API.md#receiving-events';
const base = async (org: () => Promise<string>, id?: string) => `/orgs/${seg(await org())}/subscriptions${id === undefined ? "" : `/${seg(id)}`}`;
// created_by is {id,name} or null: one scalar, never JSON.
const by = (x: any) => (typeof x === "string" ? x : x?.id);

// Piped form: fixed lines, known keys only; a secret exists only at the top level of the body.
function detail(s: any): string {
  return [
    ["id", s.id], ["name", s.name], ["url", s.url], ["events", s.events], ["active", String(s.active === true)], ["created_by", by(s.created_by)],
    ["last_delivery_at", s.last_delivery_at], ["last_delivery_status", s.last_delivery_status], ["consecutive_failures", s.consecutive_failures], ["created_at", s.created_at],
  ].map(([k, x]) => `${k}: ${dash(x)}`).join("\n");
}

function block(s: any, now: number): string {
  const st = s.last_delivery_status ?? null;
  return keyValue([
    ["id", clean(s.id)], ["name", clean(s.name)], ["url", clean(s.url)], ["events", s.events?.length ? s.events.map((e: unknown) => clean(e)).join(", ") : null],
    ["active", s.active === true ? "yes" : "no"], ["created by", s.created_by ? clean(s.created_by.name ?? s.created_by.id) : null],
    ["last delivery", delivery(st, null, now) + (st !== null && s.last_delivery_at ? ", " + when(s.last_delivery_at, now) : "")],
    ["failures in a row", dash(s.consecutive_failures)], ["created", when(s.created_at, now)],
  ]);
}

// With a secret (create, rotate): piped appends one line; the TTY block warns and points at the docs.
function shown(c: Ctx, b: any, sentence: string, withSecret: boolean): void {
  const secret = () => (withSecret ? `\nsecret (shown once): ${dash(b.secret)}` : "");
  print(c.io, c.json, b, () => detail(b.data ?? {}) + secret(), () => `${sentence}\n\n${block(b.data ?? {}, c.now())}` +
    (withSecret ? `\n\nSigning secret (shown once — store it now; it cannot be read again):\n  ${clean(b.secret)}\n${SIGNING}` : ""));
}

function body(c: Ctx, create: boolean): Record<string, unknown> {
  const { v } = c, events = (v.event as string[] | undefined) ?? [];
  if (v.active === false || v.inactive === false) throw usage("use --active or --inactive, not --no-active / --no-inactive");
  if (v.active && v.inactive) throw usage("give only one of --active / --inactive");
  const b: Record<string, unknown> = {};
  if (v.name !== undefined) b.name = v.name;
  if (v.url !== undefined) b.url = v.url;
  if (events.length) b.events = events;
  if (v.active) b.active = true;
  if (v.inactive) b.active = false;
  if (create && (!v.name || !v.url || !events.length)) throw usage("subscription create needs --name, --url and --event");
  if (!create && !Object.keys(b).length) throw usage("subscription update needs at least one field to change");
  return b;
}

const rows = (s: any) => [dash(s.id), s.active === true ? "active" : "inactive", dash(s.events), dash(s.last_delivery_status), dash(s.consecutive_failures), dash(s.url), dash(s.name)].join("\t");

// n = expected positionals (including the command word).
type Spec = { flags: string[]; n: number; build: (c: Ctx) => Plan };
const SPECS: Record<string, Spec> = {
  list: { flags: [], n: 2, build: (c) => async (call, org) => {
    const slug = await org(), b = await call("GET", await base(async () => slug)), l: any[] = Array.isArray(b.data) ? b.data : [];
    print(c.io, c.json, b, () => l.map(rows).join("\n"), () => l.length
      ? table(["ID", "NAME", "ACTIVE", "EVENTS", "LAST DELIVERY", "URL"], l.map((s) => [s.id, s.name, s.active === true ? "yes" : "no", dash(s.events), delivery(s.last_delivery_status, s.last_delivery_at, c.now()), s.url]))
      : `No subscriptions in ${clean(slug)} yet. Create one:\n  olympus subscription create --name N --url URL --event task.completed`);
  } },
  get: { flags: [], n: 3, build: (c) => async (call, org) => { const b = await call("GET", await base(org, c.pos[2])); print(c.io, c.json, b, () => detail(b.data ?? {}), () => block(b.data ?? {}, c.now())); } },
  create: { flags: ["name", "url", "event"], n: 2, build: (c) => {
    const b = body(c, true);
    return async (call, org) => { const r = await call("POST", await base(org), b); shown(c, r, `Created subscription ${clean(r.data?.id)}.`, true); };
  } },
  update: { flags: ["name", "url", "event", "active", "inactive"], n: 3, build: (c) => {
    const b = body(c, false);
    return async (call, org) => { const r = await call("PATCH", await base(org, c.pos[2]), b); shown(c, r, `Updated subscription ${clean(c.pos[2])}.`, false); };
  } },
  delete: { flags: ["yes"], n: 3, build: (c) => {
    if (!c.v.yes) throw usage("subscription delete needs --yes");
    const id = c.pos[2]!;
    return async (call, org) => {
      await call("DELETE", await base(org, id));
      print(c.io, c.json, { data: { id, deleted: true } }, () => `deleted ${clean(id)}`, () => `Deleted subscription ${clean(id)}.`);
    };
  } },
  "rotate-secret": { flags: [], n: 3, build: (c) => async (call, org) => {
    const b = await call("POST", (await base(org, c.pos[2])) + "/rotate_secret");
    shown(c, b, `Rotated the signing secret of ${clean(c.pos[2])}.`, true);
  } },
  ping: { flags: [], n: 3, build: (c) => async (call, org) => {
    const b = await call("POST", (await base(org, c.pos[2])) + "/ping"), p = b.data ?? {};
    print(c.io, c.json, b, () => [`delivered: ${p.delivered === true}`, `status: ${dash(p.status)}`, `error: ${dash(p.error)}`].join("\n"),
      () => `Ping to ${clean(c.pos[2])}: ` + (p.delivered === true ? `delivered (${clean(delivery(p.status, null, c.now()))})` : `not delivered (${dash(p.error ?? p.status)})`));
  } },
  "event-types": { flags: [], n: 1, build: (c) => async (call, org) => {
    const b = await call("GET", `/orgs/${seg(await org())}/event_types`), l: unknown[] = Array.isArray(b.data) ? b.data : [];
    print(c.io, c.json, b, () => l.map((x) => clean(x)).join("\n"), () => (l.length ? l.map((x) => clean(x)).join("\n") : "No event types."));
  } },
};

// Validates everything synchronously (usage errors exit 1 before credentials are read), then returns the closure.
export function subscriptionPlan(pos: string[], v: Opts, io: Io, json: boolean, now: () => number): Plan {
  const key = pos[0] === "event-types" ? "event-types" : (pos[1] ?? "");
  // hasOwn: a plain lookup would find Object.prototype keys (constructor, __proto__, ...); event-types is not a subscription subcommand.
  const spec = Object.hasOwn(SPECS, key) && (pos[0] === "event-types") === (key === "event-types") ? SPECS[key] : undefined;
  if (!spec) throw usage(`unknown subscription command: ${pos.slice(1).join(" ")}`);
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || GLOBAL.includes(k)) continue;
    if (!spec.flags.includes(k)) throw usage(`unknown option '--${x === false ? "no-" : ""}${k}' for subscription ${key}`);
  }
  if (pos.length !== spec.n) throw usage(`expected ${spec.n} argument(s) in: ${pos.join(" ")}`);
  if (spec.n === 3) seg(pos[2]!);
  return spec.build({ pos, v, io, json, now });
}
