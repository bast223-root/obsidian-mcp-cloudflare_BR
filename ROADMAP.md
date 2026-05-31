# ROADMAP

Forward-looking work that is understood but not built. Each item records the
decision context so a future session can pick it up without re-deriving it.

---

## Substring search beyond the 50-byte LIKE limit

**Status:** option 1 (cap + typed error) is **implemented**; options 2 and 3 are
deferred until long-substring search is actually needed.

### Background

Cloudflare's Durable-Object SQLite (and D1) caps a `LIKE`/`GLOB` *pattern* at
**50 bytes** — documented at
<https://developers.cloudflare.com/durable-objects/platform/limits/> ("Maximum
characters (bytes) in a LIKE or GLOB pattern — 50 bytes"). Stock SQLite's default
is 50,000; Cloudflare lowered it ~1000× as a shared-tenant DoS guardrail. The
runtime surfaces the misleadingly-named error `LIKE or GLOB pattern too complex:
SQLITE_ERROR` — it is purely a *length* check, not wildcard complexity, and it
cannot be raised at runtime.

`search_notes` runs `body_lower LIKE '%' || query || '%'`, so the pattern is
`query length + 2`. Any search query over ~48 bytes throws. The same limit was
the root cause of the `move_attachment` embed-rewrite bug (`findReferrers` built
`target LIKE '%/' || basename`), now fixed by switching that lookup to an indexed
equality column (`target_tail`) — see CHANGELOG.

### Option 1 — cap query length, typed error (IMPLEMENTED)

`VaultIndex.search` rejects any query whose compiled `%…%` pattern exceeds 50
bytes with a typed `query_too_long` result instead of a raw `SQLITE_ERROR`.

- **Pro:** one small change; turns an internal 500-shaped failure into a clean,
  documented tool contract; zero schema/index cost.
- **Con:** the limit still exists — you simply cannot substring-search for a
  string longer than ~48 bytes. For a personal vault this is rarely hit (most
  searches are a word or short phrase), which is why it is the chosen default.

### Option 2 — FTS5 full-text index

Replace the `%query%` scan with a SQLite FTS5 virtual table and `MATCH`.

- **Pro:** escapes the 50-byte limit entirely (`MATCH` is not a LIKE pattern);
  faster on large vaults (inverted index, not a full table scan); supports
  ranking (`bm25`) and multi-term queries for free.
- **Con:** **changes the matching model** from arbitrary-substring to
  *token*-based. `MATCH 'security'` matches the word "security" but not the
  middle of "cyber**security**". Prefix matching needs `security*`; true
  substring needs the FTS5 **trigram** tokenizer (larger index, 3-char minimum).
  Also a schema addition (FTS5 table + triggers or manual sync on upsert/delete)
  and a one-time rebuild. Confirm FTS5 (and the trigram tokenizer, if used) is
  compiled into workerd's SQLite before committing to this — verify, don't
  assume.
- **When to pick:** vault grows large enough that scan latency matters, or
  word/prefix/ranked search is desirable in its own right.

### Option 3 — coarse LIKE prefix + in-app substring filter

Keep exact-substring semantics with no length ceiling. Use the first ≤48 bytes of
the (escaped) query as a `LIKE '%prefix%'` to fetch candidate rows index-side,
then apply `body_lower.includes(fullQuery)` in JavaScript to drop false
positives. For queries already under the limit it behaves exactly like today —
the in-app filter is a no-op — so it degrades gracefully: short queries take the
fast path, only long queries pay the over-fetch.

- **Pro:** preserves precise substring matching for arbitrarily long queries;
  no schema change; no new SQLite feature dependency.
- **Con:** the prefix must be selective or the candidate set balloons (worst
  case: a long query whose first 48 bytes are common fetches many rows to filter
  in JS). Acceptable for limited/occasional long queries; not a substitute for
  FTS5 at scale.
