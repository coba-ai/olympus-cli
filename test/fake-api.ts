import { randomBytes } from "node:crypto";

const tok = (role: string) => `oly_test_${role}_${randomBytes(8).toString("hex")}`;
export const TOKENS = {
  owner: tok("owner"), teammate: tok("teammate"), pinned: tok("pinned"), multi: tok("multi"), pinnedGone: tok("pinnedgone"),
};

export const DEVICE_CODE = `dev_${randomBytes(16).toString("hex")}`;

type Webhook = Record<string, any>;
type Item = Record<string, any>;
export type TaskStore = Record<string, Record<string, { version: number; tasks: Item[] }>>;
export type FakeState = {
  next?: { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number };
  requests: { method: string; path: string; search: string; auth: string | null; body: unknown; idem: string | null }[];
  webhooks: Record<string, Webhook[]>;
  // org -> ISO Monday -> stored week; a week with no row is absent (reads answer version 0 without storing)
  tasks: TaskStore;
  // org -> user id -> YYYY-MM-DD -> stored close of day; tests reset it
  days: Record<string, Record<string, Record<string, { closed_at: string | null; score: number | null; entry: Item }>>>;
  // the server's "today" (UTC date, YYYY-MM-DD); tests pin it for goldens
  today: string;
  // overrides the clock behind done_at
  now?: () => number;
  // awaited after the request is logged, before `next` and routing (lets a test change the world mid-request)
  onRequest?: (r: { method: string; path: string }) => void | Promise<void>;
  // org -> stored CRM records; tests reset it with seedCrm()
  crm: Record<string, CrmStore>;
  // org + " " + Idempotency-Key -> the first create it covered; tests reset it with {}
  idempotency: Record<string, { fp: string; status: number; body: unknown }>;
  // org -> subscriptions; tests reset it with seedSubscriptions()
  subscriptions: Record<string, Item[]>;
  // each poll shifts one script entry: "ok" -> token, "echo" -> 400 echoing device_code, empty -> pending, else 400 <code>
  device?: { script: string[]; interval?: number; expires_in?: number; omitComplete?: boolean; codeBody?: unknown };
};

const NAMES: Record<string, string> = { acme: "Acme", beta: "Beta" };
// hera is paused; Agent#paused? in the server
const AGENTS = [
  { profile_name: "hermes", name: "Hermes", paused: false, primary: true, role_line: "Front desk for the team", created_at: "2026-10-01T09:00:00Z" },
  { profile_name: "hera", name: "Hera", paused: true, primary: false, role_line: null, created_at: "2026-09-20T09:00:00Z" },
];
// ApiBase's wording, byte for byte (BaseController at 439af0d6)
const NOT_FOUND = "Not found";
const MAX_INSTRUCTIONS = 8000;
const WHO: Record<string, { email: string; roles: Record<string, string>; pin: string | null }> = {
  [TOKENS.owner]: { email: "owner@acme.test", roles: { acme: "operator" }, pin: null },
  [TOKENS.teammate]: { email: "mate@acme.test", roles: { acme: "teammate" }, pin: null },
  [TOKENS.pinned]: { email: "pinned@acme.test", roles: { acme: "operator", beta: "operator" }, pin: "acme" },
  [TOKENS.multi]: { email: "multi@acme.test", roles: { acme: "operator", beta: "operator" }, pin: null },
  // pinned org deleted: no memberships, so every org route is 404 and /me reports organization null
  [TOKENS.pinnedGone]: { email: "gone@acme.test", roles: {}, pin: "acme" },
};

const PERSON_NAMES: Record<string, string> = {
  [TOKENS.owner]: "Abe Owner", [TOKENS.teammate]: "Mia Mate", [TOKENS.pinned]: "Pat Pinned", [TOKENS.multi]: "Max Multi",
};
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const mondayOf = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const validDay = (v: string) => { const t = Date.parse(`${v}T00:00:00Z`); return ISO_DAY.test(v) && !isNaN(t) && new Date(t).toISOString().slice(0, 10) === v; };
const rid = (p: string, n = 7) => p + Array.from(randomBytes(n), (b) => "0123456789abcdefghijklmnopqrstuvwxyz"[b % 36]).join("");

// Users present in an org: every WHO token with a role there (a pin to another org hides it). id = u_<WHO index + 1>.
function usersOf(org: string) {
  return Object.entries(WHO)
    .map(([t, w], i) => ({ t, w, id: `u_${i + 1}` }))
    .filter(({ w }) => w.roles[org] && (!w.pin || w.pin === org))
    .map(({ t, w, id }) => ({ t, id, name: PERSON_NAMES[t]!, email: w.email }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
const ref = (p: { id: string; name: string; kind: string }) => ({ id: p.id, name: p.name, kind: p.kind });

export function seedTasks(today: string): TaskStore {
  const owner = { id: "u_1", name: PERSON_NAMES[TOKENS.owner]!, kind: "user" };
  const mate = { id: "u_2", name: PERSON_NAMES[TOKENS.teammate]!, kind: "user" };
  let order = 0;
  const item = (id: string, text: string, o: Item = {}): Item => ({
    id, text, description: "", section: "the_rest", order: order++, done: false, done_at: null, assignee: null, tags: [],
    today: false, one_thing: false, added_on: today, delegated_to: null, delegated_at: null, subtasks: [], ...o,
  });
  const sub = (id: string, text: string, i: number, o: Item = {}): Item => ({
    id, text, done: false, done_at: null, assignee: null, today: false, order: i, ...o,
  });
  return {
    acme: {
      [mondayOf(today)]: {
        version: 1,
        tasks: [
          item("tstar001", "Star task", { assignee: owner, one_thing: true }),
          item("trest001", "Ship the pricing page", {
            assignee: mate, tags: ["pricing", "web"], description: "Line one",
            subtasks: [sub("s0000001", "Draft copy", 0, { assignee: owner, today: true }), sub("s0000002", "Review", 1)],
          }),
          item("tdone001", "Finished task", { done: true, done_at: `${today}T08:00:00.000Z`, assignee: owner }),
          item("tback001", "Backlog task", { section: "backlog" }),
          item("tunk0001", "Orphaned assignee", { assignee: { id: "u_9", name: null, kind: null } }),
          item("tlegacy1", "Legacy one thing", { section: "one_thing", one_thing: true }),
        ],
      },
    },
    beta: {},
  };
}

// ---- CRM + event subscriptions. Lean: list filters other than archived are only echoed in the request log; no unknown-key or fields.base 422.
export type CrmStore = { pipelines: Item[]; deals: Item[]; people: Item[]; companies: Item[] };
type Res = [number, unknown?];
const TS = "2026-10-01T09:00:00Z";
const ver = () => randomBytes(16).toString("hex");
const E = (s: number, code: string, message: string, details?: unknown): Res => [s, { error: { code, message, ...(details ? { details } : {}) } }];
const inv = (fields: Record<string, string[]>): Res => E(422, "invalid", "Validation failed.", { fields });
const FORBIDDEN = E(403, "forbidden", "You are not allowed to do that.");
const NF = E(404, "not_found", NOT_FOUND);
const pick = (b: Item, keys: string[]) => Object.fromEntries(keys.filter((k) => k in b).map((k) => [k, b[k]]));
const blank = (v: unknown) => typeof v !== "string" || !v.trim();
const CO_KEYS = ["name", "domain", "website", "industry", "linkedin_url", "phone", "city", "notes", "tags"];
const PE_KEYS = ["full_name", "email", "phone", "job_title", "linkedin_url", "notes", "tags"];
const DEAL_KEYS = ["name", "amount", "currency", "next_action", "lost_reason", "tags"];
const nul = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, null]));

