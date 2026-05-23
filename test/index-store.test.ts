import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { R2Client } from "../src/vault/r2-client";
import { type NoteRow, type Store, VaultIndex } from "../src/vault/index-store";

const cfg = { prefix: "", dailyNotePathTemplate: "Daily Notes/{{YYYY-MM-DD}}.md", permalinkBaseUrl: "" };

async function reset() {
  const list = await env.VAULT.list();
  if (list.objects.length) await env.VAULT.delete(list.objects.map((o) => o.key));
}

class MemoryStore implements Store {
  rows = new Map<string, NoteRow>();
  initCalled = 0;
  init(): void {
    this.initCalled++;
  }
  getEtags(): Map<string, string> {
    return new Map([...this.rows].map(([p, r]) => [p, r.etag]));
  }
  upsert(row: NoteRow): void {
    this.rows.set(row.path, row);
  }
  delete(path: string): void {
    this.rows.delete(path);
  }
  search(queryLower: string, limit: number): { path: string; body: string }[] {
    const out: { path: string; body: string }[] = [];
    for (const row of this.rows.values()) {
      if (out.length >= limit) break;
      if (
        row.body.toLowerCase().includes(queryLower) ||
        row.path.toLowerCase().includes(queryLower)
      ) {
        out.push({ path: row.path, body: row.body });
      }
    }
    return out;
  }
  tags(): string[] {
    const t = new Set<string>();
    for (const row of this.rows.values()) for (const tag of row.tags) t.add(tag);
    return [...t].sort();
  }
  backlinks(target: string): string[] {
    const out: string[] = [];
    for (const row of this.rows.values()) {
      if (row.wikilinks.includes(target)) out.push(row.path);
    }
    return out.sort();
  }
  findReferrers(fromPath: string, fromBasename: string, fromPathNoExt: string): string[] {
    const suffix = "/" + fromBasename;
    const out: string[] = [];
    for (const row of this.rows.values()) {
      const hit = row.wikilinks.some(
        (w) =>
          w === fromBasename ||
          w === fromPathNoExt ||
          w === fromPath ||
          w.endsWith(suffix),
      );
      if (hit) out.push(row.path);
    }
    return out.sort();
  }
}

function newIndex() {
  const store = new MemoryStore();
  const vault = new R2Client(env.VAULT, cfg);
  const index = new VaultIndex(store, vault);
  index.init();
  return { store, vault, index };
}

