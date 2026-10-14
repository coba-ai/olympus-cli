// The local CDP terminator's filter (§5.2 of the browser-relay contract; A6-A8 of the plan).
//
// The workbench is the UNTRUSTED side (§3): anything holding COMPANION_TOKEN - every agent in the
// organization with a terminal on the tenant machine - can drive this socket or attach a fake
// laptop. So this is default-deny: a command reaches Chromium only when the filter's own A8
// protection is installed browser-wide (`cdpFilter` below), its domain is allowlisted, no rule
// below names it, and it rides a flattened sessionId this filter watched attach to a page target
// AND finish its own A8 setup. Everything else is answered with a CDP error response and never
// forwarded - never dropped silently, because a dropped command leaves the workbench waiting
// forever.
//
// Only COMMANDS are filtered (Assumption 10). Chromium's responses and events pass through to the
// workbench unread, except three events this filter acts on along the way:
// Target.attachedToTarget and Target.detachedFromTarget (session tracking) and
// Page.fileChooserOpened (A8) - plus one RESPONSE, the answer to a workbench
// Target.createBrowserContext, which carries the new context's id and is read so the filter can
// deny downloads in it before the workbench knows that id. Nothing here stops an event from
// carrying what a refused domain would have produced - some arrive with no domain enabled at all -
// and nothing needs to: the workbench is the transport, so it already sees every page byte.
import type { CdpSend } from "./browser-frame";

type Params = Record<string, unknown>;

/** A CDP command from the workbench, parsed. `params` is absent unless it arrived as a JSON object. */
export type CdpCommand = { id: number; method: string; sessionId?: string; params?: Params };

// One code for every refusal; the message names the rule. Chromium returns -32000 for its own
// server errors too, so the code alone does not say a refusal came from here - the prefix does.
export const REFUSED = -32000;
const PREFIX = "refused by olympus browser attach";

// The error response a refusal sends back: {id, error} on the same session the command arrived on.
function cdpError(id: number, why: string, sessionId?: string): string {
  const body: { id: number; error: { code: number; message: string }; sessionId?: string } = {
    id,
    error: { code: REFUSED, message: `${PREFIX}: ${why}` },
  };
  if (sessionId !== undefined) body.sessionId = sessionId;
  return JSON.stringify(body);
}

// The filter's own A8 commands take ids from here up. Which responses are dropped on the way back
// is decided by the EXACT ids still outstanding (`mine` in cdpFilter), not by magnitude, so an
// answer to an accepted workbench command is never swallowed; and `refusal` refuses a workbench
// command whose id is in this range at ingress, which is what makes the range genuinely reserved -
// without it the two sides could hold the same outstanding id and neither response could be placed.
export const SETUP_ID = 1_000_000_000;

// §5.2's allowed domains. Every one is a PAGE domain, reached only through a flattened session;
// Target is absent because it addresses the browser target, so it is method-allowlisted instead.
//
// Allowlisting a DOMAIN admits every method in it, the ones nobody here has read included, and the
// ones the protocol grows next. The table and rules below close the URL-bearing and disk-reading
// methods found by reading `browser_protocol.json` on 2026-10-14; NOTHING enforces that a method
// added after that date is found at all, and method-allowlisting all ten was considered and
// declined (plan 3.1a). This is a narrower hole than it was, not a closed one.
const DOMAINS = new Set(["Page", "Runtime", "DOM", "CSS", "Input", "Network", "Fetch", "Emulation", "Log", "Accessibility"]);

// Target, cut to what driving page targets needs. This list alone is what refuses the rest of the
// domain, three of which A6 names: `sendMessageToTarget`, which carries a whole CDP message as a
// STRING to a target by id, so every check in this file would be bypassed by wrapping one message
// inside another; `exposeDevToolsProtocol`, which hands a page a `window.cdp` binding, i.e. CDP
// from inside the page; and `attachToBrowserTarget`, which is a session on the browser target
// rather than a page. `setRemoteLocations` reaches past page targets too, and so does whatever
// Target grows next - which is the point of allowlisting the methods instead of the domain.
// `createBrowserContext` is here because the rule below cuts it to the one parameter that cannot
// widen what the new context may reach, and `disposeBrowserContext` is its pair.
const TARGET_METHODS = new Set([
  "Target.activateTarget",
  "Target.attachToTarget",
  "Target.closeTarget",
  "Target.createBrowserContext",
  "Target.createTarget",
  "Target.detachFromTarget",
  "Target.disposeBrowserContext",
  "Target.getTargetInfo",
  "Target.getTargets",
  "Target.setAutoAttach",
  "Target.setDiscoverTargets",
]);

