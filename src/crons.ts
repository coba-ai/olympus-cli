import { CliError, print, realSleep, seg, usage, type Api, type Io } from "./core";
import { clean, keyValue, table, when } from "./format";
import { checkFlags, dash, type Plan } from "./tasks";

type Opts = Record<string, unknown>;
type Ctx = { pos: string[]; v: Opts; io: Io; json: boolean; now: () => number; signal: AbortSignal };

const TERMINAL = new Set(["ok", "error", "unknown"]);
const POLL_MS = 2000;
const DEFAULT_TIMEOUT_S = 300;
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const base = async (org: () => Promise<string>, id?: string) =>
  `/orgs/${seg(await org())}/crons${id === undefined ? "" : `/${seg(id)}`}`;

function stripOneTrailingNewline(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  return s;
}

function assertOneStdin(v: Opts): void {
  const used = ["schedule-file", "instructions-file", "script-file"].filter((k) => v[k] === "-");
  if (used.length > 1) throw usage("stdin can only supply one of --schedule-file / --instructions-file / --script-file");
}

// Flag text, or a file (`-` is stdin). One trailing newline is removed so a shell redirect is the value.
async function optionalText(io: Io, v: Opts, flag: string): Promise<string | undefined> {
  const fileFlag = `${flag}-file`;
  const [text, file] = [v[flag], v[fileFlag]];
  if (text !== undefined && file !== undefined) throw usage(`give only one of --${flag} / --${fileFlag}`);
  if (file === undefined) {
    if (text === undefined) return undefined;
    if (String(text).trim() === "") throw usage(`--${flag} is empty`);
    return String(text);
  }
  if (file === "") throw usage(`--${fileFlag} needs a path or -`);
  let raw: string;
  if (file === "-") raw = await io.stdin();
  else {
    try { raw = await Bun.file(String(file)).text(); }
    catch { throw usage(`cannot read ${flag} file: ${file}`); }
  }
  const value = stripOneTrailingNewline(raw);
  if (value.trim() === "") throw usage(`--${fileFlag} is empty`);
  return value;
}

async function payload(c: Ctx, keys: readonly ("name" | "schedule" | "prompt" | "script" | "profile")[]): Promise<Record<string, string>> {
  assertOneStdin(c.v);
  const body: Record<string, string> = {};
  if (keys.includes("name") && c.v.name !== undefined) {
    if (String(c.v.name).trim() === "") throw usage("--name is empty");
    body.name = String(c.v.name);
  }
  if (keys.includes("schedule")) {
    const schedule = await optionalText(c.io, c.v, "schedule");
    if (schedule !== undefined) body.schedule = schedule;
  }
  if (keys.includes("prompt")) {
    const prompt = await optionalText(c.io, c.v, "instructions");
    if (prompt !== undefined) body.prompt = prompt;
  }
  if (keys.includes("script")) {
    const script = await optionalText(c.io, c.v, "script");
    if (script !== undefined) body.script = script;
  }
  if (keys.includes("profile") && c.v.profile !== undefined) {
    if (String(c.v.profile).trim() === "") throw usage("--profile is empty");
    body.profile = String(c.v.profile);
  }
  return body;
}

function pageQuery(v: Opts): string {
  if (v.page === undefined) return "";
  if (!/^[1-9]\d*$/.test(String(v.page))) throw usage("--page must be a positive whole number");
  return `?${new URLSearchParams({ page: String(v.page) })}`;
}

// `--wait` polls; `--timeout` without it, and `--no-wait`, are usage errors. Returns 0 when not waiting.
function timeoutSecs(v: Opts): number {
  if (v.wait === false) throw usage("waiting is off unless you pass --wait");
  if (v.wait !== true) {
    if (v.timeout !== undefined) throw usage("--timeout needs --wait");
    return 0;
  }
  if (v.timeout === undefined) return DEFAULT_TIMEOUT_S;
  const raw = String(v.timeout);
  const n = /^\d+$/.test(raw) ? Number(raw) : 0;
  if (n < 1 || n > 86400) throw usage("--timeout must be a whole number of seconds from 1 to 86400");
  return n;
}

const ownerId = (o: any) => (o && typeof o === "object" ? o.id : o);
const runCells = (r: any) => [r?.id, r?.state, r?.trigger, r?.actor, r?.started_at, r?.finished_at, r?.error].map(dash).join("\t");
const closed = (r: any) => typeof r?.state === "string" && TERMINAL.has(r.state);

