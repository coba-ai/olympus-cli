import { describe, expect, test } from "bun:test";
import { cdpFilter, refusal, REFUSED, SETUP_ID } from "../src/browser-cdp";

const S = "S1"; // the one page session the harness attaches

const attachEvent = (sessionId: string, type: string) =>
  JSON.stringify({
    method: "Target.attachedToTarget",
    params: { sessionId, targetInfo: { targetId: "T1", type, url: "about:blank", attached: true }, waitingForDebugger: false },
  });

function harness() {
  const toBrowser: string[] = [];
  const toWorkbench: string[] = [];
  const f = cdpFilter((m) => void toBrowser.push(m), (m) => void toWorkbench.push(m));
  const h = {
    f,
    toBrowser,
    toWorkbench,
    /** Chromium attaches a page target; the A8 setup commands it triggers are cleared away. */
    attach(sessionId = S) {
      f.fromBrowser(attachEvent(sessionId, "page"));
      toBrowser.length = 0;
      toWorkbench.length = 0;
      return h;
    },
    send(cmd: object) {
      f.fromWorkbench(JSON.stringify(cmd));
      return h;
    },
    /** What went to Chromium, as [method, sessionId, params]. */
    issued: () => toBrowser.map((m) => JSON.parse(m)).map((m) => [m.method, m.sessionId, m.params ?? null]),
    last: (): any => JSON.parse(toWorkbench.at(-1)!),
  };
  return h;
}

/** Asserts `cmd` is answered with a CDP error on its own session and never reaches Chromium. */
function refuse(cmd: { id: number; method: string; sessionId?: string; params?: unknown }, contains: string) {
  const h = harness().attach();
  h.send(cmd);
  expect(h.toBrowser).toEqual([]);
  expect(h.toWorkbench.length).toBe(1);
  const r = h.last();
  expect([r.id, r.sessionId, r.error.code]).toEqual([cmd.id, cmd.sessionId, REFUSED]);
  expect(r.error.message).toContain(contains);
}

describe("A6 CDP allowlist: what is allowed", () => {
  test("allows one command in each permitted domain on a page session, and Target on the browser session", () => {
    const pages = new Set([S]);
    const allowed: [string, Record<string, unknown>?][] = [
      ["Page.enable"],
      ["Page.navigate", { url: "https://example.test/" }],
      ["Runtime.evaluate", { expression: "1+1" }],
      ["DOM.getDocument", { depth: 1 }],
      ["CSS.getComputedStyleForNode", { nodeId: 3 }],
      ["Input.dispatchKeyEvent", { type: "keyDown", text: "a" }],
      ["Network.enable"],
      ["Fetch.enable", { patterns: [] }],
      ["Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }],
      ["Log.enable"],
      ["Accessibility.getFullAXTree"],
      ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
    ];
    for (const [method, params] of allowed) expect(refusal({ id: 1, method, sessionId: S, params }, pages)).toBeUndefined();

    for (const method of ["Target.getTargets", "Target.setDiscoverTargets", "Target.closeTarget", "Target.activateTarget", "Target.getTargetInfo"])
      expect(refusal({ id: 1, method }, pages)).toBeUndefined();
    expect(refusal({ id: 1, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } }, pages)).toBeUndefined();
    expect(refusal({ id: 1, method: "Target.createBrowserContext", params: { disposeOnDetach: true } }, pages)).toBeUndefined();
  });

  test("forwards an allowed command to Chromium byte-for-byte and answers the workbench nothing", () => {
    const h = harness().attach();
    const raw = '{"id":7,"method":"Page.navigate","params":{"url":"https://example.test/x"},"sessionId":"S1"}';
    h.f.fromWorkbench(raw);
    expect(h.toBrowser).toEqual([raw]);
    expect(h.toWorkbench).toEqual([]);
  });
});

