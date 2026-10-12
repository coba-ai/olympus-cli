import { print, seg, usage, type Api, type Io } from "./core";
import { clean, keyValue, table, when } from "./format";
import { dash, GLOBAL, type Plan } from "./tasks";

type Opts = Record<string, unknown>;
type Ctx = { pos: string[]; v: Opts; io: Io; json: boolean; now: () => number };
type Kind = "deal" | "person" | "company";
type Spec = { flags: string[]; n: number | ((v: Opts) => number); build: (c: Ctx) => Plan };

// Field names each renderer reads from the server. Nothing else is printed, so a server field change is a one-line edit here.
const DEAL = ["id", "name", "status", "pipeline", "stage", "amount", "currency", "owner_email", "next_action", "lost_reason", "company", "person", "tags", "archived", "in_stage_since", "updated_at", "version"];
const PERSON = ["id", "full_name", "email", "phone", "job_title", "linkedin_url", "company", "tags", "archived", "version", "notes"];
const COMPANY = ["id", "name", "domain", "website", "industry", "linkedin_url", "phone", "city", "tags", "archived", "version", "notes"];
const DEAL_ROW = ["id", "status", "pipeline", "stage", "amount", "currency", "owner_email", "company_name", "tags", "name"];
const PERSON_ROW = ["id", "email", "company", "job_title", "open_deals", "tags", "full_name"];
const COMPANY_ROW = ["id", "domain", "city", "open_deals", "tags", "name"];
const DEAL_TTY = ["id", "name", "status", "stage", "amount", "currency", "owner_email", "company_name", "tags"];
const PERSON_TTY = ["id", "full_name", "email", "company", "job_title", "open_deals", "tags"];
const COMPANY_TTY = ["id", "name", "domain", "city", "open_deals", "tags"];
const NOTE = ["id", "created_at", "author", "body"], TASK = ["id", "status", "due_at", "assignee", "title"];
const DEAL_REF = ["id", "status", "stage", "name"], PERSON_REF = ["id", "email", "full_name"];
const PERSON_FIELDS = ["email", "phone", "job-title", "linkedin-url"];
const COMPANY_FIELDS = ["domain", "website", "industry", "linkedin-url", "phone", "city"];
// [prefix of the piped line, key in the record, columns]
const KIND: Record<Kind, { path: string; fields: string[]; rels: [string, string, string[]][] }> = {
  deal: { path: "deals", fields: DEAL, rels: [["note", "notes", NOTE], ["task", "tasks", TASK]] },
  person: { path: "people", fields: PERSON, rels: [["deal", "deals", DEAL_REF]] },
  company: { path: "companies", fields: COMPANY, rels: [["person", "people", PERSON_REF], ["deal", "deals", DEAL_REF]] },
};

const obj = (x: any) => !!x && typeof x === "object" && !Array.isArray(x);
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
// A reference arrives as {id, ...} or, from an older server, as a bare id.
const ref = (x: any) => (obj(x) ? x.id : x);
const sc = (x: any) => (typeof x === "string" ? x : x?.email ?? x?.name ?? x?.id);
const REF = ["pipeline", "stage", "company", "person"], SC = ["author", "assignee"];
const cell = (f: string, x: any) => (f === "archived" ? String(x === true) : REF.includes(f) ? dash(ref(x)) : SC.includes(f) ? dash(sc(x)) : dash(x));
const row = (cols: string[], r: any) => cols.map((f) => cell(f, r?.[f])).join("\t");
// TTY: names in place of ids.
const nm = (x: any): string | null => {
  const y = obj(x) ? x.name ?? x.full_name ?? x.id : Array.isArray(x) ? (x.length ? x.join(",") : null) : x;
  return y == null || y === "" ? null : String(y);
};
const tt = (f: string, x: any, now: number): string | null =>
  f.endsWith("_at") || f === "in_stage_since" ? (x == null ? null : when(x, now)) : SC.includes(f) ? nm(sc(x)) : f === "archived" ? (x === true ? "yes" : null) : nm(x);

