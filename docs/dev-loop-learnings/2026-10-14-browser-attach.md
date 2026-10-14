# 2026-10-14 — `olympus browser attach`

Loop C of three: the CLI half of the browser relay. Loop B (the server) shipped already; loop D
(the workbench bridge) does not exist, which shapes most of what follows.

Full tier. Three planning phases, five implementation waves, two fix rounds plus two targeted
fixes after a verification pass. 629 → 634 tests, 409 at the start.

## What the measurements changed

Four assumptions were written into the plan as unverified and marked for an agent to settle before
building on them. Three were wrong, and each would have shipped a broken feature.

**First-byte keying deadlocks every page.** The plan had the SOCKS proxy hold its success reply
until the tunnelled stream's first byte. A TCP connect produces no byte, the browser will not send
its request before the reply, and nothing Chromium speaks has the server talk first. The agent
built a faithful workbench, dialled a real site, pointed real Chromium at it, and got
`ERR_SOCKS_CONNECTION_FAILED` on every page. No amount of review would have caught this from
reading: the code is correct against the contract, and the contract is wrong. §4 gained an `ACK`
op, which is now binding on loop D.

**Bun's WebSocket client reports no HTTP status for a refused upgrade.** All of 400/401/404/501/
502/503 produce an identical `close`, code 1002, reason `"Expected 101 status code"` — nothing on
the error event, its `error` property, or anywhere on the prototype chain. Three rows of the
planned exit-code table were therefore unimplementable. The honest consequence is in the docs: a
revoked token is indistinguishable from an unreachable machine.

**Chromium's `--proxy-server=socks5://` sends ATYP DOMAINNAME, not a pre-resolved address.** The
documented behaviour is the opposite, and the whole hostname allowlist rested on it. Measured
twice — once observing raw CONNECTs, once driving real Chromium through the real proxy. The same
probe found that `socks5h://` is refused outright (`ERR_NO_SUPPORTED_PROXIES`, zero connections),
so the obvious "fix" for the documented behaviour would have disabled the proxy entirely.

The one assumption that held — that a pairing code may be sent verbatim because the server
normalises it — was settled by reading the server's `normalize_code`, not by guessing.

## What the adversarial review was worth

Codex reviewed the finished change, re-reviewed the fix round, then verified the second round. It
reproduced its findings rather than asserting them, and three were things no amount of unit testing
would have found, because every unit was individually correct:

- `held` counted wire bytes in and decoded-string bytes out, so malformed UTF-8 bought negative
  credit for an unbounded buffer. Reproduced at 44.8 MiB retained on one stream.
- `Target.setAutoAttach` was checked on three booleans and forwarded, but the protocol gives it a
  fourth parameter: `filter: [{exclude: true}]` excludes every target and silently undid the entire
  forced-pause protection that the previous round had just built.
- Deferred writes keyed on a stream id rather than the stream, so closing and reopening the same id
  delivered the previous conversation's bytes into the new one.

**The pattern worth remembering: every one of these lived in the seam between two correct pieces.**
The reviewer's value was not finding bad code; it was attacking the composition while holding the
threat model, which no unit agent could see from inside its own file.

## What the process got wrong

**A fix can silently undo the previous fix.** Round 1 forced paused attachment; `setAutoAttach`'s
unexamined `filter` parameter turned it straight back off. Round 2 caught it only because the
re-review was explicitly asked to attack the fixes rather than re-scan the feature. Re-reviewing a
fix round is not optional on security code.

**Default-deny has to be by parameter, not by name.** Three separate findings were the same shape:
a rule naming the dangerous parameters forwards the one nobody thought of. `createBrowserContext`
and `setAutoAttach` both ended up inverted to "refuse everything but the allowed set". The
domain-level CDP allowlist still has this shape and is documented as a known limit rather than
fixed — allowing a domain admits every method the protocol adds to it later.

**Withholding is not validating.** The filter held a new context's id until its download denial was
acked, which reads like protection and is not: the id came back through an ordinary
`Target.getTargets` response, and could also just be guessed. Closing it needed the id checked on
use and redacted on disclosure.

**Two tests stopped gating what their names claimed, both because another fix moved underneath
them.** One passed with the behaviour it tested deleted — verified by deleting it. Worth re-running
the "does this test fail if I break the thing" check after any round that changes shared machinery,
not only when the test is written.

## What the first live drive overturned, same day

Shipped, then driven against production with a hand-written workbench client. Three things only a
real browser and a real peer could show.

**Two flags claimed to suppress Chromium's calls home, and suppress nothing.** The comment said
`--disable-background-networking` and `--disable-component-update` stopped the background fetches
and the component updater. Measured on Chromium 152 with a SOCKS server logging every CONNECT: a
fresh signed-out profile on `about:blank` reaches six Google hosts, and the list is byte-identical
with the flags and without them. Production agreed — two of the six arrived as `tcp:` streams. The
giveaway was in the comment itself: it listed hosts measured from a browser run *without* the
flags, then asserted what the flags did, which no one ran. **A measurement of the before state is
not a measurement of the fix**, and putting both in one paragraph hides which half was observed.

**The laptop does not reap a departed workbench's streams.** A second workbench connection reusing
stream id 1 had it closed immediately — correct behaviour (a duplicate OPEN on a live id kills
both) applied to a stream that should no longer have been live. Nothing on either side tears down
a disconnected workbench's streams, so a reconnecting bridge must never restart its id counter.
No test could have caught this: the suite has one workbench at a time.

**The `chromium` on PATH was not the browser, and the throwaway profile was not throwaway.** A
second drive listed two unexplained extension service workers. They were the member's own: Arch's
`/usr/bin/chromium` is a launcher that injects `$XDG_CONFIG_HOME/chromium-flags.conf`, so the
profile this repo called "signed out, no extensions, no sync" was launched with their
`--load-extension`, their `--password-store=gnome-libsecret` and their OAuth credentials. Debian
and Ubuntu wrap the same way via `/etc/chromium.d/*`. The claim had been reasoned from an empty
profile directory — true, and irrelevant, because the flags come from outside the directory.
**"The inputs are clean" is not "the invocation is clean"**, and the only way to tell them apart
was reading `/proc/<pid>/cmdline` of the process actually running.

**The parts that worked, worked first time** — relay, lazy launch on the first `cdp` OPEN, and the
`tcp:`/ACK egress path end to end. The ACK, which was the loop's most expensive correction, was
right.

The shape across all three: the two that broke were both **claims about a peer nobody had** —
Chromium's behaviour under flags, and a second workbench. Every seam the suite could fake, it
faked correctly.

## Practical notes

- Agents working in one shared worktree see each other's half-written files. Scoping the typecheck
  gate per unit (`tsc --noEmit | grep <my files>`) removed the noise; a repo-wide gate is for after
  the wave.
- Telling an agent "verify your new test fails against the current code, and say which you checked"
  produced that evidence every time it was asked for, and caught one test that could not fail.
- Asking agents to read the protocol JSON rather than work from memory changed two answers: it
  removed a rule for a method that no longer exists, and found `proxyBypassList`, a second hole of
  the same shape as the one being fixed.

## Open, and deliberately so

- The CDP domain allowlist admits future methods in the ten allowed domains.
- The local CDP port is unauthenticated, and `/json/new` bypasses the filter entirely. No fix
  exists; it is documented.
- A hostname is never resolved locally, so `localhost` as a *name* is not refused here. The far end
  is what enforces it — and the far end does not exist yet.
- `CdpChannel.pause`/`resume` are exposed and unwired.