describe("A6 CDP allowlist: every refusal", () => {
  test("Target.createBrowserContext with proxyServer", () => {
    refuse({ id: 1, method: "Target.createBrowserContext", params: { proxyServer: "socks5://10.0.0.1:1080" } }, "proxyServer");
  });

  test("every Browser.* command", () => {
    for (const method of ["Browser.close", "Browser.setDownloadBehavior", "Browser.grantPermissions", "Browser.getVersion"])
      refuse({ id: 2, method }, "Browser is not an allowed CDP domain");
  });

  test("Page.setDownloadBehavior", () => {
    refuse({ id: 3, method: "Page.setDownloadBehavior", sessionId: S, params: { behavior: "allow", downloadPath: "/home/member" } }, "downloads are denied");
  });

  test("DOM.setFileInputFiles", () => {
    refuse({ id: 4, method: "DOM.setFileInputFiles", sessionId: S, params: { files: ["/home/member/.ssh/id_ed25519"], nodeId: 2 } }, "DOM.setFileInputFiles");
  });

  test("DOM.getFileInfo, which returns the local path of a File the page holds", () => {
    refuse({ id: 40, method: "DOM.getFileInfo", sessionId: S, params: { objectId: "1.2.3" } }, "DOM.getFileInfo is refused");
  });

  test("Target.sendMessageToTarget, which would carry any command as a string", () => {
    refuse(
      { id: 5, method: "Target.sendMessageToTarget", params: { targetId: "T1", message: '{"id":1,"method":"Browser.close"}' } },
      "not an allowed Target method",
    );
  });

  test("Target.attachToTarget with flatten anything but true", () => {
    for (const params of [{ targetId: "T1" }, { targetId: "T1", flatten: false }, { targetId: "T1", flatten: "true" }, { targetId: "T1", flatten: 1 }])
      refuse({ id: 6, method: "Target.attachToTarget", params }, "requires flatten: true");
  });

  test("Target.exposeDevToolsProtocol", () => {
    refuse({ id: 7, method: "Target.exposeDevToolsProtocol", params: { targetId: "T1", bindingName: "cdp" } }, "not an allowed Target method");
  });

  test("Target.setAutoAttach with flatten: false, or with none at all", () => {
    for (const flatten of [false, undefined])
      refuse({ id: 8, method: "Target.setAutoAttach", sessionId: S, params: { autoAttach: true, waitForDebuggerOnStart: false, flatten } }, "requires flatten: true");
  });

  test("an unknown domain", () => {
    for (const method of ["Debugger.enable", "Storage.clearDataForOrigin", "IO.read", "Tracing.start", "WebAuthn.enable", "Performance.enable", "Nonsense.go"])
      refuse({ id: 9, method, sessionId: S }, "is not an allowed CDP domain");
  });

  test("a Target method that is not on the list", () => {
    for (const method of ["Target.attachToBrowserTarget", "Target.setRemoteLocations", "Target.autoAttachRelated"])
      refuse({ id: 10, method }, "not an allowed Target method");
  });

  test("Input.dispatchDragEvent, the one Input method with a file payload", () => {
    refuse({ id: 11, method: "Input.dispatchDragEvent", sessionId: S, params: { type: "drop", x: 1, y: 1, data: { items: [], files: ["/etc/passwd"] } } }, "dispatchDragEvent");
  });

  test("a command on a sessionId that never attached to a page target", () => {
    refuse({ id: 12, method: "Page.reload", sessionId: "made-up" }, "never attached to a page target");
  });

  test("a page-domain command with no sessionId at all", () => {
    for (const method of ["Page.navigate", "Runtime.evaluate", "DOM.getDocument"])
      refuse({ id: 13, method, params: { url: "https://example.test/", expression: "1" } }, "carries no sessionId");
  });

  test("tracks only page targets: a browser, iframe, worker or tab session is never usable", () => {
    for (const type of ["browser", "iframe", "service_worker", "worker", "tab", "other"]) {
      const h = harness();
      h.f.fromBrowser(attachEvent("S9", type));
      expect(h.issued()).toEqual([]); // and A8's setup is not installed on one either
      h.send({ id: 14, method: "Runtime.evaluate", sessionId: "S9", params: { expression: "1" } });
      expect(h.toBrowser).toEqual([]);
      expect(h.last().error.message).toContain("never attached to a page target");
    }
  });

  test("forgets a session on Target.detachedFromTarget", () => {
    const h = harness().attach();
    h.f.fromBrowser(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: S, targetId: "T1" } }));
    h.send({ id: 15, method: "Page.reload", sessionId: S });
    expect(h.toBrowser).toEqual([]);
    expect(h.last().error.message).toContain("never attached to a page target");
  });

  test("a message that is not a CDP command", () => {
    const cases: [string, string][] = [
      ["not json at all", "not JSON"],
      ["[]", "numeric id and a string method"],
      ['{"method":"Page.reload","sessionId":"S1"}', "numeric id and a string method"],
      ['{"id":1}', "numeric id and a string method"],
      ['{"id":"1","method":"Page.reload","sessionId":"S1"}', "numeric id and a string method"],
      ['{"id":1,"method":"","sessionId":"S1"}', "not a CDP method"],
      ['{"id":1,"method":"Pagenavigate","sessionId":"S1"}', "not a CDP method"],
    ];
    for (const [message, contains] of cases) {
      const h = harness().attach();
      h.f.fromWorkbench(message);
      expect(h.toBrowser).toEqual([]);
      expect(h.last().error.code).toBe(REFUSED);
      expect(h.last().error.message).toContain(contains);
    }
  });

  test("params that are not a JSON object count as no params, so a guarded method is refused", () => {
    refuse({ id: 16, method: "Target.attachToTarget", params: ["flatten"] }, "requires flatten: true");
    refuse({ id: 17, method: "Page.navigate", sessionId: S, params: "https://example.test/" }, "a navigation needs a url");
  });
});

