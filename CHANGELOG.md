# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — direct upload endpoint (large files / mobile photos)

- Authenticated HTTP upload path so users can get real photos into the vault, which MCP tool calls can't carry (tool-call payloads are capped by the client, and a user-uploaded image only reaches the model as vision, not reproducible bytes):
  - `POST /upload` (multipart) and a self-served `GET /upload` web page, on the Worker's public handler. Authenticated by an `Authorization: Bearer <UPLOAD_TOKEN>` (bookmarked page / iOS Shortcut) or a short-lived single-use `?t=` link token.
  - `create_upload_link` MCP tool — mints a tappable, expiring, single-use link (HMAC-signed, jti tracked in `OAUTH_KV`, consumed on first success) that Claude presents in chat. Two modes: a deterministic single-file link (`filename` → baked exact `dest_path` Claude can poll) and a batch link (the page accepts up to `max_files`). The response includes `landing_dir` (the folder uploads land in) so a batch upload is found via `list_attachments` scoped to that prefix rather than a whole-vault scan.
  - `move_attachment(from_path, to_path, overwrite?, update_embeds?)` MCP tool — server-side R2 move/rename (no bytes through the model) so a file uploaded to a guess/holding location can be relocated once the destination note is known. Allowlist-guarded. By default rewrites the embed in every note that referenced the old path (via the wikilink index) so links follow across one or many notes; `update_embeds: false` moves bytes only.
  - Server-side magic-byte content sniffing: corrects mislabeled files (a JPEG named `.png` → `.jpg`) and rejects a non-image masquerading as an image extension (`content_mismatch`). Folds in the earlier extension/MIME sanity-check idea.
  - Security: multipart-only (CSRF), never cookie auth; allowlist + `ATTACHMENT_MAX_BYTES` enforced; one-time links can't be replayed.
