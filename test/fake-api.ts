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
  requests: { method: string; path: string; search: string; auth: string | null; body: unknown }[];
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

export function startFake(): { url: string; state: FakeState; stop(): void } {
  let n = 2;
  const state: FakeState = { requests: [], webhooks: { acme: [], beta: [] }, tasks: {}, days: {}, today: new Date().toISOString().slice(0, 10) };
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
      state.requests.push({ method: req.method, path: u.pathname, search: u.search, auth: req.headers.get("authorization"), body });
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
            (sub === "tasks" && (seg.length === 5 || seg.length === 6 || (seg.length === 7 && (seg[6] === "subtasks" || seg[6] === "delegate" || seg[6] === "breakdown")) || (seg.length === 8 && seg[6] === "subtasks"))) || (sub === "days" && (seg.length === 5 || seg.length === 6)) || (sub === "webhooks" && (seg.length === 5 || seg.length === 6)))));
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
