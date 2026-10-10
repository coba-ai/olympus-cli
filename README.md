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
```

Global flags: `--json`, `--host URL`, `--org SLUG`, `-h/--help`. No flag takes a token.
`webhook create` prints the signing `secret` once (both modes); `update` sends only the fields given;
`delete` never prompts and requires `--yes`.
Roles are `operator` and `teammate`; a teammate cannot `webhook get` (exit 4) or write.

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
characters in server text are stripped from stdout on a terminal (stderr error messages are not cleaned). Piped or redirected, you get plain tab-separated lines that
scripts can rely on and that will not change. `olympus org list | cat` forces the plain form. No colour is
emitted, so `NO_COLOR` does not apply. `webhook create` shows the signing secret once, in both forms. `--json` prints the API body as-is, one compact line
(`org list` → `{data:[…]}`, `org use` → `{data:{org}}`, `delete` → `{data:{id,deleted:true}}`,
`logout` → `{data:{deleted}}`). Errors go to stderr; with `--json` stderr is the error object, and
usage errors are `{"error":{"code":"usage",…}}`. A token is never printed.

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
