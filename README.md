# obsidian-mcp

A Cloudflare Worker that exposes an Obsidian vault as an OAuth-authenticated MCP server consumable by Claude.ai. The vault is stored in R2 via the Remotely Save plugin, which keeps your Obsidian desktop and iOS clients in sync. This Worker binds that same R2 bucket and serves MCP tools over an OAuth-protected endpoint.

> Background: [Two Workers for Obsidian and Claude.ai](https://dszp.dev/2026/05/23/two-workers-for-obsidian-and-claude-ai/) — announcement post covering the motivation and design of this MCP Worker and the companion link resolver.

## Documentation map

- **README.md** (this file) — architecture, tool reference, gotchas.
- [**DEPLOYMENT.md**](./DEPLOYMENT.md) — first-time setup + ongoing operations runbook (deploy, rollback, secret rotation, troubleshooting).
- [**CHANGELOG.md**](./CHANGELOG.md) — Keep a Changelog format. Update before each deploy.

## Quick start

```bash
git clone https://github.com/dszp/obsidian-mcp-cloudflare.git
cd obsidian-mcp
npm install
cp .env.example .env
$EDITOR .env                            # fill in account id, hostname, bucket name
npm run setup                           # creates R2 + KV, writes wrangler.jsonc
npx wrangler secret put AUTH_PASSWORD   # set OAuth password
npm test
npx wrangler deploy
```

Full step-by-step (including R2 token generation for Remotely Save, Claude.ai connection, and per-device sync setup) is in [DEPLOYMENT.md](./DEPLOYMENT.md).

## Architecture

```
Obsidian (Mac / iOS / iPad)
  └── Remotely Save plugin ──► R2 bucket
                                  ▲
                          obsidian-mcp Worker
                                  ▲
                          Claude.ai (MCP client over OAuth)
```

- R2 bucket is the single source of truth.
- Remotely Save runs inside Obsidian on every device, syncing bidirectionally to R2 on a 5-minute interval (default).
- The Worker binds the same R2 bucket directly (no S3 round-trip) and uses `@cloudflare/workers-oauth-provider` to handle the full OAuth 2.1 flow, gated by a single shared password (`AUTH_PASSWORD` Workers secret).
- Claude.ai connects via Dynamic Client Registration — no manual client setup required.

## Tools exposed

| Tool | Description |
|------|-------------|
| `list_notes` | List all `.md` files in the vault |
| `read_note(path)` | Returns the raw markdown as the first content block. When `PERMALINK_BASE_URL` is set, a second JSON block `{permalink}` follows. Failure: `not_found` |
| `search_notes(query, limit?)` | Case-insensitive substring search across note bodies and file paths (DO-SQLite index) |
| `create_note(path, content)` | Create a new note. If the supplied content has no `id:` in frontmatter, a 21-char nanoid is minted and injected as the first field. Returns JSON `{path, etag, permalink}`. Failure: `exists` |
| `replace_note(path, content)` | **Full overwrite** including frontmatter. Always preserves the existing note's `id:` (or mints one if absent) — id-stripping or id-changing through `replace_note` is impossible. Returns JSON `{path, etag, permalink}`. Failures: `not_found`, `malformed_frontmatter` (only if the supplied content has an unterminated `---`). For body-only edits use `replace_body`; for surgical edits prefer `patch_note` |
| `replace_body(path, body)` | Replace the body of a note while preserving the frontmatter byte-for-byte. Returns JSON `{path, etag, permalink}`. Failures: `not_found`, `malformed_frontmatter` |
| `patch_note(path, old_str, new_str, replace_all?)` | Targeted in-place edit; `old_str` must be unique unless `replace_all: true`. Returns JSON `{path, etag, count, permalink}`. Failures: `not_found`, `anchor_not_found`, `ambiguous`, `no_op` |
| `move_note(from_path, to_path)` | Move or rename a note and rewrite every wikilink across the vault that pointed to the old path, preserving aliases, heading anchors, block refs, embeds, and full-path forms. Wikilinks inside fenced code blocks and inline code spans are not rewritten. Failure reasons: `not_found`, `exists`, `same_path` |
| `delete_note(path)` | Delete a note from the vault. Idempotent |
| `parse_frontmatter(path)` | Returns JSON `{frontmatter, permalink}` — the parsed YAML object plus the note's short HTTP permalink. Failure: `not_found` |
| `generate_permalink(path)` | Returns JSON `{path, permalink, kind}` where `kind` is `"id"` (rename-stable, frontmatter-id lookup) or `"path"` (fragile fallback for un-id'd notes — run `backfill_ids` to upgrade). Failures: `not_found`, `permalink_disabled` |
| `list_tags` | Aggregate all tags across the vault, frontmatter + inline `#tags` (parallel R2 fan-out) |
| `list_backlinks(target)` | Find notes that contain a `[[target]]` wikilink (parallel R2 fan-out) |
| `get_or_create_daily_note(date?)` | Create or fetch today's (or a given date's) daily note |
| `append_to_daily_note(date?, content)` | Append a line to today's (or a given date's) daily note |
| `backfill_ids(dryRun?, limit?, prefix?)` | Scan the vault and mint a nanoid `id:` for any note missing one. Default `dryRun: true`. Returns counts plus up to 10 example writes. Safe to re-run; existing ids (any scheme) are skipped |
| `upload_attachment_url(source_url, filename?, target_note?, subfolder?, overwrite?, dest_path?)` | Fetch an HTTPS asset server-side and store it. SSRF-guarded (HTTPS only, no IP-literal/loopback hosts, validated across redirects), size-capped, HTML rejected. Same return shape. Failures: `invalid_url`, `insecure_url`, `disallowed_host`, `too_many_redirects`, `fetch_failed`, `html_response`, `too_large`, `no_extension_inferable`, `disallowed_extension`, `exists` |
| `read_attachment(path)` | Read an attachment. Image types return an MCP `image` content block + JSON metadata; non-image types return one JSON block with the base64 in `data_base64`. Only allowlisted extensions. Failures: `not_found`, `disallowed_extension` |
| `head_attachment(path)` | Metadata only — JSON `{path, size, content_type, etag, uploaded}`. Use to check `size` before a `read_attachment`. Failure: `not_found` |
| `list_attachments(prefix?, limit?, cursor?)` | List non-`.md` objects. Returns JSON `{items, cursor}`; `cursor` paginates. Empty `prefix` lists the whole vault |
| `delete_attachment(path)` | Delete an attachment. Idempotent. Only allowlisted extensions (so a note can't be deleted via this tool). Failure: `disallowed_extension` |
| `move_attachment(from_path, to_path, overwrite?, update_embeds?)` | Move/rename an attachment server-side (R2 copy+delete — works for large files). Both paths allowlisted. By default rewrites the embed in **every** note that referenced the old path (links follow the file across one or many notes); `update_embeds: false` moves bytes only. Returns JSON `{from, to, embed_markdown, etag, size, content_type, notes_modified}`. Failures: `same_path`, `not_found`, `exists`, `disallowed_extension` |
| `create_upload_link(target_note?, subfolder?, filename?, max_files?, ttl_minutes?)` | Mint a short-lived, single-use web link the **user taps** to upload file(s) straight to the vault (bypassing the tool-call payload limit) — the way to handle real photos/large images, especially from mobile. With `filename`: deterministic single-file link (returns the exact `dest_path` to poll). Without: batch link for up to `max_files`. Returns JSON `{upload_url, expires_at, landing_dir, multiple, …}` — `landing_dir` is the folder uploads land in, so a batch upload is found via `list_attachments` scoped to it (no whole-vault scan); `dest_path` only in deterministic mode. Failure: `upload_disabled` |

Tool failures use the MCP `isError: true` convention with a JSON-encoded body of the shape `{ ok: false, reason, ...context }`. Failures are not thrown as JSON-RPC errors, so they do not count as Durable Object RPC errors at the Cloudflare layer.

Daily note paths follow the `DAILY_NOTE_PATH_TEMPLATE` env var (default: `Daily Notes/{{YYYY-MM-DD}}.md`).

## Stable note ids and external permalinks

Every note created or replaced through this MCP gets an `id:` field in its frontmatter — a 21-character nanoid in the URL-safe alphabet (`^[A-Za-z0-9_-]{21}$`). Per-tool behavior:

- **`create_note`**: mints a nanoid if the caller's content has no `id:`; otherwise honors the caller-supplied id verbatim (any scheme — UUID, custom string, etc.).
- **`replace_note`**: existing note's id always wins. If the on-disk note has an id, it is preserved — even if the caller's content omits `id:` entirely or carries a *different* `id:` value (existing > supplied). If the on-disk note has no id, one is minted. id-stripping or id-changing through this tool is impossible by design.
- **`replace_body`** and **`move_note`**: byte-preserve the entire frontmatter; the id passes through untouched.
- **`patch_note`**: pure string find/replace on the body. The tool never reads or rewrites the `id:` line itself, but it offers no special protection — a patch whose `old_str` happens to overlap the `id:` line **will** strip or rewrite it. Keep `old_str` scoped to the content you intend to replace.
- **`backfill_ids`**: mints a nanoid for every note missing an `id:`. Notes that already have an id of any scheme are skipped (so externally-minted UUIDs from Advanced URI round-trip unchanged). Default `dryRun: true`.

The id is the anchor for [`Advanced URI`](https://github.com/Vinzent03/obsidian-advanced-uri) `uid=` lookups, which resolve against frontmatter directly — no path map, no client-side lookup table. Pair this MCP with the companion [`obsidian-link-resolver`](https://github.com/dszp/obsidian-link-resolver-cloudflare) Worker, which exposes three short HTTP routes that 302-redirect into Obsidian:

- `<RESOLVER_BASE>/n/<id>` → `obsidian://advanced-uri?vault=<Name>&uid=<id>` — preferred, survives renames.
- `<RESOLVER_BASE>/p/?path=<urlencoded-path>` → `obsidian://open?vault=<Name>&file=<path>` — fallback for un-id'd notes; breaks on rename.
- `<RESOLVER_BASE>/f/<urlencoded-name>` → `obsidian://open?vault=<Name>&file=<name>` — Obsidian wikilink-style lookup by bare filename.

External systems (task managers, ticketing tools, automation flows) should reference notes by the `/n/<id>` form so renames in Obsidian don't break the pointer.

### Permalink generation (server-side)

As of 0.7.0, the MCP itself emits ready-built permalinks so AI clients don't need to know the URL shape:

- Configured via `PERMALINK_BASE_URL` in `wrangler.jsonc` (e.g. `https://o.example.com`, pointing at your deployed `obsidian-link-resolver`). Empty/unset disables the feature — `permalink` fields become `null` and `generate_permalink` returns `reason='permalink_disabled'`.
- Every note-returning tool (`read_note`, `create_note`, `replace_note`, `replace_body`, `patch_note`, `parse_frontmatter`) includes a `permalink` field in its response — `${BASE}/n/<id>?f=<basename>` when an id exists, or `${BASE}/p/?path=<encoded path>` as a fragile fallback.
- `generate_permalink(path)` returns `{path, permalink, kind: 'id' | 'path'}`. The `kind` discriminator tells callers whether the link is rename-stable. Use this when you have a path but not yet a note read.
- The `?f=<basename-without-.md>` is a human-readability hint — the resolver ignores it and routes purely by id via Advanced URI's `uid=` lookup, so tampering with `?f=` cannot redirect the link.

**Multi-vault:** the MCP binds to a single R2 bucket per Worker, so a second vault requires a second MCP deploy. Point each MCP's `PERMALINK_BASE_URL` at its own resolver hostname.

## Day-2 operations

For first-time setup and routine operations, see [DEPLOYMENT.md](./DEPLOYMENT.md). Quick reference for already-deployed instances:

```bash
npx wrangler whoami                       # confirm correct Cloudflare account
npx wrangler secret put AUTH_PASSWORD     # rotate the OAuth password
npx wrangler deploy                       # redeploy after code changes
npx wrangler tail                         # stream live logs
npm test                                  # run the vitest suite
npx tsc --noEmit                          # type check
```

### Local development

```bash
echo 'AUTH_PASSWORD=local-dev-only' > .dev.vars
npm run dev
# in a second terminal:
npx @modelcontextprotocol/inspector
# point Inspector at http://127.0.0.1:8787/mcp
```

### Adding a new tool

1. Add a pure function under `src/mcp/tools/`.
2. Register it in `src/mcp/agent.ts` via `this.server.tool(...)` inside `init()`.
3. Add a vitest in `test/tools.test.ts`.
4. `npm test` → `npx wrangler deploy`.

After deploying a new tool, see the "Durable Object holds the old code" gotcha below for the disconnect-reconnect dance needed to make it visible to clients.

## Caveats

### End-to-end encryption must be OFF in Remotely Save

If you set a password in Remotely Save's encryption settings, every filename and body in R2 is encrypted with openssl/rclone crypt. The Worker has no key, so all MCP tools will return empty results or errors. Keep encryption disabled and rely on the R2 bucket being private + the OAuth gate on the MCP endpoint.

### `VAULT_PREFIX` must match Remotely Save's Remote Prefix exactly

`VAULT_PREFIX` in `wrangler.jsonc` (default empty) tells the Worker where in the R2 bucket your vault files live. If Remotely Save is set to `myvault/` and the Worker is empty (or vice versa), the MCP server will see no notes or wrong paths. After changing either, redeploy.

### Concurrent-write conflict window

If the MCP server writes a note while a device has an unsynced local edit to the same note, Remotely Save resolves the conflict via timestamp and one version will be lost. Mitigations:
- Keep the 5-minute sync interval on all devices.
- Avoid heavy concurrent editing on a device that isn't actively syncing.

### Search, tags, and backlinks are served from a DO-SQLite index

As of v0.3, `search_notes`, `list_tags`, and `list_backlinks` are served from an index persisted in the Durable Object's SQLite storage (tables prefixed `vault_*`). Every indexed read first calls `ensureFresh()`, which does a single R2 LIST and compares each object's etag against the index — only changed bodies are fetched. In steady state these tools cost one R2 LIST + one SQL query (single-digit milliseconds). Writes through this Worker (`create_note`, `replace_note`, `replace_body`, `patch_note`, `delete_note`, `move_note`, `append_to_daily_note`, the first `get_or_create_daily_note` of a day) update the index inline. `move_note` additionally consults the index to find candidate referring notes via a single `vault_wikilinks` query (matching the basename, full path, or path-suffix forms) rather than scanning every note.

The initial seed on a cold DO is still O(N) — one R2 GET per note in the vault. On the Cloudflare Free tier that caps at 50 subrequests/invocation; on Paid it's 1000. If your vault grows past the cap, the seed has to be split across multiple invocations. The current code does the full seed in one shot; if you ever hit the limit, the seed should be made incremental via DO alarms.

`search_notes` uses SQL `LIKE` against the lowercased body **or** the lowercased path — a note named `People/Kevin Meeting.md` matches a search for `kevin` even if the body never says "Kevin". Meta-characters (`%`, `_`, `\`) in queries are escaped so substring matches behave the same as plain `String.includes` — see `escapeLikePattern` in `src/vault/index-store.ts`. Filename-only matches return a generic body-prefix snippet; the returned `path` itself is the signal for why the note was matched.

### Concurrent-write race on create / update / append (latent, single-user)

`create_note`, `replace_note`, `replace_body`, and `append_to_daily_note` perform a head-or-read followed by a put without any concurrency guard. In single-user MCP usage this is dormant — there's only ever one writer — but if two MCP clients ran concurrently, both could observe "no existing note", both could put, and the last write would silently win. Tracked for a future fix using R2 conditional writes (`onlyIf: { etagMatches }`).

## Attachments

Six tools (added in the unreleased line after 0.7.0) expose the vault's binary files — images, PDFs, and other configured types — which Remotely Save already syncs into R2 alongside the markdown. This lets Claude ingest a pasted screenshot, pull a referenced asset from a URL, and read back an embedded image or PDF.

**Tools:** `create_upload_link`, `upload_attachment_url`, `read_attachment`, `head_attachment`, `list_attachments`, `move_attachment`, `delete_attachment` (see the [tool table](#tools-exposed)). Uploads return a ready-to-paste `embed_markdown` (e.g. `![[files/diagram.png]]`); compose one extra `patch_note` to display it in a note. There is deliberately **no inline-base64 upload tool** — see [below](#uploading-large-images--mobile-photos-direct-upload-endpoint) for why. Markdown tools are unchanged — `R2Client.get/put/delete` stay `.md`-only; the binary path uses separate `putBinary/getBinary/headBinary/listBinaries` methods.

### Where uploads land (`ATTACHMENTS_PATH_MODE`)

| Mode | Resulting path | Notes |
|------|----------------|-------|
| `per_note_subfolder` (default) | `<target_note's folder>/<ATTACHMENTS_SUBFOLDER>/<file>` | Matches Obsidian's per-note attachment convention. Falls back to `<subfolder>/<file>` at the vault root when no `target_note` is given. |
| `vault_default` | `<ATTACHMENTS_SUBFOLDER>/<file>` | Vault-rooted; `target_note` is ignored. |
| `caller_specified` | `<subfolder arg>/<file>` | The AI supplies the folder via the `subfolder` argument; `ATTACHMENTS_SUBFOLDER` is ignored. |

A `dest_path` argument overrides the policy entirely (still path-safety validated). Filenames are sanitized (directory components, control chars, and leading dots stripped) before use.

### Configuration (wrangler vars)

All have safe defaults baked into `wrangler.example.jsonc`; edit there (then `npm run setup`) to tune.

| Var | Default | Purpose |
|-----|---------|---------|
| `ATTACHMENTS_PATH_MODE` | `per_note_subfolder` | Path policy (table above). |
| `ATTACHMENTS_SUBFOLDER` | `files` | Subfolder name used by the first two modes. |
| `ATTACHMENT_ALLOWED_EXTENSIONS` | `png,jpg,jpeg,gif,webp,svg,pdf` | CSV allowlist (lowercase). Enforced on upload, read, and delete. Broaden, e.g. `…,docx,xlsx,pptx,txt,csv`. |
| `ATTACHMENT_MAX_BYTES` | `26214400` (25 MiB) | Upload size cap (post-decode and on URL fetch). |
| `ATTACHMENTS_MOVE_WITH_NOTE` | `unique_refs` | `unique_refs`: `move_note` co-moves attachments uniquely embedded by the note. `never`: leave them. |
| `ATTACHMENT_URL_TIMEOUT_MS` | `20000` | Timeout for `upload_attachment_url`. |

### `read_attachment` returns base64 for non-images

Images come back as a renderable MCP `image` block. Everything else (PDFs, office docs) is returned as base64 inside a JSON block, which can be large — call `head_attachment` first to check `size` on uncertain files.

### `move_note` co-moves uniquely-owned attachments

When `ATTACHMENTS_MOVE_WITH_NOTE=unique_refs`, moving a note also relocates attachments that (a) are allowlisted, (b) live nested under the note's own folder, and (c) are referenced by no other note (checked via the existing `vault_wikilinks` index — no full-vault scan). Each attachment's bytes are re-rooted under the destination folder, preserving subfolder structure, and the note's embed is rewritten only when its relative form actually changes. The byte move runs before the note commit, so a skipped/failed attachment move leaves its embed pointing at the still-present original (no broken link). `move_note`'s response gains an `attachments_moved: [{from, to}]` field.

Caveat (same R2-has-no-transactions reality as the note rollback): attachment byte-moves are **not** reversed if the subsequent note commit fails and rolls back. In that rare case the bytes sit at the new location while the restored note still references the old one. Single-user MCP usage rarely hits the rollback path at all.

### URL-fetch security model

`upload_attachment_url` is HTTPS-only and rejects IP-literal, `localhost`, `*.local`, and `*.internal` hosts. Redirects are followed manually (cap 5 hops) with the same host/protocol check re-run on every hop, so the SSRF guard covers the whole chain — not just the initial URL. HTML responses and bodies exceeding `ATTACHMENT_MAX_BYTES` (by `Content-Length` or actual size) are refused. Prefer direct asset URLs (`.png`/`.pdf`/…) over web pages.

## Uploading large images / mobile photos (direct upload endpoint)

There is intentionally **no inline-base64 upload tool**. A tool call carries its arguments as the *model's own output tokens*, so a base64 payload more than a few KB exhausts the model's per-turn output budget and the call truncates mid-stream — the desktop app shows "Couldn't send tool approval" and mobile just hangs. (It's not a transport or tool limit; the chokepoint is the model emitting the parameter.) There's also no binary input channel for MCP tools, and a user-uploaded image reaches the model only as *vision* (it can't faithfully reproduce the bytes), so chunking wouldn't help either. The robust pattern is to move the bytes **out of band**: the Worker exposes an authenticated HTTP upload endpoint the user hits directly from a browser, and Claude just embeds the resulting path.

### Three ways to upload

1. **Claude-minted link (best for mobile).** Ask Claude to upload a photo; it calls `create_upload_link` and prints a tappable URL. Tap it → the upload page opens already authorized, **showing where the file will land** (the server verifies the signed link and renders the destination; the folder fields are hidden since the link fixes placement) → choose/take the file(s) → they land in the vault. Each link is **single-use** and **expires** (default 15 min, max 30): a successful upload consumes it, and opening a spent or expired link shows a "no longer usable — ask Claude for a fresh link" notice. A *failed* upload (e.g. a rejected file) does **not** consume the link, so you can retry it until it succeeds or expires. Two flavors:
   - **Deterministic single-file** — when Claude passes a `filename`, the link returns the exact `dest_path` the file will land at, so Claude can poll `head_attachment`/`read_attachment` on that known path after you say you've uploaded.
   - **Batch** — without a filename, you can pick several files at once; they fill the folder named in the link's `landing_dir`, and Claude finds them via `list_attachments` scoped to that prefix.
2. **Bookmarked web page.** Open `https://<your-host>/upload` in any browser (iOS Safari or desktop). Enter your `UPLOAD_TOKEN` once (saved in the browser); thereafter it's a one-tap uploader. iOS offers Camera / Photo Library directly from the file picker.
3. **iOS Shortcut (share sheet).** A one-action Shortcut → from Photos, Share → upload in two taps. Recipe below.

All three POST to the same `POST /upload` endpoint. **You don't upload twice:** once the file is in the vault, Claude reads it back for OCR/text extraction with `read_attachment` (which returns the image to Claude's vision — a tool *result*, not subject to the output-token budget that makes inline upload impossible). So the loop is: tap the link and upload → tell Claude "done" (or it polls the known path) → Claude reads the image, extracts text, writes the note, embeds the path. Bytes go user→Worker; vision/authoring stays Claude→MCP.

If Claude didn't know the destination note at upload time, it can upload to a guess/holding folder and relocate later with `move_attachment` (server-side, no re-upload) — which also rewrites the embed in every note that already referenced the file, so reordering after the fact is safe.

### Setup

Two one-time steps before the endpoint works:

```bash
npx wrangler secret put UPLOAD_TOKEN     # a long random string; the bearer token + link-signing key
```

and set `SERVICE_BASE_URL` (this Worker's own public origin, e.g. `https://obsv.example.com`) in `wrangler.example.jsonc` → `npm run setup`. In the template it defaults to `https://${MCP_HOSTNAME}`, so it's usually filled automatically. If `UPLOAD_TOKEN` is unset the endpoint returns 503 and `create_upload_link` returns `reason='upload_disabled'`.

### iOS Shortcut recipe

Shortcuts → new shortcut → add **Get Contents of URL**:

- URL: `https://<your-host>/upload`
- Method: **POST**
- Headers: `Authorization` = `Bearer <your UPLOAD_TOKEN>`
- Request Body: **Form**
  - `file` = **Shortcut Input** (the shared photo)
  - optionally `target_note` = a note path

Then in the shortcut's settings enable **Show in Share Sheet** (accept Images). Now Photos → Share → your shortcut uploads in two taps.

### Security model

The endpoint lives on the public (non-OAuth) handler, so every request authenticates:

- **`Authorization: Bearer <UPLOAD_TOKEN>`** — the long-lived secret, for the bookmarked page and the Shortcut.
- **`?t=<signed token>`** — short-lived, single-use links from `create_upload_link`. Tokens are HMAC-signed with `UPLOAD_TOKEN`, carry an expiry + the target note/folder, and their id is tracked in `OAUTH_KV` and deleted on first successful upload — a leaked link can't be replayed and only works briefly.
- **CSRF hardening:** only `multipart/form-data` POSTs are accepted; auth is never read from cookies, so a malicious page can't ride your session.
- **Content sniffing:** the server reads magic bytes and stores the true type — a JPEG misnamed `.png` is corrected to `.jpg`, and a non-image masquerading as an image extension is rejected (`content_mismatch`). The extension allowlist and `ATTACHMENT_MAX_BYTES` are enforced server-side.

## Gotchas

### vitest "No such module ajv/dist/core"

`vitest-pool-workers` loads the wrangler `main` entrypoint to set up bindings. The real `src/index.ts` imports the MCP SDK, whose lazy `ajv` validation provider fails to resolve through workerd's URL-encoded path loader **when the project path contains a space** (e.g. `CLAUDE Projects/`). Workaround: a stub worker at `test/_test-worker.ts` overrides the test-time entrypoint via `main` in `vitest.config.ts`. Production deploys are unaffected because esbuild bundles everything cleanly. Easiest fix on a fresh clone is to put the project in a path without spaces.

### Custom domain deploy fails with "Hostname already has externally managed DNS records"

`custom_domain: true` requires Cloudflare to auto-create the DNS record. If a previous proxied A/AAAA/CNAME exists for the hostname, the deploy fails. Wrangler does not expose `override_existing_dns_record` in `wrangler.jsonc`. Fix: delete the existing DNS record in the dashboard, then redeploy.

### After deleting DNS records, resolution stays broken for up to 30 minutes

The Cloudflare zone's SOA negative TTL is 1800s. Local resolvers and intermediate caches will serve "no such record" for up to that long even after the records are recreated. To force a refresh on macOS: `sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder`. If your machine uses a custom DNS proxy (NextDNS, Cloudflare WARP, AdGuard, etc.), restart that too. As a last resort, point Mac DNS at `1.1.1.1` temporarily.

### Durable Object holds the old code after a tool change deploys

`ObsidianMCP` is a Durable Object; `init()` registers the tool list on the DO's `server` instance the first time the DO spins up. A `wrangler deploy` does **not** evict running DO instances — they continue serving the previous code until they hibernate (no active SSE/WebSocket connections + no inbound requests for ~30–90s). An MCP client reconnect (e.g. Claude Code `/mcp`) re-establishes the transport against the **same DO ID**, which, if still hot, is still serving the pre-deploy code — so newly-registered tools won't appear and renamed tools won't update. Symptoms: tool list is stale, the new tool returns "method not found", or behavior matches the previous version.

Resolution, in order of preference:

1. **Fully disconnect** the MCP server in your client (don't just reconnect — drop the connection so the SSE stream closes). Wait ~60–90s for the DO to hibernate, then reconnect. The next request spins up a fresh DO instance running the just-deployed code.
2. **Force eviction** via the dashboard: **Workers & Pages → obsidian-mcp → Durable Objects → ObsidianMCP**, find the instance and delete it. Safe here — OAuth state lives in `OAUTH_KV`, not in the DO; the DO is transport/session state only.

Same gotcha affects schema changes (renamed tools, changed parameter shapes), not just additions. Doesn't affect non-tool changes that don't depend on `init()` re-running.

If you've done the disconnect-wait-reconnect dance and the new tool **still** isn't visible, the DO refresh probably worked but the client is also caching the tool list — see the next gotcha.

### Claude Code caches the MCP tool list at app start, not on `/mcp` reconnect

The Claude Code CLI's local tool registry (the catalog ToolSearch reads from) is built during the initial MCP handshake when the app launches. The built-in `/mcp` reconnect command refreshes the SSE transport but **does not re-query `tools/list`**, so newly-registered server-side tools never enter the local registry. This is independent of the DO-side gotcha above: even after the server is verifiably serving the new tool, Claude Code will keep reporting the pre-launch tool set until the app is fully restarted.

Symptoms: ToolSearch returns "no matching deferred tools found" for the new tool name; reconnect output reads `Reconnected to <name>` but the tool count is unchanged.

Resolution: **fully quit Claude Code** (not `/mcp` reconnect) and reopen it. Confirm via ToolSearch that the new tool is now in the registry before invoking it.

Other MCP clients have their own behaviors here:
- **Claude.ai web** builds its tool catalog per session; opening a new chat (or refreshing the page once the integration is connected) is *usually* enough. Occasionally the integration record itself caches the catalog and needs to be **disconnected + reconnected** in Settings → Connectors before a new chat will see the new tools.
- **Claude mobile app (iOS / Android)** caches the tool catalog at app launch, same as Claude Code. Opening a new chat is *not* enough — **force-quit and reopen the app** (swipe out of the app switcher, don't just background it). Combined with the connector reconnect above, this guarantees a fresh `tools/list` handshake.
- **MCP Inspector** (`@modelcontextprotocol/inspector`) re-queries on every reconnect.

So a deploy that adds or changes a tool needs to clear *two* caches: the DO instance (server-side) and the client tool registry (mobile app force-quit, Claude Code restart, or Claude.ai connector reconnect).

## Roadmap

Forward-looking design notes — not commitments, but the next obvious things to consider.

### Conditional writes on create / update / append

`R2.put` accepts `onlyIf: { etagMatches }` and `onlyIf: { etagDoesNotExist }`. Wiring these into `createNote` (use `etagDoesNotExist`), `replaceNote` (use the etag returned from a prior read), and `appendToDailyNote` (read-with-etag, retry on mismatch) would close the TOCTOU window described in the Caveats. Single-user usage today makes this dormant; the fix is straightforward when concurrency arrives.

### Incremental DO-SQLite seeding

Open follow-up: incremental seeding via DO alarms when the initial full-vault seed would exceed the per-invocation subrequest cap. Not a problem at current vault sizes; tracked for future growth.

## Configuration files

| File | Committed? | Purpose |
|---|---|---|
| `.env.example` | ✅ | Documents required env vars. |
| `.env` | ❌ (gitignored) | Your filled-in values. Read by `npm run setup`. |
| `wrangler.example.jsonc` | ✅ | Template with `${PLACEHOLDER}` tokens. |
| `wrangler.jsonc` | ❌ (gitignored) | Generated by `npm run setup` from the template + `.env`. Wrangler reads this. |
| `scripts/setup.mjs` | ✅ | Substitutes `.env` values into the wrangler template; idempotently creates the R2 bucket and KV namespace. |
| `.dev.vars` | ❌ (gitignored) | Local dev secrets (e.g. `AUTH_PASSWORD` for `wrangler dev`). |

Re-running `npm run setup` is safe — it overwrites `wrangler.jsonc` from the current `.env` and reuses existing R2/KV resources.

## Source layout

```
src/
├── index.ts            # OAuthProvider wiring; exports ObsidianMCP DO
├── types.ts            # Env augmentation, Props, VaultConfig, ToolResult
├── log.ts              # Structured JSON logging helper
├── auth/
│   ├── consent-page.ts # HTML form
│   └── handler.ts      # GET/POST /authorize
├── mcp/
│   ├── agent.ts        # ObsidianMCP extends McpAgent, registers tools, instrumentation
│   └── tools/
│       ├── notes.ts    # list/read/create/replace/delete/patch (typed-result returns)
│       ├── metadata.ts # parse_frontmatter, list_tags, list_backlinks
│       ├── daily.ts    # daily-note helpers
│       └── admin.ts    # backfill_ids and other maintenance ops
└── vault/
    ├── r2-client.ts    # R2 binding wrapper with prefix + path validation
    ├── markdown.ts     # frontmatter, tag, wikilink parsing (pure)
    ├── concurrency.ts  # mapPool — bounded-parallel R2 fan-out
    └── index-store.ts  # VaultIndex + SqlStore — DO-SQLite-backed search index

test/
├── _test-worker.ts     # stub entrypoint for vitest-pool-workers
├── r2-client.test.ts
├── markdown.test.ts
├── concurrency.test.ts
├── instrument.test.ts
├── index-store.test.ts # VaultIndex via in-memory Store
├── sql-store.test.ts   # SqlStore SQL-LIKE semantics via fake-sqlite emulator
└── tools.test.ts
```

## License

MIT — see [LICENSE](./LICENSE).

## Author

[David Szpunar](https://david.szpunar.com)