export function seedCrm(): Record<string, CrmStore> {
  const deal = (o: Item): Item => ({
    amount: null, currency: null, in_stage_since: TS, owner_email: null, next_action: null, tags: [], archived_at: null, updated_at: TS,
    created_at: TS, lost_reason: null, version: ver(), company_id: null, person_id: null, history: [], notes: [], tasks: [], ...o,
  });
  return {
    acme: {
      pipelines: [{
        id: "p_sales", name: "Sales", currencies: ["USD"],
        stages: [["st_lead", "Lead", "open"], ["st_won", "Won", "won"], ["st_lost", "Lost", "lost"]].map(([id, name, kind], position) => ({ id, name, kind, position })),
      }],
      companies: [{ ...nul(CO_KEYS), id: "c_initech", name: "Initech", domain: "initech.test", tags: [], archived_at: null, version: ver() }],
      people: [{ ...nul(PE_KEYS), id: "pe_dana", full_name: "Dana Lee", email: "dana@initech.test", company_id: "c_initech", tags: [], archived_at: null, version: ver() }],
      deals: [
        deal({
          id: "d_renewal", name: "Initech renewal", amount: "1200", currency: "USD", stage_id: "st_lead", owner_email: "owner@acme.test",
          tags: ["renewal"], company_id: "c_initech", person_id: "pe_dana",
          notes: [{ id: "n_1", author: "owner@acme.test", body: "Kickoff call booked", created_at: TS }],
          tasks: [{ id: "ct_1", title: "Send quote", status: "open", due_at: null, assignee: "owner@acme.test" }],
        }),
        deal({ id: "d_old", name: "Old deal", stage_id: "st_lost", archived_at: TS }),
      ],
    },
    beta: { pipelines: [], deals: [], people: [], companies: [] },
  };
}

