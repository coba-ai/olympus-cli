# PLAN: `olympus browser attach <CODE>` — loop C of the browser relay

Binding contract: `CONTRACT-BROWSER-RELAY.snapshot.md` (olympus2 @ 8982e79d). §5 items 1–7, §1.6 and
§4 are all in scope. The olympus2 half is live in production (PR #772, one pilot org flagged on);
loop D (the Rafita workbench bridge) does not exist, so nothing will open a `cdp` stream and no
end-to-end CDP flow can be verified by this loop. Every claim below about what is proven says at
which level it is proven.

**Revised after Phase 3 critique** — all 21 points applied, none rebutted. `PLAN-CRITIQUE.md` has
the originals; the point ids (C1…C21) appear inline where an edit landed.

## Problem & acceptance criteria

A member runs `olympus browser attach XXXX-XXXX` on their own computer. It claims the pairing code,
stores the `obm_` token at 0600, holds a WebSocket to the relay, and exposes a fresh-profile
Chromium to the workbench over §4 frames — filtered, sandboxed, and tunnelled.

Each criterion is independently verifiable and owned by exactly one unit.

- [ ] **A1 Frame codec** (→1.1). `[u32 BE stream id][u8 op][payload]` round-trips; ops pinned 0 OPEN /
  1 DATA / 2 CLOSE; payload > 256 KiB refused on encode; a truncated or 4-byte buffer decodes as an
  error, never a partial frame; parity helpers agree that odd ids are the workbench's and even ids the
  laptop's. The 256 KiB payload cap is what keeps a frame inside the hub's 1 MiB message limit (§1.4) —
  the limit is restated in a comment, not re-checked, because 256 KiB + 5 bytes cannot reach it (C20).
  A 1 MiB CDP message fragments into 4 DATA frames and reassembles byte-identical, and a fragment
  arriving on a closed stream is dropped, not buffered (C2).
- [ ] **A2 Claim and store** (→1.2). `POST /api/v1/browser/pair {code, name}` through the existing
  `api()` client with no bearer; 201 stores `{host, machine_id, token, name}` at mode 0600 via a
  temp-file + rename; the raw token never reaches stdout, stderr or `--json`; 404 → exit 3, 400 →
  exit 6 (through `exitForStatus`, unchanged); a `relay_url` whose host is not the resolved host, or
  whose scheme is not `wss:` (`ws:` only for a loopback host), is refused before any socket opens.
  `--name` defaults to `hostname()`, as `login`'s `clientName` already does (C18). **Settled after
  wave 1:** the server normalises the code itself — `BrowserMachine.claim!` runs
  `input.upcase.gsub(/[^A-Z]/, "")` before digesting — so the displayed `XXXX-XXXX` form is sent
  verbatim and the client does no normalisation of its own.
- [ ] **A3 Reconnect policy** (→2.1, §1.6). Where the handshake status is readable: 401/404/400/501
  stop, 502/503 back off. Where it is not (Assumption 13), all of them back off under the attempt cap.
  In both worlds: 4401 stops (exit 2), 4409 stops (exit 6, Assumption 6), 1003 is OUR bug and exits 5,
  1009 and 1006 back off 1 s doubling to 60 s with jitter. The backoff is driven through `io.sleep`, so
  the test asserts the delay sequence without waiting, and asserts BOTH branches of Assumption 13 (C1).
  502 is three causes, not one — companion not ready, a companion image with no hub route, or the hub's
  64-laptop cap (its 503 is upstream of Rails' hijack, so the laptop sees 502; §1.2's non-101 branch).
  No message claims a single cause. After 3 consecutive 502s the CLI prints once, and emits a `stalled`
  `--json` line: "the organization's agent machine is not answering the relay; it may be on an older
  image — ask an operator to redeploy it", then keeps backing off (C12).
  A suspend/resume leaves a half-open socket: the client has no liveness check of its own and relies on
  the hub's `idleTimeout: 45` + `sendPings: true` closing it (UNVERIFIED: that Bun's client auto-pongs).
  Any `close` or `error`, including one arriving on wake, re-enters the backoff; a sleep longer than a
  pending backoff fires it immediately on wake rather than waiting out the wall-clock delay (C11).
