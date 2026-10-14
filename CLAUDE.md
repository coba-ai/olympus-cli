# olympus-cli — working agreement

The `olympus` CLI for the Olympus API (server: `coba-ai/olympus2`). The contract is `docs/API.md`;
build against it, never against guesses about the server. Development history, the internal
contract, `script/e2e.ts` and the loop notes live in `coba-ai/olympus-cli-internal`.

- Single static binaries via `bun build --compile` (linux/darwin × x64/arm64).
- Agents are the primary user: every command supports `--json`; exit codes are part of the contract.
- Never print a token. Credentials file is 0600.

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `WebSocket` is built-in. Don't use `ws`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile.
- ``Bun.$`ls` `` instead of execa.

## Testing

Use `bun test`. Commands are tested against a `Bun.serve` fake of the contract (`test/fake-api.ts`),
never against a live server.

## Dev-loop config

Project profile read by the `/dev-loop` skill (@kurenn/dev-loop). Copied from
`coba-ai/olympus-cli-internal`'s `CLAUDE.md` (profile verified 2026-10-09), where the loop notes still
live; the two must be changed together.

**Stack:** TypeScript on Bun 1.3.13 (`bun.lock`); `bun test`; `tsc --noEmit`.

**Commands**
- Install / prepare: `bun install --frozen-lockfile`
- Test: `bun test` (CI: `.github/workflows/ci.yml`). End-to-end against a real olympus2 + Hermes:
  `script/e2e.ts` in the internal repo (manual, not in CI).
- Test (scoped): `bun test <paths>`
- Lint: none
- Typecheck: `bun run typecheck`
- Security: none

**Worktree**
- Worktrees under `.worktrees/<short-name>/` (gitignored).
- Local config to copy: none

**Execution**
- Checkpoints: plan
- Specialist subagents: none
- Decomposition hint: types/config/credentials → HTTP client → commands → binary build; tests per
  unit against a `Bun.serve` fake of the contract.

**Quality**
- Critical paths: credentials/token handling (never print a token; 0600 file), exit codes and
  `--json` output (agents depend on them).
- Extra rating axes: contract fidelity against the contract the loop is building to.
- Fix-round cap: from tier (Light 1, Full 2)

**Ship**
- Learnings: one file per loop in `docs/dev-loop-learnings/` (`YYYY-MM-DD-<slug>.md`); mirror it into
  `coba-ai/olympus-cli-internal` afterwards, which is where the archive lives.
- PR conventions: standard `gh pr create`. **`coba-ai/olympus-cli` is PUBLIC** (since 2026-10-13) —
  nothing internal, no customer name and no host but the documented default belongs in a commit
  message, a PR body or a test fixture here.
