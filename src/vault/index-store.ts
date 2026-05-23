import { extractTags, extractWikilinks } from "./markdown";
import { mapPool } from "./concurrency";
import { log } from "../log";
import type { R2Client } from "./r2-client";

export interface SearchHit {
  path: string;
  snippet: string;
}

export interface NoteRow {
  path: string;
  etag: string;
  body: string;
  tags: string[];
  wikilinks: string[];
}

export interface Store {
  init(): void;
  /** Path → etag of every indexed note. */
  getEtags(): Map<string, string>;
  upsert(row: NoteRow): void;
  delete(path: string): void;
  search(queryLower: string, limit: number): { path: string; body: string }[];
  tags(): string[];
  backlinks(target: string): string[];
  /**
   * Find every note that has a wikilink whose stored target could resolve
   * to `fromPath`. Matches direct target equality against the bare basename,
   * the full path without extension, or the full path with `.md`, plus a
   * LIKE-suffix match for any partial-path reference ending in `/{basename}`.
   * The caller is responsible for the precise per-file resolution check
   * (regex rewriter) since the index does not distinguish ambiguous targets.
   */
  findReferrers(fromPath: string, fromBasename: string, fromPathNoExt: string): string[];
}

type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

/**
 * Escape SQL LIKE meta-characters so substring search treats user input
 * literally. Without this, a query containing `%` or `_` would silently
 * widen the match (a query of `_drafts` would match `Xdrafts`).
 */
export function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
}

export class SqlStore implements Store {
  constructor(private sql: SqlTag) {}

  init(): void {
    this.sql`CREATE TABLE IF NOT EXISTS vault_notes (
      path TEXT PRIMARY KEY,
      etag TEXT NOT NULL,
      body TEXT NOT NULL,
      body_lower TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS vault_tags (
      path TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (path, tag)
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_vault_tags_tag ON vault_tags(tag)`;
    this.sql`CREATE TABLE IF NOT EXISTS vault_wikilinks (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      PRIMARY KEY (source, target)
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_vault_wikilinks_target ON vault_wikilinks(target)`;
  }

  getEtags(): Map<string, string> {
    const rows = this.sql<{ path: string; etag: string }>`SELECT path, etag FROM vault_notes`;
    return new Map(rows.map((r) => [r.path, r.etag]));
  }

  upsert(row: NoteRow): void {
    this.sql`INSERT OR REPLACE INTO vault_notes (path, etag, body, body_lower)
      VALUES (${row.path}, ${row.etag}, ${row.body}, ${row.body.toLowerCase()})`;
    this.sql`DELETE FROM vault_tags WHERE path = ${row.path}`;
    for (const tag of row.tags) {
      this.sql`INSERT OR IGNORE INTO vault_tags (path, tag) VALUES (${row.path}, ${tag})`;
    }
    this.sql`DELETE FROM vault_wikilinks WHERE source = ${row.path}`;
    for (const w of row.wikilinks) {
      this.sql`INSERT OR IGNORE INTO vault_wikilinks (source, target) VALUES (${row.path}, ${w})`;
    }
  }

  delete(path: string): void {
    this.sql`DELETE FROM vault_notes WHERE path = ${path}`;
    this.sql`DELETE FROM vault_tags WHERE path = ${path}`;
    this.sql`DELETE FROM vault_wikilinks WHERE source = ${path}`;
  }

  search(queryLower: string, limit: number): { path: string; body: string }[] {
    const pattern = "%" + escapeLikePattern(queryLower) + "%";
    return this.sql<{ path: string; body: string }>`SELECT path, body FROM vault_notes
      WHERE body_lower LIKE ${pattern} ESCAPE '\\'
         OR LOWER(path) LIKE ${pattern} ESCAPE '\\'
      LIMIT ${limit}`;
  }

  tags(): string[] {
    return this.sql<{ tag: string }>`SELECT DISTINCT tag FROM vault_tags ORDER BY tag`.map((r) => r.tag);
  }

  backlinks(target: string): string[] {
    return this.sql<{ source: string }>`SELECT DISTINCT source FROM vault_wikilinks
      WHERE target = ${target} ORDER BY source`.map((r) => r.source);
  }