describe("A7 navigation scheme refusal", () => {
  const navMethods: [string, string | undefined][] = [
    ["Page.navigate", S],
    ["Target.createTarget", undefined],
  ];

  test("allows http, https and about:blank", () => {
    const pages = new Set([S]);
    for (const [method, sessionId] of navMethods)
      for (const url of ["http://example.test/a?b=c#d", "https://example.test:8443/", "about:blank", ""])
        expect(refusal({ id: 1, method, sessionId, params: { url } }, pages)).toBeUndefined();
  });

  test("refuses every other scheme a page can reach", () => {
    const urls = [
      "javascript:fetch('/x')",
      "file:///home/member/.ssh/id_ed25519",
      "data:text/html,<script>1</script>",
      "blob:https://example.test/0d9a",
      "chrome://settings/passwords",
      "devtools://devtools/bundled/inspector.html",
      "view-source:http://example.test/",
      "ws://example.test/",
      "ftp://example.test/",
      "about:blank#notblank",
      "about:srcdoc",
      "chrome-extension://abc/page.html",
      "filesystem:http://example.test/temporary/x",
    ];
    for (const [method, sessionId] of navMethods) for (const url of urls) refuse({ id: 20, method, sessionId, params: { url } }, "navigation target");
  });

  test("refuses a url that does not parse, and a missing or non-string one", () => {
    for (const [method, sessionId] of navMethods) {
      refuse({ id: 21, method, sessionId, params: { url: "://example.test" } }, "not a url");
      refuse({ id: 22, method, sessionId, params: {} }, "a navigation needs a url");
      refuse({ id: 23, method, sessionId, params: { url: 7 } }, "a navigation needs a url");
    }
  });
});