// A7 / §5.5, and the one scheme rule for every method that hands Chromium a URL to LOAD. "" is how
// Target.createTarget asks for a blank page. A private, loopback or link-local HOST is not checked
// here: every connection leaves through the SOCKS proxy, whose address rules refuse those (A9), and
// the proxy bypass list keeps loopback on that path.
function navTarget(url: unknown): string | undefined {
  if (typeof url !== "string") return "a navigation needs a url";
  if (url === "" || url === "about:blank") return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "refusing a navigation target that is not a url";
  }
  if (u.protocol === "http:" || u.protocol === "https:") return undefined;
  return `refusing a ${u.protocol} navigation target: only http, https and about:blank`;
}

type Rule = (p: Params) => string | undefined;

// Where a loadable URL lives, per method - a table so the next one is a row, not another branch.
// `OVERRIDE` marks a URL that REPLACES one the page already asked for, where absent means "leave it
// alone" and there is nothing to check; `REQUIRED` is a method that does not act without one, so a
// missing or non-string url is refused the way A7 already refuses it for Page.navigate.
const REQUIRED = false;
const OVERRIDE = true;
const URL_METHODS: [method: string, param: string, override: boolean][] = [
  ["Page.navigate", "url", REQUIRED], // A7
  ["Target.createTarget", "url", REQUIRED], // A7
  // "Fetches the resource and returns the content" - a fetch primitive in its own right, so without
  // this it is the file:// read that A7's two methods are refused for.
  ["Network.loadNetworkResource", "url", REQUIRED],
  // Rewrites an intercepted request's URL "in a way that's not observable by page": the page asks
  // for one thing and Chromium loads another, scheme included.
  ["Fetch.continueRequest", "url", OVERRIDE],
];

const urlRules: Record<string, Rule> = Object.fromEntries(
  URL_METHODS.map(([method, param, override]): [string, Rule] => [
    method,
    (p) => (override && p[param] === undefined ? undefined : navTarget(p[param])),
  ]),
);

// The three createBrowserContext parameters read on 2026-10-14 that widen a context's reach, each
// with the reason it does. This table buys a better message, never an allowance: the rule below
// refuses a parameter whether it is named here or not.
const CONTEXT_REFUSALS = new Map<string, string>([
  ["proxyServer", "Target.createBrowserContext with proxyServer is refused"],
  [
    "proxyBypassList",
    "Target.createBrowserContext with proxyBypassList is refused: a bypassed host is reached directly, outside the SOCKS tunnel",
  ],
  [
    "originsWithUniversalNetworkAccess",
    "Target.createBrowserContext with originsWithUniversalNetworkAccess is refused: it grants those origins unlimited cross-origin access",
  ],
]);

