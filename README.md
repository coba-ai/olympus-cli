# olympus-cli

`olympus` — the command-line client for the [Olympus](https://tryolympus.ai) API, built for agents first
(`--json`, stable exit codes, `OLYMPUS_API_KEY`) and humans second. API reference: [`docs/API.md`](docs/API.md).

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
```

Global flags: `--json`, `--host URL`, `--org SLUG`, `-h/--help`. No flag takes a token.
`webhook create` prints the signing `secret` once (both modes); `update` sends only the fields given;
`delete` never prompts and requires `--yes`.
Roles are `operator` and `teammate`; a teammate cannot `webhook get` (exit 4) or write.

Tasks: any member, teammate included, can read and write them. Every `task` subcommand (and `tasks`) takes
`--week DATE`: any date works, the server normalises it to that week's Monday, and the default is the
current week. `--star` / `task star` marks the one thing; `task today` flags a task for today. `--assign`
and `--who` take `me`, a person id (`olympus people`) or a member's email; `--assign` is resolved by the
server, so a name that matches nobody (or a paused agent) is exit 6. `task delete` and `task sub delete`
never prompt and require `--yes`. `--tag` replaces a task's tags, `--no-tags` clears them, and
`--add-tag` / `--remove-tag` edit them without replacing (they cannot be combined with `--tag` or
`--no-tags`); edits made this way by two people at once never drop each other's tags.

List filters are applied by the CLI to the week's tasks: `--mine`, `--who` and `--today` match a task
whose own assignee/flag matches **or any of its subtasks**, and show the whole task; `--open` and
`--done` look at the task only; `--tag` is repeatable, matches exact strings (`Urgent` is not `urgent`)
and requires every tag given; `--backlog` keeps the backlog section. `--mine` with `--who`, and
`--open` with `--done`, are usage errors. An unknown `--who` is exit 6. Text that starts with `-` needs
`--` (`olympus task add -- "-x"`).

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
times ("3h ago"), a `*` on the default org in `org list`, and full-sentence confirmations; control
characters in server text are stripped from stdout on a terminal and server text in error messages is cleaned on stderr too (except with `--json`, where stderr is the error body as sent). Piped or redirected, you get plain tab-separated lines that
scripts can rely on and that will not change. `olympus org list | cat` forces the plain form. No colour is
emitted, so `NO_COLOR` does not apply. `webhook create` shows the signing secret once, in both forms. `--json` prints the API body as-is (the one exception: `tasks` with list filters narrows `data.tasks` and leaves every other key as sent), one compact line
(`org list` → `{data:[…]}`, `org use` → `{data:{org}}`, `delete` → `{data:{id,deleted:true}}`,
`logout` → `{data:{deleted}}`, `task delete` → `{data:{id,deleted:true}}`; `task sub delete` prints the parent item the server returns). Errors go to stderr; with `--json` stderr is the error object, and
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

| Exit | Meaning |
|---|---|
| 0 | ok |
| 1 | usage |
| 2 | auth (401, or no token) |
| 3 | not found (404, non-member, pin mismatch) |
| 4 | forbidden (403) |
| 5 | server / network / redirect / 429 / anything unexpected |
| 6 | invalid (400, 422) |
| 130 | cancelled (Ctrl-C during login; credentials untouched) |

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