function crmApi(S: CrmStore, method: string, path: string[], q: URLSearchParams, body: unknown, write: boolean, me: string): Res {
  const b: Item = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Item) : {};
  const now = () => new Date().toISOString();
  const arch = (x: Item) => ({ archived: !!x.archived_at, archived_at: x.archived_at });
  const stOf = (id: string) => {
    for (const p of S.pipelines) { const s = p.stages.find((x: Item) => x.id === id); if (s) return { p, s }; }
  };
  const co = (id: string | null) => S.companies.find((x) => x.id === id);
  const pe = (id: string | null) => S.people.find((x) => x.id === id);
  const who = (v: unknown) => (v === "me" ? me : v ?? null);
  const open = (d: Item) => !d.archived_at && stOf(d.stage_id)?.s.kind === "open";
  const dref = (d: Item) => {
    const l = stOf(d.stage_id);
    return { id: d.id, name: d.name, pipeline: l ? { id: l.p.id, name: l.p.name } : null, stage: l ? { name: l.s.name, kind: l.s.kind } : null, status: l?.s.kind ?? null, amount: d.amount, currency: d.currency };
  };
  const base = (d: Item) => {
    const l = stOf(d.stage_id);
    return {
      id: d.id, name: d.name, amount: d.amount, currency: d.currency, status: l?.s.kind ?? null,
      pipeline: l ? { id: l.p.id, name: l.p.name } : null, stage: l ? { id: l.s.id, name: l.s.name, kind: l.s.kind } : null,
      in_stage_since: d.in_stage_since, owner_email: d.owner_email, next_action: d.next_action, tags: d.tags, ...arch(d), updated_at: d.updated_at,
    };
  };
  // core = the shape nested in a deal; detail adds the related arrays; the list row is narrower than either.
  const cOut = (c: Item, mode: "core" | "detail" | "row") => {
    const { version, website, linkedin_url, phone, notes, tasks, interactions, ...slim } = c;
    const ds = S.deals.filter((d) => d.company_id === c.id);
    const ps = S.people.filter((p) => p.company_id === c.id);
    if (mode === "row") return { ...slim, ...arch(c), people: ps.length, open_deals: ds.filter(open).length, open_value: String(ds.filter(open).reduce((a, d) => a + Number(d.amount ?? 0), 0)), currencies: [...new Set(ds.map((d) => d.currency).filter(Boolean))] };
    const full = { ...slim, website, linkedin_url, phone, notes, ...arch(c), version, deal_count: ds.length };
    return mode === "core" ? full : { ...full, deals: ds.map(dref), people: ps.map((p) => ({ id: p.id, full_name: p.full_name, email: p.email, job_title: p.job_title })), ...pick(c, ["interactions", "tasks"]) };
  };
  const pOut = (p: Item, mode: "core" | "detail" | "row") => {
    const { version, company_id, linkedin_url, notes, tasks, interactions, ...slim } = p;
    const c = co(company_id);
    const ds = S.deals.filter((d) => d.person_id === p.id);
    const head = { ...slim, ...arch(p), company: c ? { id: c.id, name: c.name } : null };
    if (mode === "row") return { ...head, open_deals: ds.filter(open).length };
    const full = { ...head, linkedin_url, notes, version, deal_count: ds.length };
    return mode === "core" ? full : { ...full, deals: ds.map(dref), ...pick(p, ["interactions", "tasks"]) };
  };
  // null_pipeline_id (test-injected) makes the list row's pipeline id null, as the server may send.
  const dRow = (d: Item) => ({ ...base(d), ...(d.null_pipeline_id && base(d).pipeline ? { pipeline: { id: null, name: base(d).pipeline!.name } } : {}), company_name: co(d.company_id)?.name ?? null, person_name: pe(d.person_id)?.full_name ?? null, person_email: pe(d.person_id)?.email ?? null });
  const dOut = (d: Item) => {
    const l = stOf(d.stage_id);
    const c = co(d.company_id), p = pe(d.person_id);
    return {
      ...base(d), lost_reason: d.lost_reason, created_at: d.created_at, version: d.version, pipeline_currencies: l?.p.currencies ?? [],
      company: c ? cOut(c, "core") : null, person: p ? pOut(p, "core") : null, stages: l?.p.stages ?? [], history: d.history,
      notes: d.notes, notes_count: d.notes.length, tasks: d.tasks, ...pick(d, ["interactions", "legacy_notes"]),
    };
  };
  const touch = (x: Item) => { x.version = ver(); if ("updated_at" in x) x.updated_at = now(); };
  const ok = (d: Item, status = 200): Res => { touch(d); return [status, { data: dOut(d) }]; };
  const stale = (x: Item, v: unknown, out: (x: Item) => unknown): Res | null =>
    v !== undefined && v !== x.version ? E(409, "conflict", "The record changed.", { current: out(x) }) : null;
  const patch = (x: Item, keys: string[]) => {
    const set = pick(b, keys);
    if ("amount" in set && set.amount != null) set.amount = String(set.amount);
    Object.assign(x, set);
  };
  // {id} links an existing record; {name|full_name,…} creates one. Returns the id or a 422.
  const link = (kind: "company" | "person", v: unknown): string | Res => {
    const o: Item = typeof v === "object" && v !== null ? (v as Item) : {};
    const list = kind === "company" ? S.companies : S.people;
    if ("id" in o) return list.some((x) => x.id === o.id) ? o.id : inv({ [kind]: ["not found"] });
    const nk = kind === "company" ? "name" : "full_name";
    if (blank(o[nk])) return inv({ [kind]: [`${nk} can't be blank`] });
    return mk(kind, o).id;
  };
  const mk = (kind: "company" | "person", o: Item) => {
    const keys = kind === "company" ? CO_KEYS : PE_KEYS;
    const x: Item = { ...nul(keys), id: `${kind === "company" ? "c_" : "pe_"}${rid("", 6)}`, tags: [], archived_at: null, version: ver(), ...pick(o, keys) };
    if (kind === "person") x.company_id = null;
    (kind === "company" ? S.companies : S.people).push(x);
    return x;
  };
  const page = (items: Item[], key: string, out: (x: Item) => unknown): Res => {
    const a = q.get("archived");
    const rows = items.filter((x) => (a === "only" ? x.archived_at : a === "include" || !x.archived_at));
    const p = Math.max(1, Number(q.get("page")) || 1);
    return [200, { data: { [key]: rows.slice((p - 1) * 50, p * 50).map(out), total: rows.length, page: p, per: 50 } }];
  };

  const [c, id, act, tid] = path;
  const M = method;
  if (M !== "GET" && !write) return FORBIDDEN;
  if (c === "pipelines") {
    const inc = q.get("archived") === "include";
    const pd = (p: Item) => ({ id: p.id, name: p.name, stages: p.stages, currencies: p.currencies, version: (p.version ??= ver()), archived: !!p.archived_at, archived_stages: p.archived_stages ?? [] });
    if (!id && M === "GET") return [200, { data: S.pipelines.filter((p) => inc || !p.archived_at).map((p) => ({ id: p.id, name: p.name, stages: p.stages, currencies: p.currencies, archived: !!p.archived_at })) }];
    const kinds = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((s) => !blank(s?.name) && ["open", "won", "lost"].includes(s?.kind));
    if (!id && M === "POST") {
      if (blank(b.name)) return inv({ name: ["can't be blank"] });
      if (!kinds(b.stages)) return inv({ stages: ["are invalid"] });
      const p: Item = { id: `p_${rid("", 6)}`, name: b.name, currencies: b.currencies ?? [], version: ver(), stages: b.stages.map((s: Item, position: number) => ({ id: `st_${rid("", 6)}`, name: s.name, kind: s.kind, position })), archived_stages: [] };
      S.pipelines.push(p);
      return [201, { data: pd(p) }];
    }
    const p = S.pipelines.find((x) => x.id === id);
    if (!p) return NF;
    if (!act && M === "GET") return [200, { data: pd(p) }];
    if (!act && M === "PATCH") {
      const s = stale(p, b.version, pd);
      if (s) return s;
      if ("name" in b) p.name = b.name;
      if ("currencies" in b) p.currencies = b.currencies;
      p.archived_stages ??= [];
      for (const rs of b.restores ?? []) { const i = p.archived_stages.findIndex((x: Item) => x.id === rs); if (i >= 0) p.stages.push(...p.archived_stages.splice(i, 1)); }
      if (b.stages) {
        const old: Item[] = p.stages;
        p.stages = b.stages.map((s: Item) => ({ ...old.find((o) => o.id === s.id), id: s.id ?? `st_${rid("", 6)}`, name: s.name, kind: s.kind }));
        for (const o of old.filter((o) => !p.stages.some((s: Item) => s.id === o.id))) {
          p.archived_stages.push({ id: o.id, name: o.name, kind: o.kind });
          for (const d of S.deals.filter((d) => d.stage_id === o.id)) d.stage_id = (b.removals ?? []).find((r: Item) => r.stage === o.id)?.move_to ?? d.stage_id;
        }
      }
      p.stages.forEach((s: Item, i: number) => (s.position = i));
      p.version = ver();
      return [200, { data: pd(p) }];
    }
    if (act === "archive" && M === "POST") { p.archived_at = b.archived === false ? null : now(); p.version = ver(); return [200, { data: pd(p) }]; }
    return NF;
  }
  if (c === "tasks" && id && M === "PATCH") {
    for (const x of [...S.deals, ...S.people, ...S.companies]) {
      const t = (x.tasks ?? []).find((t: Item) => t.id === id);
      if (t) { t.status = b.done === false ? "open" : "done"; return [200, { data: pick(t, ["id", "title", "status", "due_at", "assignee"]) }]; }
    }
    return NF;
  }
  const kind = ({ deals: "deal", people: "person", companies: "company" } as Record<string, string>)[c ?? ""];
  if (kind && id && ((act === "deletion_preview" && M === "GET") || (!act && M === "DELETE"))) {
    const list = c === "deals" ? S.deals : c === "people" ? S.people : S.companies;
    const x = list.find((r) => r.id === id);
    if (!x) return NF;
    if (M === "DELETE") { list.splice(list.indexOf(x), 1); return [204]; }
    const ds = S.deals.filter((d) => d.person_id === id || d.company_id === id).length;
    const impact = c === "deals" ? { notes: x.notes.length, tasks: x.tasks.length } : c === "people" ? { deals_unlinked: ds } : { people_unlinked: S.people.filter((p) => p.company_id === id).length, deals_unlinked: ds };
    return [200, { data: { entity: kind, id, name: x.name ?? x.full_name, impact } }];
  }
  if (c === "tags" && M === "GET") {
    const e = q.get("entity");
    const all = [...(e && e !== "deal" ? [] : S.deals), ...(e && e !== "person" ? [] : S.people), ...(e && e !== "company" ? [] : S.companies)];
    return [200, { data: [...new Set(all.flatMap((x) => x.tags))] }];
  }
  if (c === "search" && M === "GET") {
    const t = (q.get("q") ?? "").toLowerCase(), e = q.get("entity");
    if (!t) return inv({ q: ["can't be blank"] });
    const hits = [
      ...S.deals.map((x) => ({ entity: "deal", id: x.id, label: x.name, sub: dRow(x).company_name })),
      ...S.people.map((x) => ({ entity: "person", id: x.id, label: x.full_name, sub: x.email })),
      ...S.companies.map((x) => ({ entity: "company", id: x.id, label: x.name, sub: x.domain })),
    ];
    const per: Record<string, number> = {};
    return [200, { data: hits.filter((h) => (!e || h.entity === e) && h.label.toLowerCase().includes(t) && (per[h.entity] = (per[h.entity] ?? 0) + 1) <= 5) }];
  }
  if (c === "people" || c === "companies") {
    const company = c === "companies", list = company ? S.companies : S.people, nk = company ? "name" : "full_name";
    const out = (x: Item, mode: "detail" | "row" = "detail") => (company ? cOut(x, mode) : pOut(x, mode));
    if (!id) {
      if (M === "GET") return page(list, c, (x) => out(x, "row"));
      if (M !== "POST") return NF;
      if (blank(b[nk])) return inv({ [nk]: ["can't be blank"] });
      let cid: string | Res | null = null;
      if (!company && b.company) { cid = link("company", b.company); if (typeof cid !== "string") return cid; }
      const x = mk(company ? "company" : "person", b);
      if (!company) x.company_id = cid;
      return [201, { data: out(x) }];
    }
    const x = list.find((r) => r.id === id);
    if (!x) return NF;
    if (!act && M === "GET") return [200, { data: out(x) }];
    if (!act && M === "PATCH") {
      const s = stale(x, b.version, out);
      if (s) return s;
      patch(x, company ? CO_KEYS : PE_KEYS);
      touch(x);
      return [200, { data: out(x) }];
    }
    if (act === "archive" && M === "POST") { x.archived_at = b.archived === false ? null : now(); touch(x); return [200, { data: out(x) }]; }
    if (act === "tasks" && M === "POST") {
      if (blank(b.title)) return inv({ title: ["can't be blank"] });
      (x.tasks ??= []).push({ id: `ct_${rid("", 6)}`, title: b.title, status: "open", due_at: b.due_at ?? null, assignee: who(b.assignee) });
      touch(x);
      return [201, { data: out(x) }];
    }
    return NF;
  }
  if (c !== "deals") return NF;
  if (!id) {
    if (M === "GET") return q.get("stage") && !q.get("pipeline") ? inv({ stage: ["needs pipeline"] }) : page(S.deals, "deals", dRow);
    if (M !== "POST") return NF;
    if (blank(b.name)) return inv({ name: ["can't be blank"] });
    if (b.stage && !b.pipeline) return inv({ stage: ["needs pipeline"] });
    const p = S.pipelines.find((x) => x.id === (b.pipeline ?? S.pipelines[0]?.id));
    if (!p) return inv({ pipeline: ["not found"] });
    const st = p.stages.find((x: Item) => x.id === (b.stage ?? p.stages[0].id));
    if (!st) return inv({ stage: ["not found"] });
    const ids: Item = {};
    for (const k of ["company", "person"] as const) {
      if (!b[k]) continue;
      const r = link(k, b[k]);
      if (typeof r !== "string") return r;
      ids[`${k}_id`] = r;
    }
    const d: Item = {
      id: `d_${rid("", 6)}`, ...nul(["amount", "currency", "next_action", "lost_reason", "company_id", "person_id"]), currency: p.currencies[0] ?? null,
      stage_id: st.id, in_stage_since: now(), owner_email: who(b.owner ?? "me"), tags: [], archived_at: null, updated_at: now(), created_at: now(),
      history: [], notes: [], tasks: [], ...ids, ...pick(b, ["name", "amount", "currency", "next_action"]),
    };
    if (d.amount != null) d.amount = String(d.amount);
    S.deals.push(d);
    return ok(d, 201);
  }
  const d = S.deals.find((r) => r.id === id);
  if (!d) return NF;
  if (!act) {
    if (M === "GET") return [200, { data: dOut(d) }];
    if (M !== "PATCH") return NF;
    const s = stale(d, b.version, dOut);
    if (s) return s;
    patch(d, DEAL_KEYS);
    return ok(d);
  }
  if (act === "move" && M === "POST") {
    const l = stOf(d.stage_id);
    const to = l?.p.stages.find((x: Item) => x.id === b.stage);
    if (!to) return inv({ stage: ["not found"] });
    if (b.from_stage !== undefined && b.from_stage !== d.stage_id) return E(409, "conflict", "The deal moved.", { current: dOut(d) });
    if (to.id === d.stage_id) return [200, { data: dOut(d) }];
    d.history.push({ occurred_at: now(), from_stage: l!.s.name, to_stage: to.name, actor: me, note: null });
    d.stage_id = to.id;
    d.in_stage_since = now();
    return ok(d);
  }
  if (act === "owner" && M === "PUT") {
    if (b.expected !== undefined && b.expected !== d.owner_email) return E(409, "conflict", "The owner changed.", { current: dOut(d) });
    d.owner_email = who(b.owner);
    return ok(d);
  }
  if ((act === "company" || act === "person") && M === "PUT") {
    const key = `${act}_id`;
    if (b.expected !== undefined && b.expected !== d[key]) return E(409, "conflict", `The ${act} changed.`, { current: dOut(d) });
    const r = link(act, b);
    if (typeof r !== "string") return r;
    d[key] = r;
    return ok(d);
  }
  if ((act === "company" || act === "person") && M === "DELETE") { d[`${act}_id`] = null; return ok(d); }
  if (act === "notes" && M === "POST") {
    if (blank(b.body)) return inv({ body: ["can't be blank"] });
    d.notes.push({ id: `n_${rid("", 6)}`, author: me, body: b.body, created_at: now() });
    return ok(d, 201);
  }
  if (act === "tasks" && M === "POST") {
    if (blank(b.title)) return inv({ title: ["can't be blank"] });
    d.tasks.push({ id: `ct_${rid("", 6)}`, title: b.title, status: "open", due_at: b.due_at ?? null, assignee: who(b.assignee) });
    return ok(d, 201);
  }
  if (act === "tasks" && M === "PATCH") {
    const t = d.tasks.find((x: Item) => x.id === tid);
    if (!t) return NF;
    t.status = b.done === false ? "open" : "done";
    return ok(d);
  }
  if (act === "archive" && M === "POST") { d.archived_at = b.archived === false ? null : now(); return ok(d); }
  return NF;
}

