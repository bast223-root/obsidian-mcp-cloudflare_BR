import { describe, expect, it } from "vitest";
import { SqlStore, escapeLikePattern, type NoteRow } from "../src/vault/index-store";

/**
 * Minimal SQLite-tag emulator backed by JS Maps. Implements only the
 * subset of SQL that SqlStore actually uses, so SqlStore's exact LIKE
 * semantics (with the `\` escape) can be verified without pulling in
 * better-sqlite3.
 */
type Row = Record<string, string | number | boolean | null>;
class FakeSqlite {
  notes = new Map<string, Row>();
  tags = new Set<string>();
  wikilinks = new Set<string>();

  tag: <T = Row>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => T[] = ((
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    return this.run(sql, values);
  }) as never;

  private run(sql: string, params: (string | number | boolean | null)[]): Row[] {
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE INDEX")) return [];
    if (sql.startsWith("INSERT OR REPLACE INTO vault_notes")) {
      const [path, etag, body, body_lower] = params as string[];
      this.notes.set(path, { path, etag, body, body_lower });
      return [];
    }
    if (sql.startsWith("DELETE FROM vault_tags WHERE path = ?")) {
      const [p] = params as string[];
      for (const k of this.tags) if (k.startsWith(p + "\t")) this.tags.delete(k);
      return [];
    }
    if (sql.startsWith("INSERT OR IGNORE INTO vault_tags")) {
      const [path, tag] = params as string[];
      this.tags.add(`${path}\t${tag}`);
      return [];
    }
    if (sql.startsWith("DELETE FROM vault_wikilinks WHERE source = ?")) {
      const [p] = params as string[];
      for (const k of this.wikilinks) if (k.startsWith(p + "\t")) this.wikilinks.delete(k);
      return [];
    }
    if (sql.startsWith("INSERT OR IGNORE INTO vault_wikilinks")) {
      const [source, target] = params as string[];
      this.wikilinks.add(`${source}\t${target}`);
      return [];
    }
    if (sql.startsWith("DELETE FROM vault_notes WHERE path = ?")) {
      const [p] = params as string[];
      this.notes.delete(p);
      return [];
    }
    if (sql.startsWith("SELECT path, etag FROM vault_notes")) {
      return [...this.notes.values()].map((r) => ({ path: r.path, etag: r.etag }));
    }
    if (sql.startsWith("SELECT path, body FROM vault_notes WHERE body_lower LIKE ? ESCAPE")) {
      const [bodyPattern, pathPattern, limit] = params as [string, string, number];
      const bodyRx = likeToRegex(bodyPattern, "\\");
      const pathRx = likeToRegex(pathPattern, "\\");
      const out: Row[] = [];
      for (const r of this.notes.values()) {
        if (out.length >= limit) break;
        if (
          bodyRx.test(String(r.body_lower)) ||
          pathRx.test(String(r.path).toLowerCase())
        ) {
          out.push({ path: r.path, body: r.body });
        }
      }
      return out;
    }
    if (sql.startsWith("SELECT DISTINCT tag FROM vault_tags")) {
      const found = new Set<string>();
      for (const k of this.tags) found.add(k.split("\t")[1]);
      return [...found].sort().map((t) => ({ tag: t }));
    }
    if (sql.startsWith("SELECT DISTINCT source FROM vault_wikilinks WHERE target = ?")) {
      const [target] = params as string[];
      const sources = new Set<string>();
      for (const k of this.wikilinks) {
        const [s, t] = k.split("\t");
        if (t === target) sources.add(s);
      }
      return [...sources].sort().map((s) => ({ source: s }));
    }
    throw new Error(`FakeSqlite: unrecognized SQL: ${sql}`);
  }
}

function likeToRegex(pattern: string, esc: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === esc && i + 1 < pattern.length) {
      out += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 2;
      continue;
    }
    if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp("^" + out + "$");
}

describe("escapeLikePattern", () => {
  it("escapes percent, underscore, and backslash", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("_drafts")).toBe("\\_drafts");
    expect(escapeLikePattern("path\\sub")).toBe("path\\\\sub");
  });

  it("leaves plain text untouched", () => {
    expect(escapeLikePattern("hello world")).toBe("hello world");
  });
});

describe("SqlStore", () => {
  function newStore() {
    const db = new FakeSqlite();
    const store = new SqlStore(db.tag);
    store.init();
    return { db, store };
  }

  function makeRow(path: string, body: string, tags: string[] = [], wikilinks: string[] = []): NoteRow {
    return { path, body, tags, wikilinks, etag: `etag-${path}` };
  }

  it("upserts and round-trips rows via getEtags", () => {
    const { store } = newStore();
    store.upsert(makeRow("a.md", "body a", ["alpha"], []));
    store.upsert(makeRow("b.md", "body b", [], ["B"]));
    expect(store.getEtags()).toEqual(new Map([["a.md", "etag-a.md"], ["b.md", "etag-b.md"]]));
  });

  it("treats SQL LIKE meta-characters literally in search queries", () => {
    const { store } = newStore();
    store.upsert(makeRow("a.md", "this is 100% done", []));
    store.upsert(makeRow("b.md", "this is xdone", []));
    store.upsert(makeRow("c.md", "no match here", []));

    const hits = store.search("100%", 50);
    expect(hits.map((h) => h.path)).toEqual(["a.md"]);
  });

  it("treats SQL LIKE underscore as a literal character, not a single-char wildcard", () => {
    const { store } = newStore();
    store.upsert(makeRow("a.md", "field _name is special", []));
    store.upsert(makeRow("b.md", "field xname not", []));

    const hits = store.search("_name", 50);
    expect(hits.map((h) => h.path)).toEqual(["a.md"]);
  });

  it("search matches the file path (case-insensitive) in addition to the body", () => {
    const { store } = newStore();
    store.upsert(makeRow("People/Kevin Meeting.md", "agenda for next sprint", []));
    store.upsert(makeRow("daily/2026-05-12.md", "no name match in body", []));

    // 'kevin' is only in the filename of the first row.
    expect(store.search("kevin", 50).map((h) => h.path)).toEqual(["People/Kevin Meeting.md"]);
    // Path matching is case-insensitive (queryLower is already lowered by caller).
  });

  it("tags and backlinks return deduplicated sorted results", () => {
    const { store } = newStore();
    store.upsert(makeRow("a.md", "x", ["alpha", "beta"], ["T1"]));
    store.upsert(makeRow("b.md", "x", ["beta", "gamma"], ["T1"]));
    expect(store.tags()).toEqual(["alpha", "beta", "gamma"]);
    expect(store.backlinks("T1")).toEqual(["a.md", "b.md"]);
  });

  it("delete removes notes, tags, and wikilinks for that path", () => {
    const { store } = newStore();
    store.upsert(makeRow("a.md", "x", ["alpha"], ["T1"]));
    store.upsert(makeRow("b.md", "x", ["alpha"], ["T1"]));
    store.delete("a.md");
    expect(store.getEtags().has("a.md")).toBe(false);
    expect(store.tags()).toEqual(["alpha"]);
    expect(store.backlinks("T1")).toEqual(["b.md"]);
  });
});
