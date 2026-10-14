# olympus-cli

`olympus` — the command-line client for the [Olympus](https://tryolympus.ai) API, built for agents first
(`--json`, stable exit codes, `OLYMPUS_API_KEY`) and humans second. API reference: [`docs/API.md`](docs/API.md).
Agents: [`llms.txt`](llms.txt) is a compact install-and-use guide written for LLM agents.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/coba-ai/olympus-cli/main/install.sh | sh
sh install.sh [vX.Y.Z]     # from a clone; default is the latest release
```

The asset's SHA256SUMS line is verified before install. Target dir: `${OLYMPUS_INSTALL_DIR:-$HOME/.local/bin}`.
Linux x64/arm64 and macOS x64/arm64 (the macOS builds are cross-compiled). Binaries are also on the [releases page](https://github.com/coba-ai/olympus-cli/releases).

## Sign in

```sh
olympus login                        # prints a code, opens the browser; approve it there
olympus login --no-browser           # on a remote machine: open the printed URL yourself
olympus login --with-token < token   # a token created in Settings → API tokens
export OLYMPUS_API_KEY=oly_...       # or just set it (agents, CI)
```

Tokens are created and revoked in the Olympus app under **Settings → API tokens**. A token acts as you,
optionally limited to one organization.

## Commands

```
olympus login [--no-browser]        # device login: approve the printed code in a browser
olympus login --with-token          # read a token from stdin instead
olympus logout | whoami | org list | org use <slug> | agents list
olympus webhook list | get <id> | delete <id> --yes
olympus webhook create --name N --agent PROFILE (--instructions T | --instructions-file PATH|-) [--full-tools]
olympus webhook update <id> [--name] [--agent] [--instructions|--instructions-file] [--[no-]full-tools]
olympus people                      # members, then agents (ids, kind, email, paused)
olympus tags                        # the organization's tags, most used first
olympus tasks | task list [--week D] [--mine | --who ID|me|EMAIL] [--open | --done] [--today] [--tag T]... [--backlog]
olympus task get <id> | add TEXT | update <id> | done <id> | undone <id> | today <id> | star <id> | delete <id> --yes
olympus task add TEXT [--desc T] [--assign W] [--backlog] [--today] [--star] [--tag T]...
olympus task update <id> [--text T] [--desc T] [--assign W | --unassign] [--section the_rest|backlog]
                         [--tag T]... | [--no-tags] | [--add-tag T]... [--remove-tag T]...
olympus task today <id> [--off] | star <id> [--off]
olympus task sub add <id> TEXT [--assign W] | sub done <id> <sid> [--undo] | sub delete <id> <sid> --yes
olympus task delegate <id> [--to AGENT]         # open an agent session for the task
olympus task breakdown <id> [--agent AGENT]     # ask an agent to add subtasks (can take ~90 s)
olympus day [DATE] | day show [DATE]            # one day's close-of-day entry; DATE is YYYY-MM-DD, default today
olympus day list [--week D]                     # the week's five weekdays
olympus day close [DATE] [--shipped T] [--blocker T]... [--learning T]... [--reflection T] [--draft]
olympus crm pipelines [--archived] | crm tags [--entity E] | crm search QUERY [--entity E]
olympus crm deals [--pipeline ID] [--stage ID|none] [--status S] [--owner EMAIL|me|none] [--q T] [--archived] [--sort S] [--page N]
olympus crm people | companies [--q T] [--archived] [--sort S] [--page N]
olympus crm deal get <id> | add NAME | update <id> | move <id> STAGE_ID | owner <id> EMAIL|me|--none | archive <id> [--undo]
olympus crm deal add NAME [--pipeline ID] [--stage ID] [--amount N] [--currency C] [--next T] [--owner W]
                          [--company ID | --new-company NAME] [--person ID | --new-person NAME [--person-email E]]
olympus crm deal update <id> [--name T] [--amount N] [--currency C] [--next T] [--lost-reason T]
                             [--tag T]... | [--no-tags] | [--add-tag T]... [--remove-tag T]... [--version V]
olympus crm deal company <id> COMPANY_ID | --new NAME
olympus crm deal person <id> PERSON_ID | --new NAME [--email E]
olympus crm deal note <id> TEXT|-               # - reads the note from stdin
olympus crm deal task add <id> TITLE [--due ISO] [--assign W] | task done <id> <task_id> [--undo]
olympus crm person|company get <id> | archive <id> [--undo]
olympus crm deal|person|company deletion-preview <id> | delete <id> --yes
olympus crm deal unlink-company <id> | unlink-person <id>
olympus crm task done <task_id> [--undo]        # any record's task, by task id
olympus crm person|company task add <id> TITLE [--due ISO] [--assign W]
olympus crm pipeline get <id> | archive <id> [--undo]
olympus crm pipeline add NAME --stage NAME:KIND... [--currency C]...
olympus crm pipeline update <id> [--name T] [--stage [ID=]NAME:KIND]... [--remove STAGE_ID:MOVE_TO_ID]...
                                 [--restore ID]... [--currency C]... [--version V]
olympus crm <create command> ... [--idempotency-key K]   # deal|person|company add, deal note, deal|person|company task add, pipeline add
olympus crm person add NAME [--email E] [--phone P] [--job-title T] [--linkedin-url U] [--company ID | --new-company NAME]
olympus crm company add NAME [--domain D] [--website U] [--industry T] [--linkedin-url U] [--phone P] [--city C]
olympus crm person|company update <id> [--name T] [the add flags] [--notes T] [tag flags] [--version V]
olympus subscription list | get <id> | delete <id> --yes | rotate-secret <id> | ping <id>
olympus subscription create --name N --url URL --event T... | update <id> [--name N] [--url URL] [--event T]... [--active | --inactive]
olympus event-types                 # event names accepted by --event ('*' = all events)
olympus ask AGENT TEXT|- [--session ID] [--timeout SECONDS] [--no-wait]   # - reads the text from stdin
olympus sessions [--closed | --all] [--agent SLUG] [--page N]
olympus session get <id> [--after MSG_ID] | session close <id>
olympus browser attach [CODE] [--name N] [--allow-origin HOST[:PORT]]...   # lend this computer's browser to the org's agent
olympus briefing [--day YYYY-MM-DD] [--request]
olympus version | --version
```

Global flags: `--json`, `--host URL`, `--org SLUG`, `-h/--help`. No flag takes a token.
`webhook create` prints the signing `secret` once (both modes); `update` sends only the fields given;
`delete` never prompts and requires `--yes`.
Roles are `operator` and `teammate`; a teammate cannot `webhook get` (exit 4) or write.

Tasks: any member, teammate included, can read and write them. Every `task` subcommand (and `tasks`) takes
`--week DATE`: any date works, the server normalises it to that week's Monday, and the default is the
current week. `--star` / `task star` marks the one thing; `task today` flags a task for today. `--assign`
and `--who` take `me`, a person id (`olympus people`) or a member's email; `--assign` is resolved by the
server, so a value that matches nobody (or a paused agent) is exit 6. `task delete` and `task sub delete`
never prompt and require `--yes`. `--tag` replaces a task's tags, `--no-tags` clears them, and
`--add-tag` / `--remove-tag` edit them without replacing (they cannot be combined with `--tag` or
`--no-tags`); edits made this way by two people at once never drop each other's tags.

List filters are applied by the CLI to the week's tasks: `--mine`, `--who` and `--today` match a task
whose own assignee/flag matches **or any of its subtasks**, and show the whole task; `--open` and
`--done` look at the task only; `--tag` is repeatable, matches exact strings (`Urgent` is not `urgent`)
and requires every tag given; `--backlog` keeps the backlog section. `--mine` with `--who`, and
`--open` with `--done`, are usage errors. An unknown `--who` is exit 6. Text that starts with `-` needs
`--` (`olympus task add -- "-x"`).

CRM (`olympus crm …`): any member can read; writing needs the `operator` role (a teammate gets exit 4). Records are
deals, people and companies. `--version V` on an `update` is optional. Sent, the update is refused when the record
changed since you read it (exit 6, "it changed since you read it"); omitted, the last writer wins for the fields you
send. `--add-tag` / `--remove-tag` read the record and then write it with the version they read, so they are **not
atomic**: on exit 6, run the command again. Any tag flag together with other fields is two server writes; if the
second fails, the first stays. `archive` hides a record and is reversible with `--undo`; it needs no `--yes`.
`--archived` on a list shows only archived records, `--sort` and `--page` are passed to the server (one page at a
time), and `--owner` and `--stage` take `none`. A CRM that is not set up yet is exit 6; a temporarily unavailable one
(`retry after Ns`) is exit 5. Exit 5 with `details.saved: true` (in `--json` stderr) means the change may already be
saved. For a create, follow the server message: it says whether a retry with the same `--idempotency-key` (below) is
safe (the agent machine confirmed it stored the key) or to read the record (`details.id`) and not repeat the request;
for any other write, read the record and do not retry. Exit 5 without `saved` (network error, timeout): look for the
record first (`crm search` / `get`); if it is missing, retry with the same key. `--stage` needs `--pipeline`.

`delete` removes a record for good and **cannot be undone** (unlike `archive`, which `--undo` reverses). It needs
`--yes`, never prompts, and without `--yes` is exit 1 with no request. On a terminal it first fetches
`deletion-preview` and prints the counts of what goes with the record (one extra request), then deletes; if the
preview fails, nothing is deleted. Piped or with `--json` it sends the one delete. `deletion-preview` alone changes
nothing. `deal unlink-company` / `unlink-person` detach the deal's company or person; `crm task done` marks any
record's task done by its task id (`--undo` reopens it). `person|company task add` works like `deal task add`.
Person and company detail list at most 10 open tasks, so after `task add` the new task may not be shown (the
confirmation names no task id).

Pipelines: reads are open to any member, but every pipeline write (`add`, `update`, `archive`) is operator only
(a teammate gets exit 4). `pipelines --archived` includes archived pipelines. `--stage NAME:KIND` (`open`,
`won` or `lost`; the kind is whatever follows the **last** colon, so a name may contain colons) is repeatable and
sets the order; `pipeline add` needs at least one. `pipeline update` sends only what you give it, with no read
first: `--stage` is then the **full ordered list of live stages**, and `ID=NAME:KIND` keeps the existing stage
`ID` (renaming or reordering it) while a plain `NAME:KIND` is a new stage. A live stage left out of the list must
be named in `--remove STAGE_ID:MOVE_TO_ID`, which moves its deals to `MOVE_TO_ID`; the server refuses the update
otherwise (exit 6). `--restore ID` brings back an archived stage. `--currency` is repeatable and replaces the list.
`--version V` works as on records.

Idempotent creates: `deal|person|company add`, `deal note`, `deal|person|company task add` and `pipeline add`
each send a fresh random `Idempotency-Key`. `--idempotency-key K` (1-128 characters from `A-Z a-z 0-9 _ . : -`)
sends your own instead: the same K on a retry returns the original record rather than creating a second one, for
24 hours. On a terminal, an exit-5 failure of a create ends with the key it sent
(`The idempotency key sent was <key> (--idempotency-key <key> reuses it)`); the server message above it decides
whether to retry. Piped or with `--json` that line is not printed, so scripts and agents should **always pass their
own key** (a fresh UUID) on every create. After exit 5, retry with that same key only when the server message says to
retry with the same Idempotency-Key; when it says "do not repeat the request", read the record instead. After a
network error or timeout, look for the record (`crm search` / `get`) first and retry with the same key only if it is
missing. An agent machine that has not been updated yet may not honour the key; the API says so in a response header
(`Idempotency-Key-Honored: false`). The CLI does not show that header, so unless you know the organization's agent
machine is up to date, look for the record before retrying even when the message says to retry with the same key.
`crm person add --new-company` that exits 6 on `idempotency_key`: the company may already be saved (`details.id`
in `--json`); do not retry with that key. Keys are per organization and last 24 hours.

Subscriptions (`olympus subscription …`) send signed HTTP events to your URL when things happen
(`olympus event-types` lists the names). They are **operator only, reads included** (a teammate gets
exit 4). `create` and `rotate-secret` print the signing `secret` once; it cannot be read again. Rotating
makes no promise that the old secret keeps working. `delete` never prompts and requires `--yes`.
`--event` is repeatable and replaces the list on `update`; `--active` / `--inactive` switch delivery.
`ping` sends one test event (it is not an event type you can subscribe to): it does not count toward
`consecutive_failures` and exits 0 whether or not your URL answered, so read `delivered`; `status` is `-` on a
network failure and `error` says why. It can be rate limited (exit 5: retry after the stated seconds). A
subscription pauses after 20 failed events in a row; re-enable it with `update <id> --active`. Verifying
signatures: [`docs/API.md`](docs/API.md#receiving-events). Delivery is at-least-once, so receivers dedupe on
`X-Request-ID` (keep seen ids at least 25 hours); events can arrive late or out of order.

Agents and days:

- `task delegate` opens a new agent session for a task, using the task's text and description, and
  records the agent on the task. `--to` names an agent (`olympus agents list`); without it the task's
  assignee is used if it is an active agent, otherwise the organization's primary agent. It is **not
  idempotent**: running it again opens another session. It takes `--week` like the other task commands.
- `task breakdown` asks an agent to propose subtasks and appends them to the task (a task holds at
  most 5, and one that is full is exit 6). `--agent` works like `--to`. The call waits for the agent and
  can take up to about 90 seconds; the CLI allows 100 s. If the agent fails or answers badly the server
  replies `502 agent_failed` and the CLI exits 5 with the agent's message; nothing is saved. If you
  interrupt it (or it times out) the subtasks may still have been added, so check with `task get <id>`
  before running it again.
- `day` shows your own close-of-day entry for one weekday (Monday to Friday; the default is today in
  your local time zone, so a weekend "today" is exit 6). `day list` shows the week's five days.
  `--week` takes any date in the week. Only your own entries are visible.
- `day close` saves what you give it and closes the day; `--draft` saves without closing. Fields you
  do not give are left as they were, but `--blocker` and `--learning` replace the whole list. With no
  content flag (`--shipped`, `--blocker`, `--learning`, `--reflection`) it asks questions, but only when
  stdin and stderr are both terminals and `--json` is off. Otherwise it is a usage error (exit 1)
  and never waits on stdin, so scripts cannot hang. Re-closing a day from a script means
  re-sending the content you want kept. Week close is not available from the CLI.

When it asks, `day close` first reads the day (so a bad token, organization or date fails before the
first question), then asks for shipped, blockers (one per line), learnings (one per line) and a
reflection. Enter skips a question; an empty line ends a list. Ctrl-C cancels at any point before the save
(typed-ahead answers are discarded); Ctrl-D cancels at a question that still needs an answer. Exit
130, nothing saved. If every answer is empty and the day has nothing saved yet, nothing is saved
either (exit 130).
The wording of prompts and of terminal-mode confirmations is not a stable interface; the piped forms
below are.

Asking an agent: `olympus ask AGENT TEXT` (AGENT is the agent's slug from `olympus agents list`) opens a
session with the agent, sends the text, waits for the reply and prints it. TEXT `-` reads it from stdin.
Replies take minutes, not seconds: the CLI checks about every 2 s (more slowly after an error, and it
honours `Retry-After`), which is about 30 requests a minute, under the 60 a minute a token gets. `--timeout`
is whole seconds, default 300, at most 86400. If the agent is busy with another message in that session
the CLI waits and retries until the timeout. `--session ID` continues a session instead of opening one
(the agent must match the session's; otherwise exit 6, `agent_mismatch`). `--no-wait` sends and returns at
once without a reply (it cannot be combined with `--timeout`). Stop waiting with Ctrl-C (exit 130); what it
prints depends on when you stop: before the message is sent, that nothing was sent; while it is being sent,
that it may have been sent (check `olympus session get ID`); after, the session id to read the reply later
with `olympus session get ID`. The message endpoint's 202 does not identify the accepted message, so if someone
else sends a message in the same session at the same moment, the replies cannot be told apart exactly;
`olympus ask` finds its own message by your user id and the exact text it sent, then takes the replies after it up to the first later message from another person (once another person posts after your message, `ask` returns the reply it has); if you send another message to the same session (from the app or another process) before `ask` has read its reply, that message's reply can be folded into this `ask`'s output, so send one message per session at a time and wait for `ask` to return; if its own message never shows up before the deadline it exits 5 `timeout` and you read it later with `session get`. Only sessions you opened or take part in are visible to you. `sessions` lists open sessions (`--closed`, or `--all`;
`--agent` filters by slug). `session get ID` prints the thread (the last 200 messages; `--after MSG_ID` only
newer ones) and `session close ID` closes a session; its transcript is kept. `briefing` shows your morning
briefing for today (`--day` for another date); `--request` asks your agent to write today's. It is exit 6
until your briefing is set up in the Olympus app.

Lending your browser: `olympus browser attach CODE` pairs this computer with the organization's agent and
then holds the connection until Ctrl-C (exit 130). The `XXXX-XXXX` code comes from **Settings → Rafita**,
lasts 10 minutes and is good for one claim; it is sent as shown (the server normalises it). Pairing stores an
`obm_` machine token at `~/.config/olympus/browser.json` (file 0600, one record per host), and `attach` with
no CODE reconnects with it — with nothing stored for that host, that is a usage error. `--name` labels the
computer in the app and is read only when pairing (default: this computer's hostname). `olympus logout` does
not touch this file and does not detach; revoke the computer in Settings → Rafita.

**No browser opens yet.** Chromium launches on the first CDP stream from the organization's workbench
bridge, and that bridge does not exist. Today `attach` pairs, connects, reports `online` and opens no
window. That is the command working, not stalling. When it does launch it gets a throwaway `--user-data-dir`
made per run and removed on exit — signed out, no extensions, no sync, never your own profile — and every
connection it makes leaves through a loopback SOCKS5 proxy, down the tunnel, and out of **the
organization's machine**, including Chromium's own startup calls to Google. `--disable-background-networking`
and `--disable-component-update` are set and, measured against Chromium 152 with a logging SOCKS server,
**suppress none of it**: a fresh signed-out profile on `about:blank` still reaches six Google hosts, the
same six with the flags and without them. Pass `--allow-origin` if that traffic must not leave; it refuses
all six. The binary is `$OLYMPUS_CHROME` if set, else the first of `chromium`,
`chromium-browser`, `google-chrome`, `google-chrome-stable` on `PATH`, else the two standard macOS
application paths. Nothing is downloaded, and no browser found is exit 1 — checked before the pairing code
is spent.

**The browser's local CDP port is unauthenticated.** It is bound to loopback, but Chromium's debugging
socket carries no credential, so any process running as you can drive that browser past this command's CDP
filter entirely; `--remote-debugging-port` also serves `/json/new` and `/json/list`, which open and address
targets without passing the filter at all. Nothing enforces otherwise: the filter guards the relay, not the
port. What it does guard is the workbench's side — default-deny by domain (`Page`, `Runtime`, `DOM`, `CSS`,
`Input`, `Network`, `Fetch`, `Emulation`, `Log`, `Accessibility`, plus a method list for `Target`), on a
flattened session the filter watched attach to a page target, with a CDP error back on every refusal rather
than a silent drop; downloads are denied browser-wide before any workbench command is forwarded, and the
filter refuses everything if that denial fails to install, while file choosers are cancelled per attached
page, so a page the filter never sees attach is covered for downloads but not for choosers; navigation and the
other URL-bearing methods take `http:`, `https:` and `about:blank` only. Allowing a domain admits every
method in it, the ones the protocol grows next included, and `Runtime.evaluate` is allowed by design, so the
agent can run arbitrary JavaScript in the pages it drives.

`--allow-origin HOST[:PORT]` is repeatable and narrows the default — any public host on 80 and 443 — to
exactly the hosts given. It matches the name Chromium sends with each connection, and the CLI performs no
DNS. Private, loopback and link-local **addresses** are always refused, whatever the list says; a *name*
such as `localhost` or an internal hostname is not resolved here and so is not refused here, and the
organization's machine resolves it at the far end.

With `--json`, one object per line on stdout as the state changes: `paired`, `connecting`, `online`,
`stream`, `refused`, `closed`, `stalled`, `backoff`, `backpressure`, and last `{"state":"exit","code":N}`
carrying the process's exit code, a pair failure included. Human mode prints short status lines to stderr
instead. Neither ever carries the machine token. Exits: 0 when the browser closes, 130 on Ctrl-C, 1 for usage
(including a bad `--allow-origin` and no browser on the computer), 3 or 6 for a refused pairing code, 2 when
the organization revoked this computer, 6 when another connection attached as the same machine, 5 for a
browser that cannot be started or reached and for a relay the CLI gave up on. **A revoked or unknown token
is not reported as such.** Measured: Bun's WebSocket client surfaces no HTTP status for a refused upgrade,
so the CLI cannot tell a revoked token from an unreachable machine. Either one shows as repeated
reconnection attempts (1 s doubling to 60 s, jittered, ten of them) and then exit 5. Only a close on a live
connection is specific: revoked is exit 2, replaced is exit 6.

## Environment

| Variable | Meaning |
|---|---|
| `OLYMPUS_API_KEY` | token; beats the stored one |
| `OLYMPUS_HOST` | API host |
| `OLYMPUS_ORG` | default org |
| `OLYMPUS_CHROME` | the browser `browser attach` launches; otherwise Chromium or Chrome from `PATH` |

Empty values count as unset. Stored credentials: `~/.config/olympus/credentials.json` (dir 0700, file 0600:
`host`, `token`, `org`). The stored token is only sent to its stored host. `browser attach` keeps its `obm_`
machine token in a separate file, `~/.config/olympus/browser.json` (also 0600), which `olympus logout` leaves
alone.

- **Host:** `--host` → `OLYMPUS_HOST` → stored host (only when no `OLYMPUS_API_KEY`) → `https://app.tryolympus.ai`. `http://` only for loopback.
- **Org:** `--org` → `OLYMPUS_ORG` → the token's pin → stored default → the only membership; otherwise exit 1 listing slugs.

## Output and exit codes

Human mode depends on where stdout goes. On a terminal you get headers, aligned columns, relative
times ("3h ago"; a time in the future reads `+5m`, `+3h` or `+8d`, and beyond 30 days it is the ISO date, while piped and `--json` output are unaffected), a `*` on the default org in `org list`, and full-sentence confirmations; control
characters in server text are stripped from stdout on a terminal and server text in error messages is cleaned on stderr too (except with `--json`, where stderr is the error body as sent). Piped or redirected, you get plain tab-separated lines that
scripts can rely on and that will not change. `olympus org list | cat` forces the plain form. No colour is
emitted, so `NO_COLOR` does not apply. `webhook create` shows the signing secret once, in both forms. `--json` prints the API body as-is (the one exception: `tasks` with list filters narrows `data.tasks` and leaves every other key as sent), one compact line
(`org list` → `{data:[…]}`, `org use` → `{data:{org}}`, `delete` → `{data:{id,deleted:true}}`,
`logout` → `{data:{deleted}}`, `task delete` and `subscription delete` → `{data:{id,deleted:true}}`; `task delegate`, `task breakdown`, `day …` → the response body; `task sub delete` prints the parent item the server returns). Errors go to stderr; with `--json` stderr is the error object, and
usage errors are `{"error":{"code":"usage",…}}`. A token is never printed.

**Piped tasks output** (tab-separated; every server string has control characters stripped, so a tab or
newline in task text never splits a row; nothing is printed for an empty list):

- `people`: `id  kind  name  email|-  me|paused|-`, one row per person.
- `tags`: one tag per line.
- `tasks` / `task list`: `id  open|done  section  flags  assignee-id|-  tag,tag|-  text`, where flags is
  `star`, `today`, `star,today` or `-`. Each subtask follows its task as
  `sid  open|done  sub:<task id>  today|-  assignee-id|-  -  text`. A comma inside a tag is ambiguous here.
- `task get` and every command that returns an item (add, update, done, undone, today, star, `sub …`) print
  these lines: `id:`, `text:`, `description:` (flattened to one line), `section:`, `order:`, `done:`,
  `done_at:`, `assignee:` (id), `tags:` (comma-joined), `today:`, `one_thing:`, `added_on:`,
  `delegated_to:`, `delegated_at:`, then one `subtask: sid<TAB>open|done<TAB>assignee-id|-<TAB>today|-<TAB>text`
  line per subtask. Empty and null values print `-`; `--json` is the lossless form.
- `task delete` prints `deleted <id>`.
- `task delegate`, four lines: `agent: <name>`, `session: <session id>`, `title: <title|->`,
  `url: <session URL>`.
- `task breakdown`: `agent: <name>`, then one `added: <sid><TAB><text>` line per new subtask (none if the
  agent added nothing).
- `day show` / `day [DATE]`, and what `day close` prints after saving: `day:`, `closed:` (`true|false`),
  `closed_at:`, `score:`, `shipped:`, `reflection:`, `agent_note:` (empty values print `-`), then one
  `blocker: <id><TAB><text>` and one `learning: <id><TAB><text>` line per item. A day with nothing saved
  prints the same lines with `-` for the empty ones. The `summary` is in `--json` only.
- `crm pipelines`: `id  pipeline  currencies|-  name`, then one `stage-id  stage:<pipeline id>  kind  name` row per stage.
- `crm tags`: one tag per line. `crm search`: `entity  id  sub|-  label`.
- `crm deals`: `id  status  pipeline-id|-  stage-id  amount  currency  owner-email|-  company-name|-  tag,tag|-  name`.
  `crm people`: `id  email|-  company-id|-  job-title|-  open-deals  tag,tag|-  name`.
  `crm companies`: `id  domain|-  city|-  open-deals  tag,tag|-  name`. Piped lists are **one page**, with no
  paging footer; use `--json` for `total`, `page` and `per`, and `--page N` for the next one.
- `crm deal|person|company get` and every CRM command that returns a record (add, update, move, owner,
  company, person, note, task, archive) print `field: value` lines (empty and null print `-`, `archived`
  is `true|false`, tags are comma-joined): a deal has `id`, `name`, `status`, `pipeline`, `stage`, `amount`,
  `currency`, `owner_email`, `next_action`, `lost_reason`, `company`, `person`, `tags`, `archived`,
  `in_stage_since`, `updated_at`, `version`; a person `id`, `full_name`, `email`, `phone`, `job_title`,
  `linkedin_url`, `company`, `tags`, `archived`, `version`, `notes`; a company `id`, `name`, `domain`,
  `website`, `industry`, `linkedin_url`, `phone`, `city`, `tags`, `archived`, `version`, `notes`.
  Related rows follow, tab-separated: deals `note: id  created_at  author  body` and
  `task: id  status  due_at|-  assignee  title`; people `deal: id  status  stage-name  name`; companies
  `person: id  email  full_name` and `deal: id  status  stage-name  name` (deal refs carry the stage name, not an id).
  After those, all three kinds print `interaction: occurred_at  kind  direction  summary` lines (none if there
  are none), and people and companies also print `task: id  status  due_at|-  assignee  title` lines (after the
  `deal:` lines, before `interaction:`). A deal with `legacy_notes` prints a `legacy_notes: <text>` line right
  after `version:` (flattened to one line); unlike every other field it is **absent**, not `-`, when empty.
  Pass the `version` back as `--version`.
- `crm deal|person|company deletion-preview <id>`: `entity:`, `id:`, `name:`, then one
  `impact: <key><TAB><count>` line per key the server returns, in its order. The keys are server-defined (they
  vary by record kind and can change), so print or loop over them all rather than expecting a fixed set.
  `crm ... delete` prints `deleted <id>`; `--json` prints `{"data":{"id":…,"deleted":true}}`.
- `crm task done` prints one line, `task: id  status  due_at|-  assignee  title`. `deal unlink-company` /
  `unlink-person` and `person|company task add` print the whole deal, person or company as above.
- `crm pipeline get`, `add`, `update` and `archive` print `id:`, `name:`, `currencies:` (comma-joined or `-`),
  `archived:` (`true|false`), `version:`, then one `stage: id<TAB>kind<TAB>name` line per live stage and one
  `archived_stage: id<TAB>kind<TAB>name` line per archived stage, in the server's order.
  `crm pipelines --archived` marks an archived pipeline by `pipeline:archived` in the second column of its row
  (live ones stay `pipeline`; stage rows are unchanged).
- `subscription list`: `id  active|inactive  event,event  last-status|-  consecutive-failures  url  name`.
- `subscription get`, `create`, `update` and `rotate-secret`: `id:`, `name:`, `url:`, `events:`
  (comma-joined), `active:` (`true|false`), `created_by:` (user id), `last_delivery_at:`,
  `last_delivery_status:`, `consecutive_failures:`, `created_at:` (empty prints `-`). `create` and
  `rotate-secret` add a last line `secret (shown once): <secret>`. `subscription delete` prints `deleted <id>`.
- `subscription ping`: `delivered: true|false`, `status:` (HTTP status or `-`), `error:` (or `-`).
- `event-types`: one event name per line.
- `day list`: five rows, Monday to Friday, `day<TAB>closed|draft|-<TAB>score|-<TAB>shipped|-`
  (`draft` = saved but not closed, `-` = nothing saved).

**Piped sessions output** (same rules: tab-separated, control characters stripped, nothing for an empty list):

- `sessions`: `id  open|closed  agent-slug  turn  last-activity|-  title|-`, where turn is `idle`, `queued`,
  `running` or `failed`, and last-activity is an ISO time. One page; `--page N` for the next.
- `session get`: one line per message, `role: text` or `role sender-id: text` (role is `user` or `assistant`; the
  text is flattened to one line). No header: the session, the turn and the timestamps are in `--json`.
- `session close` prints `closed <id>`.
- `briefing` and `briefing --request`: `day:`, `state:` (`none`, `pending`, `failed` or `ready`), `session_id:`,
  `requested_at:` (empty prints `-`), then one `document.<path>: value` line per leaf of the briefing document,
  in the server's order (array items are numbered, `document.items.0.title`; empty values print `-`; the
  document's fields are set by the server and can grow). There are no `document` lines when there is no document.
- `ask`: stdout is the reply text only (several assistant messages are separated by a blank line). On a
  terminal the new session's id is also printed to stderr as `session <id>`; piped, stderr stays quiet. With
  `--no-wait`, stdout is the session id (on a terminal, a sentence naming it).
- `ask --json` prints `{"session":…,"messages":[…],"turn":…}`: `messages` is every new message in the
  thread, including the one you sent; with `--no-wait` it is `[]`. In scripts use `--json` and read
  `.session.id` on success. Any failure after the session exists (a timeout, a failed turn, a closed session)
  prints the error object with `error.details.session_id`, so you can continue with `--session`.
  A failed turn is exit 1 with `error.code` `turn_failed`: tell it apart from a usage error by `error.code`.
  If the network drops while sending, the message may have been delivered; check with `olympus session get`
  before sending again.
- `version` / `--version`: `olympus <version>`; `version --json` is `{"data":{"version":"…"}}`.

| Exit | Meaning |
|---|---|
| 0 | ok |
| 1 | usage; also an `ask` whose turn failed (`error.code` `turn_failed`) |
| 2 | auth (401, or no token); also a `browser attach` whose computer was revoked by the organization |
| 3 | not found (404, non-member, pin mismatch) |
| 4 | forbidden (403) |
| 5 | server / network / redirect / 429 / anything unexpected, including "CRM temporarily unavailable (retry after)", "agent machine needs an update", and for `ask` a busy agent that stayed busy, no time left to send (`not_sent`), a timeout (`timeout`), or an agent machine that is not ready (for `ask`, retry only when the message says "nothing was sent", as `busy` and `not_sent` do before sending; `machine_not_ready` is the server's 503 and says no such thing: without `error.details.session_id` the session was never created, so nothing was sent and you can retry later, and with one read with `session get` first; after `timeout`, `network_error`, a 5xx on the send itself, or `bad_request` while reading, the message may have been sent: read with `session get` before asking again), and for `browser attach` a browser that could not be started or reached and a relay it gave up reconnecting to |
| 6 | invalid (400, 422), a 409 conflict ("changed since you read it"), "CRM not set up", `no_agent` (the organization has no agent), `session_closed`, `briefing_not_set_up`, `ask` `agent_mismatch`, and a `browser attach` replaced by another connection for the same machine |
| 130 | cancelled (Ctrl-C during login, credentials untouched; a cancelled `day close` prompt, nothing saved; or Ctrl-C during `ask`, which prints the session id when one exists) |

## `.env` is not loaded by the binary

The compiled binary is built with `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`. A CLI that
silently picks up `OLYMPUS_API_KEY` from whatever project directory it is run in acts as the wrong
identity. (`bun src/cli.ts` in development still loads `.env`.)

## Quirks

Arguments are parsed strictly: `--instructions -foo` is refused as an unknown option; write
`--instructions=-foo`. `--instructions-file -` (or `=-`) reads stdin.

Text that starts with `-` needs `--`: `olympus ask hermes -- "-text"`.

## Release

Push a `vX.Y.Z` tag: the release workflow builds `olympus-linux-x64`, `olympus-linux-arm64`,
`olympus-darwin-x64`, `olympus-darwin-arm64` plus `SHA256SUMS` and creates a GitHub release.
Release binaries print their tag (`olympus --version` → `olympus 0.7.0` for `v0.7.0`); a local build or
`bun src/cli.ts` prints `olympus dev`.
`workflow_dispatch`, or a PR touching release files, runs a dry-run build (artifact only, no release).

## Develop

```sh
bun install
bun test
bun run typecheck
bun run build        # → dist/olympus
```
