import { print, seg, usage, type Io } from "./core";
import { ago, clean, keyValue, pageFooter, table, when } from "./format";
import { checkFlags, dash, type Plan } from "./tasks";

type Opts = Record<string, unknown>;
type Ctx = { pos: string[]; v: Opts; io: Io; json: boolean; now: () => number };

const base = async (org: () => Promise<string>, tail = "") => `/orgs/${seg(await org())}/sessions${tail}`;
// An absent turn is idle; any state other than idle or failed means the agent is still on it.
const turnState = (s: any): string => (typeof s?.turn?.state === "string" ? s.turn.state : "idle");
const working = (s: any) => !["idle", "failed"].includes(turnState(s));

function list(c: Ctx): Plan {
  const { v } = c;
  checkFlags(v, ["closed", "all", "agent", "page"], "sessions");
  if (c.pos.length !== 1) throw usage(`expected 1 argument(s) in: ${c.pos.join(" ")}`);
  if (v.closed === false || v.all === false) throw usage("use --closed or --all, not --no-closed / --no-all");
  if (v.closed && v.all) throw usage("give only one of --closed / --all");
  if (v.page !== undefined && !/^[1-9]\d*$/.test(String(v.page))) throw usage("--page must be a positive whole number");
  const q = new URLSearchParams();
  if (v.closed) q.set("state", "closed");
  if (v.all) q.set("state", "all");
  if (v.agent !== undefined) q.set("agent", String(v.agent));
  if (v.page !== undefined) q.set("page", String(v.page));
  const none = v.closed ? "No closed sessions." : v.all ? "No sessions." : "No open sessions.";
  return async (call, org) => {
    const b = await call("GET", (await base(org)) + (q.size ? `?${q}` : "")), d = b.data ?? {}, l: any[] = Array.isArray(d.sessions) ? d.sessions : [];
    print(c.io, c.json, b,
      () => l.map((s) => [s.id, s.state, s.agent?.slug, turnState(s), s.last_activity_at, s.title].map(dash).join("\t")).join("\n"),
      () => (l.length
        ? table(["ID", "AGENT", "STATE", "TURN", "LAST ACTIVITY", "TITLE"],
            l.map((s) => [s.id, s.agent?.name ?? s.agent?.slug, s.state, turnState(s), ago(s.last_activity_at ?? s.created_at, c.now()), s.title])) + pageFooter(d, l.length)
        : none));
  };
}

const turnText = (s: any, now: number): string => {
  const t = turnState(s);
  return t === "running" ? `running, started ${ago(s.turn?.started_at, now)}` : t === "failed" ? `failed: ${clean(s.turn?.error ?? "the agent's turn failed")}` : clean(t);
};

function get(c: Ctx): Plan {
  checkFlags(c.v, ["after"], "session get");
  const id = seg(c.pos[2]!), q = new URLSearchParams();
  if (c.v.after !== undefined) q.set("after", String(c.v.after));
  return async (call, org) => {
    const b = await call("GET", (await base(org, `/${id}`)) + (q.size ? `?${q}` : "")), d = b.data ?? {}, s = d.session ?? {}, m: any[] = Array.isArray(d.messages) ? d.messages : [];
    const now = c.now(), agent = clean(s.agent?.name ?? s.agent?.slug ?? "the agent");
    print(c.io, c.json, b,
      () => m.map((x) => `${clean(x.role)}${x.sender?.id ? " " + clean(x.sender.id) : ""}: ${clean(x.text)}`).join("\n"),
      () => {
        const head = keyValue([
          ["id", clean(s.id)], ["agent", s.agent ? `${agent}${s.agent.slug ? ` (${clean(s.agent.slug)})` : ""}` : null], ["title", s.title == null ? null : clean(s.title)],
          ["state", clean(s.state)], ["turn", turnText(s, now)], ["opened by", s.opened_by ? clean(s.opened_by.name ?? s.opened_by.id) : null],
          ["created", when(s.created_at, now)], ["last activity", when(s.last_activity_at, now)],
        ]);
        const cap = m.length >= 200 && c.v.after === undefined ? ["Showing the last 200 messages."] : [];
        const msgs = m.map((x) => `${clean(x.role === "assistant" ? agent : x.sender?.name ?? x.sender?.id ?? x.role)} · ${ago(x.created_at, now)}\n` +
          clean(x.text, true).split("\n").map((ln) => "  " + ln).join("\n"));
        const empty = m.length ? [] : [c.v.after === undefined ? "No messages yet." : "No new messages."];
        const wait = working(s) ? [`${agent} is still working; run this again to see the reply.`] : [];
        return [head, ...cap, ...msgs, ...empty, ...wait].join("\n\n");
      });
  };
}

function close(c: Ctx): Plan {
  checkFlags(c.v, [], "session close");
  const id = seg(c.pos[2]!);
  return async (call, org) => {
    const b = await call("DELETE", await base(org, `/${id}`));
    print(c.io, c.json, b, () => `closed ${clean(c.pos[2])}`, () => `Closed session ${clean(c.pos[2])}. Its transcript is kept.`);
  };
}

// Validates everything synchronously (usage errors exit 1 before credentials are read), then returns the closure.
export function sessionsPlan(pos: string[], v: Opts, io: Io, json: boolean, now: () => number): Plan {
  const c: Ctx = { pos, v, io, json, now };
  if (pos[0] === "sessions") return list(c);
  const verb = pos[1];
  if (verb !== "get" && verb !== "close") throw usage(`unknown session command: ${pos.slice(1).join(" ")}`);
  if (pos.length !== 3) throw usage(`expected 3 argument(s) in: ${pos.join(" ")}`);
  return verb === "get" ? get(c) : close(c);
}
