import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Props, ToolResult, VaultConfig } from "../types";
import { R2Client } from "../vault/r2-client";
import { SqlStore, VaultIndex } from "../vault/index-store";
import { listNotes, readNote, createNote, replaceNote, replaceBody, deleteNote, patchNote, moveNote } from "./tools/notes";
import { generatePermalink, parseFrontmatter } from "./tools/metadata";
import { getOrCreateDailyNote, appendToDailyNote } from "./tools/daily";
import { backfillIds } from "./tools/admin";
import { type McpResponse, errResponse, instrument } from "./instrument";

const NotePath = z.string().min(1).regex(/\.md$/i, "path must end with .md");

function okText(text: string): McpResponse {
  return { content: [{ type: "text", text }] };
}

function okJson(value: unknown): McpResponse {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function fromToolResult<T>(r: ToolResult<T>, render: (value: T) => string): McpResponse {
  if (r.ok) return okText(render(r.value));
  const { ok: _ok, reason, ...rest } = r;
  return errResponse(reason, rest);
}

// Multi-block variant — used by read_note to keep the raw note body as the
// primary text block (preserving the pre-0.7.0 client UX) while still
// surfacing the permalink as a second JSON-typed block when enabled.
function fromToolResultBlocks<T>(
  r: ToolResult<T>,
  render: (value: T) => string[],
): McpResponse {
  if (r.ok) {
    return { content: render(r.value).map((text) => ({ type: "text", text })) };
  }
  const { ok: _ok, reason, ...rest } = r;
  return errResponse(reason, rest);
}

export class ObsidianMCP extends McpAgent<Env, never, Props> {
  server = new McpServer({ name: "obsidian-vault", version: "0.7.0" });
  private _index?: VaultIndex;

  private get vault(): R2Client {
    return new R2Client(this.env.VAULT, this.cfg);
  }

  private get cfg(): VaultConfig {
    return {
      prefix: this.env.VAULT_PREFIX,
      dailyNotePathTemplate: this.env.DAILY_NOTE_PATH_TEMPLATE,
      permalinkBaseUrl: this.env.PERMALINK_BASE_URL ?? "",
    };
  }

  private get index(): VaultIndex {
    if (!this._index) {
      const sqlTag = ((strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) =>
        this.sql(strings, ...values)) as unknown as ConstructorParameters<typeof SqlStore>[0];
      this._index = new VaultIndex(new SqlStore(sqlTag), this.vault);
      this._index.init();
    }
    return this._index;
  }

  async init() {
    // Touch the index getter so schema migrations run on every DO wake.
    void this.index;

    this.server.tool(
      "list_notes",
      "List every markdown note in the vault. Returns an array of vault-relative paths.",
      {},
      async () =>
        instrument("list_notes", async () => okJson(await listNotes(this.vault, this.cfg))),
    );

    this.server.tool(
      "read_note",
      "Read the full contents of a single markdown note. The note body is returned as the first text block (raw markdown). When PERMALINK_BASE_URL is configured, a second text block follows containing JSON `{permalink}` — the short HTTP URL that resolves into Obsidian via the link-resolver Worker. Clients that only inspect content[0] still get the raw body unchanged.",
      { path: NotePath },
      async ({ path }) =>
        instrument("read_note", async () =>
          fromToolResultBlocks(await readNote(this.vault, this.cfg, { path }), (v) =>
            v.permalink ? [v.content, JSON.stringify({ permalink: v.permalink })] : [v.content],
          ),
        ),
    );

    this.server.tool(
      "search_notes",
      "Case-insensitive substring search across every note. Matches against either the note body OR the note's file path, so 'kevin' will find both `Notes about Kevin.md` (body match) and `People/Kevin Meeting.md` (filename-only match). Returns matching paths with short snippets around the first body-match position; filename-only matches return a generic body-prefix snippet — the `path` field itself is the signal for why the note matched. Backed by an incrementally-synced DO-SQLite index — typical calls run in single-digit milliseconds.",
      { query: z.string().min(1), limit: z.number().int().positive().max(200).optional() },
      async ({ query, limit }) =>
        instrument("search_notes", async () => okJson(await this.index.search(query, limit ?? 50))),
    );

    this.server.tool(
      "create_note",
      "Create a new markdown note. Returns JSON `{path, etag, permalink}` on success (permalink is null if PERMALINK_BASE_URL is unset). Fails with reason='exists' if a note already exists at this path.",
      { path: NotePath, content: z.string() },
      async (args) =>
        instrument("create_note", async () => {
          const r = await createNote(this.vault, this.cfg, args);
          if (r.ok) this.index.upsertFromContent(r.value.path, r.value.content, r.value.etag);
          return fromToolResult(r, (v) =>
            JSON.stringify({ path: v.path, etag: v.etag, permalink: v.permalink }),
          );
        }),
    );

    this.server.tool(
      "replace_note",
      "Full overwrite of a note — replaces everything including frontmatter, EXCEPT the note's `id:` field, which is always preserved from the existing note (or freshly minted if absent). External links keyed on the id stay stable across full-content rewrites. Returns JSON `{path, etag, permalink}` on success. Use only when authoring the entire file content, including the YAML frontmatter block. For body-only edits that preserve frontmatter, use replace_body. For targeted edits to specific lines, use patch_note. Fails with reason='not_found' if the note does not exist, reason='malformed_frontmatter' if the SUPPLIED content has an unterminated `---` opener (an unterminated frontmatter in the existing note is salvaged — a fresh id is minted on top).",
      { path: NotePath, content: z.string() },
      async (args) =>
        instrument("replace_note", async () => {
          const r = await replaceNote(this.vault, this.cfg, args);
          if (r.ok) this.index.upsertFromContent(r.value.path, r.value.content, r.value.etag);
          return fromToolResult(r, (v) =>
            JSON.stringify({ path: v.path, etag: v.etag, permalink: v.permalink }),
          );
        }),
    );

    this.server.tool(
      "replace_body",
      "Replaces the body of a note (everything after the closing --- of the frontmatter) while preserving the existing frontmatter exactly. Returns JSON `{path, etag, permalink}` on success. Use when rewriting note content but keeping the note's identity, metadata, tags, and timestamps. For targeted edits to specific lines, prefer patch_note. For full overwrite including frontmatter, use replace_note. Fails with reason='not_found' if the note does not exist, reason='malformed_frontmatter' if the existing frontmatter is unterminated.",
      { path: NotePath, body: z.string() },
      async (args) =>
        instrument("replace_body", async () => {
          const r = await replaceBody(this.vault, this.cfg, args);
          if (r.ok) this.index.upsertFromContent(r.value.path, r.value.content, r.value.etag);
          return fromToolResult(r, (v) =>
            JSON.stringify({ path: v.path, etag: v.etag, permalink: v.permalink }),
          );
        }),
    );

    this.server.tool(
      "patch_note",
      "Replace an anchor string within an existing note while preserving everything else. Returns JSON `{path, etag, count, permalink}` on success. Fails with reason='anchor_not_found' (anchor missing), 'ambiguous' (anchor appears multiple times — pass replace_all=true to replace all), or 'no_op' (old_str equals new_str). Use this for surgical edits.",
      {
        path: NotePath,
        old_str: z.string().min(1),
        new_str: z.string(),
        replace_all: z.boolean().optional(),
      },
      async (args) =>
        instrument("patch_note", async () => {
          const r = await patchNote(this.vault, this.cfg, args);
          if (r.ok) this.index.upsertFromContent(r.value.path, r.value.content, r.value.etag);
          return fromToolResult(r, (v) =>
            JSON.stringify({
              path: v.path,
              etag: v.etag,
              count: v.count,
              permalink: v.permalink,
            }),
          );
        }),
    );

    this.server.tool(
      "move_note",
      "Move or rename a note. Updates all wikilinks across the vault that pointed to the old path, preserving aliases, heading anchors, and block references. Best-effort atomic — the move and link updates apply together, with reverse-order rollback if any step fails (R2 has no transactional API, so a crash mid-rollback can still leave partial state). Wikilinks inside fenced code blocks and inline code spans are not rewritten. Fails with reason='not_found' if from_path doesn't exist, reason='exists' if to_path already exists, reason='same_path' if from_path equals to_path.",
      { from_path: NotePath, to_path: NotePath },
      async (args) =>
        instrument("move_note", async () => {
          const r = await moveNote(this.vault, this.cfg, this.index, args);
          if (r.ok) {
            this.index.delete(r.value.from);
            this.index.upsertFromContent(
              r.value.moved.path,
              r.value.moved.content,
              r.value.moved.etag,
            );
            for (const n of r.value.notes_modified) {
              this.index.upsertFromContent(n.path, n.content, n.etag);
            }
          }
          return fromToolResult(r, (v) =>
            JSON.stringify({
              moved: true,
              from: v.from,
              to: v.to,
              links_updated: v.links_updated,
              notes_modified: v.notes_modified.map((n) => n.path),
            }),
          );
        }),
    );

    this.server.tool(
      "delete_note",
      "Delete a note. Idempotent: succeeds even if the note does not exist.",
      { path: NotePath },
      async (args) =>
        instrument("delete_note", async () => {
          await deleteNote(this.vault, this.cfg, args);
          this.index.delete(args.path);
          return okText(`deleted ${args.path}`);
        }),
    );

    this.server.tool(
      "parse_frontmatter",
      "Return the parsed YAML frontmatter of a note as an object, plus a `permalink` field (the short HTTP URL that resolves into Obsidian, null when PERMALINK_BASE_URL is unset). Response shape: `{frontmatter, permalink}`. Fails with reason='not_found' if the note does not exist.",
      { path: NotePath },
      async (args) =>
        instrument("parse_frontmatter", async () =>
          fromToolResult(await parseFrontmatter(this.vault, this.cfg, args), (v) =>
            JSON.stringify({ frontmatter: v.frontmatter, permalink: v.permalink }),
          ),
        ),
    );

    this.server.tool(
      "generate_permalink",
      "Build a short HTTP permalink for a note. The URL routes through the link-resolver Worker (configured via PERMALINK_BASE_URL) and 302-redirects into Obsidian. Returns JSON `{path, permalink, kind}` where kind is 'id' (rename-stable, resolved by frontmatter id) or 'path' (fallback for notes without an id — breaks on rename, run backfill_ids to upgrade). Fails with reason='not_found' if the note does not exist, reason='permalink_disabled' if PERMALINK_BASE_URL is unset.",
      { path: NotePath },
      async (args) =>
        instrument("generate_permalink", async () =>
          fromToolResult(await generatePermalink(this.vault, this.cfg, args), (v) =>
            JSON.stringify(v),
          ),
        ),
    );

    this.server.tool(
      "list_tags",
      "List every unique tag across the vault, drawn from both YAML frontmatter and #inline tags in note bodies. Backed by an incrementally-synced DO-SQLite index.",
      {},
      async () => instrument("list_tags", async () => okJson(await this.index.listTags())),
    );

    this.server.tool(
      "list_backlinks",
      "Find every note containing a wikilink to the given target (matched against the target name, ignoring aliases and headings). Backed by an incrementally-synced DO-SQLite index.",
      { target: z.string().min(1) },
      async (args) =>
        instrument("list_backlinks", async () =>
          okJson(await this.index.listBacklinks(args.target)),
        ),
    );

    this.server.tool(
      "get_or_create_daily_note",
      "Look up today's daily note (or the supplied YYYY-MM-DD date), creating it from the template if it does not yet exist.",
      { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
      async (args) =>
        instrument("get_or_create_daily_note", async () => {
          const r = await getOrCreateDailyNote(this.vault, this.cfg, args);
          if (r.created && r.etag !== null && r.content !== null) {
            this.index.upsertFromContent(r.path, r.content, r.etag);
          }
          return okJson({ path: r.path, created: r.created });
        }),
    );

    this.server.tool(
      "append_to_daily_note",
      "Append a block of text to today's daily note (or the supplied date), creating it if it does not exist. A newline boundary is inserted automatically if needed.",
      { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), content: z.string().min(1) },
      async (args) =>
        instrument("append_to_daily_note", async () => {
          const r = await appendToDailyNote(this.vault, this.cfg, args);
          this.index.upsertFromContent(r.path, r.content, r.etag);
          return okJson({ path: r.path });
        }),
    );

    this.server.tool(
      "backfill_ids",
      "Scan the vault and add a stable nanoid `id:` to the frontmatter of any note missing one. Default is dry-run (no writes) — pass dryRun=false to actually persist. `limit` caps how many notes are inspected. `prefix` (e.g. 'Daily Notes/') restricts the scan to one folder for smoke-testing. Notes that already have an `id` are skipped. Returns counts, up to 10 examples of newly-minted (path, id), and up to 20 malformed-frontmatter paths for follow-up. Designed to be re-runnable safely.",
      {
        dryRun: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        prefix: z.string().optional(),
      },
      async (args) =>
        instrument("backfill_ids", async () => {
          const r = await backfillIds(this.vault, this.cfg, args, (path, content, etag) => {
            this.index.upsertFromContent(path, content, etag);
          });
          return fromToolResult(r, (v) => JSON.stringify(v));
        }),
    );
  }
}