  findReferrers(fromPath: string, fromBasename: string, fromPathNoExt: string): string[] {
    const suffix = "%/" + escapeLikePattern(fromBasename);
    return this.sql<{ source: string }>`SELECT DISTINCT source FROM vault_wikilinks
      WHERE target = ${fromBasename}
         OR target = ${fromPathNoExt}
         OR target = ${fromPath}
         OR target LIKE ${suffix} ESCAPE '\\'
      ORDER BY source`.map((r) => r.source);
  }
}

export class VaultIndex {
  private static SYNC_CONCURRENCY = 25;

  constructor(private store: Store, private vault: R2Client) {}

  init(): void {
    this.store.init();
  }

  /**
   * Bring the index up to date with R2. Cheap when nothing has changed
   * (one R2 LIST). On startup or after external writes (Remotely Save
   * syncing in fresh notes from Obsidian) it fetches and indexes only
   * the changed bodies. Must be called before every indexed read.
   */
  async ensureFresh(): Promise<void> {
    const started = Date.now();
    const r2 = await this.vault.listMarkdownWithMeta();
    const r2Map = new Map(r2.map((o) => [o.path, o.etag]));
    const indexMap = this.store.getEtags();

    const toFetch: string[] = [];
    for (const [path, etag] of r2Map) {
      if (indexMap.get(path) !== etag) toFetch.push(path);
    }
    const toDelete: string[] = [];
    for (const path of indexMap.keys()) {
      if (!r2Map.has(path)) toDelete.push(path);
    }

    if (toFetch.length === 0 && toDelete.length === 0) {
      log.debug("index_sync_noop", { indexed: indexMap.size, durationMs: Date.now() - started });
      return;
    }

    const fetched = await mapPool(toFetch, VaultIndex.SYNC_CONCURRENCY, async (p) => ({
      path: p,
      body: await this.vault.get(p),
    }));

    let upserted = 0;
    for (const { path, body } of fetched) {
      if (body === null) continue;
      this.upsertFromContent(path, body, r2Map.get(path)!);
      upserted++;
    }
    for (const p of toDelete) {
      this.store.delete(p);
    }

    log.info("index_sync", {
      upserted,
      deleted: toDelete.length,
      durationMs: Date.now() - started,
    });
  }

  /** Write-through update after a successful R2 put. */
  upsertFromContent(path: string, body: string, etag: string): void {
    this.store.upsert({
      path,
      etag,
      body,
      tags: extractTags(body),
      wikilinks: extractWikilinks(body),
    });
  }

  /** Write-through deletion after a successful R2 delete. */
  delete(path: string): void {
    this.store.delete(path);
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const q = query.toLowerCase();
    if (!q) return [];
    await this.ensureFresh();
    const rows = this.store.search(q, limit);
    return rows.map(({ path, body }) => ({ path, snippet: makeSnippet(body, query) }));
  }

  async listTags(): Promise<string[]> {
    await this.ensureFresh();
    return this.store.tags();
  }

  async listBacklinks(target: string): Promise<string[]> {
    await this.ensureFresh();
    return this.store.backlinks(target);
  }

  /**
   * Find candidate referring notes for a move. Returns paths whose stored
   * wikilink targets *could* resolve to `fromPath` — by bare basename,
   * full path, or path-form ending in the basename. The move tool runs
   * the precise rewriter on each candidate to do the final resolution
   * check, so a few extra candidates here are harmless.
   */
  async findReferrersFor(fromPath: string): Promise<string[]> {
    await this.ensureFresh();
    const pathNoExt = fromPath.replace(/\.md$/i, "");
    const slash = pathNoExt.lastIndexOf("/");
    const basename = slash === -1 ? pathNoExt : pathNoExt.slice(slash + 1);
    return this.store.findReferrers(fromPath, basename, pathNoExt);
  }
}

function makeSnippet(body: string, query: string): string {
  const i = body.toLowerCase().indexOf(query.toLowerCase());
  if (i === -1) return body.slice(0, 120);
  const start = Math.max(0, i - 60);
  const end = Math.min(body.length, i + query.length + 60);
  return (
    (start > 0 ? "…" : "") +
    body.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < body.length ? "…" : "")
  );
}