// A6's refusals that sit INSIDE an allowed domain, plus the URL table above and the three marked
// ADDITION, which A6 does not name. The ones outside an allowed domain - every `Browser.*`,
// `sendMessageToTarget`, `exposeDevToolsProtocol` - need no rule here: the two allowlists above are
// what refuse them. A rule returns why it refused, or undefined to carry on.
const RULES: Record<string, Rule> = {
  ...urlRules,
  // A non-flattened attach wraps that session's messages in Target.sendMessageToTarget envelopes,
  // which are not inspected, so it is refused outright rather than filtered: only flattened
  // sessions exist. CDP's `flatten` defaults to the old nested behaviour, so absent is not true.
  "Target.attachToTarget": (p) => (p.flatten === true ? undefined : "Target.attachToTarget requires flatten: true"),
  // The filter installs a paused auto-attach of its own on the browser session (cdpFilter below),
  // and a sessionless workbench setAutoAttach lands on that same session: `autoAttach: false` would
  // switch it off and `waitForDebuggerOnStart: false` would let a new target run before the filter
  // has seen it attach. So the workbench may re-state this command and may not weaken it - which
  // also means it cannot auto-attach a sub-target un-paused. What enforces the pause is this rule
  // plus the filter's own command; nothing in Chromium does, and `Target.autoAttachRelated`, the
  // other way to set it, is kept out by TARGET_METHODS above rather than by a rule here.
  "Target.setAutoAttach": (p) =>
    p.flatten !== true
      ? "Target.setAutoAttach requires flatten: true"
      : p.autoAttach !== true
        ? "Target.setAutoAttach requires autoAttach: true: the filter's own auto-attach may not be switched off"
        : p.waitForDebuggerOnStart !== true
          ? "Target.setAutoAttach requires waitForDebuggerOnStart: true: a target must not run before the filter has seen it attach"
          : undefined,
  // A new context is created with a routing and reach of its own, so this method is allowlisted by
  // PARAMETER the way the rest of the file is allowlisted by method: `disposeOnDetach`, which only
  // says when the context dies, is the one that passes, and EVERY other parameter is refused by
  // presence - including the ones nobody here has read and the ones the protocol grows next. That
  // is the point of inverting it: a parameter named by no rule is refused rather than forwarded.
  // The cost is refusing a future harmless parameter, which the workbench can complain about;
  // forwarding a future widening one is the failure nobody would see. What enforces it is this
  // function and the test "refuses every parameter but disposeOnDetach, named by a rule or not" -
  // nothing in Chromium does, and nothing checks that CONTEXT_REFUSALS above stays current.
  //
  // Those three keep a message of their own because each says more than the generic refusal:
  //   proxyServer (A6): that context's traffic leaves wherever the workbench likes, outside the
  //     SOCKS tunnel every other connection leaves through (§5.4).
  //   proxyBypassList: the same hole from the other end - a host named here is reached DIRECT from
  //     the member's machine, which is their LAN, and the launcher's own bypass list is what keeps
  //     loopback on that path. Whether Chromium honours a bypass list with no proxyServer beside
  //     it is UNVERIFIED (nothing here launches a browser), so it is refused rather than tested.
  //   originsWithUniversalNetworkAccess: "a list of origins to grant unlimited cross-origin access
  //     to" - no proxy involved, the reach widened inside the renderer instead.
  "Target.createBrowserContext": (p) => {
    const name = Object.keys(p).find((k) => k !== "disposeOnDetach");
    if (name === undefined) return undefined;
    // A Map, not an object: a workbench can send `__proto__` as a parameter name, and an object
    // lookup would answer with something that is not a refusal message.
    return CONTEXT_REFUSALS.get(name) ?? `Target.createBrowserContext with ${name} is refused: only disposeOnDetach is allowed`;
  },
  // A8: the filter issues download-deny itself, and the workbench may not undo it. Browser's copy
  // of this method is refused with the rest of that domain.
  "Page.setDownloadBehavior": () => "downloads are denied; Page.setDownloadBehavior is refused",
  // Writes the member's own files into a file input - the one command that reads their disk.
  "DOM.setFileInputFiles": () => "DOM.setFileInputFiles is refused",
  // ADDITION. "Returns file information for the given File wrapper" - and the information is
  // `path`, the local filesystem path. The same leak as the line above, read back rather than
  // written in, and A6 names only the written-in half.
  "DOM.getFileInfo": () => "DOM.getFileInfo is refused",
  // The drag payload carries files, which is that same read of the member's disk by another name.
  "Input.dispatchDragEvent": () => "Input.dispatchDragEvent is refused",
  // ADDITION. A8 says the workbench cannot undo chooser interception "because A6 refuses both
  // commands", but A6 names only the two above: without this rule the workbench turns interception
  // off and the member gets a real file picker on their own filesystem.
  "Page.setInterceptFileChooserDialog": () =>
    "file choosers are intercepted and cancelled; Page.setInterceptFileChooserDialog is refused",
  // ADDITION, for the same claim. Whether disabling the domain also drops the interception this
  // filter installed is UNVERIFIED - nothing here launches Chromium - so it is refused rather than
  // tested. The workbench loses nothing it needs: it can ignore the events instead.
  "Page.disable": () => "Page.disable is refused: it may drop the file-chooser interception this filter installed",
};

