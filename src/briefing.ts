import { print, seg, usage, type Io } from "./core";
import { ago, clean, keyValue } from "./format";
import { checkFlags, dash, type Plan } from "./tasks";

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object";
const scalar = (x: unknown) => !isObj(x);
const label = (k: string) => clean(k).replace(/_/g, " ");

// Piped: one `<path>: <value>` line per scalar leaf, server order; array indices are segments; null/""/empty container print "-".
function leaves(x: unknown, path: string): string[] {
  if (isObj(x) && Object.keys(x).length) return Object.entries(x).flatMap(([k, y]) => leaves(y, `${path}.${clean(k)}`));
  return [`${path}: ${isObj(x) ? "-" : dash(x)}`];
}

const indent = (s: string, n: number) => s.split("\n").join("\n" + " ".repeat(n));
const text = (x: unknown) => (x == null ? "-" : clean(x, true));

// TTY: top-level scalars as key/value, then each non-scalar key as a section. Nesting below one level is omitted (--json has it).
function sections(doc: unknown): string {
  if (!isObj(doc)) return text(doc);
  const e = Object.entries(doc);
  const kv = e.filter(([, y]) => scalar(y)).map(([k, y]) => [label(k), text(y)] as [string, string]);
  const item = (i: unknown) => (!isObj(i) ? text(i) : Array.isArray(i) ? "-" : Object.values(i).filter(scalar).map(text).join("  ") || "-");
  const rest = e.filter(([, y]) => !scalar(y)).map(([k, y]) => {
    const lines = Array.isArray(y) ? y.map((i) => `  - ${indent(item(i), 4)}`) : Object.entries(y as object).filter(([, s]) => scalar(s)).map(([a, s]) => `  ${label(a)}: ${indent(text(s), 4)}`);
    return `${label(k)}:${lines.length ? "\n" + lines.join("\n") : " -"}`;
  });
  return [kv.length ? keyValue(kv) : "", ...rest].filter(Boolean).join("\n\n");
}

export function briefingPlan(pos: string[], v: Record<string, unknown>, io: Io, json: boolean, now: () => number): Plan {
  checkFlags(v, ["day", "request"], "briefing");
  if (pos.length !== 1) throw usage(`expected no arguments in: ${pos.join(" ")}`);
  if (v.request === false) throw usage("--no-request is not valid for briefing");
  const day = typeof v.day === "string" ? v.day : undefined;
  if (day !== undefined) seg(day);
  if (v.request && day !== undefined) throw usage("--request asks for today's briefing; drop --day");
  return async (call, org) => {
    const path = `/orgs/${seg(await org())}/briefings/${day === undefined ? "today" : seg(day)}`;
    const body = await call(v.request ? "POST" : "GET", path);
    const d = isObj(body?.data) ? body.data : {};
    const dd = clean(d.day ?? day ?? "today");
    const state = typeof d.state === "string" ? d.state : "";
    const hint = day === undefined ? "\nAsk for one: olympus briefing --request" : "";
    const piped = () => [["day", d.day], ["state", d.state], ["session_id", d.session_id], ["requested_at", d.requested_at]].map(([k, x]) => `${k}: ${dash(x)}`).concat(d.document == null ? [] : leaves(d.document, "document")).join("\n");
    const tty = () => {
      if (state === "none") return `No briefing for ${dd}.${hint}`;
      if (state === "pending") return v.request ? `Asked your agent to write your briefing for ${dd}. Check back in a few minutes: olympus briefing` : `Your briefing for ${dd} is being written${d.requested_at ? ` (asked ${ago(d.requested_at as string, now())})` : ""}. Check again in a few minutes.`;
      if (state === "failed") return `The briefing for ${dd} could not be written.${hint}`;
      const head = state === "ready" ? `Briefing for ${dd}` : `Briefing for ${dd}: ${clean(d.state)}`;
      return d.document == null ? head : `${head}\n\n${sections(d.document)}`;
    };
    print(io, json, body, piped, tty);
  };
}
