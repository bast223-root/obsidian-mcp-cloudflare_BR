# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker that exposes a user's Obsidian vault (stored in R2 via the Remotely Save plugin) as an OAuth-authenticated MCP server. The deployed Worker hostname, R2 bucket name, KV namespace id, and Cloudflare account id are all driven by `.env` (gitignored) and substituted into `wrangler.jsonc` by `scripts/setup.mjs`. **Running `npx wrangler whoami` before any deploy is non-negotiable** — if you operate multiple Cloudflare accounts, the setup script verifies the one in `.env` is active before doing anything destructive, but the user should still confirm.

### Sibling project: `obsidian-link-resolver`

A separate, content-free Cloudflare Worker lives at [`obsidian-link-resolver`](https://github.com/dszp/obsidian-link-resolver-cloudflare). It 302-redirects short HTTP URLs (`/n/<nanoid>`, `/p/?path=`, `/f/<name>`) to `obsidian://` deep links. **Coupling point:** this MCP mints the `id:` field that the resolver's `/n/` route targets via Advanced URI's `uid=` lookup. Changing the id scheme here breaks the resolver's input allowlist regex. The resolver has zero R2/KV/DO bindings by design — it reads nothing from the vault.

## Authoritative documentation

Before answering operational questions, read the relevant file rather than guessing:

- `README.md` — architecture, tool reference, caveats, gotchas. The longest and most current source of truth.
- `DEPLOYMENT.md` — first-time third-party setup + ongoing deploy/rollback/secret-rotation runbook.
- `CHANGELOG.md` — update before each deploy (Keep a Changelog format).
- `.env.example` — list of configurable values; `.env` itself is gitignored.

## Branching convention

- `main` — deployable state. Should always pass `npm test` and `npx wrangler deploy --dry-run`. No unreviewed direct commits when the project has other contributors.
- For larger or experimental changes, branch into `feat/<short-name>` and merge back.

## Common commands

All commands assume this directory as the working directory.

```bash
npm run setup             # regenerate wrangler.jsonc from .env (idempotent)
npm test                  # vitest run — full suite in workers pool
npm run test:watch        # vitest watch mode
npx vitest run path/to/file.test.ts        # one file
npx vitest run -t "substring of test name" # one test by name
npx tsc --noEmit          # type check (CI-equivalent)
npm run dev               # wrangler dev (needs .dev.vars with AUTH_PASSWORD=…)
npm run deploy            # wrangler deploy — verify whoami first
npm run deploy:fresh      # npm run setup + wrangler deploy in one shot
npx wrangler tail         # live production logs
npm run types             # regenerate worker-configuration.d.ts after binding changes
```

There is no lint step configured. TypeScript strictness + vitest is the full check.

## Architecture — the parts that span multiple files

The Worker is wired in `src/index.ts` as an `OAuthProvider` from `@cloudflare/workers-oauth-provider`. Three pieces collaborate:

1. **`src/auth/handler.ts`** — owns `/authorize` (GET renders consent page, POST verifies the shared `AUTH_PASSWORD` secret and calls `completeAuthorization`). `/token` and `/register` are handled inside `OAuthProvider` itself; we never write that code.
2. **`src/mcp/agent.ts`** — `ObsidianMCP extends McpAgent` is a Durable Object (SQLite-backed, see `migrations` in `wrangler.jsonc`). Its `init()` registers every MCP tool on the embedded `McpServer`. Each handler is wrapped via `instrument()` from `src/mcp/instrument.ts` to time, log, and convert typed-result failures to `isError: true` MCP responses. Tool handlers are thin: they read `this.env`, build an `R2Client` + `VaultConfig`, delegate to pure functions in `src/mcp/tools/`, and (for indexed reads/writes) coordinate the `VaultIndex`.
3. **`src/vault/r2-client.ts`** — the only place that touches the R2 binding. It enforces path safety (`..` and leading `/` rejected) and applies `VAULT_PREFIX` consistently on read, write, list, and delete. `put` returns the resulting etag so write-through index updates can stamp the correct version. Anything that needs vault I/O goes through this client; the tool implementations never touch `this.env.VAULT` directly.

Tool implementations live as pure functions in `src/mcp/tools/{notes,metadata,daily,admin}.ts`. They take an `R2Client` and `VaultConfig`, never the agent or env — this is what makes them straightforward to unit-test under the workers pool. Pure functions return `ToolResult<T>` on expected failures (typed `{ ok: false, reason, ...context }`) rather than throwing, so MCP boundary handlers can surface them as `isError: true` without ever incrementing the DO RPC-error counter. `admin.ts` holds maintenance operations like `backfill_ids` that walk the vault — keep them there to signal "not a routine read/write".

The SQLite-backed search/tags/backlinks index lives in `src/vault/index-store.ts` (`VaultIndex` + `SqlStore`, tables prefixed `vault_*`). `ensureFresh()` compares R2 etags against the index on every indexed read; writes through this Worker upsert inline. See README's "DO-SQLite vault index" section for the full design.

### Adding a tool

1. Pure function in `src/mcp/tools/*.ts` (or a new file). Take `(c: R2Client, cfg: VaultConfig, args)`. Return `ToolResult<T>` on expected failures, not `throw`. If the tool writes, return the new etag in the success value so the agent can upsert the index. For tools that return note metadata, include a `permalink: string | null` field built via `buildPermalink(cfg.permalinkBaseUrl, path, id)` so AI callers don't have to know the resolver URL shape.
2. Register in `src/mcp/agent.ts` inside `init()` via `this.server.tool(name, description, zodSchema, handler)`. The handler should call `instrument(name, ...)` and use `fromToolResult` / `okText` / `okJson` from `src/mcp/instrument.ts` for the response shape. Use `fromToolResultBlocks` if the tool needs to emit multiple text content blocks (e.g. raw body + JSON metadata, as `read_note` does).
3. If the tool reads many notes, query the index via `this.index` instead of scanning R2.
4. Add a vitest in `test/tools.test.ts` (or a sibling file).
5. Update `README.md`'s tool table and `CHANGELOG.md`.
6. `npm test` → `npx wrangler deploy` → **see the DO/client cache gotcha below**.

### Path validation invariant

`NotePath` in `agent.ts` enforces `.md$` at the schema layer. `R2Client.toKey` enforces the safety check (`..`, leading `/`). Both layers exist deliberately — don't remove either thinking it's redundant. Schema validation gives a clean Zod error to the MCP client; the runtime check guards anything that might bypass the schema later.

## Gotchas that will burn you (read once, save hours)

### Deploying a new tool ≠ clients see the new tool

`ObsidianMCP` is a Durable Object. `init()` runs once per DO instance lifetime. `wrangler deploy` does **not** evict live DO instances; they keep serving the previous code until they hibernate (~60–90s with no active SSE/inbound traffic). On top of that, every MCP client caches the tool registry somewhere of its own:

- **Claude Code CLI**: tool registry built at app launch; `/mcp` reconnect does NOT re-query. Fully quit and reopen.
- **Claude mobile app**: same — caches at app launch. Force-quit (swipe out of the app switcher) and reopen. New chat alone is not enough.
- **Claude.ai web**: usually per-chat, but the integration record itself can cache — disconnect + reconnect in Settings → Connectors if a new chat still shows stale tools.

So a tool deploy needs to clear *two* caches: the DO instance (disconnect fully, wait, reconnect — or force-delete the DO from the dashboard) **and** the client tool registry. Symptoms and full procedure in `README.md` under "Durable Object holds the old code…" and the per-client cache subsections.

### `vitest` fails to load the SDK when the project path contains a space

`workerd`'s URL-encoded path loader inside `ajv` breaks when the project lives at a path containing a space (e.g. `…/CLAUDE Projects/…`). The workaround is `test/_test-worker.ts`, a minimal stub used as the test-time `main` (see `vitest.config.ts`). Do not delete it. Production deploys are unaffected because esbuild bundles cleanly.

### `VAULT_PREFIX` must match Remotely Save's "Remote Prefix" exactly

Default is empty in both. If you change one without the other, the Worker sees the wrong key namespace and tools return empty results.

### Stable note ids — what every write path does and does not touch

Every note minted through this MCP carries a 21-char nanoid in frontmatter as `id:` (alphabet `A-Za-z0-9_-`). The sibling `obsidian-link-resolver` design depends on this id being stable and singular-scheme. Per-tool invariants, enforced in `src/mcp/tools/`:

- **`create_note`**: mints a nanoid into the frontmatter if none was supplied; honors a caller-supplied id verbatim (any scheme).
- **`replace_note`**: **always** preserves the existing note's id even if the caller's content omits or rewrites it (`setIdInFrontmatter` force-overrides on the way out). If the existing note had no id, one is minted. id-stripping or id-changing through `replace_note` is impossible by design.
- **`replace_body`**: byte-preserves the entire frontmatter, so the id passes through untouched.
- **`patch_note`**: pure string find/replace on the file body, never imports or calls any id helper. It does not mint, convert, or "correct" ids. **Caveat**: id-stable only when the caller's `old_str` does not overlap the `id:` line. A patch whose `old_str` happens to match (or partially match) the id line will strip or rewrite the id — there is no special-case protection. Treat `old_str` as a literal range to overwrite, including the id line if it falls inside that range.
- **`backfill_ids`**: skips any note that already has an `id:` line of *any* scheme (preserves user-chosen or plugin-minted ids like UUIDs). Only mints nanoid for notes that have no id at all. Default `dryRun: true`.

The codebase has exactly one id minter (`generateNoteId` in `src/vault/markdown.ts`, nanoid-only). The id-line regex (`FRONTMATTER_ID_RE`) deliberately accepts any non-whitespace value, not just nanoid shape, so legacy ids and externally-set ids round-trip unchanged.

Caveat from production: **Advanced URI can write a UUIDv4 `id:` into a note in Obsidian** when "copy URI" or related commands are invoked, before the note ever reaches this server. Treat any non-nanoid id as legitimate. If you need to re-mint a specific note's id to nanoid, the workflow is: open in Obsidian → delete the `id:` line in frontmatter → save → let Remotely Save sync → call `backfill_ids` with `dryRun: false`. There is no server-side "force re-mint" tool by design (would compromise the resolver's id-stability guarantee).