// A domain name is short, and this one is echoed back in the refusal message; anything longer is
// not a domain.
const domainOf = (method: string) => {
  const dot = method.indexOf(".");
  return dot > 0 && dot <= 40 ? method.slice(0, dot) : "";
};

/**
 * Why this command is refused, or undefined to forward it. The whole decision, as a pure function.
 * `unusable` carries the page sessions that attached but are not usable: their setup is still in
 * flight, or Chromium refused it. They are refused with a reason of their own rather than with the
 * never-attached message, which would be the false comment of rule 0 in a protocol field.
 */
export function refusal(
  cmd: CdpCommand,
  pageSessions: ReadonlySet<string>,
  unusable: ReadonlyMap<string, { why: string }> = new Map(),
): string | undefined {
  if (cmd.id >= SETUP_ID) return `a command id at or above ${SETUP_ID} is reserved for this filter's own commands`;
  const domain = domainOf(cmd.method);
  if (!domain) return "not a CDP method";
  if (domain === "Target") {
    if (!TARGET_METHODS.has(cmd.method)) return "not an allowed Target method";
  } else if (!DOMAINS.has(domain)) {
    return `${domain} is not an allowed CDP domain`;
  }

  const why = RULES[cmd.method]?.(cmd.params ?? {});
  if (why) return why;

  // §5.2 filters on every flattened sessionId. A command with no sessionId lands on the
  // browser-level session this CLI holds, where no page exists and A8 installs nothing, so only
  // Target is allowed there - and that is also what keeps a CDP connection wired to a PAGE
  // endpoint from arriving as a stream of sessionless page commands nothing would check.
  if (cmd.sessionId === undefined) {
    if (domain !== "Target") return `${domain} needs a flattened page session, and this command carries no sessionId`;
  } else if (!pageSessions.has(cmd.sessionId)) {
    return unusable.get(cmd.sessionId)?.why ?? "this sessionId never attached to a page target";
  }
  return undefined;
}

export type CdpFilter = {
  /** A message from the workbench: forwarded to Chromium verbatim, or answered with a CDP error. */
  fromWorkbench: (message: string) => void;
  /** A message from Chromium: forwarded to the workbench, with the three events and the one response above acted on. */
  fromBrowser: (message: string) => void;
};

// What a page session that attached but is not usable is refused with. The whole value of the map
// entry, so `refusal` above can read it without this file allocating a second map per command.
type Unusable = { why: string };

/**
 * The terminator's filter over one CDP connection. Both sends are injected; this opens no socket.
 *
 * A8's protection is installed in TWO places, because installing it only where a page attaches made
 * it depend on the untrusted side choosing to attach:
 *
 *   - browser-wide, from this constructor, before the first workbench command is allowed through:
 *     `Browser.setDownloadBehavior` deny (a command the FILTER issues - the whole Browser domain is
 *     refused to the workbench) and a paused `Target.setAutoAttach`, so a target the workbench
 *     creates and never attaches to, or a page a script opens, inherits the denial and cannot run
 *     before this filter has seen it. The workbench is refused until both have SUCCEEDED, and if
 *     either is refused by Chromium the filter refuses everything from then on. That gate is what
 *     makes "before anything is forwarded" true - not the order of the sends, which assumes a
 *     FIFO-per-session Chromium this repo cannot verify (nothing here launches a browser).
 *   - per page session, as before: Page.enable, download deny, chooser interception.
 *
 * What is enforced, exactly: no workbench command is forwarded until the browser-wide denial is
 * acknowledged, and no page session is usable until its own three commands are acknowledged. What
 * is NOT: that Chromium's browser-wide denial actually covers every present and future context -
 * the protocol's text says an omitted `browserContextId` means the DEFAULT context, which is why a
 * context the workbench creates gets its own command below, and the rest is UNVERIFIED; and that
 * auto-attach on the browser session reaches every target Chromium can create, which is UNVERIFIED
 * too. A page the filter never sees attach therefore gets the download denial and NOT the
 * file-chooser interception, which is narrower than it was, not closed.
 */
