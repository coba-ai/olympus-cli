import { randomBytes } from "node:crypto";

const tok = (role: string) => `oly_test_${role}_${randomBytes(8).toString("hex")}`;
export const TOKENS = {
  owner: tok("owner"), teammate: tok("teammate"), pinned: tok("pinned"), multi: tok("multi"), pinnedGone: tok("pinnedgone"),
};

export const DEVICE_CODE = `dev_${randomBytes(16).toString("hex")}`;

type Webhook = Record<string, any>;
export type FakeState = {
  next?: { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number };
  requests: { method: string; path: string; auth: string | null; body: unknown }[];
  webhooks: Record<string, Webhook[]>;
  // awaited after the request is logged, before `next` and routing (lets a test change the world mid-request)
  onRequest?: (r: { method: string; path: string }) => void | Promise<void>;
  // each poll shifts one script entry: "ok" -> token, "echo" -> 400 echoing device_code, empty -> pending, else 400 <code>
  device?: { script: string[]; interval?: number; expires_in?: number; omitComplete?: boolean; codeBody?: unknown };
};

const NAMES: Record<string, string> = { acme: "Acme", beta: "Beta" };
// hera is paused; Agent#paused? in the server
const AGENTS = [{ profile_name: "hermes", name: "Hermes", paused: false }, { profile_name: "hera", name: "Hera", paused: true }];
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

export function startFake(): { url: string; state: FakeState; stop(): void } {
  let n = 2;
  const state: FakeState = { requests: [], webhooks: { acme: [], beta: [] } };
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
      state.requests.push({ method: req.method, path: u.pathname, auth: req.headers.get("authorization"), body });
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
          (r === "orgs" && !!org && ((sub === "agents" && seg.length === 5) || (sub === "webhooks" && (seg.length === 5 || seg.length === 6)))));
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