function cronPiped(d: any, runs?: any[]): string {
  return [
    `id: ${dash(d.id)}`, `name: ${dash(d.name)}`, `profile_name: ${dash(d.profile_name)}`, `schedule: ${dash(d.schedule)}`,
    `state: ${dash(d.state)}`, `paused: ${d.paused === true ? "true" : d.paused === false ? "false" : "-"}`,
    `paused_note: ${dash(d.paused_note)}`, `owner: ${dash(ownerId(d.owner))}`, `prompt: ${dash(d.prompt)}`, `script: ${dash(d.script)}`,
    `last_run_at: ${dash(d.last_run_at)}`, `last_result: ${dash(d.last_result)}`, `last_error: ${dash(d.last_error)}`,
    `last_delivery_error: ${dash(d.last_delivery_error)}`,
    `latest_receipt: ${d.latest_receipt ? runCells(d.latest_receipt) : "-"}`,
    ...arr(d.recent_failures).map((r) => `failure: ${runCells(r)}`),
    ...(runs ? runs.map((r) => `run: ${runCells(r)}`) : []),
  ].join("\n");
}

function moreFooter(body: any): string {
  const page = Number(body?.page) || 1;
  if (body?.more === true) return `\n\nPage ${page}. Next: --page ${page + 1}`;
  return page > 1 ? `\n\nPage ${page}.` : "";
}

function cronBlock(d: any, now: number, runs: any[] | undefined, body: any): string {
  const owner = d.owner && typeof d.owner === "object" ? d.owner.name ?? d.owner.id : d.owner;
  const latest = d.latest_receipt;
  const head = keyValue([
    ["id", clean(d.id)], ["name", clean(d.name)], ["agent", d.profile_name == null ? null : clean(d.profile_name)],
    ["schedule", d.schedule == null ? null : clean(d.schedule)], ["state", d.state == null ? null : clean(d.state)],
    ["paused", d.paused === true ? "yes" : d.paused === false ? "no" : null],
    ["paused note", d.paused_note == null ? null : clean(d.paused_note)],
    ["owner", owner == null || owner === "" ? null : clean(owner)],
    ["prompt", d.prompt == null ? null : clean(d.prompt, true)], ["script", d.script == null ? null : clean(d.script, true)],
    ["last run", d.last_run_at == null ? null : when(d.last_run_at, now)], ["last result", d.last_result == null ? null : clean(d.last_result)],
    ["last error", d.last_error == null ? null : clean(d.last_error)],
    ["delivery error", d.last_delivery_error == null ? null : clean(d.last_delivery_error)],
    ["latest receipt", latest ? `${clean(latest.state)} ${when(latest.finished_at ?? latest.started_at, now)}` : null],
  ]);
  const failures = arr(d.recent_failures);
  const fail = failures.length
    ? `\n\nrecent failures:\n` + failures.map((r) => "  " + [r?.id, r?.state, when(r?.started_at, now), r?.error ?? "-"].map((x) => clean(x)).join("  ")).join("\n")
    : "";
  const listed = runs === undefined ? ""
    : `\n\nruns:\n` + (runs.length ? runs.map((r) => "  " + [r?.id, r?.state, r?.trigger, r?.actor ?? "-", when(r?.started_at, now)].map((x) => clean(x)).join("  ")).join("\n") : "  none") + moreFooter(body);
  return head + fail + listed;
}

function showCron(c: Ctx, body: any, sentence?: string): void {
  const d = body?.data ?? {};
  const runs = Object.prototype.hasOwnProperty.call(body ?? {}, "runs") ? arr(body.runs) : undefined;
  print(c.io, c.json, body, () => cronPiped(d, runs), () => (sentence ? `${sentence}\n\n` : "") + cronBlock(d, c.now(), runs, body));
}

function runPiped(r: any): string {
  return [
    ["id", r.id], ["cron_id", r.cron_id], ["profile_name", r.profile_name], ["state", r.state], ["trigger", r.trigger],
    ["actor", r.actor], ["started_at", r.started_at], ["finished_at", r.finished_at], ["error", r.error],
  ].map(([k, x]) => `${k}: ${dash(x)}`).join("\n");
}

function runBlock(r: any, now: number): string {
  const head = keyValue([
    ["id", r.id == null ? null : clean(r.id)], ["cron", r.cron_id == null ? null : clean(r.cron_id)],
    ["agent", r.profile_name == null ? null : clean(r.profile_name)], ["state", r.state == null ? null : clean(r.state)],
    ["trigger", r.trigger == null ? null : clean(r.trigger)], ["actor", r.actor == null ? null : clean(r.actor)],
    ["started", r.started_at == null ? null : when(r.started_at, now)], ["finished", r.finished_at == null ? null : when(r.finished_at, now)],
    ["error", r.error == null ? null : clean(r.error)],
  ]);
  const receipt = r.receipt;
  const empty = receipt == null || (typeof receipt === "object" && !Array.isArray(receipt) && !Object.keys(receipt).length);
  return head + (empty ? "" : `\n\nreceipt:\n` + clean(JSON.stringify(receipt, null, 2), true).split("\n").map((l) => "  " + l).join("\n"));
}