const EVENT_TYPES = ["task.created", "task.updated", "task.completed", "task.reopened", "task.assigned", "task.deleted", "task.delegated"];

export function seedSubscriptions(): Record<string, Item[]> {
  return {
    acme: [{
      id: "sub_000000000001", name: "seed", url: "https://example.test/hook", events: ["task.completed"], active: true,
      created_by: { id: "u_1", name: "Abe Owner" }, last_delivery_at: null, last_delivery_status: null, consecutive_failures: 0, created_at: TS,
    }],
    beta: [],
  };
}

// path = segments after /subscriptions. Operator only, reads included.
function subsApi(L: Item[], method: string, path: string[], body: unknown, operator: boolean): Res {
  if (!operator) return FORBIDDEN; // before the id is looked up: a teammate never learns whether an id exists
  const b: Item = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Item) : {};
  const [id, act] = path;
  const secret = () => randomBytes(32).toString("hex");
  const check = (create: boolean) => {
    const f: Record<string, string[]> = {};
    for (const k of ["name", "url"]) if ((create || k in b) && blank(b[k])) f[k] = ["can't be blank"];
    const e = b.events;
    if ((create || "events" in b) && !(Array.isArray(e) && e.length > 0 && ((e.length === 1 && e[0] === "*") || e.every((x) => EVENT_TYPES.includes(x))))) f.events = ["must be a non-empty list of known event types or *"];
    if ("active" in b && typeof b.active !== "boolean") f.active = ["must be true or false"];
    return f;
  };
  if (!id) {
    if (method === "GET") return [200, { data: L }];
    if (method !== "POST") return NF;
    const f = check(true);
    if (Object.keys(f).length) return inv(f);
    const s: Item = {
      id: `sub_${rid("", 12)}`, name: b.name.trim(), url: b.url, events: b.events, active: true, created_by: { id: "u_1", name: PERSON_NAMES[TOKENS.owner] },
      last_delivery_at: null, last_delivery_status: null, consecutive_failures: 0, created_at: new Date().toISOString(),
    };
    L.push(s);
    return [201, { data: s, secret: secret() }];
  }
  const s = L.find((x) => x.id === id);
  if (!s) return NF;
  if (!act && method === "GET") return [200, { data: s }];
  if (!act && method === "DELETE") { L.splice(L.indexOf(s), 1); return [204]; }
  if (!act && method === "PATCH") {
    const f = check(false);
    if (Object.keys(f).length) return inv(f);
    Object.assign(s, pick(b, ["name", "url", "events", "active"]));
    if (b.active === true) s.consecutive_failures = 0;
    return [200, { data: s }];
  }
  if (act === "rotate_secret" && method === "POST") return [200, { data: s, secret: secret() }];
  if (act === "ping" && method === "POST") return [200, { data: { delivered: true, status: 200, error: null } }];
  return NF;
}