- **When to pick:** long-substring search becomes a real need but FTS5's
  token-based semantics are unacceptable, and query volume stays low. With the
  `findReferrers` fix already in place for exact-name lookups, there is no need
  to build this speculatively.

---

## Obsidian R2 Freshness Trigger — push-driven "pull now"

**Status:** architecture settled, not built. Full design lives in the vault note
`Automation/Projects/obsidian-r2-freshness-trigger-plugin.md`
(<https://o.dszp.app/n/e15_5VmatY1hxuBBGvePH>). Summary below; consult the note
for the load-bearing details before building.

### Goal

Shrink the latency between "a note changed in R2" and "Obsidian on my devices
reflects it" from the current Remotely Save interval (5–10 min) to ~1–2 s on
desktop and "within seconds of foregrounding" on iOS — **without** writing a sync
engine and **without** blind-polling R2.

### The one separation that makes it safe

**Freshness is a signal problem, not a sync problem.** Bidirectional
reconciliation, conflict handling, and delete tracking — the hard, dangerous part
— stay inside Remotely Save. This project builds only the *trigger*: learn that
R2 changed, then fire Remotely Save's existing "sync now" command
(`executeCommandById("remotely-save:start-sync")` — verify the slug live).
Conflating the two is what would turn a weekend plugin into a multi-month
liability.

### Settled architecture

One Cloudflare Worker + one **hibernatable** Durable Object ("Fanout") holding
device WebSocket connections and a `lastChange` timestamp. Endpoints: `/connect`
(WS upgrade), `/notify` (privileged POST — bump ts + broadcast), `/last` (cheap
ts read for iOS catch-up).

- **Desktop (Electron):** persistent authenticated WebSocket; on `changed`, fire
  the sync command. Near-instant.
- **iOS:** **persistent push is impossible** — an Obsidian plugin runs as JS in a
  `WKWebView`, so no APNs, no background fetch; iOS tears down the socket seconds
  after backgrounding. Foreground-only: on `visibilitychange→visible` and a light
  foreground interval, GET `/last` and sync if newer. Do not re-introduce
  "WebSocket everywhere" — this constraint invalidated it.
- **The plugin contains no sync, diff, conflict, or file I/O logic** — a
  connection/poll manager plus one `executeCommandById` call. That is the whole
  point and what keeps it first-plugin-sized.

### Coupling to this MCP server

The MCP Worker mutates R2 directly and therefore *knows* when a change happened —
its write path is the natural first caller of `/notify`. Start there to prove the
path, then add **R2 Event Notifications → Queue → consumer → `/notify`** for full
coverage (desktop Remotely Save pushes, other devices, manual `wrangler`/rclone
drops). The events leg **requires dedup/debounce** (one logical save emits many
object-create events) and a **feedback-loop check** (a notify→pull must not
re-trigger a push→notify storm — verify empirically, add a content-hash guard if
it doesn't damp).

### Security model

Two credentials, two jobs: a **low-privilege device token** for `/connect` +
`/last` (blast radius if leaked: trigger a pull, read a timestamp), and a
**privileged credential** for `/notify` only, held server-side, never on a
device. Secrets in a mobile plugin are not secret — design the device token to be
inherently low-privilege so that's acceptable. Reuse neither for, nor derive
either from, Remotely Save's full R2 credentials.

### Build order

1. Prove the trigger (desktop command that fires the sync; confirm the command
   slug live).
2. Backend Worker + hibernatable DO (`/connect`, `/notify`, `/last`); wire this
   MCP Worker to POST `/notify` after each R2 write.
3. Desktop WebSocket push (heartbeat, backoff, reconnect on `online` /
   `visibilitychange`).
4. iOS degraded mode (foreground poll + catch-up; side-load via BRAT; verify
   socket-death timing with Safari Web Inspector).
5. Full coverage via R2 event notifications → Queue → `/notify`, with
   dedup/debounce; verify the feedback loop damps.
