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
// Target.createBrowserContext, which carries the new context's id and is HELD until the download
// denial for that context is acknowledged. BROWSER CONTEXTS are the one thing read on both sides:
// a command naming a context this filter has not covered is refused (`refusal` below), and an
// uncovered context's id is stripped out of whatever would have disclosed it (`disclose` below).
// Nothing here stops an event from carrying what a refused domain would have
// produced - some arrive with no domain enabled at all -
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

// Target.setAutoAttach's FULL parameter list, read from `browser_protocol.json` (1.3) on
// 2026-10-14: `autoAttach` and `waitForDebuggerOnStart`, both required booleans, plus the optional
// `flatten` and `filter` - four, and no more. These three are the ones the rule below enforces by
// value; `filter` is refused by the same inversion that refuses whatever the protocol grows next.
const AUTO_ATTACH_PARAMS = new Set(["autoAttach", "waitForDebuggerOnStart", "flatten"]);

// `filter` keeps a message of its own because it is the parameter that turns three true booleans
// into no auto-attach at all. TargetFilter's own text: "the first entry that matches determines if
// the target is included or not", and a FilterEntry with no `type` "matches any type" - so
// `filter: [{exclude: true}]` excludes EVERY target.
const AUTO_ATTACH_REFUSALS = new Map<string, string>([
  [
    "filter",
    "Target.setAutoAttach with filter is refused: an entry with no type matches every target, so [{exclude: true}] is the filter's own paused auto-attach switched off by another name",
  ],
]);

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
  // switch it off, `waitForDebuggerOnStart: false` would let a new target run before the filter has
  // seen it attach, and `filter` would drop the targets it applies to while all three booleans read
  // true. So this method is allowlisted by PARAMETER the way createBrowserContext below is: the
  // three AUTO_ATTACH_PARAMS must each be `true`, and EVERY other parameter is refused by presence,
  // including the ones nobody here has read and the ones the protocol grows next.
  //
  // So the workbench may re-state this command and may not weaken it - which also means it cannot
  // auto-attach a sub-target un-paused. What enforces that is this function plus the filter's own
  // command on construction, and the tests "Target.setAutoAttach that would weaken the filter's own
  // paused auto-attach" and "refuses every setAutoAttach parameter but the three it enforces,
  // filter included"; nothing in Chromium does. `Target.autoAttachRelated`, the other way to set it
  // - and it carries `filter` too - is kept out by TARGET_METHODS above rather than by a rule here.
  "Target.setAutoAttach": (p) => {
    if (p.flatten !== true) return "Target.setAutoAttach requires flatten: true";
    if (p.autoAttach !== true) return "Target.setAutoAttach requires autoAttach: true: the filter's own auto-attach may not be switched off";
    if (p.waitForDebuggerOnStart !== true)
      return "Target.setAutoAttach requires waitForDebuggerOnStart: true: a target must not run before the filter has seen it attach";
    // A Set and a Map, not objects, for the reason spelled out on createBrowserContext below: a
    // workbench can send `__proto__` as a parameter name.
    const name = Object.keys(p).find((k) => !AUTO_ATTACH_PARAMS.has(k));
    if (name === undefined) return undefined;
    return (
      AUTO_ATTACH_REFUSALS.get(name) ??
      `Target.setAutoAttach with ${name} is refused: only autoAttach, waitForDebuggerOnStart and flatten are allowed`
    );
  },
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

/**
 * Every object inside `value` that carries a `browserContextId` of its own. The caller reads the id
 * off each one, or deletes it - this only finds them, and serves both directions: the command the
 * workbench sent and the message Chromium answered with.
 *
 * Iterative, not recursive: both sides are untrusted here, and a recursive walk over a deeply
 * nested message would overflow this process's stack rather than refuse anything.
 *
 * It keys on the literal name, and a context named under any other key is neither refused nor
 * redacted. Swept from `browser_protocol.json` (1.3) on 2026-10-14 (`refusal` and `disclose` below
 * carry the two lists): every parameter, return and event that names a context spells it
 * `browserContextId` EXCEPT `Target.getBrowserContexts`, whose `browserContextIds` and
 * `defaultBrowserContextId` this walk does not find - that method is outside TARGET_METHODS, so
 * its response only exists if something other than the workbench asked for it, and nothing here
 * would redact one. Nor does anything enforce that a later protocol keeps to that one spelling.
 */