describe("VaultIndex", () => {
  beforeEach(reset);

  it("seeds an empty index from R2 on first ensureFresh", async () => {
    const { store, vault, index } = newIndex();
    await vault.put("a.md", "#alpha");
    await vault.put("b.md", "#beta");

    expect(store.rows.size).toBe(0);
    await index.ensureFresh();
    expect(store.rows.size).toBe(2);
    expect(store.rows.get("a.md")?.tags).toEqual(["alpha"]);
    expect(store.rows.get("b.md")?.tags).toEqual(["beta"]);
  });

  it("is a no-op when nothing has changed", async () => {
    const { store, vault, index } = newIndex();
    await vault.put("a.md", "alpha");
    await index.ensureFresh();
    const first = new Map(store.rows);

    await index.ensureFresh();
    expect(store.rows.size).toBe(first.size);
    expect(store.rows.get("a.md")?.body).toBe(first.get("a.md")?.body);
  });

  it("picks up an externally-added note", async () => {
    const { vault, index } = newIndex();
    await vault.put("a.md", "alpha");
    await index.ensureFresh();
    expect((await index.listTags()).sort()).toEqual([]);

    // Simulate Remotely Save dropping a new note straight into R2.
    await vault.put("c.md", "#gamma");
    await index.ensureFresh();
    expect(await index.listTags()).toEqual(["gamma"]);
  });

  it("removes a note that disappeared from R2", async () => {
    const { vault, index, store } = newIndex();
    await vault.put("a.md", "alpha");
    await index.ensureFresh();
    expect(store.rows.has("a.md")).toBe(true);

    await vault.delete("a.md");
    await index.ensureFresh();
    expect(store.rows.has("a.md")).toBe(false);
  });

  it("re-indexes a note whose body changed (different etag)", async () => {
    const { vault, index, store } = newIndex();
    await vault.put("a.md", "#alpha");
    await index.ensureFresh();
    expect(store.rows.get("a.md")?.tags).toEqual(["alpha"]);

    await vault.put("a.md", "#beta");
    await index.ensureFresh();
    expect(store.rows.get("a.md")?.tags).toEqual(["beta"]);
  });

  it("search returns hits with snippets", async () => {
    const { vault, index } = newIndex();
    await vault.put("a.md", "the quick brown fox");
    await vault.put("b.md", "lazy dog");
    await vault.put("sub/c.md", "Quick Reference");

    const hits = await index.search("quick", 50);
    expect(hits.map((h) => h.path).sort()).toEqual(["a.md", "sub/c.md"]);
    expect(hits.every((h) => h.snippet.toLowerCase().includes("quick"))).toBe(true);
  });

  it("search matches against the file path as well as the body", async () => {
    const { vault, index } = newIndex();
    await vault.put("People/Kevin Meeting Notes.md", "agenda item one");
    await vault.put("dailies/2026-05-12.md", "no mention of the name here");

    // 'kevin' appears nowhere in any body, only in the filename.
    const hits = await index.search("kevin", 50);
    expect(hits.map((h) => h.path)).toEqual(["People/Kevin Meeting Notes.md"]);
  });

  it("listTags aggregates frontmatter and inline tags", async () => {
    const { vault, index } = newIndex();
    await vault.put("a.md", "#alpha #beta");
    await vault.put("b.md", "---\ntags: [beta, gamma]\n---");
    expect(await index.listTags()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("listBacklinks finds notes linking to a target", async () => {
    const { vault, index } = newIndex();
    await vault.put("hub.md", "see [[Target]] and [[Other]]");
    await vault.put("orbit.md", "also [[Target|alias]]");
    await vault.put("none.md", "nothing");
    expect(await index.listBacklinks("Target")).toEqual(["hub.md", "orbit.md"]);
  });

  it("write-through upsert keeps the index fresh without ensureFresh", async () => {
    const { store, vault, index } = newIndex();
    const etag = await vault.put("a.md", "#hello");
    index.upsertFromContent("a.md", "#hello", etag);
    expect(store.rows.get("a.md")?.tags).toEqual(["hello"]);
  });

  it("write-through delete drops the row", async () => {
    const { store, vault, index } = newIndex();
    const etag = await vault.put("a.md", "x");
    index.upsertFromContent("a.md", "x", etag);
    expect(store.rows.has("a.md")).toBe(true);
    index.delete("a.md");
    expect(store.rows.has("a.md")).toBe(false);
  });

  it("returns empty for empty query", async () => {
    const { vault, index } = newIndex();
    await vault.put("a.md", "anything");
    expect(await index.search("", 50)).toEqual([]);
  });

  it("findReferrersFor matches bare-basename, full-path, and partial-path references", async () => {
    const { vault, index } = newIndex();
    await vault.put("ref-bare.md", "see [[old]]");
    await vault.put("ref-fullpath.md", "see [[Folder/old]]");
    await vault.put("ref-partial.md", "see [[deeper/Folder/old]]");
    await vault.put("ref-other.md", "see [[unrelated]]");
    await vault.put("Folder/old.md", "self with no internal wikilinks");

    const referrers = await index.findReferrersFor("Folder/old.md");
    expect(referrers.sort()).toEqual(["ref-bare.md", "ref-fullpath.md", "ref-partial.md"]);
    expect(referrers).not.toContain("ref-other.md");
  });

  it("findReferrersFor includes the moved note itself when it has a self-reference", async () => {
    const { vault, index } = newIndex();
    await vault.put("ref.md", "see [[old]]");
    await vault.put("Folder/old.md", "I am [[old]] and link to myself");
    expect((await index.findReferrersFor("Folder/old.md")).sort()).toEqual([
      "Folder/old.md",
      "ref.md",
    ]);
  });

  it("findReferrersFor returns empty when nothing references the target", async () => {
    const { vault, index } = newIndex();
    await vault.put("a.md", "see [[somewhere-else]]");
    await vault.put("orphan.md", "no inbound links");
    expect(await index.findReferrersFor("orphan.md")).toEqual([]);
  });
});