export function cdpFilter(toBrowser: CdpSend, toWorkbench: CdpSend): CdpFilter {
  const pages = new Set<string>();
  const unusable = new Map<string, Unusable>();
  /** Our own outstanding request ids, each with what to do with its answer. The answer is dropped. */
  const mine = new Map<number, (m: any) => void>();
  /** Workbench Target.createBrowserContext ids waiting for the response that names the new context. */
  const contexts = new Set<number>();
  let nextId = SETUP_ID;
  let installed = 0;
  let broken: string | undefined;

  const issue = (sessionId: string | undefined, method: string, params?: Params, settle?: (m: any) => void) => {
    const id = nextId++;
    mine.set(id, settle ?? (() => {}));
    // `sessionId: undefined` drops out of the JSON, which is how a command addresses the
    // browser-level session this CLI holds.
    toBrowser(JSON.stringify({ id, method, params, sessionId }));
  };

  // Chromium's own wording where there is one, so a refusal says why rather than that something
  // went wrong. `m.error` on a CDP response is {code, message}; nothing guarantees the shape here.
  const said = (m: any) => (typeof m?.error?.message === "string" ? m.error.message : JSON.stringify(m?.error));

  // Fail closed, and stay closed: a half-installed protection forwards nothing. There is no retry -
  // the workbench reconnects, which builds a new filter and a new install.
  const fail = (what: string, m: any) => {
    broken ??= `${what} failed to install (${said(m)}); this filter forwards nothing`;
  };

  // A8, browser-wide. Issued here rather than on attach; see the comment on this function.
  const opened = (m: any) => {
    if (m?.error) return fail("the browser-wide download denial", m);
    installed++;
  };
  issue(undefined, "Browser.setDownloadBehavior", { behavior: "deny" }, opened);
  issue(undefined, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, opened);

  // A8 per page session, and the only thing that makes one usable. Until all three are acknowledged
  // the session is refused with a reason of its own, and a command Chromium refuses is not
  // discarded - it ends the setup, and the session stays refused for as long as it exists. A target
  // that attached PAUSED is then never resumed, so it never runs; one that attached running - a
  // workbench Target.attachToTarget, where waitingForDebugger is false - was already running before
  // this filter saw it, and all it loses is the session. The browser-wide denial is what covers it.
  //
  // Page.enable comes first because fileChooserOpened is a Page event and the workbench may never
  // enable the domain; whether Chromium withholds the event without it is UNVERIFIED (nothing here
  // launches a browser - that is 2.4), and the cost of enabling is that the workbench receives Page
  // events it never asked for.
  const install = (sid: string, paused: boolean) => {
    const state = { left: 3, why: "this page session is not usable yet: the filter's download and file-chooser protection is still installing" };
    // If the same sessionId ever attaches twice, the second attach starts unusable rather than
    // inheriting the first setup's success.
    pages.delete(sid);
    unusable.set(sid, state);
    const settle = (m: any) => {
      if (unusable.get(sid) !== state || state.left <= 0) return; // detached, re-attached, or already failed
      if (m?.error) {
        state.left = -1;
        state.why = `this page session is unusable: Chromium refused the filter's protection setup (${said(m)})`;
        return;
      }
      if (--state.left > 0) return;
      unusable.delete(sid);
      pages.add(sid);
      // Only now: the target has been paused since it attached, and this is what lets it run.
      // UNVERIFIED that Chromium rejects this on a target that was not waiting, which is why it is
      // sent only for one that was.
      if (paused) issue(sid, "Runtime.runIfWaitingForDebugger");
    };
    issue(sid, "Page.enable", undefined, settle);
    issue(sid, "Page.setDownloadBehavior", { behavior: "deny" }, settle);
    issue(sid, "Page.setInterceptFileChooserDialog", { enabled: true }, settle);
  };

  return {
    fromWorkbench(message) {
      let m: any;
      try {
        m = JSON.parse(message);
      } catch {
        return toWorkbench(cdpError(0, "message is not JSON"));
      }
      const sessionId = typeof m?.sessionId === "string" ? m.sessionId : undefined;
      if (typeof m?.id !== "number" || typeof m?.method !== "string")
        return toWorkbench(cdpError(typeof m?.id === "number" ? m.id : 0, "a CDP command needs a numeric id and a string method", sessionId));
      // The A8 gate. Refused rather than queued: a queue would hold a command this filter has
      // already decided may never be forwarded if the install turns out to have failed.
      if (broken !== undefined) return toWorkbench(cdpError(m.id, broken, sessionId));
      if (installed < 2)
        return toWorkbench(cdpError(m.id, "the filter's browser-wide download denial is still installing; nothing is forwarded until it succeeds", sessionId));
      // Anything but a JSON object for params counts as no params, so a rule that reads one sees
      // nothing rather than something it cannot read, and default-deny refuses.
      const params = m.params !== null && typeof m.params === "object" && !Array.isArray(m.params) ? (m.params as Params) : undefined;
      const why = refusal({ id: m.id, method: m.method, sessionId, params }, pages, unusable);
      if (why !== undefined) return toWorkbench(cdpError(m.id, why, sessionId));
      // The response to this one names the new context, which the filter reads on the way back.
      if (m.method === "Target.createBrowserContext") contexts.add(m.id);
      // Forwarded as it arrived, not re-serialized: this filter is not the one to rewrite it.
      return toBrowser(message);
    },

    fromBrowser(message) {
      let m: any;
      try {
        m = JSON.parse(message);
      } catch {
        return toWorkbench(message);
      }
      if (typeof m?.id === "number") {
        const settle = mine.get(m.id);
        if (settle !== undefined) {
          // The answer to one of our own: never forwarded, because the workbench never sent it.
          mine.delete(m.id);
          settle(m);
          return;
        }
        if (contexts.has(m.id)) {
          contexts.delete(m.id);
          const browserContextId = m.result?.browserContextId;
          // Issued BEFORE the response is forwarded, so it is on the wire ahead of anything the
          // workbench can send about a context whose id it does not have yet. A refusal fails the
          // whole filter closed rather than leaving one context downloading.
          if (typeof browserContextId === "string")
            issue(undefined, "Browser.setDownloadBehavior", { behavior: "deny", browserContextId }, (r) =>
              r?.error ? fail(`the download denial for browser context ${browserContextId}`, r) : undefined,
            );
        }
      }
      const sid = m?.params?.sessionId;
      if (m?.method === "Target.attachedToTarget") {
        if (typeof sid === "string") {
          if (m.params?.targetInfo?.type === "page") install(sid, m.params?.waitingForDebugger === true);
          // Not a page, so no page protection applies to it and nothing here will ever make it a
          // usable session - but the filter's own waitForDebuggerOnStart pauses it too, and leaving
          // it paused would hang whatever is waiting on it. The browser-wide download denial does
          // not depend on this one running or not. UNVERIFIED whether a non-page target can open a
          // file chooser; if one can, it is not intercepted.
          else if (m.params?.waitingForDebugger === true) issue(sid, "Runtime.runIfWaitingForDebugger");
        }
      } else if (m?.method === "Target.detachedFromTarget") {
        if (typeof sid === "string") {
          pages.delete(sid);
          unusable.delete(sid);
        }
      } else if (m?.method === "Page.fileChooserOpened" && typeof m.sessionId === "string" && pages.has(m.sessionId)) {
        // A8's answer: cancel it. `cancel` is the protocol's own dismissal flag. UNVERIFIED against
        // a real Chromium, and one that rejects the parameter leaves the chooser intercepted and
        // unanswered - no file is selected either way, so the failure direction is the safe one.
        // What is enforced here is that the command goes out on the session that asked.
        issue(m.sessionId, "Page.setInterceptFileChooserDialog", { enabled: true, cancel: true });
      }
      return toWorkbench(message);
    },
  };
}