### `patch_note`'s `new_str` is a literal, not a substitution template

Earlier versions (≤0.6.0) routed the single-replace path through `String.prototype.replace(string, string)`, whose replacement-string semantics interpret `` $` ``, `$'`, `$&`, `$$`, and `$n`. A `new_str` containing any of those — easy to produce, e.g. a regex literal in a markdown code span — would splice unrelated parts of the file into the result. 0.6.1 fixes this by always going through `parts.join(args.new_str)` (literal concatenation, no substitution layer). General lesson: if you add a future tool that does string substitution, **don't** reach for `String.prototype.replace` with a string second argument. Use `parts.join`, a function replacer (`(_match) => new_str`), or escape `$` → `$$` first.

## Bindings reference (from `wrangler.jsonc`)

Concrete values come from `.env`. The bindings themselves:

- `VAULT` — R2 bucket (single source of truth for the vault). Bucket name in `.env` as `R2_BUCKET_NAME`.
- `OAUTH_KV` — KV namespace for OAuth state. Id in `.env` as `OAUTH_KV_ID` (auto-filled by `npm run setup`).
- `MCP_OBJECT` — Durable Object class `ObsidianMCP` (transport/session state + the SQLite vault index; the index is recoverable from R2 via `ensureFresh()`, so the DO is still safe to evict).
- `AUTH_PASSWORD` — Workers secret (set/rotated via `npx wrangler secret put AUTH_PASSWORD`).
- `VAULT_PREFIX`, `DAILY_NOTE_PATH_TEMPLATE`, `PERMALINK_BASE_URL` — plain vars. `PERMALINK_BASE_URL` is the base URL of a deployed sibling `obsidian-link-resolver` Worker; empty disables permalink generation across every tool. Per-vault scoping is by deploy — second vault = second MCP deploy = second `PERMALINK_BASE_URL`.