function showRun(c: Ctx, body: any, sentence?: string): void {
  print(c.io, c.json, body, () => runPiped(body?.data?.run ?? {}), () => (sentence ? `${sentence}\n\n` : "") + runBlock(body?.data?.run ?? {}, c.now()));
}

const listRow = (c: any) => [
  c?.id, c?.state, c?.profile_name, ownerId(c?.owner), c?.last_run_at, c?.last_result,
  Array.isArray(c?.recent_failures) ? c.recent_failures.length : null, c?.schedule, c?.name, c?.prompt,
].map(dash).join("\t");

// Deadline bounds the wait when the clock moves. maxPolls stops a stuck clock from spinning.
async function pollRun(c: Ctx, call: Api, org: () => Promise<string>, id: string, opened: any, secs: number): Promise<void> {
  const runId = opened?.id;
  if (runId == null || runId === "") throw new CliError(5, { error: { code: "bad_response", message: "the server did not return a run receipt" } });
  const finish = (run: any) => showRun(c, { data: { run } }, `Run ${clean(runId)} finished: ${clean(run.state)}.`);
  if (closed(opened)) return finish(opened);
  const deadline = c.now() + secs * 1000;
  const maxPolls = secs + 1;
  const path = (await base(org, id)) + "/runs?page=1";
  const giveUp = () => new CliError(5, { error: { code: "timeout", message: `timed out after ${secs}s waiting for cron ${clean(id)} run ${clean(runId)}; it may still be running. Read it later: olympus crons runs ${clean(id)}` } });
  const cancelled = () => new CliError(130, { error: { code: "cancelled", message: `cancelled while waiting for cron ${clean(id)} run ${clean(runId)}; the run was started. Read it later: olympus crons runs ${clean(id)}` } });
  if (c.io.tty && !c.json) c.io.err(`Waiting up to ${secs}s for cron ${clean(id)} run ${clean(runId)}...\n`);
  let gap = POLL_MS;
  for (let polls = 0; ; polls++) {
    if (polls >= maxPolls || c.now() >= deadline) throw giveUp();
    if (polls > 0) {
      const left = deadline - c.now();
      if (left <= 0) throw giveUp();
      await (c.io.sleep ?? realSleep)(Math.min(gap, left), c.signal);
      gap = POLL_MS;
      if (c.signal.aborted) throw cancelled();
      if (c.now() >= deadline) throw giveUp();
    }
    let page: any;
    try {
      const left = deadline - c.now();
      page = await call("GET", path, undefined, Math.max(1000, Math.min(30_000, left)));
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      if (e.exit === 130 || c.signal.aborted) throw cancelled();
      const code = e.body?.error?.code;
      if (code === "machine_not_ready" || code === "machine_needs_update") throw e;
      const transient = e.status === undefined ? code === "network_error" : e.status === 429 || (e.status ?? 0) >= 500;
      if (!transient) throw e;
      if (e.status === 429 && e.retryAfter && /^\d+$/.test(e.retryAfter)) gap = Math.max(POLL_MS, Number(e.retryAfter) * 1000);
      continue;
    }
    const found = arr(page?.data).find((r) => r?.id != null && String(r.id) === String(runId));
    if (closed(found)) return finish(found);
  }
}

type Spec = { flags: string[]; n: number; build: (c: Ctx) => Plan | Promise<Plan> };