export function startFake(): { url: string; state: FakeState; stop(): void } {
  let n = 2;
  const state: FakeState = { requests: [], webhooks: { acme: [], beta: [] }, tasks: {}, days: {}, crm: seedCrm(), idempotency: {}, subscriptions: seedSubscriptions(), today: new Date().toISOString().slice(0, 10) };
  state.tasks = seedTasks(state.today);
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const text = await req.text();
      let body: unknown;
      let malformed = false;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
        malformed = true;
      }
      state.requests.push({ method: req.method, path: u.pathname, search: u.search, auth: req.headers.get("authorization"), body, idem: req.headers.get("idempotency-key") });
      await state.onRequest?.({ method: req.method, path: u.pathname });
      const send = (status: number, b?: unknown, headers: Record<string, string> = {}) =>
        status === 204
          ? new Response(null, { status, headers })
          : new Response(typeof b === "string" ? b : JSON.stringify(b), {
              status,
              headers: { "Content-Type": "application/json", ...headers },
            });
      const err = (status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>) =>
        send(status, { error: { code, message, ...(details ? { details } : {}) } }, headers);
      const notFound = () => err(404, "not_found", NOT_FOUND);
      const badJson = () => err(400, "bad_request", "Malformed JSON body.");

      const nx = state.next;
      if (nx) {
        state.next = undefined;
        if (nx.delayMs) await Bun.sleep(nx.delayMs);
        return send(nx.status, nx.body ?? "", nx.headers);
      }

      const d = state.device;
      const isDevice = req.method === "POST" && (u.pathname === "/api/v1/device/code" || u.pathname === "/api/v1/device/token");
      if (isDevice && malformed) return badJson(); // no auth on these routes, so a bad bearer cannot 401 first
      if (req.method === "POST" && u.pathname === "/api/v1/device/code") {
        if (!d) return notFound();
        const uri = `${u.origin}/device`;
        return send(
          200,
          d.codeBody ?? {
            device_code: DEVICE_CODE, user_code: "ABCD-EFGH", verification_uri: uri,
            ...(d.omitComplete ? {} : { verification_uri_complete: `${uri}?user_code=ABCD-EFGH` }),
            expires_in: d.expires_in ?? 600, interval: d.interval ?? 5,
          },
        );
      }
      if (req.method === "POST" && u.pathname === "/api/v1/device/token") {
        if (!d) return notFound();
        const step = d.script.shift() || "authorization_pending";
        if (step === "ok") return send(200, { data: { token: TOKENS.owner } });
        if (step === "echo") return err(400, "invalid_grant", `bad device_code ${(body as any)?.device_code}`);
        return err(400, step, step);
      }

      // Unknown /api/v1/* paths are 404 before auth, with or without a token.
      const seg = u.pathname.split("/").filter(Boolean); // api v1 ...
      const [r, org, sub, id] = seg.slice(2);
      const known =
        seg[0] === "api" && seg[1] === "v1" &&
        ((r === "me" && seg.length === 3) ||
          (r === "orgs" && !!org && ((sub === "agents" && seg.length === 5) || (sub === "people" && seg.length === 5) || (sub === "tags" && seg.length === 5) ||
            (sub === "tasks" && (seg.length === 5 || seg.length === 6 || (seg.length === 7 && (seg[6] === "subtasks" || seg[6] === "delegate" || seg[6] === "breakdown")) || (seg.length === 8 && seg[6] === "subtasks"))) || (sub === "days" && (seg.length === 5 || seg.length === 6)) || (sub === "webhooks" && (seg.length === 5 || seg.length === 6)) ||
            (sub === "crm" && seg.length >= 6 && seg.length <= 9 && ["pipelines", "tags", "search", "tasks", "deals", "people", "companies"].includes(seg[5]!)) ||
            (sub === "subscriptions" && seg.length >= 5 && seg.length <= 7) || (sub === "event_types" && seg.length === 5))));
      if (!known) return notFound();

      const who = WHO[(req.headers.get("authorization") ?? "").replace(/^Bearer /, "")];
      if (!who)
        return err(401, "unauthorized", "Missing or invalid API token.", undefined, { "WWW-Authenticate": 'Bearer realm="olympus"' });
      const orgs = Object.keys(who.roles).filter((s) => !who.pin || s === who.pin);

      if (r === "me") {
        if (req.method !== "GET") return notFound();
        const pinOrg = who.pin && who.roles[who.pin] ? { slug: who.pin, name: NAMES[who.pin] } : null;
        return send(200, {
          data: {
            user: { email: who.email },
            memberships: orgs.map((s) => ({ org: { slug: s, name: NAMES[s] }, role: who.roles[s] })),
            token: { name: "test", last4: "abcd", organization: pinOrg },
          },
        });
      }
      // require_org! reads params first, so a malformed body is 400 before the org lookup
      if (malformed) return badJson();
      if (!who.roles[org!] || (who.pin && who.pin !== org)) return notFound();
      const operator = who.roles[org!] === "operator";
      const forbidden = () => err(403, "forbidden", "You are not allowed to do that.");
      const reply = ([st, o]: Res) => send(st, o);
      if (sub === "crm") {
        const run = () => crmApi((state.crm[org!] ??= { pipelines: [], deals: [], people: [], companies: [] }), req.method, seg.slice(5), u.searchParams, body, operator, who.email);
        const route = `${req.method} ${seg.slice(5).join("/")}`;
        const key = req.headers.get("idempotency-key");
        if (key === null || !operator || !/^POST (pipelines|deals|people|companies|deals\/[^/]+\/(notes|tasks)|(people|companies)\/[^/]+\/tasks)$/.test(route)) return reply(run());
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) return reply(inv({ idempotency_key: ["is invalid"] }));
        const slot = `${org} ${key}`, fp = `${route} ${JSON.stringify(body ?? null)}`, hit = state.idempotency[slot];
        if (hit) return hit.fp === fp ? send(hit.status, hit.body, { "Idempotent-Replayed": "true" }) : reply(inv({ idempotency_key: ["was already used for a different request"] }));
        const [st, o] = run();
        if (st < 300) state.idempotency[slot] = { fp, status: st, body: o };
        return send(st, o);
      }
      if (sub === "subscriptions") return reply(subsApi((state.subscriptions[org!] ??= []), req.method, seg.slice(5), body, operator));
      if (sub === "event_types") return req.method === "GET" ? send(200, { data: EVENT_TYPES }) : notFound();
      if (sub === "agents") return req.method === "GET" ? send(200, { data: AGENTS }) : notFound();
      if (sub === "people" || sub === "tasks" || sub === "tags" || sub === "days") return tasksRoute();
      const list = state.webhooks[org!] ?? (state.webhooks[org!] = []);
      const strip = ({ instructions, ...rest }: Webhook) => rest;

      if (!id && req.method === "GET") return send(200, { data: list.map(strip) });
      if (!id && req.method === "POST") {
        if (!operator) return forbidden();
        const b = (body ?? {}) as Webhook;
        const te = typeErrors(b);
        if (te) return invalid(te);
        const agent = AGENTS.find((a) => a.profile_name === b.agent);
        const f = rowErrors(b.name ?? "", agent);
        const ie = instructionsError(b.instructions);
        if (ie) f.instructions = ie;
        if (Object.keys(f).length) return invalid(f);
        const wid = `wh_${n++}`;
        const w: Webhook = {
          id: wid, name: b.name.trim(), agent: b.agent, full_tools: b.full_tools ?? false,
          url: `${server.url}hooks/${wid}`, last_delivery_at: null, last_delivery_status: null,
          created_at: new Date().toISOString(), instructions: b.instructions,
        };
        list.push(w);
        return send(201, { data: strip(w), secret: `whsec_${randomBytes(8).toString("hex")}` }, { "Cache-Control": "no-store" });
      }
      const w = list.find((x) => x.id === id);
      if (!w) return notFound();
      if (req.method === "GET") return operator ? send(200, { data: w }, { "Cache-Control": "no-store" }) : forbidden();
      if (req.method === "DELETE") {
        if (!operator) return forbidden();
        list.splice(list.indexOf(w), 1);
        return send(204);
      }
      if (req.method === "PATCH") {
        if (!operator) return forbidden();
        const b = (body ?? {}) as Webhook;
        const te = typeErrors(b);
        if (te) return invalid(te);
        const agent = AGENTS.find((a) => a.profile_name === ("agent" in b ? b.agent : w.agent));
        const f = rowErrors("name" in b ? b.name ?? "" : w.name, agent);
        if (b.instructions != null) {
          const ie = instructionsError(b.instructions);
          if (ie) f.instructions = ie;
        }
        if (Object.keys(f).length) return invalid(f);
        for (const k of ["name", "agent", "full_tools"]) if (k in b) w[k] = k === "name" ? b[k].trim() : b[k];
        if (b.instructions != null) w.instructions = b.instructions;
        return send(200, { data: strip(w) });
      }
      return notFound();

      // people + tasks: only what a CLI can observe. No board sort, today cap, per-person one_thing rule or tag normalisation.
      function tasksRoute() {
        const nsHdr = { "Cache-Control": "no-store" };
        const tsend = (status: number, b?: unknown) => send(status, b, nsHdr);
        const terr = (status: number, code: string, message: string, details?: unknown) => err(status, code, message, details, nsHdr);
        const bad = (fields: Record<string, string[]>) => terr(422, "invalid", "Validation failed.", { fields });
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        const people = [
          ...usersOf(org!).map((p) => ({ id: p.id, name: p.name, kind: "user", email: p.email, me: p.t === token })),
          ...[...AGENTS].sort((a, b) => Number(b.primary) - Number(a.primary))
            .map((a) => ({ id: a.profile_name, name: a.name, kind: "agent", paused: a.paused, me: false })),
        ];
        if (sub === "people") return req.method === "GET" ? tsend(200, { data: people }) : terr(404, "not_found", NOT_FOUND);
        if (sub === "tags") {
          if (req.method !== "GET") return terr(404, "not_found", NOT_FOUND);
          const counts = new Map<string, number>();
          for (const wk of Object.values(state.tasks[org!] ?? {}))
            for (const t of wk.tasks) for (const g of t.tags ?? []) counts.set(g, (counts.get(g) ?? 0) + 1);
          // stable sort keeps first-seen order on ties
          return tsend(200, { data: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([g]) => g) });
        }
        const me = people.find((p) => p.me)!;

        const q = u.searchParams;
        if (sub === "days" && seg[5]) return dayOne(seg[5]);
        let week = mondayOf(state.today);
        if (q.has("week")) {
          const wk = q.get("week")!;
          if (!validDay(wk)) return bad({ week: ["must be a date (YYYY-MM-DD)"] });
          week = mondayOf(wk);
        }
        const current = week === mondayOf(state.today);
        const store = (state.tasks[org!] ??= {});
        const row = store[week];
        if (sub === "days") return req.method === "GET" ? dayList() : terr(404, "not_found", NOT_FOUND);
        const tid = seg[5], isSub = seg[6] === "subtasks", sid = seg[7];
        const m = req.method;
        if (!tid) {
          if (m === "GET")
            return tsend(200, { data: { week, current, version: row?.version ?? 0, me: me.id, tasks: (row?.tasks ?? []) } });
          if (m !== "POST") return terr(404, "not_found", NOT_FOUND);
          const b = isObj(body) ? body : {};
          const r = fields(b, true);
          if (r.f) return bad(r.f);
          const wr = (store[week] ??= { version: 0, tasks: [] });
          const t: Item = {
            id: rid("t"), text: "", description: "", section: "the_rest", order: wr.tasks.length, done: false, done_at: null,
            assignee: null, tags: [], today: false, one_thing: false, added_on: state.today, delegated_to: null, delegated_at: null,
            subtasks: [],
          };
          apply(t, r.set!);
          wr.tasks.push(t);
          wr.version++;
          return tsend(201, { data: t });
        }
        const t = row?.tasks.find((x) => x.id === tid);
        if (!t) return terr(404, "not_found", NOT_FOUND);
        const act = seg[6] === "delegate" || seg[6] === "breakdown" ? seg[6] : null;
        if (act) {
          if (m !== "POST") return terr(404, "not_found", NOT_FOUND);
          const b = isObj(body) ? body : {};
          const agent = typeof b.agent === "string" ? b.agent : "hermes";
          row!.version++;
          if (act === "delegate") {
            t.delegated_to = agent;
            t.delegated_at = nowIso();
            const id = rid("w", 14);
            return tsend(201, { data: { task: t, session: { id, title: null, agent, url: `${u.origin}/${org}/sessions/${id}` } } });
          }
          const added = ["First step", "Second step"].map((text) => {
            const s = { id: rid("s"), text, done: false, done_at: null, assignee: null, today: false, order: t.subtasks.length };
            t.subtasks.push(s);
            return s;
          });
          return tsend(200, { data: { task: t, agent: AGENTS.find((a) => a.profile_name === agent)?.name ?? agent, added } });
        }
        if (!isSub) {
          if (m === "GET") return tsend(200, { data: t });
          if (m === "DELETE") {
            row!.tasks.splice(row!.tasks.indexOf(t), 1);
            row!.version++;
            return tsend(204);
          }
          if (m !== "PATCH") return terr(404, "not_found", NOT_FOUND);
          const r = fields(isObj(body) ? body : {}, false, t);
          if (r.f) return bad(r.f);
          apply(t, r.set!);
          row!.version++;
          return tsend(200, { data: t });
        }
        if (!sid) {
          if (m !== "POST") return terr(404, "not_found", NOT_FOUND);
          const r = subFields(isObj(body) ? body : {}, true);
          if (r.f) return bad(r.f);
          t.subtasks.push({ id: rid("s"), text: "", done: false, done_at: null, assignee: null, today: false, order: t.subtasks.length });
          apply(t.subtasks[t.subtasks.length - 1], r.set!);
          row!.version++;
          return tsend(201, { data: t });
        }
        const s = t.subtasks.find((x: Item) => x.id === sid);
        if (!s) return terr(404, "not_found", NOT_FOUND);
        if (m === "DELETE") {
          t.subtasks.splice(t.subtasks.indexOf(s), 1);
          row!.version++;
          return tsend(200, { data: t });
        }
        if (m !== "PATCH") return terr(404, "not_found", NOT_FOUND);
        const r = subFields(isObj(body) ? body : {}, false);
        if (r.f) return bad(r.f);
        apply(s, r.set!);
        row!.version++;
        return tsend(200, { data: t });

        function dayView(day: string) {
          const r = state.days[org!]?.[me.id]?.[day];
          const e = r?.entry;
          return {
            day, closed: !!r?.closed_at, closed_at: r?.closed_at ?? null, score: r?.score ?? null,
            entry: !r ? null : {
              shipped: e!.shipped ?? "", blockers: e!.blockers ?? [], learnings: e!.learnings ?? [], reflection: e!.reflection ?? "",
              summary: { tasks_created: 0, tasks_done: 0, one_thing_progress: 0, learnings: (e!.learnings ?? []).length, allocation: [] },
              agent_note: null, week_close: false,
            },
          };
        }
        function dayList() {
          let wk = mondayOf(state.today);
          if (q.has("week")) {
            if (!validDay(q.get("week")!)) return bad({ week: ["must be a date (YYYY-MM-DD)"] });
            wk = mondayOf(q.get("week")!);
          }
          const days = [0, 1, 2, 3, 4].map((i) => {
            const d = new Date(`${wk}T00:00:00Z`);
            d.setUTCDate(d.getUTCDate() + i);
            return dayView(d.toISOString().slice(0, 10));
          });
          return tsend(200, { data: { week: wk, days } });
        }
        function dayOne(day: string) {
          const wd = validDay(day) ? new Date(`${day}T00:00:00Z`).getUTCDay() : 0;
          if (wd < 1 || wd > 5) return bad({ day: ["must be a weekday (YYYY-MM-DD, Monday to Friday)"] });
          if (req.method === "PUT") {
            const b = isObj(body) ? body : {};
            const mine = ((state.days[org!] ??= {})[me.id] ??= {});
            const r = (mine[day] ??= { closed_at: null, score: null, entry: {} });
            const items = (k: string, p: string) => (b[k] as string[]).map((text, i) => ({ id: `${p}${i + 1}`, text }));
            for (const k of ["shipped", "reflection"]) if (k in b) r.entry[k] = b[k];
            if (Array.isArray(b.blockers)) r.entry.blockers = items("blockers", "b");
            if (Array.isArray(b.learnings)) r.entry.learnings = items("learnings", "l");
            if (b.close !== false) r.closed_at = nowIso();
          } else if (req.method !== "GET") return terr(404, "not_found", NOT_FOUND);
          return tsend(200, { data: dayView(day) });
        }
        function isObj(v: unknown): v is Record<string, any> {
          return typeof v === "object" && v !== null && !Array.isArray(v);
        }
        function nowIso() {
          return new Date(state.now?.() ?? Date.now()).toISOString();
        }
        // string -> {id,name,kind} | error message
        function resolve(v: unknown): { ok: Item | null } | { err: string } {
          if (v === null) return { ok: null };
          if (typeof v !== "string") return { err: "must be a string" };
          const key = v === "me" ? me.id : v;
          const p = people.find((x) => x.id === key || ("email" in x && x.email.toLowerCase() === v.toLowerCase()));
          if (!p) return { err: "must be a member or agent of this organization" };
          if ("paused" in p && p.paused) return { err: "is paused" };
          return { ok: ref(p) };
        }
        function flags(b: Record<string, any>, f: Record<string, string[]>, set: Item, keys: string[]) {
          for (const k of keys) if (k in b && typeof b[k] !== "boolean") f[k] = ["must be true or false"];
          if (b.today === true && !current) f.today = ["can only be set on the current week"];
          for (const k of keys) if (!f[k] && k in b) set[k] = b[k];
        }
        function fields(b: Record<string, any>, create: boolean, cur?: Item) {
          const f: Record<string, string[]> = {};
          const set: Item = {};
          for (const k of ["text", "description", "section"])
            if (k in b && typeof b[k] !== "string") f[k] = ["must be a string"];
          if (!f.text && (create || "text" in b) && !(b.text ?? "").trim()) f.text = ["can't be blank"];
          if (!f.section && "section" in b && !["the_rest", "backlog"].includes(b.section)) f.section = ["must be the_rest or backlog"];
          if ("tags" in b && !(Array.isArray(b.tags) && b.tags.every((x: unknown) => typeof x === "string"))) f.tags = ["must be an array of strings"];
          for (const k of ["text", "description", "section", "tags"]) if (!f[k] && k in b) set[k] = b[k];
          const strs = (k: string) => {
            if (!(k in b)) return;
            if (!(Array.isArray(b[k]) && b[k].every((x: unknown) => typeof x === "string"))) f[k] = ["must be an array of strings"];
            else if ("tags" in b) f.tags = [`can't be combined with ${k}`];
          };
          strs("add_tags");
          strs("remove_tags");
          if (cur && !f.tags && !f.add_tags && !f.remove_tags && ("add_tags" in b || "remove_tags" in b)) {
            const clean = (k: string) => (b[k] ?? []).map((x: string) => x.trim()).filter(Boolean);
            const rm = clean("remove_tags");
            const out = (cur.tags ?? []).filter((g: string) => !rm.includes(g));
            for (const g of clean("add_tags")) if (!out.includes(g)) out.push(g);
            set.tags = out;
          }
          let assignee = cur?.assignee ?? null;
          if ("assignee" in b) {
            const r = resolve(b.assignee);
            if ("err" in r) f.assignee = [r.err];
            else set.assignee = assignee = r.ok;
          }
          flags(b, f, set, ["done", "today", "one_thing"]);
          if (b.one_thing === true && !f.one_thing) {
            if (!current) f.one_thing = ["can only be set on the current week"];
            else if (!assignee && !f.assignee) f.one_thing = ["needs an assignee"];
          }
          if (f.one_thing) delete set.one_thing;
          return Object.keys(f).length ? { f } : { set };
        }
        function subFields(b: Record<string, any>, create: boolean) {
          const f: Record<string, string[]> = {};
          const set: Item = {};
          if ("text" in b && typeof b.text !== "string") f.text = ["must be a string"];
          else if ((create || "text" in b) && !(b.text ?? "").trim()) f.text = ["can't be blank"];
          else if ("text" in b) set.text = b.text;
          if ("assignee" in b) {
            const r = resolve(b.assignee);
            if ("err" in r) f.assignee = [r.err];
            else set.assignee = r.ok;
          }
          flags(b, f, set, ["done", "today"]);
          return Object.keys(f).length ? { f } : { set };
        }
        function apply(x: Item, set: Item) {
          const { done, ...rest } = set;
          Object.assign(x, rest);
          if (done !== undefined) {
            x.done_at = done ? x.done_at ?? nowIso() : null;
            x.done = done;
          }
        }
      }

      function invalid(fields: Record<string, string[]>) {
        return err(422, "invalid", "Validation failed.", { fields });
      }
      // Mirrors WebhooksController#type_errors!: a null string is fine here, full_tools must be a real boolean.
      function typeErrors(b: Webhook) {
        const f: Record<string, string[]> = {};
        for (const k of ["name", "agent", "instructions"]) if (b[k] != null && typeof b[k] !== "string") f[k] = ["must be a string"];
        if ("full_tools" in b && typeof b.full_tools !== "boolean") f.full_tools = ["must be true or false"];
        return Object.keys(f).length ? f : null;
      }
      // OrgWebhook validations: name length 1..80 after strip; agent must exist, and must not be paused.
      function rowErrors(name: string, agent: (typeof AGENTS)[number] | undefined) {
        const f: Record<string, string[]> = {};
        const len = name.trim().length;
        if (len < 1) f.name = ["is too short (minimum is 1 character)"];
        else if (len > 80) f.name = ["is too long (maximum is 80 characters)"];
        if (!agent) f.agent = ["must exist"];
        else if (agent.paused) f.agent = ["is paused"];
        return f;
      }
      function instructionsError(v: unknown) {
        const t = typeof v === "string" ? v : "";
        return !t.trim() || t.length > MAX_INSTRUCTIONS ? [`must be between 1 and ${MAX_INSTRUCTIONS} characters`] : null;
      }
    },
  });
  const url = server.url.href.replace(/\/$/, "");
  state.webhooks.acme = [
    {
      id: "wh_1", name: "seed", agent: "hermes", full_tools: false, url: `${url}/hooks/wh_1`,
      last_delivery_at: null, last_delivery_status: null, created_at: new Date().toISOString(),
      instructions: "seed instructions",
    },
    {
      id: "wh_paused", name: "on hera", agent: "hera", full_tools: false, url: `${url}/hooks/wh_paused`,
      last_delivery_at: null, last_delivery_status: null, created_at: new Date().toISOString(),
      instructions: "paused instructions",
    },
  ];
  return { url, state, stop: () => void server.stop(true) };
}
