// The local CDP terminator's filter (§5.2 of the browser-relay contract; A6-A8 of the plan).
//
// The workbench is the UNTRUSTED side (§3): anything holding COMPANION_TOKEN - every agent in the
// organization with a terminal on the tenant machine - can drive this socket or attach a fake
// laptop. So this is default-deny: a command reaches Chromium only when its domain is allowlisted,
// no rule below names it, and it rides a flattened sessionId this filter watched attach to a page
// target. Everything else is answered with a CDP error response and never forwarded - never
// dropped silently, because a dropped command leaves the workbench waiting forever.
//
// Only COMMANDS are filtered (Assumption 10). Chromium's responses and events pass through to the
// workbench unread, except three events this filter acts on along the way:
// Target.attachedToTarget and Target.detachedFromTarget (session tracking) and
// Page.fileChooserOpened (A8). Nothing here stops an event from carrying what a refused domain
// would have produced - some arrive with no domain enabled at all - and nothing needs to: the
// workbench is the transport, so it already sees every page byte.
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

// The filter's own A8 setup commands take ids from here up, and Chromium's answers to them are
// dropped on the way back because the workbench never sent them. That id is the only thing read in
// the browser-to-workbench direction. A workbench using ids this high loses its own responses.
export const SETUP_ID = 1_000_000_000;

// §5.2's allowed domains. Every one is a PAGE domain, reached only through a flattened session;
// Target is absent because it addresses the browser target, so it is method-allowlisted instead.
const DOMAINS = new Set(["Page", "Runtime", "DOM", "CSS", "Input", "Network", "Fetch", "Emulation", "Log", "Accessibility"]);

// Target, cut to what driving page targets needs. This list alone is what refuses the rest of the
// domain, three of which A6 names: `sendMessageToTarget`, which carries a whole CDP message as a
// STRING to a target by id, so every check in this file would be bypassed by wrapping one message
// inside another; `exposeDevToolsProtocol`, which hands a page a `window.cdp` binding, i.e. CDP
// from inside the page; and `attachToBrowserTarget`, which is a session on the browser target
// rather than a page. `setRemoteLocations` reaches past page targets too, and so does whatever
// Target grows next - which is the point of allowlisting the methods instead of the domain.
// `createBrowserContext` is here because A6 refuses only its `proxyServer` form, and
// `disposeBrowserContext` is its pair.
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

// A7 / §5.5. "" is how Target.createTarget asks for a blank page. A private, loopback or
// link-local HOST is not checked here: every connection leaves through the SOCKS proxy, whose
// address rules refuse those (A9), and the proxy bypass list keeps loopback on that path.
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

// A6's refusals that sit INSIDE an allowed domain, plus the two marked ADDITION, which A6 does not
// name and A8 needs. The ones outside an allowed domain - every `Browser.*`, `sendMessageToTarget`,
// `exposeDevToolsProtocol` - need no rule here: the two allowlists above are what refuse them. A
// rule returns why it refused, or undefined to carry on.
const RULES: Record<string, (p: Params) => string | undefined> = {
  // A non-flattened attach wraps that session's messages in Target.sendMessageToTarget envelopes,
  // which are not inspected, so it is refused outright rather than filtered: only flattened
  // sessions exist. CDP's `flatten` defaults to the old nested behaviour, so absent is not true.
  "Target.attachToTarget": (p) => (p.flatten === true ? undefined : "Target.attachToTarget requires flatten: true"),
  "Target.setAutoAttach": (p) => (p.flatten === true ? undefined : "Target.setAutoAttach requires flatten: true"),
  // A context with its own proxy sends that context's traffic wherever the workbench likes,
  // outside the SOCKS tunnel every other connection leaves through (§5.4).
  "Target.createBrowserContext": (p) =>
    p.proxyServer === undefined ? undefined : "Target.createBrowserContext with proxyServer is refused",
  "Target.createTarget": (p) => navTarget(p.url),
  "Page.navigate": (p) => navTarget(p.url),
  // A8: the filter issues download-deny itself, and the workbench may not undo it. Browser's copy
  // of this method is refused with the rest of that domain.
  "Page.setDownloadBehavior": () => "downloads are denied; Page.setDownloadBehavior is refused",
  // Writes the member's own files into a file input - the one command that reads their disk.
  "DOM.setFileInputFiles": () => "DOM.setFileInputFiles is refused",
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

/** Why this command is refused, or undefined to forward it. The whole decision, as a pure function. */
export function refusal(cmd: CdpCommand, pageSessions: ReadonlySet<string>): string | undefined {
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
    return "this sessionId never attached to a page target";
  }
  return undefined;
}

export type CdpFilter = {
  /** A message from the workbench: forwarded to Chromium verbatim, or answered with a CDP error. */
  fromWorkbench: (message: string) => void;
  /** A message from Chromium: forwarded to the workbench, with the three events above acted on. */
  fromBrowser: (message: string) => void;
};

/** The terminator's filter over one CDP connection. Both sends are injected; this opens no socket. */
export function cdpFilter(toBrowser: CdpSend, toWorkbench: CdpSend): CdpFilter {
  const pages = new Set<string>();
  let nextId = SETUP_ID;
  const issue = (sessionId: string, method: string, params?: Params) =>
    toBrowser(JSON.stringify({ id: nextId++, method, params, sessionId }));

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
      // Anything but a JSON object for params counts as no params, so a rule that reads one sees
      // nothing rather than something it cannot read, and default-deny refuses.
      const params = m.params !== null && typeof m.params === "object" && !Array.isArray(m.params) ? (m.params as Params) : undefined;
      const why = refusal({ id: m.id, method: m.method, sessionId, params }, pages);
      // Forwarded as it arrived, not re-serialized: this filter is not the one to rewrite it.
      return why === undefined ? toBrowser(message) : toWorkbench(cdpError(m.id, why, sessionId));
    },

    fromBrowser(message) {
      let m: any;
      try {
        m = JSON.parse(message);
      } catch {
        return toWorkbench(message);
      }
      if (typeof m?.id === "number" && m.id >= SETUP_ID) return; // the answer to one of our own
      const sid = m?.params?.sessionId;
      if (m?.method === "Target.attachedToTarget") {
        if (typeof sid === "string" && m.params?.targetInfo?.type === "page") {
          pages.add(sid);
          // A8, issued by the filter itself on every page session. Page.enable comes first because
          // fileChooserOpened is a Page event and the workbench may never enable the domain;
          // whether Chromium withholds the event without it is UNVERIFIED (nothing here launches a
          // browser - that is 2.4), and the cost of enabling is that the workbench receives Page
          // events it never asked for.
          issue(sid, "Page.enable");
          issue(sid, "Page.setDownloadBehavior", { behavior: "deny" });
          issue(sid, "Page.setInterceptFileChooserDialog", { enabled: true });
        }
      } else if (m?.method === "Target.detachedFromTarget") {
        if (typeof sid === "string") pages.delete(sid);
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