- New secret `UPLOAD_TOKEN` (bearer + link-signing key; unset disables the endpoint) and wrangler var `SERVICE_BASE_URL` (this Worker's origin; defaults to `https://${MCP_HOSTNAME}`).
- No inline-base64 upload tool is provided: a tool call carries its arguments as the model's output tokens, so a base64 payload beyond a few KB exhausts the output budget and truncates mid-stream. Binary uploads go through `create_upload_link` (user taps a link) or `upload_attachment_url` (server fetch).

### Added — attachment support

- Six new tools expose the vault's binary files (images, PDFs, configurable types) that Remotely Save already syncs into R2:
  - `upload_attachment_url` — fetch an HTTPS asset server-side, SSRF-guarded (HTTPS only, no IP-literal/loopback hosts, re-validated across redirects), size-capped, HTML rejected.
  - `read_attachment` — returns an MCP `image` content block for images, base64-in-JSON for other types.
  - `head_attachment` — metadata only (size/type/etag/uploaded) to check size before reading.
  - `list_attachments` — paginated listing of non-`.md` objects, optional `prefix` scope.
  - `delete_attachment` — idempotent; allowlist-guarded so it can't remove a note.
- New wrangler vars with safe defaults: `ATTACHMENTS_PATH_MODE`, `ATTACHMENTS_SUBFOLDER`, `ATTACHMENT_ALLOWED_EXTENSIONS`, `ATTACHMENT_MAX_BYTES`, `ATTACHMENTS_MOVE_WITH_NOTE`, `ATTACHMENT_URL_TIMEOUT_MS`.
- `R2Client` gains binary methods (`putBinary`, `getBinary`, `headBinary`, `listBinaries`) and an `ObjectExistsError` for non-clobber writes; the text `get`/`put`/`delete` stay `.md`-only.
- Pure helper module `src/vault/attachments.ts` (MIME/extension tables, filename sanitization, path-policy resolution, embed-markdown construction, SSRF host check) and tool module `src/mcp/tools/attachments.ts`.

### Changed

- `move_note` now optionally co-moves attachments uniquely embedded by the moving note (controlled by `ATTACHMENTS_MOVE_WITH_NOTE`, default `unique_refs`), rewriting embeds only when their relative form changes. Its response gains an `attachments_moved` array. Behavior is unchanged when a note embeds no allowlisted attachments.

### Documentation

- README now links to the [announcement blog post](https://dszp.dev/2026/05/23/two-workers-for-obsidian-and-claude-ai/) covering the motivation and design of both Workers.
- New "Attachments" section in README documenting the tools, path modes, config vars, co-move behavior, and the URL-fetch security model.

## [0.8.0] - 2026-05-23

First public release. Everything that was previously per-instance configuration is now `.env`-driven so anyone can deploy this without editing the codebase.

### Added

- `${PLACEHOLDER}`-driven configuration. `wrangler.example.jsonc` + `.env.example` are the committed templates; `wrangler.jsonc` and `.env` are generated locally by `npm run setup` and gitignored. Lets the same codebase deploy to anyone's Cloudflare account.
- `scripts/setup.mjs` — zero-dependency Node script that reads `.env`, idempotently creates the R2 bucket and `OAUTH_KV` KV namespace, captures the KV id back into `.env`, and substitutes placeholders into `wrangler.jsonc`. All wrangler shell-outs go through `execFileSync` (no shell interpolation) so values from `.env` can't become command injection.
- `npm run setup` and `npm run deploy:fresh` package scripts.
- `DEPLOYMENT.md` rewritten to combine first-time third-party setup with ongoing operations in a single doc.
- `LICENSE` (MIT) and author attribution in `package.json` and `README.md`.

### Changed

- README sanitized for public consumption — no per-instance hostnames, account ids, bucket names, or KV ids baked into prose. Architecture diagrams and tool descriptions use placeholders instead.
- CLAUDE.md sanitized similarly; kept the architectural context and gotchas, dropped per-installation specifics and personal git-signing notes.

### Removed

- `SETUP-NEW-USER.md` — merged into `DEPLOYMENT.md`.

## [0.7.0] - 2026-05-17

### Added — permalink generation

- New `PERMALINK_BASE_URL` wrangler var. When set, every note-returning tool produces a short HTTP permalink that 302-redirects into Obsidian via the sibling [`obsidian-link-resolver`](https://github.com/dszp/obsidian-link-resolver-cloudflare) Worker. Empty/unset disables the feature (all permalink fields become `null`, `generate_permalink` returns `reason='permalink_disabled'`). Per-vault scoping is by deploy — point a second MCP at its own `PERMALINK_BASE_URL`.
- `buildPermalink(baseUrl, path, id)` helper in `src/vault/markdown.ts`. Strategy:
  - id present → `${BASE}/n/<encoded id>?f=<encoded basename-no-ext>`. The `?f=` slug is decorative — the resolver ignores it and routes purely by id via Advanced URI's `uid=` lookup. Survives renames.
  - id null/empty → `${BASE}/p/?path=<encoded full path>` fallback. Works today but breaks on rename; backfill an id to upgrade.
- New `generate_permalink(path)` tool. Returns `{path, permalink, kind: 'id' | 'path'}`. `kind` lets the caller know whether the link is rename-stable. Soft-fails with `permalink_disabled` if base URL unset, `not_found` if the note doesn't exist.

### Changed — response shapes (0.7.0 is the first response-shape change since the initial release)

- `read_note` now returns **two** text content blocks when permalink is enabled: block 1 is the raw markdown body (unchanged), block 2 is JSON `{permalink}`. When `PERMALINK_BASE_URL` is unset, only the first block is emitted — pre-0.7.0 clients that read `content[0].text` continue to work either way.
- `create_note`, `replace_note`, `replace_body`, and `patch_note` now return JSON `{path, etag, permalink, ...}` instead of a plain text acknowledgement string. This is a documented shape change called out in each tool's description string. `permalink` is `null` when the feature is disabled.
- `parse_frontmatter` now returns JSON `{frontmatter, permalink}` instead of the raw frontmatter object. Same `null` semantics when disabled.

### Migration note

If you parse the previous ack strings (`"created Knowledge/foo.md"`, etc.) from the write tools, switch to JSON parsing. Failing closed when the response isn't the expected shape lets you survive future additions to the JSON.

## [0.6.1] - 2026-05-17

### Fixed

- `patch_note` now writes `new_str` literally even when it contains `$` metacharacters (`` $` ``, `$'`, `$&`, `$$`, `$n`). The single-replace branch previously routed through `String.prototype.replace(string, string)`, whose replacement-string semantics treat those sequences specially. A `new_str` containing `` $` `` (e.g. a regex literal followed by a backtick in a markdown code span) would splice the entire pre-match content of the file into the result. Fix: both branches now use `parts.join(args.new_str)`, which concatenates literally and has no substitution layer. Two regression tests pin all five metacharacters in both single and `replace_all` modes.

## [0.6.0] - 2026-05-17

### Added — stable note ids

- Every note created or replaced through the MCP now gets a stable `id:` field in its frontmatter (21-char nanoid in the URL-safe alphabet, regex `^[A-Za-z0-9_-]{21}$`). Ids are minted in `src/vault/markdown.ts::generateNoteId()` via `nanoid/customAlphabet`. Designed to pair with a separate HTTP resolver Worker that emits stable `obsidian://advanced-uri?uid=<id>` deep links — so external systems reference notes by id rather than by path, surviving renames.
- `ensureIdInFrontmatter(src, mintId)` and `extractIdFromFrontmatter(src)` in `src/vault/markdown.ts`. The ensure helper is byte-preserving: it injects `id: <newId>\n` right after the opening `---` fence if frontmatter exists, prepends a minimal block if not, and leaves source untouched when an `id` is already present. Field ordering and YAML formatting around other keys are preserved (no gray-matter round-trip).
- `setIdInFrontmatter(src, id)` — force-set variant used by `replace_note` to lock in the existing id regardless of what the caller submits. Makes id-stripping or id-rewriting impossible through `replace_note`.
- `backfill_ids` MCP tool (`src/mcp/tools/admin.ts::backfillIds`) — scans the vault and mints ids for notes that lack one. Default is `dryRun: true`. Supports `prefix` for folder-scoped runs and `limit` to cap inspection size. Reports counts, up to 10 example writes, and up to 20 malformed-frontmatter paths for follow-up. Idempotent and safe to re-run.

### Changed — id preservation across edits

- `create_note` now injects an id into the new note's frontmatter (or accepts a caller-supplied id and leaves bytes untouched if present).
- `replace_note` **preserves** the existing note's id even if the caller's content omits or changes it. External links keyed on the id stay stable across full-content rewrites. New error reason `malformed_frontmatter` fires when the **supplied** content has an unterminated `---` opener. A malformed existing note is salvaged: id extraction silently falls back to minting a fresh id rather than erroring, since `replace_note` is by definition rewriting the file.
- `get_or_create_daily_note` mints an id into the new daily note's frontmatter (previously the daily note was created with no frontmatter at all).

### Dependencies

- Added `nanoid@^5`.

## [0.5.0] - 2026-05-13

### Added — move_note (v0.5)

- `move_note(from_path, to_path)` MCP tool — moves or renames a note and rewrites every wikilink across the vault that pointed to the old path. Preserves aliases (`[[old|Display]]`), heading anchors (`[[old#Section]]`), block references (`[[old#^abc123]]`), embed markers (`![[old]]`), and full-path forms (`[[Folder/old]]`). Wikilinks inside fenced code blocks and inline code spans are not rewritten — they are treated as verbatim text. Returns `{ moved, from, to, links_updated, notes_modified }` on success. Failure reasons: `not_found`, `exists`, `same_path`.
- `rewriteWikilinksForMove()` in `src/vault/markdown.ts` — offset-based wikilink rewriter that masks out fenced/inline code regions before substitution, so surrounding whitespace and link spacing stay untouched.
- `VaultIndex.findReferrersFor(fromPath)` plus `Store.findReferrers(...)` — queries the `vault_wikilinks` index for candidate referring notes via a single SQL query (target equality against the basename, full path, or path-with-`.md`, plus a `LIKE '%/{basename}'` clause to catch path-suffix references). The move tool runs the precise per-file rewriter on each candidate to do the final resolution check; the index serves as a fast pre-filter so the move skips the rest of the vault entirely.

### Changed — move_note (v0.5)

- `move_note` commits with best-effort atomicity: writes the destination first, then each referrer rewrite, then deletes the source. On any failure, every successful write is reverted in reverse order. R2 has no transactional API, so a crash mid-rollback can still leave partial state — a future iteration could add conditional writes (`onlyIf: { etagMatches }`) once the latent concurrent-write race is also addressed.
- `McpServer` version bumped to `0.5.0`.

### Added — replace_note / replace_body split (v0.4)

- `replace_body(path, body)` MCP tool — replaces the body of a note while preserving the existing frontmatter byte-for-byte. Implementation is string-level boundary detection only (no YAML parse-and-reserialize) so nested mappings, quoted colons, Templater expressions, and CRLF line endings round-trip untouched. New failure reason `malformed_frontmatter` when the opening `---` has no closing fence — callers should escalate to `read_note` + `replace_note` rather than guess where the boundary is.
- `splitFrontmatterRaw()` in `src/vault/markdown.ts` — the boundary detector. Returns the raw frontmatter bytes (including the opening, the YAML, the closing fence, and the trailing newline) or `null` when no frontmatter exists; throws `MalformedFrontmatterError` otherwise.
- `replace_note(path, content)` MCP tool — the named full-overwrite operation (same behavior as the removed `update_note`). Tool description steers callers toward `replace_body` for body-only edits and `patch_note` for surgical edits.

### Removed — replace_note / replace_body split (v0.4)

- `update_note(path, content)` MCP tool. **Breaking change.** Replaced by the explicit `replace_note` + `replace_body` pair. Rationale: AI consumers don't surface ergonomic friction the way humans do — a tool that silently wipes frontmatter when the caller meant "edit the body" is the wrong default. Encoding the safe path at the tool-selection layer (named operations) is more reliable than encoding it in description text.

### Changed — replace_note / replace_body split (v0.4)

- `McpServer` version bumped to `0.4.0` to reflect the removed tool. MCP clients do not negotiate against this field; the user-visible effect is a one-time tool-list refresh (force-quit Claude Code, etc.).

### Added — DO-SQLite vault index (v0.3)

- `src/vault/index-store.ts` — `VaultIndex` + `Store` interface + `SqlStore` implementation. The index is persisted in the Durable Object's SQLite storage (tables `vault_notes`, `vault_tags`, `vault_wikilinks`, all prefixed `vault_` to avoid collision with the `agents` SDK's `cf_agents_*` internal tables).
- `VaultIndex.ensureFresh()` syncs the index with R2 by comparing etags: one R2 LIST plus fetches only for changed bodies. Called before every indexed read so external changes (e.g. Remotely Save syncing in new notes from Obsidian) get picked up without manual invalidation.
- Write-through index updates: every successful `create_note` / `update_note` / `patch_note` / `delete_note` / `append_to_daily_note` / new-day `get_or_create_daily_note` updates the index inline using the etag returned from `R2.put`, so the index never lags writes that go through this Worker.
- `escapeLikePattern()` escapes SQL `LIKE` meta-characters (`%`, `_`, `\`) and the queries use `ESCAPE '\\'` so substring searches behave the same as plain `String.includes` — a query of `_drafts` or `100%` no longer silently widens via SQL wildcards.
- `test/index-store.test.ts` — `VaultIndex` integration tests against an in-memory `Store` with a real `R2Client`, covering seeding, no-op sync, externally-added/changed/deleted notes, search, tags, backlinks, and write-through paths.
- `test/sql-store.test.ts` — `SqlStore` tested against a fake SQLite emulator that implements the LIKE-with-ESCAPE semantics exactly. Catches regressions where `%` or `_` in a search query would otherwise be treated as wildcards.
- `R2Client.put` now returns the resulting etag (was `void`). Required so write-through updates can index against the right version.
- `R2Client.listMarkdownWithMeta()` returns `{ path, etag }[]` for the diff in `ensureFresh()`. `listMarkdown()` is preserved as a convenience that returns paths only.

### Changed — DO-SQLite vault index (v0.3)

- **`search_notes`, `list_tags`, `list_backlinks` now read from the SQLite index** instead of scanning R2 on every call. Steady-state cost is one R2 LIST + one SQL query (single-digit milliseconds) rather than `O(N)` R2 GETs. Cold-DO first call still seeds the full index (`O(N)` R2 GETs) — same total work as before, just amortized differently.
- `src/vault/search.ts` deleted — `VaultIndex.search()` is the implementation.
- `src/mcp/tools/metadata.ts` no longer exports `listTags`/`listBacklinks` (moved into `VaultIndex`); `parseFrontmatter` remains as it's a single-note operation that doesn't benefit from indexing.
- `McpServer` version bumped to `0.3.0` to reflect the new index-backed read path and the additional `etag`/`content` fields in write-tool success values.

### Added — error-rate / observability (v0.2)

- `patch_note(path, old_str, new_str, replace_all?)` MCP tool — targeted in-place edit modeled on the Anthropic file-editor `str_replace` contract. `old_str` must be unique in the note unless `replace_all: true` is passed; missing anchor fails closed with `reason: "anchor_not_found"`. Avoids retransmitting full note bodies for small edits and gives implicit concurrent-edit detection via anchor presence.
- `src/vault/concurrency.ts` — `mapPool(items, limit, fn)` helper for bounded-parallel R2 fan-out.
- `src/log.ts` — structured JSON logging helper (`log.debug/info/warn/error`) that surfaces in Workers Logs as queryable events.
- Tool **descriptions** on every `this.server.tool(...)` registration. MCP clients (especially LLM-driven ones) now see human-readable guidance for each tool — including the explicit warning that `update_note` is a destructive full-content replace.
- Per-tool instrumentation in `src/mcp/agent.ts`: every invocation emits `{event: "tool", name, durationMs, ok}`. Unexpected handler exceptions are caught, logged as `tool_unexpected`, and returned as `isError: true` so they no longer escape as DO RPC errors.
- Structured logs in `src/auth/handler.ts` for every non-2xx return path (`non_oauth_path`, `auth_form_invalid`, `auth_failed`, `auth_method_not_allowed`) with appropriate log levels so probe traffic stops inflating the dashboard "Errors" metric.
- Structured log on path-validation rejection in `R2Client.toKey` (`invalid_path_rejected`).
- Structured log of vault list duration (`vault_list`).
- `test/concurrency.test.ts` covering `mapPool` ordering, concurrency cap, and the empty-input edge case.

### Changed — error-rate / observability (v0.2)

- **Search, list_tags, list_backlinks now fan out R2 reads via `mapPool`** with concurrency 25 instead of sequential `await` per note. Eliminates the dominant source of P99 tail latency and `client_disconnected` errors on Durable Object metrics. (Largely superseded by the v0.3 index for these specific tools, but the helper is still used during initial seed and elsewhere.)
- **Tool functions return typed `ToolResult<T>` instead of throwing on expected failures.** Affects `readNote`, `createNote`, `updateNote`, `patchNote`, `parseFrontmatter`. Each "expected" failure (missing note, anchor not found, etc.) now returns `{ ok: false, reason, ...context }` and is surfaced to the MCP client as `isError: true` — no longer counted as a Durable Object RPC error. New reason codes: `not_found`, `exists`, `anchor_not_found`, `ambiguous`, `no_op`.
- `read_note` now returns a textual reason on miss instead of an empty string, so the calling LLM can react.
- Pinned `account_id` in `wrangler.jsonc` to a specific account. Removes the interactive account-picker on `wrangler deploy`. (Superseded in [Unreleased] by `.env`-driven configuration.)
- Bumped `wrangler` devDependency to `^4.90.1`.

### Documentation

- README gotchas: documented the post-deploy "tool list is stale" problem at two layers — Durable Object instances continue serving pre-deploy code until they hibernate, and Claude Code's local tool registry is built at app launch and isn't refreshed by `/mcp` reconnect. Each layer has its own resolution; both must be cleared for a newly-added tool to be invokable.
- README gotchas: added a note about TOCTOU race on `create_note`/`update_note`/`append_to_daily_note` — currently dormant in single-user use, but a known limitation tracked for a future fix using R2 conditional writes.

## [0.1.0] - 2026-05-11

Initial release.

### Added

- Cloudflare Worker scaffold (`wrangler.jsonc`, `tsconfig.json`, `package.json`, `.gitignore`).
- R2 bucket binding (`VAULT`) for direct vault access without S3 round-trips.
- KV namespace (`OAUTH_KV`) for OAuth state.
- Durable Object class `ObsidianMCP` (binding `MCP_OBJECT`, SQLite storage) for stateful MCP sessions.
- `R2Client` wrapper (`src/vault/r2-client.ts`) with prefix-aware key normalization and path-traversal validation.
- Markdown parsing utilities (`src/vault/markdown.ts`): `parseNote`, `extractTags`, `extractWikilinks`. Tags merge frontmatter + inline `#tags` (nested-tag aware); wikilinks ignore code fences.
- Linear content search with snippets (`src/vault/search.ts`).
- Eleven MCP tools registered on `ObsidianMCP`:
  - `list_notes`, `read_note`, `search_notes`, `create_note`, `update_note`, `delete_note`
  - `parse_frontmatter`, `list_tags`, `list_backlinks`
  - `get_or_create_daily_note`, `append_to_daily_note`
- OAuth consent flow (`src/auth/`): password-gated `/authorize` page using `@cloudflare/workers-oauth-provider`.
- `OAuthProvider` wiring in `src/index.ts` with `/mcp`, `/authorize`, `/token`, `/register` endpoints (Dynamic Client Registration enabled so Claude.ai can self-register).
- Custom domain route (`custom_domain: true`).
- Vitest test suite: 25 tests across `r2-client`, `markdown`, `search`, and `tools` modules.
- `test/_test-worker.ts` stub entrypoint used by `vitest-pool-workers` (workaround for MCP SDK / `ajv` module-resolution failure when the project path contains a space).
- README, deployment runbook (`DEPLOYMENT.md`), new-user setup guide (`SETUP-NEW-USER.md`), and this changelog.

### Configuration

- `VAULT_PREFIX = ""` (empty — vault files at bucket root; must match Remotely Save's "Remote Prefix").
- `DAILY_NOTE_PATH_TEMPLATE = "Daily Notes/{{YYYY-MM-DD}}.md"`.
- `compatibility_date = "2026-05-01"`, `compatibility_flags = ["nodejs_compat"]`.
- `AUTH_PASSWORD` stored as a Workers secret (set via `wrangler secret put`).

### Notes

- End-to-end deployment verified: Obsidian (Mac) ↔ Remotely Save ↔ R2 ↔ Worker ↔ Claude.ai. Note creation through Claude.ai was confirmed and the new note synced back to Obsidian on the next Remotely Save interval.
- Documented gotchas encountered during build: `vitest-pool-workers` + space-in-path, `custom_domain` clashes with pre-existing DNS records, 30-minute negative DNS cache after record deletion.

[Unreleased]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/dszp/obsidian-mcp-cloudflare/compare/v0.1.0...v0.5.0
[0.1.0]: https://github.com/dszp/obsidian-mcp-cloudflare/releases/tag/v0.1.0