describe("the same scheme rule on the two url-bearing methods A7 did not cover", () => {
  const pages = new Set([S]);
  const options = { disableCache: false, includeCredentials: false };

  test("Network.loadNetworkResource, which fetches a url of its own", () => {
    for (const url of ["file:///home/member/.ssh/id_ed25519", "data:text/html,<script>1</script>", "chrome://settings/passwords", "javascript:fetch('/x')"])
      refuse({ id: 41, method: "Network.loadNetworkResource", sessionId: S, params: { url, options } }, "navigation target");
    refuse({ id: 42, method: "Network.loadNetworkResource", sessionId: S, params: { options } }, "a navigation needs a url");
    refuse({ id: 43, method: "Network.loadNetworkResource", sessionId: S, params: { url: "://example.test", options } }, "not a url");

    for (const url of ["http://example.test/a.js", "https://example.test/a.js"])
      expect(refusal({ id: 44, method: "Network.loadNetworkResource", sessionId: S, params: { url, options } }, pages)).toBeUndefined();
  });

  test("Fetch.continueRequest's url override, where no override is nothing to check", () => {
    for (const url of ["file:///etc/passwd", "data:text/html,x", "chrome://version", "about:srcdoc", 7])
      refuse({ id: 45, method: "Fetch.continueRequest", sessionId: S, params: { requestId: "R1", url } }, "navigation");

    for (const params of [
      { requestId: "R1" }, // the ordinary continue: no override, so no url to check
      { requestId: "R1", method: "POST", postData: "x" },
      { requestId: "R1", url: "https://example.test/x" },
      { requestId: "R1", url: "http://example.test/x" },
    ])
      expect(refusal({ id: 46, method: "Fetch.continueRequest", sessionId: S, params }, pages)).toBeUndefined();
  });
});

describe("A8 downloads and file choosers", () => {
  test("issues download-deny and chooser interception itself on every page session", () => {
    const h = harness();
    h.f.fromBrowser(attachEvent(S, "page"));
    expect(h.issued()).toEqual([
      ["Page.enable", S, null],
      ["Page.setDownloadBehavior", S, { behavior: "deny" }],
      ["Page.setInterceptFileChooserDialog", S, { enabled: true }],
    ]);
    expect(h.toWorkbench).toEqual([attachEvent(S, "page")]); // the event still reaches the workbench

    h.f.fromBrowser(attachEvent("S2", "page")); // every page session, not just the first
    expect(h.issued().filter(([, sid]) => sid === "S2").length).toBe(3);
  });

  test("answers Page.fileChooserOpened by cancelling on the session that asked", () => {
    const h = harness().attach();
    const event = JSON.stringify({ method: "Page.fileChooserOpened", params: { frameId: "F1", mode: "selectSingle", backendNodeId: 42 }, sessionId: S });
    h.f.fromBrowser(event);
    expect(h.issued()).toEqual([["Page.setInterceptFileChooserDialog", S, { enabled: true, cancel: true }]]);
    expect(h.toWorkbench).toEqual([event]);
  });

  test("ignores a chooser event on a session it never saw attach", () => {
    const h = harness().attach();
    h.f.fromBrowser(JSON.stringify({ method: "Page.fileChooserOpened", params: { frameId: "F1", mode: "selectSingle" }, sessionId: "made-up" }));
    expect(h.toBrowser).toEqual([]);
  });

  test("the workbench cannot undo either: all four commands are refused", () => {
    for (const method of ["Page.setDownloadBehavior", "Page.setInterceptFileChooserDialog", "Page.disable", "Browser.setDownloadBehavior"])
      refuse({ id: 30, method, sessionId: method.startsWith("Page.") ? S : undefined, params: { enabled: false, behavior: "allow" } }, "refused");
  });

  test("drops Chromium's answers to its own setup commands, and forwards every other message", () => {
    const h = harness();
    h.f.fromBrowser(attachEvent(S, "page"));
    const ids: number[] = h.toBrowser.map((m) => JSON.parse(m).id);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(SETUP_ID);
    expect(new Set(ids).size).toBe(3);
    h.toWorkbench.length = 0;

    for (const id of ids) h.f.fromBrowser(JSON.stringify({ id, result: {}, sessionId: S }));
    expect(h.toWorkbench).toEqual([]);

    const theirs = '{"id":5,"result":{"frameId":"F1","loaderId":"L1"},"sessionId":"S1"}';
    const event = '{"method":"Network.responseReceived","params":{"requestId":"R1"},"sessionId":"S1"}';
    const unparseable = "}{";
    for (const m of [theirs, event, unparseable]) h.f.fromBrowser(m);
    expect(h.toWorkbench).toEqual([theirs, event, unparseable]);
  });
});
