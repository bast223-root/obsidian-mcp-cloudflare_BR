import { describe, expect, it } from "vitest";
import {
  MAX_LIKE_PATTERN_BYTES,
  SqlStore,
  escapeLikePattern,
  linkTail,
  searchPatternBytes,
  type NoteRow,
} from "../src/vault/index-store";

/**
 * Minimal SQLite-tag emulator backed by JS Maps. Implements only the
 * subset of SQL that SqlStore actually uses, so SqlStore's exact LIKE
 * semantics (with the `\` escape) can be verified without pulling in
 * better-sqlite3.
 *
 * It also enforces Cloudflare DO-SQLite's 50-byte LIKE/GLOB pattern limit
 * (throwing the same "pattern too complex" error the real runtime does), so a
 * query that builds an over-long pattern fails here exactly as it would in
 * production — this is what makes the findReferrers / search tests real
 * regression oracles rather than green-by-construction.
 */
type Row = Record<string, string | number | boolean | null>;
type WikilinkRow = { source: string; target: string; target_tail: string };
class FakeSqlite {
  notes = new Map<string, Row>();
  tags = new Set<string>();
  // Keyed by `source\ttarget` (the table's primary key).
  wikilinks = new Map<string, WikilinkRow>();
  // Simulate a DO created before the target_tail column existed. When false,
  // PRAGMA omits the column until SqlStore.migrate() runs ALTER TABLE.
  hasTailColumn: boolean;
  alterCount = 0;

  constructor(opts: { legacy?: boolean } = {}) {
    this.hasTailColumn = !opts.legacy;
  }

  tag: <T = Row>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => T[] = ((
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    return this.run(sql, values);
  }) as never;

  /** Reject a LIKE/GLOB pattern over the 50-byte DO-SQLite limit, mirroring the
   * real runtime's error so over-long patterns fail in tests too. */
  private assertPatternFits(pattern: string): void {
    if (new TextEncoder().encode(pattern).length > MAX_LIKE_PATTERN_BYTES) {
      throw new Error("LIKE or GLOB pattern too complex: SQLITE_ERROR");
    }
  }