- [ ] **A4 HTTP/1.1 handshake** (→2.1). The handshake goes through `new WebSocket(url, {headers})` and
  never `fetch()`: the test asserts no `fetch` call on the relay path and that the bearer travels in
  the `Authorization` header, never the query string (`relay_spec` "ignores a session cookie and a
  token in the query string" is the server half). **The reason is not testable here** — an HTTP/2
  connection reaches Rails as a plain GET and gets 400 `bad_handshake`, measured outside this repo and
  re-confirmed only by the ship gate's live drive; a local `ws://` handshake negotiates no ALPN at
  all (C16).
- [ ] **A5 Stream multiplexing** (→2.1). Only `cdp` streams opened on an **odd** id are accepted; a
  `cdp` OPEN on an even id, a second OPEN on a live id, and any OPEN target that is neither `cdp` nor
  `tcp:` are refused with CLOSE and never reach Chromium (§5.6). A text frame is never sent (the hub
  closes the sender with 1003). The relay pauses reading from every local socket (CDP and SOCKS) while
  the WebSocket's `bufferedAmount` exceeds 4 MiB and resumes below 1 MiB, so the hub's 8 MiB queue
  limit (§1.4) is not reached by our own writes (C15).
- [ ] **A6 CDP allowlist** (→2.2). Allowed: Page, Runtime, DOM, CSS, Input (minus
  `Input.dispatchDragEvent`), Network, Fetch, Emulation, Log, Accessibility, and Target restricted to
  page targets. Refused with a CDP error response (never a silent drop): `Target.createBrowserContext`
  with `proxyServer`, every `Browser.*`, `Page.setDownloadBehavior`, `DOM.setFileInputFiles`,
  `Target.sendMessageToTarget` and `Target.attachToTarget` with `flatten` anything but `true` (a
  wrapped message is not inspected, so non-flattened attach is refused outright, not filtered),
  `Target.exposeDevToolsProtocol`, `Target.setAutoAttach` with `flatten: false` (C9), an unknown
  domain, and a command on a `sessionId` the filter did not see attach to a page target.
- [ ] **A7 Navigation scheme refusal** (→2.2). `Page.navigate` and `Target.createTarget` to anything
  but `http:`, `https:` and `about:blank` are refused (§5.5).
- [ ] **A8 Downloads and file choosers** (→2.2). On every page session the filter itself issues
  download-deny and file-chooser interception, and answers `Page.fileChooserOpened` by cancelling
  (§5.3). The workbench cannot undo either, because A6 refuses both commands.
- [ ] **A9 SOCKS5 address rules** (→2.3). CONNECT only — no BIND, no UDP ASSOCIATE, no authentication
  method but `0x00`. The allowlist is matched on the **name as sent in CONNECT** for ATYP DOMAINNAME
  and on the literal for ATYP IPv4/IPv6; the CLI performs **no DNS of its own** (that would put queries
  on the member's LAN, against §5.4, and the workbench resolves again anyway). A name is never resolved
  to compare against an address literal, and an address literal is matched against the private/
  loopback/link-local denial of Assumption 8 after normalising IPv4-mapped IPv6. **UNVERIFIED and
  checked in wave 2 before 2.3 is written: whether Chromium's `socks5://` sends names or pre-resolved
  addresses. If it pre-resolves, `--allow-origin NAME` can never match and 2.3 must take `socks5h://`
  or the flag must take addresses** — a ship blocker found cheaply, so find it first (C8). A refused
  address gets SOCKS reply `0x02` and opens no stream. An allowed CONNECT opens one even-id
  `tcp:<host>:<port>` stream and pumps bytes both ways. **AMENDED after wave 2 (measured).** The SOCKS success
  reply keys on an **`ACK` frame**, not on the stream's first byte. Unit 2.3 drove real Chromium
  through a faithful workbench and measured `ERR_SOCKS_CONNECTION_FAILED` on every page: a TCP
  connect produces no byte, the browser will not send its request before the reply, and nothing
  Chromium speaks has the server talk first — so first-byte keying deadlocks all HTTP and HTTPS.
  §4 gains op `3 ACK`, sent by the workbench once its dial succeeds. A CONNECT whose `tcp:` OPEN
  gets no ACK within 30 s is answered with SOCKS reply `0x04` and the stream is closed — the hub drops laptop
  frames while no workbench is connected (§1.4), so this is the normal case, not an edge (C6).
- [ ] **A10 Chromium launch** (→2.4). Flags assembled exactly: a fresh `mkdtemp` `--user-data-dir`,
  `--remote-debugging-port=0` on loopback, `--proxy-server=socks5://127.0.0.1:<p>`,
  `--proxy-bypass-list=<-loopback>`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, no
  extensions, no sync, signed out. The CDP port is read from `DevToolsActivePort` in the profile dir.
  The profile directory is removed on every exit path. Launch is triggered by 2.1's first accepted
  `cdp` stream, never by attach itself (C6). The CDP port is loopback-only and unauthenticated: any
  process running as the member can drive the browser past the filter entirely. Nothing enforces
  otherwise; the filter guards the relay, not the port (C10).
- [ ] **A11 Command surface** (→3.1). `olympus browser attach [CODE] [--name N] [--allow-origin O]...`
  dispatches without an `oly_` token (pair is unauthenticated); unknown flags are rejected by
  `checkFlags` before any request; `--json` emits one JSON object per line per state change; SIGINT
  exits 130; Chromium exiting exits 0. One spawned-process test in `test/binary.test.ts`'s shape
  (`bun src/cli.ts browser attach` against the fake, kill SIGINT, assert exit 130 within 1500 ms)
  proves both that the signal path works and that no listener or socket keeps the process alive after
  `run` returns (C19).
- [ ] **A12 Exit codes** (→3.1). **AMENDED after wave 2 (measured):** Assumption 13 is **false** —
  Bun's `WebSocket` client surfaces no HTTP status for a refused upgrade; all six of
  400/401/404/501/502/503 produce an identical `close`, code 1002, reason `"Expected 101 status
  code"`. So the **pre-upgrade** rows (401→2, 404→3, 400/501→5) are **unreachable** and must not be
  documented as behaviour: every refused handshake backs off and exits 5 at the attempt cap. The
  live-socket rows (4401→2, 4409→6, 1003→5) do fire. **A14's ship gate changes with it** — a revoked
  token shows as ten failed attempts then exit 5, not an immediate exit 2. Pair errors map through `exitForStatus` unchanged (404→3, 400→6).
  The relay handshake does NOT: it returns no API error body, and a 400 there is a protocol bug, not
  invalid input, so the relay table is explicit — 401 and close 4401 → 2; 404 → 3; 400 and 501 → 5;
  4409 → 6 (`replaced`); 1003 → 5 (we sent a text frame: our bug); usage → 1; SIGINT → 130; clean
  browser exit → 0. The test asserts both tables, and that `exitForStatus` is not called on the relay
  path (C5).
- [ ] **A13 Docs** (→3.2). README command block, flag/env rows (`OLYMPUS_CHROME`), exit-code table and
  the token-file path; `docs/API.md` gains the pair endpoint and the relay. Nothing names a customer
  org or a host but the documented default (the repo is public).

**Verifiable only after loop D exists:** interop of A1's pinned op numbers and length prefix, A5's
parity rule, A6's flattened-`sessionId` expectations and A9's `tcp:` stream shape with a real
workbench. Also any end-to-end CDP byte flow at all: the hub **drops laptop frames while no workbench
is connected** (§1.4), so even the ship gate's live drive cannot echo a single frame. Everything
A1–A12 claims is proven against the local fake and unit tests only.

## Scope

**In:** the `browser attach` command and its dispatch; the §4 frame codec and the `cdp` length prefix;
the pair call and the 0600 token file; the relay client with §1.6 reconnect; the local CDP terminator
and allowlist; the SOCKS5 proxy and its address rules; Chromium launch and teardown; the test doubles
for pair and relay; the README and `docs/API.md` entries.

**Out:** loop D (the workbench bridge) and anything that assumes it; any Rails or companion change
(olympus2 is live and frozen for this loop); listing or revoking machines from the CLI (the console
owns that, and API v1 exposes no route for it); a `browser detach` subcommand (re-running `attach`
with a fresh code overwrites the token record — Assumption 9); relaunching Chromium after it exits;
any new runtime dependency; a `ws`, `socks` or `chrome-remote-interface` package.

## Risk tier

**Full.** Declared critical paths touched:

- **Credentials/token handling** — the `obm_` token is a new credential on disk; the file is 0600 and
  the value is never printed (`CLAUDE.md`, the repo's own rule).
- **Exit codes and `--json`** — agents depend on both; A12 reuses `exitForStatus` for pair and states
  the relay's own table explicitly rather than pretending one mapping covers both.
- A third, specific to this feature: **the workbench is the untrusted side** (§3 — anything holding
  `COMPANION_TOKEN`, i.e. every agent in the org with a terminal, can drive the socket or attach a
  fake laptop). The CDP allowlist and the SOCKS address rules are the only thing standing between that
  and the member's computer, so A6, A7, A9 and A10 are security code, not ergonomics.
- A fourth: the relay shares the member's console rate budget (§1.6), so the backoff and Assumption
  14's cap are availability code, not politeness (C14).

## Test strategy

Everything runs under `bun test` against `Bun.serve` doubles. No test reaches the network, launches a
real Chromium, or needs a real olympus2.

- **Frame codec (A1)** — pure unit tests on `Uint8Array`s. Table-driven: round-trips, the payload cap,
  truncation, parity, and the `cdp` length-prefix fragment/reassemble path. No I/O.
- **Pair and token file (A2)** — against `test/fake-api.ts`'s `Bun.serve`, using the same `mkdtemp`
  HOME helper every test file already uses. Asserts the file's mode with `stat` (0o600), that the raw
  token appears in no sink, and the 404/400 → exit mapping.
- **WebSocket client, hermetically (A3–A5)** — a new `test/fake-relay.ts`: a `Bun.serve` with a
  `websocket` handler standing in for olympus2-web **and** the hub. It checks the bearer, can be told
  to answer 400/401/404/502/503 before the upgrade, can close with 4401/4409/1006 on command, and can
  **act as the workbench** — opening `cdp` streams and reading what comes back. Like Rails, it forwards
  bytes and never parses a frame; tests build frames with A1's codec. Backoff is asserted through
  `io.sleep`, so §1.6's 1 s→60 s sequence is checked in milliseconds.
- **CDP allowlist (A6–A8)** — the filter is a pure function from a parsed message plus session state,
  so A6–A8's allow and refuse cases are asserted directly, each on the error response it returns, not
  merely on nothing being forwarded (C21).
- **SOCKS handler (A9)** — driven over a real loopback socket from `Bun.connect` with the
  stream-opener injected as a spy; A9's table is the test (C21).
- **Chromium (A10)** — never launched. The unit exports flag assembly as a pure function (asserted
  string-by-string) and takes `spawn` and the `DevToolsActivePort` read as injected seams; the test
  passes a fake process and a temp profile dir it writes itself.
- **Dispatch (A11–A12)** — `test/cli.test.ts`-style: call `run(argv, io)` with a fake `Io` and assert
  code, stdout and stderr. The attach loop takes its relay, CDP, SOCKS and launcher as injected
  dependencies, so the dispatch test composes four fakes and never opens a socket. Plus the one
  spawned-process SIGINT test of A11.

**Deliberately not tested:** a real Chromium, a real CDP conversation, a real workbench, the live
relay (the ship gate is a manual drive, recorded in the PR, not a test), and the hub's limits
themselves (A5's pause thresholds are unit-tested against a fake socket whose `bufferedAmount` the
test sets; the real 8 MiB behaviour is not) (C15).

## Assumptions

Every one of these is a decision taken without the authority to take it alone; the checkpoint exists
to overturn any of them.

1. **Frame ops are pinned 0 OPEN / 1 DATA / 2 CLOSE, and a `cdp` stream carries length-prefixed
   messages: `[u32 BE byte length][UTF-8 CDP JSON]`, fragmented across as many DATA frames as needed.**
   §4 calls the op numbers "a proposal" and defines no message boundary inside a stream; a CDP response
   over 256 KiB (a screenshot) needs one. **Both are binding on loop D** — the bridge must use the same
   three values and the same prefix or nothing interops, and the contract should be amended to state
   them as settled once this ships. `tcp:` streams stay a raw byte stream with no prefix (C2).
2. **The relay client is Bun's built-in `WebSocket`** with `{headers: {Authorization: "Bearer obm_…"}}`
   (`Bun.WebSocketOptions`, verified in `node_modules/bun-types/globals.d.ts:240`). Never the `ws`
   package. Bun's client does an HTTP/1.1 Upgrade and offers no h2, which is how A4 is satisfied.
3. **Chromium discovery:** `$OLYMPUS_CHROME` first, then the first of `chromium`, `chromium-browser`,
   `google-chrome`, `google-chrome-stable` on `PATH`, then on macOS the two standard
   `/Applications/...app/Contents/MacOS/...` paths. None found → exit 1 with a message naming
   `OLYMPUS_CHROME`. No download, no bundled browser.
4. **The token file is `~/.config/olympus/browser.json`**, mode 0600, beside `credentials.json` and
   written with the same temp-file + `rename` dance — a separate file, because the `obm_` token is a
   different credential with a different lifetime, and `olympus logout` should not silently detach a
   machine. The file is `{"machines": {"<host>": {machine_id, token, name}}}`, one record per host, so
   pairing against a second host adds a record instead of refusing (Assumption 5 looks up "a stored
   token for this host"). A malformed file is the same `credentials_malformed` shape `readCreds`
   already raises. A `token` that is not `obm_` + ≥1 character is refused before anything is
   written (C18).
5. **`CODE` is optional.** Given, it is claimed. Omitted with a stored token for this host, it
   reconnects without pairing. Omitted with no token, it is a usage error (exit 1).
6. **4409 stops** (§1.6 leaves the choice to loop C). Two processes reconnecting for one machine evict
   each other forever, so the second one exits 6 saying another process or computer is attached as this
   machine (the close code carries no identity, so it cannot say which), and suggesting a fresh
   code (C13).
7. **Chromium is launched on the first accepted `cdp` stream, not at attach**, and its exit then ends
   the command (exit 0, closing the relay and removing the profile). Until a workbench opens a stream
   there is no browser, no profile dir and no window. Until loop D exists that is every run: `attach`
   holds the socket, prints `online (no workbench connected)`, and launches nothing. Launching eagerly
   would put a window on screen that cannot load a page, because the hub drops laptop frames while no
   workbench is connected (§1.4) — a dead control, not a pending feature (C6).
8. **Navigation scope defaults to any public http(s) host on 80/443**; private, loopback and
   link-local addresses are always refused; `--allow-origin HOST[:PORT]`, repeatable, narrows the
   default to exactly that set. §5.5 chose "the app-under-test origins" and declined "any http(s)",
   and **this reverses that** — because the laptop-side origin list buys very little (the workbench
   serves every byte of every `tcp:` stream, so an allowed host is not a trusted host) while an
   empty default guarantees a browser that can reach nothing. What actually protects the member is
   the fresh signed-out profile, download denial, chooser cancellation, and all egress leaving
   through the tunnel — none of which depend on the list. **This needs the contract amended at §5.5,
   and it is the decision most worth overturning at the checkpoint** (C7).
9. **No `browser detach`.** Re-running `attach` with a fresh code overwrites that host's record;
   revoking is the console's job and already works. A local-only "forget the token" verb can follow.
10. **Only commands are filtered.** Responses and events pass through unread except
    `Target.attachedToTarget` / `detachedFromTarget`, which A6's session tracking consumes to know
    which flattened `sessionId` is a page. **Nothing enforces that no event carries data a disallowed
    domain would have produced** — some arrive without any domain being enabled — and nothing needs to:
    the workbench already sees every page byte, because it is the transport (§3). Filtering events
    would be a filter change, not a redesign (C17).
11. **`--json` is newline-delimited JSON on stdout**, one object per state change (`paired`,
    `connecting`, `online`, `stalled`, `stream`, `refused`, `backoff`, `closed`), because the command
    is long-running and the repo's one-shot `print()` shape does not fit. Human mode prints status
    lines to stderr. Neither carries the token.
12. **No new runtime dependency.** SOCKS5 CONNECT and the CDP filter are each about 120 lines of
    hand-rolled code; the alternatives (`socks`, `chrome-remote-interface`) pull transitive trees into
    a single-binary build and the second would drag in `ws`, which the profile forbids outright.
13. **The handshake status is read from the failed-handshake event if Bun exposes it; otherwise the
    fallback is: every handshake failure backs off, bounded by Assumption 14's attempt cap, and only a
    close code the client DID receive on a live socket (4401, 4409) stops.** UNVERIFIED — whether Bun's
    `WebSocket` client surfaces the HTTP status of a refused upgrade is checked in wave 2 before A3's
    test is written. A pre-flight `fetch` is not the escape hatch: A4 forbids it on this path (C1).
14. **Attempts are capped: 10 consecutive failed handshakes, then exit 5** with the next step
    printed. The relay has no throttle of its own and every attempt counts against Rack::Attack's
    `req/ip` 300 per 5 minutes, **shared with the member's own browsing from that address** (§1.6),
    so an unbounded retry can lock them out of the console. A successful connection resets the
    count (C14).

## Work breakdown into waves

### Wave 1 — contracts: codec, credential, doubles

- **1.1 §4 frame codec and the shared seam types** · owns: `src/browser-frame.ts`,
  `test/browser-frame.test.ts` · does: encode and decode the multiplex frame, pin the three op numbers,
  enforce the 256 KiB payload cap, expose the stream-id parity predicates, provide the cdp-stream
  length-prefix framer/reassembler, and declare the seam types wave 2 shares — `Stream`
  (write/close/onData), `StreamOpener` (`(target: string) => Stream`, which allocates the even id) and
  `CdpSend` — so no wave-2 unit defines them (C2, C4).
  · done when: A1 is green and the module imports nothing but Bun globals.
- **1.2 Pair call, the `obm_` token file, and the API fake's pair endpoint** · owns:
  `src/browser-store.ts`, `src/core.ts`, `test/fake-api.ts`, `test/browser-store.test.ts` · does: claim
  the code through the existing `api(host, undefined)` client (no bearer, path `/browser/pair` — `api()`
  already prepends `/api/v1`), validate `relay_url` against the resolved host, persist the record at
  0600, and add `POST /browser/pair` plus its pending-code state to the existing API fake (C3). Extends
  `src/core.ts` by extracting the 0600 temp-file + rename writer out of `writeCreds` so both callers
  share one implementation; it adds no new error-to-exit mapping, reusing `CliError` and
  `exitForStatus`. **Sole owner of `src/core.ts` and `test/fake-api.ts` in every wave.**
  · done when: A2 is green, `writeCreds`'s own tests in `test/core.test.ts` still pass untouched, and
  `bun run typecheck` is clean.
- **1.3 Relay double** · owns: `test/fake-relay.ts`, `test/fake-relay.test.ts` · does: a relay double
  standing in for olympus2-web and the hub together — bearer check, every pre-upgrade status from §1.2,
  the close codes from §1.5, and a workbench side that opens streams. It forwards bytes and never
  parses a frame, so it carries no dependency on 1.1.
  · done when: the double's own test shows a refused bearer, each injectable status, a commanded 4401
  and 4409, and a byte echo through an opened stream.

### Wave 2 — the four halves (each consumes wave 1's modules AND its seam types; all four are then mutually independent)

- **2.1 Relay client** · owns: `src/browser-relay.ts`, `test/browser-relay.test.ts` · does: hold the
  socket with `new WebSocket(url, {headers})`, implement §1.6's stop/backoff policy through `io.sleep`
  and `io.now` (seams `Io` already has, used by `deviceLogin`'s identical poll loop), and demultiplex
  §4 streams, owning the even-id counter (the opener it hands out allocates; 2.3 never picks an
  id) (C4) — accepting only workbench-opened `cdp` streams and handing laptop-opened `tcp:` streams out
  to a provided opener; and apply the `bufferedAmount` pause/resume of A5 (C15). **Before writing A3's
  test, settle Assumption 13 empirically** (does Bun surface the refused-upgrade status?) and record
  which branch holds. Consumes 1.1's codec and 1.2's record; tested against 1.3's double.
  **Wave-1 amendments (from HANDOFFS.md):** 2.1 also owns (a) deriving the reconnect relay URL,
  `wss://<stored host>/api/v1/browser/relay`, validated with 1.2's exported `checkRelayUrl` — nothing
  owned it, because Assumption 4 deliberately stores no `relay_url`; and (b) a reassembly ceiling on
  1.1's `cdpReader`, whose declared length prefix is attacker-controlled and otherwise unbounded —
  past the ceiling the offending stream is closed. It must also COPY any `decodeFrame` payload it
  queues, because the payload is a view into the WebSocket message buffer, not a copy.
  · done when: A3, A4 and A5 are green.
- **2.2 CDP terminator and allowlist** · owns: `src/browser-cdp.ts`, `test/browser-cdp.test.ts` · does:
  terminate CDP locally, track which flattened `sessionId` belongs to a page target — only flattened
  sessions exist, because non-flattened attach is refused (C9) — filter every command against §5.2's
  allowlist, refuse non-http(s) navigation targets, and deny downloads and cancel file choosers on each
  page session. Pure functions plus an injected send; no socket.
  · done when: A6, A7 and A8 are green, with a named refuse case for every exclusion A6 lists.
- **2.3 SOCKS5 proxy** · owns: `src/browser-socks.ts`, `test/browser-socks.test.ts` · does: a
  `Bun.listen` loopback server speaking SOCKS5 CONNECT only, checking each target per A9's matching
  rules, and turning an allowed CONNECT into an even-id `tcp:` stream through the injected opener.
  **Before writing the address tests, settle A9's UNVERIFIED question** (does Chromium's `socks5://`
  send names or pre-resolved addresses?) and record the answer; if it pre-resolves, raise it rather
  than shipping a flag that can never match (C8).
  · done when: A9 is green across all three ATYPs and both refused commands.
- **2.4 Chromium launch and teardown** · owns: `src/browser-chrome.ts`, `test/browser-chrome.test.ts` ·
  does: discover the binary (Assumption 3), assemble §5.1/§5.4's flags, create and remove the temp
  profile, read `DevToolsActivePort`, and surface the browser's exit. `spawn` and the port read are
  injected, following the `Io.openBrowser` seam precedent in `src/cli.ts`.
  · done when: A10 is green and `bun test` spawns no browser process.

### Wave 3 — composition, dispatch, docs

**AMENDED after wave 2.** Wave 2's measurements added a protocol fix and a hardening pass that must
land before composition, so wave 3 splits in two: **3.0 and 3.1a run in parallel**, then **3.1 and
3.2** compose on top of them.

- **3.0 Protocol fix: the OPEN acknowledgement, and four smaller corrections** · owns:
  `src/browser-frame.ts`, `src/browser-relay.ts`, `src/browser-socks.ts`, `src/browser-chrome.ts`
  and their four test files · does: (a) add op `3 ACK` to the §4 codec and make the SOCKS success
  reply key on it rather than on the stream's first byte — **the fix for the measured deadlock, and
  the reason the feature can load a page at all**; (b) add `pause()`/`resume()` to the `Stream` seam
  and wire 2.1's `onBackpressure` to the SOCKS server, which is what makes A5 true rather than
  half-true; (c) cap `decodeFrame`'s inbound payload at `MAX_PAYLOAD` and make `cdpReader.push`
  linear instead of quadratic; (d) count a connection that closes under 5 s as a failed attempt so
  an instant-drop flap cannot reconnect forever; (e) add `--remote-debugging-address=127.0.0.1` and
  Chromium's telemetry-suppression flags to 2.4's argv. One unit because (a) and (b) each span three
  files that cannot be split without a broken intermediate state.

- **3.1a CDP hardening** · owns: `src/browser-cdp.ts`, `test/browser-cdp.test.ts` · does: close the
  three named escapes 2.2 found inside the allowlisted domains — extend A7's scheme check to
  `Network.loadNetworkResource` and to `Fetch.continueRequest`'s URL override, and refuse
  `DOM.getFileInfo`. Method-allowlisting all ten domains is out of scope and declined; the residual
  limit is documented, not closed.

- **3.1 `browser attach` command and dispatch** · owns: `src/browser.ts`, `src/cli.ts`,
  `test/browser-attach.test.ts`, `test/binary.test.ts` · does: the command module in this repo's shape
  (`src/tasks.ts`'s pattern — validate flags with `checkFlags` and all arguments synchronously, then
  return the closure), composing 2.1–2.4 and launching Chromium lazily per Assumption 7; and the single
  edit to the dispatcher — USAGE lines, `allow-origin` in `OPTIONS`, and a **pre-authentication** branch
  beside `login`/`logout`/`version`, because pair reads no bearer and the authenticated path's
  `resolveToken` would exit 2 before the command ran. SIGINT is wired the way `ask` already wires it
  (`process.once("SIGINT", …)` around the plan). **Sole owner of `src/cli.ts` in every wave.**
  · done when: A11 and A12 are green, including the spawned-process SIGINT test (C19), and
  `bun test && bun run typecheck` is green whole-suite.
- **3.2 Docs** · owns: `README.md`, `docs/API.md` · does: the command block, the `OLYMPUS_CHROME` and
  token-file rows, the exit codes, and the two endpoints. States plainly that CDP needs the workbench
  bridge, which does not exist yet.
  · done when: A13 holds and no customer org or non-default host appears anywhere in the diff.

### Ship gate (not a unit; performed by the orchestrator, blocks the PR)

**A14** is driven by hand against the production host and a flagged org — pair, relay, **Online** in
Settings → Rafita, Revoke, the 4401 close, a reconnect getting 401 and exiting 2, then `attach` once
more with a stale token for the stop path. Also confirms by hand that the handshake survives the Fly
edge (A4's h2 half). No agent can run it and no test covers it; the PR says what was clicked and
says explicitly that no CDP byte was exchanged because loop D does not exist (C16).