const detail = (kind: Kind, d: any) => [
  ...KIND[kind].fields.map((f) => `${f}: ${cell(f, d[f])}`),
  ...KIND[kind].rels.flatMap(([p, key, cols]) => arr(d[key]).map((r) => `${p}: ${row(cols, r)}`)),
].join("\n");

function block(kind: Kind, d: any, now: number): string {
  const secs = KIND[kind].rels.filter(([, key]) => arr(d[key]).length).map(([, key, cols]) =>
    `\n\n${key}:\n` + arr(d[key]).map((r) => "  " + cols.map((c) => clean(tt(c, r?.[c], now) ?? "-")).join("  ")).join("\n"));
  return keyValue(KIND[kind].fields.map((f) => [f.replace(/_/g, " "), tt(f, d[f], now)])) + secs.join("");
}

const crm = async (org: () => Promise<string>, rest: string) => `/orgs/${seg(await org())}/crm${rest}`;
const dp = (id: string, rest = "") => `/deals/${seg(id)}${rest}`;
const kv = (fs: string[]) => fs.map((f) => [f, f.replace(/-/g, "_")]);
const fill = (b: Opts, v: Opts, pairs: string[][]) => { for (const [f, k] of pairs) if (v[f!] !== undefined) b[k!] = v[f!]; return b; };
const list = (c: Ctx, k: string) => (c.v[k] as string[] | undefined) ?? [];

