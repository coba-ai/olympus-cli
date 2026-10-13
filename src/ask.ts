import { CliError, print, realSleep, seg, usage, type Io } from "./core";
import { clean } from "./format";
import { checkFlags, type Plan } from "./tasks";

// Seconds from Retry-After as milliseconds, floored at 2s; anything but plain digits is ignored.
const retryMs = (e: CliError) => (e.retryAfter && /^\d+$/.test(e.retryAfter) ? Math.max(2000, Number(e.retryAfter) * 1000) : undefined);
const lastId = (ms: any) => (Array.isArray(ms) ? ms.at(-1)?.id : undefined);

export async function askPlan(pos: string[], v: Record<string, unknown>, io: Io, json: boolean, now: () => number, signal: AbortSignal): Promise<Plan> {
  checkFlags(v, ["session", "timeout", "wait"]);
  if (pos.length !== 3) throw usage("ask needs an agent and TEXT (use - to read it from stdin)");
  if (v.wait === true) throw usage("waiting is the default; use --no-wait to skip it");
  const noWait = v.wait === false;
  if (noWait && v.timeout !== undefined) throw usage("--timeout cannot be combined with --no-wait");
  const secs = v.timeout === undefined ? 300 : /^\d+$/.test(String(v.timeout)) ? Number(v.timeout) : 0;
  if (secs < 1 || secs > 86400) throw usage("--timeout must be a whole number of seconds from 1 to 86400");
  if (v.session !== undefined) seg(String(v.session));
  const agent = pos[1]!;
  const text = pos[2] === "-" ? await io.stdin() : pos[2]!;
  if (!text.trim()) throw usage("TEXT is empty");

  return async (call, org) => {
    const deadline = now() + secs * 1000;
    let sid = "", tag = ""; // tag: sid as safe to print
    const mk = (exit: 1 | 5 | 6 | 130, code: string, message: string) =>
      new CliError(exit, { error: { code, message, ...(sid ? { details: { session_id: sid } } : {}) } });
    let sent: "none" | "inflight" | "accepted" = "none";
    let sawBusy = false;
    const cancelled = () =>
      sent === "accepted" ? mk(130, "cancelled", `cancelled; read it later: olympus session get ${tag}`)
      : sent === "inflight" ? mk(130, "cancelled", `cancelled; the message may have been sent; check olympus session get ${tag}`)
      : mk(130, "cancelled", `cancelled; nothing was sent${sid && !json ? ` (session ${tag})` : ""}`);
    const req = async (method: "GET" | "POST", path: string, body?: unknown) => {
      if (signal.aborted) throw cancelled();
      try {
        return (await call(method, path, body, Math.max(1000, Math.min(30000, deadline - now())))).data;
      } catch (e) {
        throw e instanceof CliError && e.exit === 130 ? cancelled() : e;
      }
    };
    const nap = async (ms: number) => {
      await (io.sleep ?? realSleep)(ms, signal);
      if (signal.aborted) throw cancelled(); // nothing is requested after an abort
    };
    const orgSeg = seg(await org());
    const base = `/orgs/${orgSeg}/sessions`;
    const read = (after?: string) => req("GET", `${base}/${seg(sid)}${after ? `?${new URLSearchParams({ after })}` : ""}`);

    try {
      let myId = "";
      if (!noWait) {
        const ps = await req("GET", `/orgs/${orgSeg}/people`);
        const id = Array.isArray(ps) ? ps.find((p: any) => p?.me === true)?.id : undefined;
        if (typeof id !== "string" || !id) throw new CliError(5, { error: { code: "bad_response", message: "could not tell which person you are; nothing was sent" } });
        myId = id;
      }
      let session: any, after: string | undefined;
      if (v.session !== undefined) {
        sid = String(v.session);
        tag = clean(sid);
        const d = await read();
        session = d?.session;
        const slug = session?.agent?.slug;
        if (slug !== undefined && slug !== agent) throw mk(6, "agent_mismatch", `session ${tag} is with ${clean(slug)}, not ${clean(agent)}`);
        after = lastId(d?.messages);
      } else {
        session = await req("POST", base, { agent });
        if (typeof session?.id !== "string" || !session.id) throw new CliError(5, { error: { code: "bad_response", message: "unexpected response when opening the session" } });
        sid = session.id;
        tag = clean(sid);
        if (io.tty && !json && !noWait) io.err(`session ${tag}\n`);
      }

      let turn: any;
      for (;;) {
        try {
          if (signal.aborted) throw cancelled();
          if (deadline - now() <= 0) throw mk(5, sawBusy ? "busy" : "not_sent", `${sawBusy ? `the agent is still busy in session ${tag}` : "no time left to send"}; nothing was sent`);
          sent = "inflight";
          turn = (await req("POST", `${base}/${seg(sid)}/messages`, { text }))?.turn;
          sent = "accepted";
          break;
        } catch (e) {
          if (sent === "inflight" && e instanceof CliError && e.exit !== 130) sent = "none"; // refused or failed: handled below
          if (!(e instanceof CliError)) throw e;
          // A network failure may have delivered the message, so it is never retried; a refusal (busy, rate limit) is safe to.
          if (e.status === undefined && e.body.error.code === "network_error") throw mk(5, "network_error", `the message may have been sent; check olympus session get ${tag}`);
          if (e.status !== 429 && !(e.status === 409 && e.body.error.code === "busy")) throw e;
          sawBusy ||= e.status === 409;
          const left = deadline - now();
          if (left <= 0) throw mk(5, "busy", `the agent is still busy in session ${tag}; nothing was sent`);
          await nap(Math.min(retryMs(e) ?? 5000, left));
          after = lastId((await read(after))?.messages) ?? after; // skip what others wrote while we waited
        }
      }

      if (noWait) {
        const body = { session, messages: [], turn };
        const line = `Sent to ${clean(session?.agent?.name ?? agent)} in session ${tag}. Read the reply later: olympus session get ${tag}`;
        return print(io, json, body, () => tag, () => line);
      }

      const got: any[] = [];
      let replies: any[] = [], wait = 2000, errs = 0, quiet = 0, live = turn?.state !== "failed";
      for (;;) {
        const left = deadline - now();
        if (left <= 0) throw mk(5, "timeout", `no reply within ${secs}s; the agent may still answer. Read it later: olympus session get ${tag}`);
        await nap(Math.min(wait, left));
        let d: any;
        try {
          d = await read(after);
        } catch (e) {
          if (!(e instanceof CliError)) throw e;
          if (e.status === 422) throw mk(5, "bad_request", `the server rejected the read; read it later: olympus session get ${tag}`);
          const transient = e.status === undefined ? e.body.error.code === "network_error" : e.status >= 500 || e.status === 429;
          if (!transient) throw e;
          wait = retryMs(e) ?? Math.min(2000 * 2 ** ++errs, 30000);
          continue;
        }
        errs = 0;
        wait = 2000;
        session = d?.session ?? session;
        const ms: any[] = Array.isArray(d?.messages) ? d.messages : [];
        got.push(...ms);
        after = lastId(ms) ?? after;
        turn = d?.turn ?? { state: "idle" };
        const st = typeof turn.state === "string" ? turn.state : "idle";
        // Our message is the first new user message from us with the text we sent; the reply is matched by that, not by position.
        const first = got.findIndex((m) => m.role === "user" && m.sender?.id === myId && m.text?.trim() === text.trim());
        // The reply ends at the next user message from anyone else (a missing sender id counts as someone else).
        const end = first < 0 ? -1 : got.findIndex((m, i) => i > first && m.role === "user" && m.sender?.id !== myId);
        replies = first < 0 ? [] : got.slice(first + 1, end < 0 ? undefined : end).filter((m) => m.role === "assistant");
        live ||= st !== "failed";
        const failure = () => mk(1, "turn_failed", `${clean(turn.error) || "the agent's turn failed"} (session ${tag})`);
        // Once someone else has spoken after our message our turn is over; the session's state now belongs to their turn.
        const over = first >= 0 && end >= 0;
        if (over) {
          if (!replies.length) io.err(`note: the agent finished without a text reply; see olympus session get ${tag}\n`);
          break;
        }
        if (st === "failed" && (first >= 0 || live)) throw failure();
        if (st !== "idle" && st !== "failed") quiet = 0; // anything but idle/failed (including unknown states) is still working
        else if (replies.length) break;
        else if (++quiet >= 3) { // finished, but the reply is not in the thread (yet)
          if (st === "failed") throw failure();
          if (first >= 0) { io.err(`note: the agent finished without a text reply; see olympus session get ${tag}\n`); break; }
        }
      }
      print(io, json, { session, messages: got, turn }, () => replies.map((m) => clean(m.text, true)).join("\n\n"));
    } catch (e) {
      if (e instanceof CliError && sid) { // tag every error with the session so a script can continue it
        const b: any = e.body.error;
        const d = b.details && typeof b.details === "object" && !Array.isArray(b.details) ? b.details : {};
        if (d.session_id === undefined) {
          b.details = { ...d, session_id: sid };
          if (!json && typeof b.message === "string") b.message += ` (session ${tag})`;
        }
      }
      throw e;
    }
  };
}
