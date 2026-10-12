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

CRM (`olympus crm …`): any member can read; writing needs the `operator` role (a teammate gets exit 4).
Records are deals, people and companies. `--version V` on an `update` is optional. Sent, the update is
refused when the record changed since you read it (exit 6, "it changed since you read it"); omitted, the
last writer wins for the fields you send. `--add-tag` / `--remove-tag` read the record and then write it
with the version they read, so they are **not atomic**: on exit 6, run the command again.
Any tag flag together with other fields is two server writes; if the second fails, the first stays.
`archive` hides a record and is reversible with `--undo`; it needs no `--yes`. `--archived` on a list
shows only archived records, `--sort` and `--page` are passed to the server (one page at a time), and
`--owner` and `--stage` take `none`. A CRM that is not set up yet is exit 6; a temporarily unavailable one
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
missing. An agent machine that has not been updated yet may not honour the key; the API says so in a response
header (`Idempotency-Key-Honored: false`), which the CLI does not show.

Subscriptions (`olympus subscription …`) send signed HTTP events to your URL when things happen
(`olympus event-types` lists the names). They are **operator only, reads included** (a teammate gets
exit 4). `create` and `rotate-secret` print the signing `secret` once; it cannot be read again. Rotating
makes no promise that the old secret keeps working. `delete` never prompts and requires `--yes`.
`--event` is repeatable and replaces the list on `update`; `--active` / `--inactive` switch delivery.
`ping` sends one test event (it is not an event type you can subscribe to): it does not count toward
`consecutive_failures` and exits 0 whether or not your URL answered, so read `delivered`; `status` is `-` on a
network failure and `error` says why. It can be rate limited (exit 5: retry after the stated seconds). A
subscription pauses after 20 failed events in a row; re-enable it with `update <id> --active`. Verifying
signatures: [`docs/API.md`](docs/API.md#receiving-events).

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

## Environment

| Variable | Meaning |
|---|---|
| `OLYMPUS_API_KEY` | token; beats the stored one |
| `OLYMPUS_HOST` | API host |
| `OLYMPUS_ORG` | default org |

Empty values count as unset. Stored credentials: `~/.config/olympus/credentials.json` (dir 0700, file 0600:
`host`, `token`, `org`). The stored token is only sent to its stored host.

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

| Exit | Meaning |
|---|---|
| 0 | ok |
| 1 | usage |
| 2 | auth (401, or no token) |
| 3 | not found (404, non-member, pin mismatch) |
| 4 | forbidden (403) |
| 5 | server / network / redirect / 429 / anything unexpected, including "CRM temporarily unavailable (retry after)" and "agent machine needs an update" |
| 6 | invalid (400, 422), a 409 conflict ("changed since you read it"), "CRM not set up" |
| 130 | cancelled (Ctrl-C during login, credentials untouched; or a cancelled `day close` prompt, nothing saved) |

## `.env` is not loaded by the binary

The compiled binary is built with `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`. A CLI that
silently picks up `OLYMPUS_API_KEY` from whatever project directory it is run in acts as the wrong
identity. (`bun src/cli.ts` in development still loads `.env`.)

## Quirks

Arguments are parsed strictly: `--instructions -foo` is refused as an unknown option; write
`--instructions=-foo`. `--instructions-file -` (or `=-`) reads stdin.

## Release

Push a `vX.Y.Z` tag: the release workflow builds `olympus-linux-x64`, `olympus-linux-arm64`,
`olympus-darwin-x64`, `olympus-darwin-arm64` plus `SHA256SUMS` and creates a GitHub release.
`workflow_dispatch`, or a PR touching release files, runs a dry-run build (artifact only, no release).

## Develop

```sh
bun install
bun test
bun run typecheck
bun run build        # → dist/olympus
```