const QS = ["pipeline", "stage", "status", "owner", "q", "archived", "sort", "page", "entity"];
function qs(v: Opts, first?: [string, string]): string {
  const p = new URLSearchParams(first ? [first] : []);
  for (const k of QS) { const x = k === "archived" ? (v.archived ? "only" : undefined) : v[k]; if (x !== undefined) p.set(k, String(x)); }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ---- reads
const show = (c: Ctx, kind: Kind, b: any, sentence?: string) => print(c.io, c.json, b, () => detail(kind, b.data ?? {}),
  () => (sentence ? `${sentence}\n\n` : "") + block(kind, b.data ?? {}, c.now()));

function get(c: Ctx, kind: Kind): Plan {
  const rel = `/${KIND[kind].path}/${seg(c.pos[3]!)}`;
  return async (call, org) => show(c, kind, await call("GET", await crm(org, rel)));
}

// key: where the rows sit in data (null = data is the array). The paging footer needs total/page/per, which only list bodies carry.
function lst(c: Ctx, url: string, key: string | null, cols: string[], tty: string[], empty: string): Plan {
  return async (call, org) => {
    const b = await call("GET", await crm(org, url));
    const d = b.data ?? {}, rows = arr(key ? d[key] : d);
    print(c.io, c.json, b, () => rows.map((r) => row(cols, r)).join("\n"), () => {
      if (!rows.length) return empty;
      const p = Number(d.page) || 1, per = Number(d.per) || rows.length, total = Number(d.total), more = p * per < total;
      const foot = Number.isFinite(total) && (more || p > 1) ? `\n\nPage ${p} · showing ${rows.length} of ${total}.${more ? ` Next: --page ${p + 1}` : ""}` : "";
      return table(tty.map((f) => f.toUpperCase().replace(/_/g, " ")), rows.map((r) => tty.map((f) => tt(f, r?.[f], c.now())))) + foot;
    });
  };
}

function pipelines(c: Ctx): Plan {
  return async (call, org) => {
    const b = await call("GET", await crm(org, "/pipelines"));
    const ps = arr(b.data);
    print(c.io, c.json, b, () => ps.flatMap((p) => [
      [dash(p?.id), "pipeline", dash(p?.currencies), dash(p?.name)].join("\t"),
      ...arr(p?.stages).map((s) => [dash(s?.id), `stage:${dash(p?.id)}`, dash(s?.kind), dash(s?.name)].join("\t")),
    ]).join("\n"), () => ps.length ? table(["ID", "NAME", "INFO"], ps.flatMap((p) => [
      [nm(p?.id), nm(p?.name), nm(p?.currencies)], ...arr(p?.stages).map((s) => ["  " + nm(s?.id), "  " + nm(s?.name), nm(s?.kind)]),
    ])) : "No pipelines.");
  };
}

function tags(c: Ctx): Plan {
  return async (call, org) => {
    const b = await call("GET", await crm(org, `/tags${qs(c.v)}`));
    const rows = arr(b.data).map((x) => clean(x));
    print(c.io, c.json, b, () => rows.join("\n"), () => (rows.length ? rows.join("\n") : "No tags."));
  };
}

function search(c: Ctx): Plan {
  if (!c.pos[2]) throw usage("crm search needs a query");
  return lst(c, `/search${qs(c.v, ["q", c.pos[2]])}`, null, ["entity", "id", "sub", "label"], ["entity", "id", "label", "sub"], "No matches.");
}

// ---- writes: each build() throws its usage errors synchronously, before the closure exists.
type Method = Parameters<Api>[0];
// body may be a function when it needs I/O (stdin); it runs before any request.
const w = (c: Ctx, kind: Kind, method: Method, rel: string, body: unknown, say: (d: any) => string): Plan => async (call, org) => {
  const bd = typeof body === "function" ? await body() : body;
  const b = await call(method, await crm(org, rel), bd);
  show(c, kind, b, say(b.data ?? {}));
};
const pickRef = (v: Opts, id: string, nw: string, nameKey: string, extra: Opts = {}) => {
  if (v[id] !== undefined && v[nw] !== undefined) throw usage(`give only one of --${id} / --${nw}`);
  return v[id] !== undefined ? { id: v[id] } : v[nw] !== undefined ? { [nameKey]: v[nw], ...extra } : undefined;
};
const id3 = (c: Ctx) => clean(c.pos[3]);

const DEAL_ADD = kv(["pipeline", "stage", "amount", "currency", "owner"]).concat([["next", "next_action"]]);
function dealAdd(c: Ctx): Plan {
  const { v } = c;
  if (v["person-email"] !== undefined && v["new-person"] === undefined) throw usage("--person-email needs --new-person");
  const body = fill({ name: c.pos[3] }, v, DEAL_ADD);
  const co = pickRef(v, "company", "new-company", "name");
  const pe = pickRef(v, "person", "new-person", "full_name", v["person-email"] === undefined ? {} : { email: v["person-email"] });
  if (co) body.company = co;
  if (pe) body.person = pe;
  return w(c, "deal", "POST", "/deals", body, (d) => `Added deal ${dash(d.id)}.`);
}

function update(c: Ctx, kind: Kind, pairs: string[][]): Plan {
  const { v } = c;
  const set = list(c, "tag").length > 0, addT = list(c, "add-tag"), rem = list(c, "remove-tag"), rmw = addT.length + rem.length > 0;
  if (set && v.tags === false) throw usage("give only one of --tag / --no-tags");
  if (rmw && (set || v.tags === false)) throw usage("--add-tag / --remove-tag cannot be combined with --tag or --no-tags");
  const body = fill({}, v, pairs);
  if (set) body.tags = list(c, "tag");
  if (v.tags === false) body.tags = [];
  if (!Object.keys(body).length && !rmw) throw usage(`crm ${kind} update needs at least one field to change`);
  if (v.version !== undefined) body.version = v.version;
  const rel = `/${KIND[kind].path}/${seg(c.pos[3]!)}`;
  return async (call, org) => {
    const path = await crm(org, rel);
    if (rmw) {
      // Read then write: not atomic. The GET's version rides in the PATCH so a change in between is a 409, not a lost edit.
      const g = await call("GET", path);
      const keep = arr(g.data?.tags).filter((t) => !rem.includes(t));
      body.tags = [...keep, ...addT.filter((t, i) => !keep.includes(t) && addT.indexOf(t) === i)];
      if (v.version === undefined && typeof g.data?.version === "string") body.version = g.data.version;
    }
    show(c, kind, await call("PATCH", path, body), `Updated ${kind} ${id3(c)}.`);
  };
}

const archive = (kind: Kind): Spec => ({
  flags: ["undo"], n: 4,
  build: (c) => w(c, kind, "POST", `/${KIND[kind].path}/${seg(c.pos[3]!)}/archive`, { archived: !c.v.undo }, () => `${c.v.undo ? "Restored" : "Archived"} ${kind} ${id3(c)}.`),
});

const TAGF = ["tag", "tags", "add-tag", "remove-tag"];
// person and company differ only in these parameters.
function entity(kind: "person" | "company", nameKey: string, fields: string[]): Record<string, Spec> {
  const upd = [["name", nameKey], ...kv([...fields, "notes"])];
  return {
    [`${kind} get`]: { flags: [], n: 4, build: (c) => get(c, kind) },
    [`${kind} add`]: {
      flags: [...fields, ...(kind === "person" ? ["company", "new-company"] : [])], n: 4,
      build: (c) => {
        const body = fill({ [nameKey]: c.pos[3] }, c.v, kv(fields));
        const co = pickRef(c.v, "company", "new-company", "name");
        if (co) body.company = co;
        return w(c, kind, "POST", `/${KIND[kind].path}`, body, (d) => `Added ${kind} ${dash(d.id)}.`);
      },
    },
    [`${kind} update`]: { flags: [...upd.map(([f]) => f!), ...TAGF, "version"], n: 4, build: (c) => update(c, kind, upd) },
    [`${kind} archive`]: archive(kind),
  };
}

const DEAL_UPD = [["name", "name"], ["next", "next_action"], ...kv(["amount", "currency", "lost-reason"])];
const dealTask = (c: Ctx) => dp(c.pos[4]!, "/tasks");
const LIST = ["q", "archived", "sort", "page"];
const SPECS: Record<string, Spec> = {
  pipelines: { flags: [], n: 2, build: pipelines },
  tags: { flags: ["entity"], n: 2, build: tags },
  search: { flags: ["entity"], n: 3, build: search },
  deals: { flags: ["pipeline", "stage", "status", "owner", ...LIST], n: 2, build: (c) => lst(c, `/deals${qs(c.v)}`, "deals", DEAL_ROW, DEAL_TTY, "No deals.") },
  people: { flags: LIST, n: 2, build: (c) => lst(c, `/people${qs(c.v)}`, "people", PERSON_ROW, PERSON_TTY, "No people.") },
  companies: { flags: LIST, n: 2, build: (c) => lst(c, `/companies${qs(c.v)}`, "companies", COMPANY_ROW, COMPANY_TTY, "No companies.") },
  "deal get": { flags: [], n: 4, build: (c) => get(c, "deal") },
  "deal add": { flags: [...DEAL_ADD.map(([f]) => f!), "company", "new-company", "person", "new-person", "person-email"], n: 4, build: dealAdd },
  "deal update": { flags: [...DEAL_UPD.map(([f]) => f!), ...TAGF, "version"], n: 4, build: (c) => update(c, "deal", DEAL_UPD) },
  "deal move": {
    flags: [], n: 5,
    build: (c) => w(c, "deal", "POST", dp(c.pos[3]!, "/move"), { stage: c.pos[4] }, (d) => `Moved deal ${id3(c)} to ${dash(nm(d.stage))}.`),
  },
  "deal owner": {
    flags: ["none"], n: (v) => (v.none ? 4 : 5),
    build: (c) => w(c, "deal", "PUT", dp(c.pos[3]!, "/owner"), { owner: c.v.none ? null : c.pos[4] },
      (d) => `Deal ${id3(c)} is now owned by ${d.owner_email ? clean(d.owner_email) : "nobody"}.`),
  },
  "deal company": {
    flags: ["new"], n: (v) => (v.new !== undefined ? 4 : 5),
    build: (c) => w(c, "deal", "PUT", dp(c.pos[3]!, "/company"), c.v.new !== undefined ? { name: c.v.new } : { id: c.pos[4] },
      (d) => `Linked company ${dash(nm(d.company))} to deal ${id3(c)}.`),
  },
  "deal person": {
    flags: ["new", "email"], n: (v) => (v.new !== undefined ? 4 : 5),
    build: (c) => {
      if (c.v.email !== undefined && c.v.new === undefined) throw usage("--email needs --new");
      const body = c.v.new !== undefined ? { full_name: c.v.new, ...(c.v.email === undefined ? {} : { email: c.v.email }) } : { id: c.pos[4] };
      return w(c, "deal", "PUT", dp(c.pos[3]!, "/person"), body, (d) => `Linked ${dash(nm(d.person))} to deal ${id3(c)}.`);
    },
  },
  "deal note": {
    flags: [], n: 5,
    build: (c) => w(c, "deal", "POST", dp(c.pos[3]!, "/notes"), async () => {
      const text = c.pos[4] === "-" ? await c.io.stdin() : c.pos[4]!;
      if (c.pos[4] === "-" && !text.trim()) throw usage("no note text on stdin");
      return { body: text };
    }, () => `Added a note to deal ${id3(c)}.`),
  },
  "deal task add": {
    flags: ["due", "assign"], n: 6,
    build: (c) => w(c, "deal", "POST", dealTask(c), fill({ title: c.pos[5] }, c.v, [["due", "due_at"], ["assign", "assignee"]]),
      (d) => `Added task ${dash(arr(d.tasks).at(-1)?.id)} to deal ${clean(c.pos[4])}.`),
  },
  "deal task done": {
    flags: ["undo"], n: 6,
    build: (c) => w(c, "deal", "PATCH", `${dealTask(c)}/${seg(c.pos[5]!)}`, { done: !c.v.undo }, () => `Marked task ${clean(c.pos[5])} ${c.v.undo ? "not done" : "done"}.`),
  },
  "deal archive": archive("deal"),
  ...entity("person", "full_name", PERSON_FIELDS),
  ...entity("company", "name", COMPANY_FIELDS),
};

// Validates everything synchronously (so usage errors exit 1 before credentials are read), then returns the closure.
export function crmPlan(pos: string[], v: Opts, io: Io, json: boolean, now: () => number): Plan {
  const [, a, b, d] = pos;
  const ent = a === "deal" || a === "person" || a === "company";
  const task = a === "deal" && b === "task";
  // A positional with a space must not be able to spell a two- or three-word subcommand.
  const spaced = (a ?? "").includes(" ") || (ent && (b ?? "").includes(" ")) || (task && (d ?? "").includes(" "));
  const key = task ? `deal task ${d ?? ""}` : ent ? `${a} ${b ?? ""}` : (a ?? "");
  // hasOwn: a plain lookup would find Object.prototype keys (constructor, __proto__, ...).
  const spec = !spaced && Object.hasOwn(SPECS, key) ? SPECS[key] : undefined;
  if (!spec) throw usage(`unknown crm command: ${pos.slice(1).join(" ")}`);
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || GLOBAL.includes(k)) continue;
    if (!spec.flags.includes(k)) throw usage(`unknown option '--${k}' for crm ${key}`);
  }
  const n = typeof spec.n === "function" ? spec.n(v) : spec.n;
  if (pos.length !== n) throw usage(`expected ${n} argument(s) in: ${pos.join(" ")}`);
  if (v.tags === true) throw usage("--tags is only valid as --no-tags");
  if (v.page !== undefined && !/^[1-9]\d*$/.test(String(v.page))) throw usage("--page must be a positive integer");
  return spec.build({ pos, v, io, json, now });
}
