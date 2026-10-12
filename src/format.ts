import { STATUS_CODES } from "node:http";

// Strips C0/C1 controls (so server text cannot drive the terminal). Tabs and, unless kept, newlines become spaces.
export function clean(s: unknown, keepNewlines = false): string {
  const t = typeof s === "string" ? s : s !== null && typeof s === "object" ? JSON.stringify(s) : String(s ?? "");
  const x = t.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, " ");
  return keepNewlines ? x : x.replace(/\n/g, " ");
}

// null/undefined cells render "-"; "" renders empty. The last column is never padded.
export function table(head: string[], rows: (string | null | undefined)[][]): string {
  const cell = (v: string | null | undefined) => (v === null || v === undefined ? "-" : clean(v));
  const grid = [head, ...rows.map((r) => r.map(cell))];
  // ponytail: .length width; wide/emoji chars misalign, use Intl.Segmenter + east-asian width if it matters
  const w = head.map((_, i) => Math.max(...grid.map((r) => (r[i] ?? "").length)));
  return grid.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]! + 2))).join("").trimEnd()).join("\n");
}

// Values keep their newlines; continuation lines are indented under the value column.
export function keyValue(pairs: [string, string | null | undefined][]): string {
  const w = Math.max(0, ...pairs.map(([k]) => clean(k).length)) + 2;
  return pairs
    .map(([k, v]) => {
      const val = v === null || v === undefined ? "-" : clean(v, true);
      return (clean(k).padEnd(w) + val.split("\n").join("\n" + " ".repeat(w))).trimEnd();
    })
    .join("\n");
}

export function ago(iso: string | null | undefined, now: number): string {
  if (iso === null || iso === undefined) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return clean(iso);
  const s = (now - t) / 1000;
  if (s < 0) { // future: up to 5 min ahead is clock skew; "+Nd", not "in Nd", because test/cli.test.ts:562 (frozen) needs one token before the paren
    const f = -s;
    if (f <= 300) return "just now";
    if (f < 3600) return `+${Math.floor(f / 60)}m`;
    if (f < 86400) return `+${Math.floor(f / 3600)}h`;
    if (f < 30 * 86400) return `+${Math.floor(f / 86400)}d`;
    return new Date(t).toISOString().slice(0, 10);
  }
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

export function when(iso: string | null | undefined, now: number): string {
  if (iso === null || iso === undefined) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return clean(iso);
  return `${ago(iso, now)} (${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC)`;
}

export function delivery(status: number | null | undefined, at: string | null | undefined, now: number): string {
  if (status === null || status === undefined) return "never";
  const label = STATUS_CODES[status]?.toLowerCase();
  return `${status}${label ? " " + label : ""}${at ? ", " + ago(at, now) : ""}`;
}