function contextHolders(value: unknown): Params[] {
  const holders: Params[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    const held = node as Params;
    // `hasOwn`, not `in`: a workbench can send `__proto__` as a parameter name, and `JSON.parse`
    // makes that an ordinary own property rather than a prototype - walked like any other value.
    if (Object.hasOwn(held, "browserContextId")) holders.push(held);
    for (const v of Object.values(held)) stack.push(v);
  }
  return holders;
}

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
 *
 * `covered` carries the browser contexts this filter has denied downloads in; naming any other one
 * is refused. It defaults to empty, so a caller that passes nothing may name no context at all.
 */
export function refusal(
  cmd: CdpCommand,
  pageSessions: ReadonlySet<string>,
  unusable: ReadonlyMap<string, { why: string }> = new Map(),
  covered: ReadonlySet<string> = new Set(),
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

  // A context is COVERED once `Browser.setDownloadBehavior` deny for it has been acknowledged, and
  // the only contexts that happens for are the ones the workbench created through
  // Target.createBrowserContext on this connection (cdpFilter below is what adds them). Naming any
  // other one is refused here, which is what closes the two routes that holding the new context's
  // id did not: an id the workbench guessed, and an id it read back out of ordinary traffic before
  // `disclose` below started stripping them.
  //
  // Swept from `browser_protocol.json` (1.3) on 2026-10-14: of the methods the two allowlists above
  // admit, exactly two carry a browserContextId - `Target.createTarget` (optional) and
  // `Target.disposeBrowserContext` (required), both at the top level of params. The other eight in
  // the protocol that name a context are already outside those allowlists: Browser.setPermission,
  // grantPermissions, resetPermissions, setDownloadBehavior and cancelDownload (a refused DOMAIN),
  // Storage.getCookies, setCookies and clearCookies (likewise), and Target.getBrowserContexts,
  // which would enumerate every context, is not in TARGET_METHODS. The whole params object is
  // walked rather than those two fields, so a nested or later-added one is refused too - but
  // NOTHING enforces that the sweep itself stays current, the same hole DOMAINS above admits.
  //
  // The DEFAULT context is covered by the construction-time denial, and its id is never learnt
  // here (getBrowserContexts is refused), so it is not in `covered` and the workbench cannot name
  // it. What it loses is only the spelling: a command reaches that context by naming no context,
  // which is what Target.createTarget does when `browserContextId` is omitted.
  for (const holder of contextHolders(cmd.params))
    if (typeof holder.browserContextId !== "string" || !covered.has(holder.browserContextId))
      return "this command names a browser context the filter has not denied downloads in; only a context created through Target.createBrowserContext on this connection may be named";

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
 * acknowledged, no page session is usable until its own three commands are acknowledged, and a
 * browser context is usable and disclosable only once its own denial is acknowledged - the id of a
 * context the workbench creates is withheld until then (the hold below), a command naming a context
 * that is not covered is refused (`refusal` above), and an uncovered context's id is stripped out of
 * the messages that would have disclosed it (`disclose` below).
 * What is NOT: that Chromium's browser-wide denial actually covers every present and future context -
 * the protocol's text says an omitted `browserContextId` means the DEFAULT context, which is why a
 * context the workbench creates gets its own command below, and the rest is UNVERIFIED; and that
 * auto-attach on the browser session reaches every target Chromium can create, which is UNVERIFIED
 * too. A page the filter never sees attach therefore gets the download denial and NOT the
 * file-chooser interception, which is narrower than it was, not closed. Nor does the context gate
 * reach a context that already existed when this filter connected: the workbench can neither name
 * it nor be told its id, but a target living in one still arrives in a target info with every other
 * field intact, and attaching to it by `targetId` is allowed - what covers that page is the
 * per-session setup above and the browser-wide denial, not `covered`.
 */
export function cdpFilter(toBrowser: CdpSend, toWorkbench: CdpSend): CdpFilter {
  const pages = new Set<string>();
  const unusable = new Map<string, Unusable>();
  /** Our own outstanding request ids, each with what to do with its answer. The answer is dropped. */
  const mine = new Map<number, (m: any) => void>();
  /** Workbench Target.createBrowserContext ids waiting for the response that names the new context. */
  const contexts = new Set<number>();
  /**
   * The browser contexts this filter has denied downloads in, each added when Chromium acknowledged
   * that denial. A context the workbench created is PENDING - absent from here - from the response
   * that names it until its denial returns; if that denial is refused it is disposed and never
   * added, and the filter fails closed anyway. Nothing is ever removed, disposal included: a
   * disposed id left here costs an error from Chromium on the next command, not a protection.
   * The default context is covered by the construction-time denial and is NOT in here, because its
   * id is never learnt (see `refusal` above).
   */
  const covered = new Set<string>();
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

  // The other half of the context gate: a message on its way to the workbench does not hand over
  // the id of a context that is not covered. Swept from `browser_protocol.json` (1.3) on
  // 2026-10-14, the messages that can carry one are the responses to Target.getTargets,
  // Target.getTargetInfo and Target.createBrowserContext, and the events Target.attachedToTarget,
  // Target.targetCreated and Target.targetInfoChanged - all but createBrowserContext's through a
  // TargetInfo. (Target.getBrowserContexts would return a whole list of them; it is in neither
  // allowlist and this filter never issues it, and it spells them differently anyway - see
  // `contextHolders` above.) This reads the message's shape rather than its method, so a later one
  // is covered as long as it spells the field the same way - which nothing enforces.
  //
  // The ID is REDACTED and the entry kept, rather than the entry dropped: the workbench still has
  // to learn the target exists to attach to it and drive it, and dropping an attachedToTarget would
  // leave it waiting on a session this filter had already set up. `browserContextId` is optional on
  // TargetInfo, so what is left is a message the protocol still describes.
  //
  // The string test is not only speed: a message whose bytes do not spell the name holds no such
  // field, UNLESS whatever serialized it escaped the key - `"\u0062rowserContextId"` parses to the
  // same name and would read past this test unredacted. What serializes these is Chromium, which
  // does not; nothing here would notice if it started. It is also why an untouched message is
  // forwarded byte-for-byte rather than re-serialized.
  // What is NOT covered either: a message that is not JSON is forwarded unread, as it always was.
  //
  // `Target.setDiscoverTargets` (and `Target.getTargets`) take a `filter`, which was left with no
  // rule and still has none: it chooses WHICH targets the workbench is told about and never what a
  // target info says, so every id it lets through comes past this function anyway. It is not the
  // setAutoAttach case either - discovery attaches nothing, pauses nothing, and this filter acts on
  // no discovery event; its session tracking rides Target.attachedToTarget, which comes from
  // auto-attach.
  const disclose = (raw: string, m: any): string => {
    if (!raw.includes("browserContextId")) return raw;
    let redacted = false;
    for (const holder of contextHolders(m)) {
      if (typeof holder.browserContextId === "string" && covered.has(holder.browserContextId)) continue;
      delete holder.browserContextId;
      redacted = true;
    }
    return redacted ? JSON.stringify(m) : raw;
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
      const why = refusal({ id: m.id, method: m.method, sessionId, params }, pages, unusable, covered);
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
          // The response is HELD, not forwarded, until the denial for the new context is
          // acknowledged, and the id is added to `covered` in the same step. Issuing the denial
          // first and forwarding straight away was NOT enough - the workbench's next command for
          // that context was accepted while the denial was still in flight, so a target could be
          // created in an uncovered context. Held by this branch and the test "holds the new
          // context's id until downloads are denied in it".
          //
          // The hold is no longer what protects an uncovered context, because an id can be guessed
          // and one used to arrive back in a target info: `refusal` above refuses a command naming
          // an uncovered context and `disclose` above strips an uncovered id out of every message
          // that would have carried it. This is what tells those two that a context is covered.
          if (typeof browserContextId === "string") {
            issue(undefined, "Browser.setDownloadBehavior", { behavior: "deny", browserContextId }, (r) => {
              if (!r?.error) {
                covered.add(browserContextId);
                return void toWorkbench(disclose(message, m)); // covered now: release the id
              }
              // Refused, so the context exists and its downloads are not denied. The filter disposes
              // it, answers the workbench's own command with an error instead of the id, and fails
              // closed from here on. Whether the dispose actually happened is NOT checked - its
              // answer is dropped like every other command of the filter's. Enforced by "disposes
              // the context and fails the command when that denial is refused, then fails closed".
              fail(`the download denial for browser context ${browserContextId}`, r);
              issue(undefined, "Target.disposeBrowserContext", { browserContextId });
              toWorkbench(
                cdpError(
                  m.id,
                  `downloads could not be denied in the new browser context (${said(r)}); it was sent Target.disposeBrowserContext, whose answer this filter does not check, and nothing is forwarded from here on`,
                  typeof m.sessionId === "string" ? m.sessionId : undefined,
                ),
              );
            });
            return;
          }
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
      // Everything above reads the message as Chromium sent it; only what the workbench is handed
      // is redacted, so the attach this filter just acted on still installs its setup.
      return toWorkbench(disclose(message, m));
    },
  };
}