  private run(sql: string, params: (string | number | boolean | null)[]): Row[] {
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE INDEX")) return [];
    if (sql.startsWith("PRAGMA table_info(vault_wikilinks)")) {
      const cols = ["source", "target"];
      if (this.hasTailColumn) cols.push("target_tail");
      return cols.map((name) => ({ name }));
    }
    if (sql.startsWith("ALTER TABLE vault_wikilinks ADD COLUMN target_tail")) {
      this.alterCount++;
      this.hasTailColumn = true;
      return [];
    }
    if (sql.startsWith("UPDATE vault_wikilinks SET target_tail = ?")) {
      const [tail, source, target] = params as string[];
      const row = this.wikilinks.get(`${source}\t${target}`);
      if (row) row.target_tail = tail;
      return [];
    }
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
      for (const k of this.wikilinks.keys()) if (k.startsWith(p + "\t")) this.wikilinks.delete(k);
      return [];
    }
    if (sql.startsWith("INSERT OR IGNORE INTO vault_wikilinks")) {
      const [source, target, target_tail] = params as string[];
      const key = `${source}\t${target}`;
      if (!this.wikilinks.has(key)) this.wikilinks.set(key, { source, target, target_tail: target_tail ?? "" });
      return [];
    }
    if (sql.startsWith("DELETE FROM vault_notes WHERE path = ?")) {
      const [p] = params as string[];
      this.notes.delete(p);
      return [];
    }
    if (sql.startsWith("SELECT source, target FROM vault_wikilinks")) {
      return [...this.wikilinks.values()].map((r) => ({ source: r.source, target: r.target }));
    }
    if (sql.startsWith("SELECT path, etag FROM vault_notes")) {
      return [...this.notes.values()].map((r) => ({ path: r.path, etag: r.etag }));
    }
    if (sql.startsWith("SELECT path, body FROM vault_notes WHERE body_lower LIKE ? ESCAPE")) {
      const [bodyPattern, pathPattern, limit] = params as [string, string, number];
      this.assertPatternFits(bodyPattern);
      this.assertPatternFits(pathPattern);
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
      // findReferrers is the multi-clause form (it references target_tail);
      // backlinks is the single-target form. Both are pure equality — no LIKE.
      const isFindReferrers = sql.includes("target_tail = ?");
      const sources = new Set<string>();
      if (isFindReferrers) {
        const [basename, pathNoExt, fullPath, tail] = params as string[];
        for (const r of this.wikilinks.values()) {
          if (
            r.target === basename ||
            r.target === pathNoExt ||
            r.target === fullPath ||
            r.target_tail === tail
          ) {
            sources.add(r.source);
          }
        }
      } else {
        const [target] = params as string[];
        for (const r of this.wikilinks.values()) if (r.target === target) sources.add(r.source);
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

  it("findReferrers matches bare-name, full-path, and partial-path (target_tail) references", () => {
    const { store } = newStore();
    store.upsert(makeRow("ref-bare.md", "x", [], ["old"]));
    store.upsert(makeRow("ref-full.md", "x", [], ["Folder/old"]));
    store.upsert(makeRow("ref-partial.md", "x", [], ["deeper/Folder/old"]));
    store.upsert(makeRow("ref-other.md", "x", [], ["unrelated"]));
    // A different file whose last segment merely *contains* the name must NOT match.
    store.upsert(makeRow("ref-decoy.md", "x", [], ["Folder/not-old"]));

    const referrers = store.findReferrers("Folder/old.md", "old", "Folder/old");
    expect(referrers).toEqual(["ref-bare.md", "ref-full.md", "ref-partial.md"]);
  });

  it("findReferrers does NOT throw on a long basename (no LIKE pattern is built)", () => {
    // Regression: the embed-rewrite lookup used to be `target LIKE '%/'||name`,
    // which exceeds DO-SQLite's 50-byte pattern limit for a long filename and
    // threw "pattern too complex" — after the R2 byte-move had already
    // committed. The target_tail equality path has no pattern, so any length
    // is fine. This basename alone is 55 bytes; the old `%/`+name LIKE was 57.
    const basename = "MSPs-Practical-Guide-to-CIS-Control-Implementation.pdf";
    expect(basename.length).toBeGreaterThan(MAX_LIKE_PATTERN_BYTES);
    const { store } = newStore();
    store.upsert(makeRow("note.md", "x", [], [`Knowledge/Security/files/${basename}`]));

    expect(() =>
      store.findReferrers(`Knowledge/Security/files/${basename}`, basename, `Knowledge/Security/files/${basename}`),
    ).not.toThrow();
    expect(
      store.findReferrers(`Knowledge/Security/files/${basename}`, basename, `Knowledge/Security/files/${basename}`),
    ).toEqual(["note.md"]);
  });

  it("search still throws the runtime pattern-limit error for an over-long query (guarded at the boundary)", () => {
    const { store } = newStore();
    store.upsert(makeRow("a.md", "anything", []));
    const longQuery = "a".repeat(MAX_LIKE_PATTERN_BYTES); // pattern = %…% = limit + 2 bytes
    expect(() => store.search(longQuery, 50)).toThrow(/pattern too complex/);
    // A query that fits is unaffected.
    expect(() => store.search("a", 50)).not.toThrow();
  });
});

describe("linkTail", () => {
  it("returns the last path segment, or the whole target when slash-free", () => {
    expect(linkTail("Folder/sub/name.pdf")).toBe("name.pdf");
    expect(linkTail("name.pdf")).toBe("name.pdf");
    expect(linkTail("a/b")).toBe("b");
    expect(linkTail("")).toBe("");
    expect(linkTail("trailing/")).toBe(""); // matches SQL substr-after-last-slash
  });
});

describe("searchPatternBytes / MAX_LIKE_PATTERN_BYTES", () => {
  it("counts the %…% wrapper and lowercases like search() does", () => {
    // "AB" -> "%ab%" = 4 bytes.
    expect(searchPatternBytes("AB")).toBe(4);
  });

  it("counts the extra bytes added by LIKE meta-escaping", () => {
    // "%" escapes to "\%", so "a%" -> "%a\%%" = 5 bytes, not 4.
    expect(searchPatternBytes("a%")).toBe(5);
  });

  it("counts UTF-8 bytes, not characters, so multibyte queries are gated correctly", () => {
    // "é" is 2 UTF-8 bytes; "%é%" = 4 bytes.
    expect(searchPatternBytes("é")).toBe(4);
  });

  it("the boundary condition matches the limit: a 48-char ASCII query fits, 49 does not", () => {
    expect(searchPatternBytes("a".repeat(48))).toBe(MAX_LIKE_PATTERN_BYTES);
    expect(searchPatternBytes("a".repeat(48)) <= MAX_LIKE_PATTERN_BYTES).toBe(true);
    expect(searchPatternBytes("a".repeat(49)) > MAX_LIKE_PATTERN_BYTES).toBe(true);
  });
});

describe("SqlStore schema migration (target_tail)", () => {
  it("adds and backfills target_tail on a pre-existing (legacy) DO, idempotently", () => {
    const db = new FakeSqlite({ legacy: true });
    const store = new SqlStore(db.tag);
    // Seed a wikilink row as if it predated the column (target_tail empty).
    db.wikilinks.set("note.md\tFolder/old", { source: "note.md", target: "Folder/old", target_tail: "" });

    store.init(); // runs migrate(): ALTER + backfill
    expect(db.alterCount).toBe(1);
    expect(db.wikilinks.get("note.md\tFolder/old")?.target_tail).toBe("old");
    // The backfilled tail makes the partial-path lookup resolve.
    expect(store.findReferrers("Folder/old.md", "old", "Folder/old")).toEqual(["note.md"]);

    store.init(); // second wake: column already present → no further ALTER
    expect(db.alterCount).toBe(1);
  });

  it("does not ALTER when the column already exists (fresh DO)", () => {
    const db = new FakeSqlite(); // non-legacy: PRAGMA reports target_tail
    const store = new SqlStore(db.tag);
    store.init();
    expect(db.alterCount).toBe(0);
  });
});
