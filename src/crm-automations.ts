import { CliError, print, seg, usage, type Io } from "./core";
import { clean, keyValue } from "./format";
import { pollRun, showRun, timeoutSecs } from "./crons";
import { checkFlags, dash, type Plan } from "./tasks";

type Opts = Record<string, unknown>;
type Ctx = { v: Opts; io: Io; json: boolean; now: () => number; signal: AbortSignal };

// A key the server rejects is a usage error, so it is never sent. `^[a-z0-9][a-z0-9-]{0,63}$`.
const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const crm = async (org: () => Promise<string>, rest: string) => `/orgs/${seg(await org())}/crm${rest}`;

// `{automation?: key, all?: true}`. A note is not a field: the server rejects it, and `--note` is not a flag here.
function selection(v: Opts, action: string): Record<string, unknown> {
  if (v.all === false) throw usage(`crm automation ${action} does not accept --no-all`);
  const picked = v.automation !== undefined;
  const all = v.all === true;
  if (picked && all) throw usage("--automation and --all cannot be combined");
  if (!picked) return all ? { all: true } : {};
  const key = String(v.automation);
  if (!KEY.test(key)) throw usage("--automation must be 1-64 characters of a-z, 0-9 and hyphens, starting with a letter or digit");
  return { automation: key };
}

function showState(c: Ctx, body: any, sentence: string): void {
  const state = body?.data?.state;
  print(c.io, c.json, body, () => `state: ${dash(state)}`, () => `${sentence}\n\n` + keyValue([["state", state == null || state === "" ? null : clean(state)]]));
}

type Spec = { flags: string[]; build: (c: Ctx, dealId: string) => Plan };

const SPECS: Record<string, Spec> = {
  pause: { flags: ["automation", "all"], build: (c, dealId) => {
    const body = selection(c.v, "pause");
    return async (call, org) => showState(c, await call("POST", await crm(org, `/deals/${seg(dealId)}/automation_pause`), body), `Paused the automation on deal ${clean(dealId)}.`);
  } },
  resume: { flags: ["automation", "all"], build: (c, dealId) => {
    const body = selection(c.v, "resume");
    return async (call, org) => showState(c, await call("POST", await crm(org, `/deals/${seg(dealId)}/automation_resume`), body), `Resumed the automation on deal ${clean(dealId)}.`);
  } },
  run: { flags: ["automation", "wait", "timeout"], build: (c, dealId) => {
    const secs = timeoutSecs(c.v);
    const body = selection(c.v, "run");
    return async (call, org) => {
      let started = false;
      try {
        const b = await call("POST", await crm(org, `/deals/${seg(dealId)}/automation_run`), body);
        started = true;
        const run = b?.data?.run;
        const have = run?.id != null && run.id !== "";
        if (!have && b?.data?.state === "cron_paused")
          return showState(c, b, `Deal ${clean(dealId)}'s automation cron is paused; nothing was queued.`);
        if (!have) throw new CliError(5, { error: { code: "bad_response", message: "the server did not return a run receipt" } });
        if (!secs) return showRun(c, b, `Triggered the automation on deal ${clean(dealId)}.`);
        const cronId = run.cron_id;
        if (typeof cronId !== "string" || cronId === "" || cronId === "." || cronId === "..")
          throw new CliError(5, { error: { code: "bad_response", message: "the server did not return a cron id on the run receipt" } });
        await pollRun(c, call, org, cronId, run, secs);
      } catch (e) {
        if (!started && e instanceof CliError && e.exit === 130)
          throw new CliError(130, { error: { code: "cancelled", message: "cancelled; the run was not started" } });
        throw e;
      }
    };
  } },
};

export function automationPlan(pos: string[], v: Opts, io: Io, json: boolean, now: () => number, signal: AbortSignal): Plan {
  const action = pos[2] ?? "";
  const spec = Object.hasOwn(SPECS, action) ? SPECS[action] : undefined;
  if (!spec) throw usage(`unknown crm command: ${pos.slice(1).join(" ")}`);
  checkFlags(v, spec.flags, "crm automation " + action);
  if (pos.length !== 4) throw usage(`expected 4 argument(s) in: ${pos.join(" ")}`);
  const dealId = pos[3]!;
  seg(dealId);
  return spec.build({ v, io, json, now, signal }, dealId);
}