const SPECS: Record<string, Spec> = {
  list: { flags: [], n: 2, build: (c) => async (call, org) => {
    const slug = await org();
    const b = await call("GET", await base(async () => slug));
    const rows = arr(b?.data);
    print(c.io, c.json, b, () => rows.map(listRow).join("\n"), () => rows.length
      ? table(["ID", "NAME", "STATE", "SCHEDULE", "AGENT", "OWNER", "LAST RUN", "RESULT", "FAILURES"], rows.map((x) => [
        x?.id, x?.name, x?.state, x?.schedule, x?.profile_name,
        x?.owner && typeof x.owner === "object" ? x.owner.name ?? x.owner.id : x?.owner,
        x?.last_run_at == null ? null : when(x.last_run_at, c.now()), x?.last_result,
        Array.isArray(x?.recent_failures) ? String(x.recent_failures.length) : null,
      ]))
      : `No crons in ${clean(slug)} yet.`);
  } },
  get: { flags: ["page"], n: 3, build: (c) => {
    const q = pageQuery(c.v), id = c.pos[2]!;
    return async (call, org) => showCron(c, await call("GET", (await base(org, id)) + q));
  } },
  create: { flags: ["name", "schedule", "schedule-file", "instructions", "instructions-file", "profile"], n: 2, build: async (c) => {
    const body = await payload(c, ["name", "schedule", "prompt", "profile"]);
    if (body.name === undefined || body.schedule === undefined || body.prompt === undefined)
      throw usage("cron create needs --name, --schedule or --schedule-file, and --instructions or --instructions-file");
    return async (call, org) => {
      const b = await call("POST", await base(org), body);
      showCron(c, b, `Created cron ${clean(b?.data?.id)}.`);
    };
  } },
  update: { flags: ["name", "schedule", "schedule-file", "instructions", "instructions-file", "script", "script-file"], n: 3, build: async (c) => {
    const body = await payload(c, ["name", "schedule", "prompt", "script"]);
    if (!Object.keys(body).length) throw usage("cron update needs at least one field to change");
    const id = c.pos[2]!;
    return async (call, org) => {
      const b = await call("PATCH", await base(org, id), body);
      showCron(c, b, `Updated cron ${clean(id)}.`);
    };
  } },
  pause: { flags: ["note"], n: 3, build: (c) => {
    const id = c.pos[2]!, body = c.v.note === undefined ? {} : { note: String(c.v.note) };
    return async (call, org) => showCron(c, await call("POST", (await base(org, id)) + "/pause", body), `Paused cron ${clean(id)}.`);
  } },
  resume: { flags: [], n: 3, build: (c) => {
    const id = c.pos[2]!;
    return async (call, org) => showCron(c, await call("POST", (await base(org, id)) + "/resume", {}), `Resumed cron ${clean(id)}.`);
  } },
  delete: { flags: ["yes"], n: 3, build: (c) => {
    if (!c.v.yes) throw usage("cron delete needs --yes");
    const id = c.pos[2]!;
    return async (call, org) => {
      await call("DELETE", await base(org, id));
      print(c.io, c.json, { data: { id, deleted: true } }, () => `deleted ${id}`, () => `Deleted cron ${clean(id)}.`);
    };
  } },
  run: { flags: ["wait", "timeout"], n: 3, build: (c) => {
    const secs = timeoutSecs(c.v), id = c.pos[2]!;
    return async (call, org) => {
      let started = false;
      try {
        const b = await call("POST", (await base(org, id)) + "/run", {});
        started = true;
        const run = b?.data?.run;
        if (run?.id == null || run.id === "") throw new CliError(5, { error: { code: "bad_response", message: "the server did not return a run receipt" } });
        if (!secs) return showRun(c, b, `Triggered cron ${clean(id)}.`);
        await pollRun(c, call, org, id, run, secs);
      } catch (e) {
        if (!started && e instanceof CliError && e.exit === 130)
          throw new CliError(130, { error: { code: "cancelled", message: "cancelled; the run was not started" } });
        throw e;
      }
    };
  } },
  runs: { flags: ["page"], n: 3, build: (c) => {
    const q = pageQuery(c.v), id = c.pos[2]!;
    return async (call, org) => {
      const b = await call("GET", (await base(org, id)) + "/runs" + q);
      const rows = arr(b?.data);
      print(c.io, c.json, b, () => rows.map(runCells).join("\n"), () => rows.length
        ? table(["ID", "STATE", "TRIGGER", "ACTOR", "STARTED", "FINISHED", "ERROR"], rows.map((r) => [
          r?.id, r?.state, r?.trigger, r?.actor, r?.started_at == null ? null : when(r.started_at, c.now()),
          r?.finished_at == null ? null : when(r.finished_at, c.now()), r?.error,
        ])) + moreFooter(b)
        : "No runs.");
    };
  } },
};

export async function cronsPlan(pos: string[], v: Opts, io: Io, json: boolean, now: () => number, signal: AbortSignal): Promise<Plan> {
  const key = pos[1] ?? "";
  const spec = Object.hasOwn(SPECS, key) ? SPECS[key] : undefined;
  if (!spec) throw usage(`unknown cron command: ${pos.slice(1).join(" ")}`);
  checkFlags(v, spec.flags, "crons " + key);
  if (pos.length !== spec.n) throw usage(`expected ${spec.n} argument(s) in: ${pos.join(" ")}`);
  if (spec.n === 3) seg(pos[2]!);
  return spec.build({ pos, v, io, json, now, signal });
}
