import { env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import { R2Client } from "../src/vault/r2-client";
import {
  listNotes,
  readNote,
  createNote,
  replaceNote,
  replaceBody,
  deleteNote,
  patchNote,
  moveNote,
} from "../src/mcp/tools/notes";
import { generatePermalink, parseFrontmatter } from "../src/mcp/tools/metadata";
import { getOrCreateDailyNote, appendToDailyNote } from "../src/mcp/tools/daily";
import { type NoteRow, type Store, VaultIndex } from "../src/vault/index-store";
import { extractIdFromFrontmatter, extractTags, extractWikilinks } from "../src/vault/markdown";
import {
  deleteAttachment,
  headAttachment,
  listAttachments,
  moveAttachment,
  readAttachment,
  uploadAttachmentData,
  uploadAttachmentUrl,
} from "../src/mcp/tools/attachments";
import { makeCfg } from "./_helpers";

const NANOID_RE = /^[A-Za-z0-9_-]{21}$/;

const cfg = makeCfg();
const cfgWithPermalink = makeCfg({ permalinkBaseUrl: "https://o.example.test" });

async function reset() {
  const list = await env.VAULT.list();
  if (list.objects.length) await env.VAULT.delete(list.objects.map((o) => o.key));
}

class MemoryStore implements Store {
  rows = new Map<string, NoteRow>();
  init(): void {}
  getEtags(): Map<string, string> {
    return new Map([...this.rows].map(([p, r]) => [p, r.etag]));
  }
  upsert(row: NoteRow): void {
    this.rows.set(row.path, row);
  }
  delete(path: string): void {
    this.rows.delete(path);
  }
  search(): { path: string; body: string }[] {
    return [];
  }
  tags(): string[] {
    return [];
  }
  backlinks(target: string): string[] {
    const out: string[] = [];
    for (const r of this.rows.values()) if (r.wikilinks.includes(target)) out.push(r.path);
    return out.sort();
  }
  findReferrers(fromPath: string, fromBasename: string, fromPathNoExt: string): string[] {
    const suffix = "/" + fromBasename;
    const out: string[] = [];
    for (const r of this.rows.values()) {
      if (
        r.wikilinks.some(
          (w) =>
            w === fromBasename ||
            w === fromPathNoExt ||
            w === fromPath ||
            w.endsWith(suffix),
        )
      ) {
        out.push(r.path);
      }
    }
    return out.sort();
  }
}

function newIndex(vault: R2Client) {
  const store = new MemoryStore();
  const index = new VaultIndex(store, vault);
  index.init();
  return { store, index };
}

describe("note tools", () => {
  beforeEach(reset);

  it("listNotes returns markdown paths", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("a.md", "x");
    await c.put("b.md", "y");
    expect((await listNotes(c, cfg)).sort()).toEqual(["a.md", "b.md"]);
  });

  it("readNote returns ok with content for an existing note", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "body");
    const r = await readNote(c, cfg, { path: "n.md" });
    expect(r).toEqual({ ok: true, value: { path: "n.md", content: "body", permalink: null } });
  });

  it("readNote returns not_found for a missing note", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await readNote(c, cfg, { path: "missing.md" });
    expect(r).toEqual({ ok: false, reason: "not_found", path: "missing.md" });
  });

  it("createNote injects a fresh nanoid into frontmatter when missing", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await createNote(c, cfg, { path: "n.md", content: "v1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.path).toBe("n.md");
      expect(typeof r.value.etag).toBe("string");
      const id = extractIdFromFrontmatter(r.value.content);
      expect(id).toMatch(NANOID_RE);
      expect(r.value.content).toContain("v1");
      expect(r.value.content).toBe(await c.get("n.md"));
    }
  });

  it("createNote preserves a caller-supplied id and leaves bytes untouched", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const supplied = "ABCdefGHIjkl_MNO-1234";
    const content = `---\nid: ${supplied}\ntitle: foo\n---\nbody\n`;
    const r = await createNote(c, cfg, { path: "n.md", content });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.content).toBe(content);
      expect(extractIdFromFrontmatter(r.value.content)).toBe(supplied);
    }
  });

  it("createNote returns exists when the note already exists", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await createNote(c, cfg, { path: "n.md", content: "v1" });
    const r = await createNote(c, cfg, { path: "n.md", content: "v2" });
    expect(r).toEqual({ ok: false, reason: "exists", path: "n.md" });
  });

  it("replaceNote preserves the existing id even if the new content omits it", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const id = "KEEP-this-ID-12345abc";
    await c.put("n.md", `---\nid: ${id}\ntitle: old\n---\nold body`);
    const r = await replaceNote(c, cfg, { path: "n.md", content: "totally new" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(extractIdFromFrontmatter(r.value.content)).toBe(id);
      expect(r.value.content).toContain("totally new");
    }
  });

  it("replaceNote preserves the existing id even if the caller supplies a different one", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const original = "ORIGINAL-id-keepme-22";
    const caller = "CALLER-id-ignored-22z";
    await c.put("n.md", `---\nid: ${original}\n---\n`);
    const r = await replaceNote(c, cfg, {
      path: "n.md",
      content: `---\nid: ${caller}\ntitle: x\n---\nbody`,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(extractIdFromFrontmatter(r.value.content)).toBe(original);
      expect(r.value.content).not.toContain(caller);
    }
  });

  it("replaceNote mints a fresh id when the existing note has none", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "no frontmatter here\n");
    const r = await replaceNote(c, cfg, { path: "n.md", content: "v2" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(extractIdFromFrontmatter(r.value.content)).toMatch(NANOID_RE);
      expect(r.value.content).toContain("v2");
    }
  });

  it("replaceNote salvages a malformed-existing-frontmatter note by minting a fresh id (does NOT error)", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "---\ntitle: never closed\n");
    const r = await replaceNote(c, cfg, { path: "n.md", content: "all new content" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(extractIdFromFrontmatter(r.value.content)).toMatch(NANOID_RE);
    }
  });

  it("replaceNote returns malformed_frontmatter when the SUPPLIED content has an unterminated opener", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "---\nid: existing-id-keepit-22\n---\nbody");
    const r = await replaceNote(c, cfg, { path: "n.md", content: "---\ntitle: never closed\n" });
    expect(r).toEqual({ ok: false, reason: "malformed_frontmatter", path: "n.md" });
  });

  it("replaceNote returns not_found for a missing note", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await replaceNote(c, cfg, { path: "missing.md", content: "x" });
    expect(r).toEqual({ ok: false, reason: "not_found", path: "missing.md" });
  });

  it("replaceBody preserves frontmatter byte-for-byte and replaces body", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const fm = "---\ntitle: Foo\ncreated: 2026-05-12\ntags:\n  - a\n  - b\n---\n";
    await c.put("n.md", fm + "old body line 1\nold body line 2\n");
    const r = await replaceBody(c, cfg, { path: "n.md", body: "new body\n" });
    expect(r.ok).toBe(true);
    expect(await c.get("n.md")).toBe(fm + "new body\n");
  });

  it("replaceBody on a note without frontmatter replaces the entire content", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "no frontmatter here");
    const r = await replaceBody(c, cfg, { path: "n.md", body: "fresh content" });
    expect(r.ok).toBe(true);
    expect(await c.get("n.md")).toBe("fresh content");
  });

  it("replaceBody returns malformed_frontmatter when opening --- has no closing fence", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "---\ntitle: Foo\nno closing fence below\nstill not it\n");
    const r = await replaceBody(c, cfg, { path: "n.md", body: "x" });
    expect(r).toEqual({ ok: false, reason: "malformed_frontmatter", path: "n.md" });
  });

  it("replaceBody preserves complex frontmatter (nested maps, quoted colons, Templater)", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const fm =
      "---\n" +
      "title: \"Project: phase 2\"\n" +
      "people:\n" +
      "  - name: alice\n" +
      "    role: lead\n" +
      "  - name: bob\n" +
      "    role: dev\n" +
      "templater: '<% tp.date.now() %>'\n" +
      "tags: [a, b, c]\n" +
      "---\n";
    await c.put("n.md", fm + "old body");
    const r = await replaceBody(c, cfg, { path: "n.md", body: "new body" });
    expect(r.ok).toBe(true);
    expect(await c.get("n.md")).toBe(fm + "new body");
  });

  it("replaceBody returns not_found for a missing note", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await replaceBody(c, cfg, { path: "missing.md", body: "x" });
    expect(r).toEqual({ ok: false, reason: "not_found", path: "missing.md" });
  });

  it("replaceBody preserves body containing --- horizontal rules", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const fm = "---\ntitle: x\n---\n";
    await c.put("n.md", fm + "old body");
    const body = "section A\n\n---\n\nsection B\n";
    const r = await replaceBody(c, cfg, { path: "n.md", body });
    expect(r.ok).toBe(true);
    expect(await c.get("n.md")).toBe(fm + body);
  });

  it("replaceBody preserves CRLF line endings in existing frontmatter", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const fm = "---\r\ntitle: x\r\n---\r\n";
    await c.put("n.md", fm + "old body");
    const r = await replaceBody(c, cfg, { path: "n.md", body: "new body" });
    expect(r.ok).toBe(true);
    expect(await c.get("n.md")).toBe(fm + "new body");
  });

  it("deleteNote removes a note", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "x");
    await deleteNote(c, cfg, { path: "n.md" });
    expect(await c.get("n.md")).toBeNull();
  });

  it("patchNote replaces a unique anchor", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "hello TODO world");
    const r = await patchNote(c, cfg, { path: "n.md", old_str: "TODO", new_str: "DONE" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.path).toBe("n.md");
      expect(r.value.count).toBe(1);
      expect(r.value.content).toBe("hello DONE world");
    }
    expect(await c.get("n.md")).toBe("hello DONE world");
  });

  it("patchNote returns not_found when the note does not exist", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await patchNote(c, cfg, { path: "missing.md", old_str: "a", new_str: "b" });
    expect(r).toMatchObject({ ok: false, reason: "not_found", path: "missing.md" });
  });

  it("patchNote returns anchor_not_found when old_str is missing", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "hello world");
    const r = await patchNote(c, cfg, { path: "n.md", old_str: "TODO", new_str: "DONE" });
    expect(r).toMatchObject({ ok: false, reason: "anchor_not_found", path: "n.md" });
  });

  it("patchNote returns ambiguous when old_str is non-unique without replace_all", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "TODO TODO");
    const r = await patchNote(c, cfg, { path: "n.md", old_str: "TODO", new_str: "DONE" });
    expect(r).toEqual({ ok: false, reason: "ambiguous", path: "n.md", count: 2 });
  });

  it("patchNote replaces every occurrence when replace_all is true", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "TODO TODO");
    const r = await patchNote(c, cfg, { path: "n.md", old_str: "TODO", new_str: "DONE", replace_all: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.count).toBe(2);
    expect(await c.get("n.md")).toBe("DONE DONE");
  });

  it("patchNote returns no_op when old_str equals new_str", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "anchor");
    const r = await patchNote(c, cfg, { path: "n.md", old_str: "anchor", new_str: "anchor" });
    expect(r).toEqual({ ok: false, reason: "no_op", path: "n.md" });
  });

  // Regression: String.prototype.replace(string, string) interprets $`, $', $&,
  // $$, and $n in the replacement. We use parts.join instead so new_str is
  // written verbatim. Without this guard a new_str like "`$\``" (regex
  // literal followed by a backtick) splices the whole pre-match body into the
  // file — observed corrupting a note in production with three self-copies.
  it("patchNote writes new_str literally even when it contains $ metacharacters (single replace)", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "before [ANCHOR] after");
    const r = await patchNote(c, cfg, {
      path: "n.md",
      old_str: "[ANCHOR]",
      new_str: "$` $' $& $$ $1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.content).toBe("before $` $' $& $$ $1 after");
    expect(await c.get("n.md")).toBe("before $` $' $& $$ $1 after");
  });

  it("patchNote writes new_str literally even when it contains $ metacharacters (replace_all)", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "X X");
    const r = await patchNote(c, cfg, {
      path: "n.md",
      old_str: "X",
      new_str: "$`",
      replace_all: true,
    });
    expect(r.ok).toBe(true);
    expect(await c.get("n.md")).toBe("$` $`");
  });
});

describe("moveNote", () => {
  beforeEach(reset);

  async function seed(c: R2Client, store: MemoryStore, files: Record<string, string>) {
    for (const [path, body] of Object.entries(files)) {
      const etag = await c.put(path, body);
      store.upsert({ path, etag, body, tags: extractTags(body), wikilinks: extractWikilinks(body) });
    }
  }

  it("moves a note with zero inbound wikilinks", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, { "Old/src.md": "body" });

    const r = await moveNote(c, cfg, index, { from_path: "Old/src.md", to_path: "New/dst.md" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from).toBe("Old/src.md");
      expect(r.value.to).toBe("New/dst.md");
      expect(r.value.links_updated).toBe(0);
      expect(r.value.notes_modified).toEqual([]);
    }
    expect(await c.get("Old/src.md")).toBeNull();
    expect(await c.get("New/dst.md")).toBe("body");
  });

  it("rewrites a plain wikilink referrer", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, {
      "src.md": "moved body",
      "ref.md": "see [[src]] for details",
    });

    const r = await moveNote(c, cfg, index, { from_path: "src.md", to_path: "dst.md" });
    expect(r.ok).toBe(true);
    expect(await c.get("ref.md")).toBe("see [[dst]] for details");
  });

  it("preserves aliases on rewritten links", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, { "src.md": "x", "ref.md": "[[src|Display Text]]" });
    const r = await moveNote(c, cfg, index, { from_path: "src.md", to_path: "Folder/dst.md" });
    expect(r.ok).toBe(true);
    expect(await c.get("ref.md")).toBe("[[Folder/dst|Display Text]]");
  });

  it("preserves heading anchors", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, { "src.md": "x", "ref.md": "[[src#Section A]]" });
    const r = await moveNote(c, cfg, index, { from_path: "src.md", to_path: "dst.md" });
    expect(r.ok).toBe(true);
    expect(await c.get("ref.md")).toBe("[[dst#Section A]]");
  });

  it("preserves block references", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, { "src.md": "x", "ref.md": "see [[src#^abc123]]" });
    const r = await moveNote(c, cfg, index, { from_path: "src.md", to_path: "dst.md" });
    expect(r.ok).toBe(true);
    expect(await c.get("ref.md")).toBe("see [[dst#^abc123]]");
  });

  it("preserves embed markers", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, { "src.md": "x", "ref.md": "![[src]]" });
    const r = await moveNote(c, cfg, index, { from_path: "src.md", to_path: "dst.md" });
    expect(r.ok).toBe(true);
    expect(await c.get("ref.md")).toBe("![[dst]]");
  });

  it("rewrites full-path references", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, { "Folder/src.md": "x", "ref.md": "[[Folder/src]]" });
    const r = await moveNote(c, cfg, index, {
      from_path: "Folder/src.md",
      to_path: "Other/dst.md",
    });
    expect(r.ok).toBe(true);
    expect(await c.get("ref.md")).toBe("[[Other/dst]]");
  });

  it("rewrites bare-basename AND full-path forms across multiple files", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, {
      "Folder/src.md": "x",
      "ref-bare.md": "[[src]]",
      "ref-full.md": "[[Folder/src]]",
    });
    const r = await moveNote(c, cfg, index, {
      from_path: "Folder/src.md",
      to_path: "New/dst.md",
    });
    expect(r.ok).toBe(true);
    expect(await c.get("ref-bare.md")).toBe("[[New/dst]]");
    expect(await c.get("ref-full.md")).toBe("[[New/dst]]");
  });

  it("rewrites self-references inside the moved file", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, { "src.md": "I am [[src]] referencing myself" });
    const r = await moveNote(c, cfg, index, { from_path: "src.md", to_path: "dst.md" });
    expect(r.ok).toBe(true);
    expect(await c.get("dst.md")).toBe("I am [[dst]] referencing myself");
  });

  it("does NOT rewrite wikilinks inside fenced code blocks", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    const body = "use [[src]] live\n```\n[[src]] in code\n```\nend";
    await seed(c, store, { "src.md": "x", "ref.md": body });
    const r = await moveNote(c, cfg, index, { from_path: "src.md", to_path: "dst.md" });
    expect(r.ok).toBe(true);
    expect(await c.get("ref.md")).toBe("use [[dst]] live\n```\n[[src]] in code\n```\nend");
  });

  it("does NOT rewrite wikilinks inside inline code spans", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, { "src.md": "x", "ref.md": "`[[src]]` literal vs [[src]] live" });
    const r = await moveNote(c, cfg, index, { from_path: "src.md", to_path: "dst.md" });
    expect(r.ok).toBe(true);
    expect(await c.get("ref.md")).toBe("`[[src]]` literal vs [[dst]] live");
  });

  it("fails with reason='exists' when the destination already exists", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, { "src.md": "a", "dst.md": "b", "ref.md": "[[src]]" });
    const r = await moveNote(c, cfg, index, { from_path: "src.md", to_path: "dst.md" });
    expect(r).toEqual({ ok: false, reason: "exists", to_path: "dst.md" });
    // No partial state: source still present, referrer untouched.
    expect(await c.get("src.md")).toBe("a");
    expect(await c.get("dst.md")).toBe("b");
    expect(await c.get("ref.md")).toBe("[[src]]");
  });

  it("fails with reason='not_found' when the source is missing", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { index } = newIndex(c);
    const r = await moveNote(c, cfg, index, { from_path: "missing.md", to_path: "dst.md" });
    expect(r).toEqual({ ok: false, reason: "not_found", from_path: "missing.md" });
  });

  it("fails with reason='same_path' when from_path equals to_path", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, { "src.md": "x" });
    const r = await moveNote(c, cfg, index, { from_path: "src.md", to_path: "src.md" });
    expect(r).toEqual({ ok: false, reason: "same_path", path: "src.md" });
  });

  it("moves into a new directory key", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, { "src.md": "body" });
    const r = await moveNote(c, cfg, index, {
      from_path: "src.md",
      to_path: "Deeply/Nested/dst.md",
    });
    expect(r.ok).toBe(true);
    expect(await c.get("Deeply/Nested/dst.md")).toBe("body");
  });

  it("cross-directory move: bare-basename refs untouched (still resolve), full-path refs updated", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, {
      "OldFolder/src.md": "x",
      "ref-bare.md": "see [[src]]",
      "ref-full.md": "see [[OldFolder/src]]",
    });
    const r = await moveNote(c, cfg, index, {
      from_path: "OldFolder/src.md",
      to_path: "NewFolder/src.md",
    });
    expect(r.ok).toBe(true);
    // Bare basename ref gets rewritten to the new full path (always-correct fallback,
    // since we can't cheaply prove basename is still unique).
    expect(await c.get("ref-bare.md")).toBe("see [[NewFolder/src]]");
    expect(await c.get("ref-full.md")).toBe("see [[NewFolder/src]]");
  });

  it("preserves CRLF line endings across move and rewrite", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, {
      "src.md": "moved\r\nbody\r\n",
      "ref.md": "alpha\r\nsee [[src]]\r\nomega\r\n",
    });
    const r = await moveNote(c, cfg, index, { from_path: "src.md", to_path: "dst.md" });
    expect(r.ok).toBe(true);
    expect(await c.get("dst.md")).toBe("moved\r\nbody\r\n");
    expect(await c.get("ref.md")).toBe("alpha\r\nsee [[dst]]\r\nomega\r\n");
  });

  it("rolls back when a mid-operation put fails", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seed(c, store, {
      "src.md": "moved body",
      "ref-a.md": "[[src]] one",
      "ref-b.md": "[[src]] two",
    });

    // Patch put() to throw on the 3rd call (after the dest write + first referrer rewrite).
    const realPut = c.put.bind(c);
    let calls = 0;
    c.put = async (path: string, body: string) => {
      calls++;
      if (calls === 3) throw new Error("simulated failure");
      return realPut(path, body);
    };

    await expect(
      moveNote(c, cfg, index, { from_path: "src.md", to_path: "dst.md" }),
    ).rejects.toThrow("simulated failure");

    // Restore put so we can verify state.
    c.put = realPut;
    expect(await c.get("src.md")).toBe("moved body");
    expect(await c.get("dst.md")).toBeNull();
    // The referrer that was rewritten before the failure should have been rolled back.
    expect(await c.get("ref-a.md")).toBe("[[src]] one");
    expect(await c.get("ref-b.md")).toBe("[[src]] two");
  });
});

describe("moveNote attachment co-move", () => {
  beforeEach(reset);

  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  async function seedNote(c: R2Client, store: MemoryStore, path: string, body: string) {
    const etag = await c.put(path, body);
    store.upsert({ path, etag, body, tags: extractTags(body), wikilinks: extractWikilinks(body) });
  }

  it("co-moves a uniquely-embedded attachment and keeps the relative embed", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seedNote(c, store, "Projects/Plan.md", "see ![[files/img.png]]");
    await c.putBinary("Projects/files/img.png", PNG, "image/png");

    const r = await moveNote(c, cfg, index, {
      from_path: "Projects/Plan.md",
      to_path: "Archive/Plan.md",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.attachments_moved).toEqual([
        { from: "Projects/files/img.png", to: "Archive/files/img.png" },
      ]);
      // Relative embed form is unchanged, so no rewrite was needed.
      expect(r.value.moved.content).toBe("see ![[files/img.png]]");
    }
    expect(await c.getBinary("Projects/files/img.png")).toBeNull();
    expect(await c.getBinary("Archive/files/img.png")).not.toBeNull();
  });

  it("rewrites a vault-rooted embed when the attachment co-moves", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seedNote(c, store, "Projects/Plan.md", "see ![[Projects/files/img.png]]");
    await c.putBinary("Projects/files/img.png", PNG, "image/png");

    const r = await moveNote(c, cfg, index, {
      from_path: "Projects/Plan.md",
      to_path: "Archive/Plan.md",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.attachments_moved).toEqual([
        { from: "Projects/files/img.png", to: "Archive/files/img.png" },
      ]);
      expect(r.value.moved.content).toBe("see ![[files/img.png]]");
    }
    expect(await c.getBinary("Archive/files/img.png")).not.toBeNull();
  });

  it("leaves a shared attachment in place", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { store, index } = newIndex(c);
    await seedNote(c, store, "Projects/Plan.md", "![[files/img.png]]");
    await seedNote(c, store, "Other.md", "also ![[Projects/files/img.png]]");
    await c.putBinary("Projects/files/img.png", PNG, "image/png");

    const r = await moveNote(c, cfg, index, {
      from_path: "Projects/Plan.md",
      to_path: "Archive/Plan.md",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.attachments_moved).toEqual([]);
    // Attachment stays put because another note still references it.
    expect(await c.getBinary("Projects/files/img.png")).not.toBeNull();
    expect(await c.getBinary("Archive/files/img.png")).toBeNull();
  });

  it("never touches attachments when ATTACHMENTS_MOVE_WITH_NOTE=never", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const noMove = makeCfg({ attachmentsMoveWithNote: "never" });
    const { store, index } = newIndex(c);
    await seedNote(c, store, "Projects/Plan.md", "![[files/img.png]]");
    await c.putBinary("Projects/files/img.png", PNG, "image/png");

    const r = await moveNote(c, noMove, index, {
      from_path: "Projects/Plan.md",
      to_path: "Archive/Plan.md",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.attachments_moved).toEqual([]);
    expect(await c.getBinary("Projects/files/img.png")).not.toBeNull();
  });
});

describe("metadata tools", () => {
  beforeEach(reset);

  it("parseFrontmatter returns ok with YAML data and a null permalink when disabled", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", "---\ntitle: T\n---\nbody");
    const r = await parseFrontmatter(c, cfg, { path: "n.md" });
    expect(r).toEqual({ ok: true, value: { frontmatter: { title: "T" }, permalink: null } });
  });

  it("parseFrontmatter returns not_found for a missing note", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await parseFrontmatter(c, cfg, { path: "missing.md" });
    expect(r).toEqual({ ok: false, reason: "not_found", path: "missing.md" });
  });
});

describe("permalink integration", () => {
  beforeEach(reset);

  const ID = "ABCdefGHIjkl_MNO-1234"; // 21-char URL-safe alphabet, valid nanoid shape.

  it("readNote returns the id-based permalink when configured and the note has an id", async () => {
    const c = new R2Client(env.VAULT, cfgWithPermalink);
    await c.put("Knowledge/foo.md", `---\nid: ${ID}\n---\nbody`);
    const r = await readNote(c, cfgWithPermalink, { path: "Knowledge/foo.md" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.permalink).toBe(`https://o.example.test/n/${ID}?f=foo`);
  });

  it("readNote falls back to /p/?path= when the note has no id", async () => {
    const c = new R2Client(env.VAULT, cfgWithPermalink);
    await c.put("Knowledge/foo.md", "no frontmatter, no id");
    const r = await readNote(c, cfgWithPermalink, { path: "Knowledge/foo.md" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.permalink).toBe("https://o.example.test/p/?path=Knowledge%2Ffoo.md");
  });

  it("createNote returns a permalink keyed on the freshly-minted id", async () => {
    const c = new R2Client(env.VAULT, cfgWithPermalink);
    const r = await createNote(c, cfgWithPermalink, {
      path: "n.md",
      content: "hello",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.permalink).toMatch(
      /^https:\/\/o\.example\.test\/n\/[A-Za-z0-9_-]{21}\?f=n$/,
    );
  });

  it("replaceNote keeps permalink stable when caller's content carries a different id", async () => {
    const c = new R2Client(env.VAULT, cfgWithPermalink);
    await c.put("n.md", `---\nid: ${ID}\n---\noriginal`);
    const intruderId = "ZZZZZZZZZZZZZZZZZZZZZ";
    const r = await replaceNote(c, cfgWithPermalink, {
      path: "n.md",
      content: `---\nid: ${intruderId}\n---\nnew body`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.permalink).toBe(`https://o.example.test/n/${ID}?f=n`);
  });

  it("replaceBody preserves the permalink (frontmatter untouched)", async () => {
    const c = new R2Client(env.VAULT, cfgWithPermalink);
    await c.put("n.md", `---\nid: ${ID}\n---\noriginal`);
    const r = await replaceBody(c, cfgWithPermalink, { path: "n.md", body: "new" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.permalink).toBe(`https://o.example.test/n/${ID}?f=n`);
  });

  it("patchNote preserves the permalink when the patch does not touch the id line", async () => {
    const c = new R2Client(env.VAULT, cfgWithPermalink);
    await c.put("n.md", `---\nid: ${ID}\n---\nbefore`);
    const r = await patchNote(c, cfgWithPermalink, {
      path: "n.md",
      old_str: "before",
      new_str: "after",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.permalink).toBe(`https://o.example.test/n/${ID}?f=n`);
  });

  it("patchNote that strips the id line falls back to the path-based permalink", async () => {
    // Documents the patch_note id-line edge case from CLAUDE.md.
    const c = new R2Client(env.VAULT, cfgWithPermalink);
    await c.put("n.md", `---\nid: ${ID}\n---\nbody`);
    const r = await patchNote(c, cfgWithPermalink, {
      path: "n.md",
      old_str: `---\nid: ${ID}\n---\n`,
      new_str: "",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.permalink).toBe("https://o.example.test/p/?path=n.md");
  });

  it("parseFrontmatter returns permalink alongside frontmatter when configured", async () => {
    const c = new R2Client(env.VAULT, cfgWithPermalink);
    await c.put("n.md", `---\nid: ${ID}\ntitle: T\n---\nbody`);
    const r = await parseFrontmatter(c, cfgWithPermalink, { path: "n.md" });
    expect(r).toEqual({
      ok: true,
      value: {
        frontmatter: { id: ID, title: "T" },
        permalink: `https://o.example.test/n/${ID}?f=n`,
      },
    });
  });

  it("generatePermalink returns kind='id' when an id is present", async () => {
    const c = new R2Client(env.VAULT, cfgWithPermalink);
    await c.put("n.md", `---\nid: ${ID}\n---\nbody`);
    const r = await generatePermalink(c, cfgWithPermalink, { path: "n.md" });
    expect(r).toEqual({
      ok: true,
      value: {
        path: "n.md",
        permalink: `https://o.example.test/n/${ID}?f=n`,
        kind: "id",
      },
    });
  });

  it("generatePermalink returns kind='path' when no id is present", async () => {
    const c = new R2Client(env.VAULT, cfgWithPermalink);
    await c.put("Notes/foo.md", "no id");
    const r = await generatePermalink(c, cfgWithPermalink, { path: "Notes/foo.md" });
    expect(r).toEqual({
      ok: true,
      value: {
        path: "Notes/foo.md",
        permalink: "https://o.example.test/p/?path=Notes%2Ffoo.md",
        kind: "path",
      },
    });
  });

  it("generatePermalink returns permalink_disabled when base URL is unset", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("n.md", `---\nid: ${ID}\n---\nbody`);
    const r = await generatePermalink(c, cfg, { path: "n.md" });
    expect(r).toEqual({ ok: false, reason: "permalink_disabled", path: "n.md" });
  });

  it("generatePermalink returns not_found for a missing note", async () => {
    const c = new R2Client(env.VAULT, cfgWithPermalink);
    const r = await generatePermalink(c, cfgWithPermalink, { path: "missing.md" });
    expect(r).toEqual({ ok: false, reason: "not_found", path: "missing.md" });
  });
});

describe("daily-note tools", () => {
  beforeEach(reset);

  it("getOrCreateDailyNote creates a note at the templated path with an id", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const res = await getOrCreateDailyNote(c, cfg, { date: "2026-05-11" });
    expect(res.path).toBe("Daily Notes/2026-05-11.md");
    expect(res.created).toBe(true);
    expect(typeof res.etag).toBe("string");
    expect(res.content).toContain("# 2026-05-11");
    expect(extractIdFromFrontmatter(res.content ?? "")).toMatch(NANOID_RE);
    const again = await getOrCreateDailyNote(c, cfg, { date: "2026-05-11" });
    expect(again.created).toBe(false);
    expect(again.etag).toBeNull();
    expect(again.content).toBeNull();
  });

  it("appendToDailyNote appends with a newline boundary", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await appendToDailyNote(c, cfg, { date: "2026-05-11", content: "line1" });
    await appendToDailyNote(c, cfg, { date: "2026-05-11", content: "line2" });
    const body = await c.get("Daily Notes/2026-05-11.md");
    expect(body).toBe("line1\nline2\n");
  });
});

describe("attachment tools", () => {
  beforeEach(reset);

  const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));
  const PDF_B64 = btoa("%PDF-1.4 fake");

  it("uploadAttachmentData lands a PNG under the note's files/ subfolder", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await uploadAttachmentData(c, cfg, {
      filename: "diagram.png",
      data_base64: PNG_B64,
      target_note: "Projects/Plan.md",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.path).toBe("Projects/files/diagram.png");
      expect(r.value.content_type).toBe("image/png");
      expect(r.value.size).toBe(PNG_BYTES.length);
      expect(r.value.embed_markdown).toBe("![[files/diagram.png]]");
    }
    const stored = await c.getBinary("Projects/files/diagram.png");
    expect(new Uint8Array(stored!.body)).toEqual(new Uint8Array(PNG_BYTES));
  });

  it("uploadAttachmentData honors vault_default mode", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const vd = makeCfg({ attachmentsPathMode: "vault_default", attachmentsSubfolder: "_att" });
    const r = await uploadAttachmentData(c, vd, {
      filename: "a.png",
      data_base64: PNG_B64,
      target_note: "Deep/Note.md",
    });
    expect(r.ok && r.value.path).toBe("_att/a.png");
  });

  it("uploadAttachmentData honors caller_specified mode", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const cs = makeCfg({ attachmentsPathMode: "caller_specified" });
    const r = await uploadAttachmentData(c, cs, {
      filename: "a.png",
      data_base64: PNG_B64,
      subfolder: "Media/2026",
    });
    expect(r.ok && r.value.path).toBe("Media/2026/a.png");
  });

  it("uploadAttachmentData dest_path overrides path policy", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await uploadAttachmentData(c, cfg, {
      filename: "ignored.png",
      data_base64: PNG_B64,
      target_note: "Note.md",
      dest_path: "Exact/spot.png",
    });
    expect(r.ok && r.value.path).toBe("Exact/spot.png");
  });

  it("uploadAttachmentData accepts a data: URL and infers MIME", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await uploadAttachmentData(c, cfg, {
      filename: "x.png",
      data_base64: `data:image/png;base64,${PNG_B64}`,
    });
    expect(r.ok && r.value.content_type).toBe("image/png");
  });

  it("uploadAttachmentData rejects invalid base64", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await uploadAttachmentData(c, cfg, { filename: "x.png", data_base64: "@@not base64@@" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_base64");
  });

  it("uploadAttachmentData rejects oversize payloads", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const tiny = makeCfg({ attachmentMaxBytes: 4 });
    const r = await uploadAttachmentData(c, tiny, { filename: "x.png", data_base64: PNG_B64 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("too_large");
      expect(r.max).toBe(4);
    }
  });

  it("uploadAttachmentData rejects a disallowed extension", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await uploadAttachmentData(c, cfg, { filename: "evil.exe", data_base64: PNG_B64 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("disallowed_extension");
      expect(r.ext).toBe("exe");
    }
  });

  it("uploadAttachmentData refuses to clobber without overwrite", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await uploadAttachmentData(c, cfg, { filename: "a.png", data_base64: PNG_B64 });
    const again = await uploadAttachmentData(c, cfg, { filename: "a.png", data_base64: PNG_B64 });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("exists");

    const overwrite = await uploadAttachmentData(c, cfg, {
      filename: "a.png",
      data_base64: PNG_B64,
      overwrite: true,
    });
    expect(overwrite.ok).toBe(true);
  });

  it("readAttachment returns an image-flagged result for image MIME", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await uploadAttachmentData(c, cfg, { filename: "a.png", data_base64: PNG_B64, dest_path: "files/a.png" });
    const r = await readAttachment(c, cfg, { path: "files/a.png" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.is_image).toBe(true);
      expect(r.value.content_type).toBe("image/png");
      expect(r.value.data_base64).toBe(PNG_B64);
    }
  });

  it("readAttachment returns a non-image result for PDF", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await uploadAttachmentData(c, cfg, { filename: "doc.pdf", data_base64: PDF_B64, dest_path: "files/doc.pdf" });
    const r = await readAttachment(c, cfg, { path: "files/doc.pdf" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.is_image).toBe(false);
      expect(r.value.content_type).toBe("application/pdf");
    }
  });

  it("readAttachment 404s for a missing path and blocks disallowed extensions", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const missing = await readAttachment(c, cfg, { path: "files/none.png" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("not_found");

    const blocked = await readAttachment(c, cfg, { path: "secrets.env" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe("disallowed_extension");
  });

  it("headAttachment returns metadata without bytes", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await uploadAttachmentData(c, cfg, { filename: "a.png", data_base64: PNG_B64, dest_path: "files/a.png" });
    const r = await headAttachment(c, cfg, { path: "files/a.png" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.size).toBe(PNG_BYTES.length);
      expect(r.value.content_type).toBe("image/png");
      expect(typeof r.value.uploaded).toBe("string");
    }
    const missing = await headAttachment(c, cfg, { path: "files/none.png" });
    expect(missing.ok).toBe(false);
  });

  it("listAttachments enumerates non-md objects and scopes by prefix", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("note.md", "# hi");
    await uploadAttachmentData(c, cfg, { filename: "a.png", data_base64: PNG_B64, dest_path: "files/a.png" });
    await uploadAttachmentData(c, cfg, { filename: "b.png", data_base64: PNG_B64, dest_path: "Other/b.png" });

    const all = await listAttachments(c, cfg, {});
    expect(all.items.map((i) => i.path).sort()).toEqual(["Other/b.png", "files/a.png"]);

    const scoped = await listAttachments(c, cfg, { prefix: "files/" });
    expect(scoped.items.map((i) => i.path)).toEqual(["files/a.png"]);
  });

  it("moveAttachment relocates bytes server-side", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await uploadAttachmentData(c, cfg, { filename: "a.png", data_base64: PNG_B64, dest_path: "Inbox/a.png" });
    const r = await moveAttachment(c, cfg, { from_path: "Inbox/a.png", to_path: "Projects/files/a.png" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.to).toBe("Projects/files/a.png");
      expect(r.value.embed_markdown).toBe("![[Projects/files/a.png]]");
      expect(r.value.content_type).toBe("image/png");
    }
    expect(await c.getBinary("Inbox/a.png")).toBeNull();
    expect(await c.getBinary("Projects/files/a.png")).not.toBeNull();
  });

  it("moveAttachment won't clobber without overwrite, and reports same_path/not_found", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await uploadAttachmentData(c, cfg, { filename: "a.png", data_base64: PNG_B64, dest_path: "files/a.png" });
    await uploadAttachmentData(c, cfg, { filename: "b.png", data_base64: PNG_B64, dest_path: "files/b.png" });

    const clobber = await moveAttachment(c, cfg, { from_path: "files/a.png", to_path: "files/b.png" });
    expect(clobber.ok).toBe(false);
    if (!clobber.ok) expect(clobber.reason).toBe("exists");

    const overwrite = await moveAttachment(c, cfg, { from_path: "files/a.png", to_path: "files/b.png", overwrite: true });
    expect(overwrite.ok).toBe(true);

    expect((await moveAttachment(c, cfg, { from_path: "x.png", to_path: "x.png" })).ok).toBe(false);
    const missing = await moveAttachment(c, cfg, { from_path: "files/none.png", to_path: "files/c.png" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("not_found");
  });

  it("moveAttachment refuses to move a non-allowlisted path (e.g. a note)", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await moveAttachment(c, cfg, { from_path: "Note.md", to_path: "Other.md" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("disallowed_extension");
  });

  it("deleteAttachment is idempotent and refuses non-allowlisted paths", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await uploadAttachmentData(c, cfg, { filename: "a.png", data_base64: PNG_B64, dest_path: "files/a.png" });
    const del = await deleteAttachment(c, cfg, { path: "files/a.png" });
    expect(del.ok).toBe(true);
    expect(await c.getBinary("files/a.png")).toBeNull();
    // idempotent
    expect((await deleteAttachment(c, cfg, { path: "files/a.png" })).ok).toBe(true);
    // refuses to delete a markdown note through this tool
    const blocked = await deleteAttachment(c, cfg, { path: "note.md" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe("disallowed_extension");
  });

  // ─── upload_attachment_url (mocked fetch) ────────────────────────────────

  function mockFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
    return ((input: Parameters<typeof fetch>[0]) =>
      Promise.resolve(handler(typeof input === "string" ? input : String(input)))) as typeof fetch;
  }
  const imageResponse = () =>
    new Response(new Uint8Array(PNG_BYTES), { status: 200, headers: { "content-type": "image/png" } });

  it("uploadAttachmentUrl stores a fetched image (happy path)", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await uploadAttachmentUrl(
      c,
      cfg,
      { source_url: "https://cdn.example.com/pic.png" },
      mockFetch(() => imageResponse()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.path).toBe("files/pic.png");
      expect(r.value.content_type).toBe("image/png");
    }
    expect(await c.getBinary("files/pic.png")).not.toBeNull();
  });

  it("uploadAttachmentUrl follows a redirect to an allowed host", async () => {
    const c = new R2Client(env.VAULT, cfg);
    let calls = 0;
    const r = await uploadAttachmentUrl(
      c,
      cfg,
      { source_url: "https://cdn.example.com/redir" },
      mockFetch((url) => {
        calls++;
        if (url.endsWith("/redir")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://assets.example.com/pic.png" },
          });
        }
        return imageResponse();
      }),
    );
    expect(calls).toBe(2);
    expect(r.ok && r.value.path).toBe("files/pic.png");
  });

  it("uploadAttachmentUrl rejects a redirect to a private IP", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await uploadAttachmentUrl(
      c,
      cfg,
      { source_url: "https://cdn.example.com/redir" },
      mockFetch(() =>
        new Response(null, { status: 302, headers: { location: "https://10.0.0.1/evil.png" } }),
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("disallowed_host");
  });

  it("uploadAttachmentUrl rejects an HTML response", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await uploadAttachmentUrl(
      c,
      cfg,
      { source_url: "https://example.com/page.png" },
      mockFetch(() => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("html_response");
  });

  it("uploadAttachmentUrl rejects an oversize body", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const tiny = makeCfg({ attachmentMaxBytes: 4 });
    const r = await uploadAttachmentUrl(
      c,
      tiny,
      { source_url: "https://cdn.example.com/pic.png" },
      mockFetch(() => imageResponse()),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_large");
  });

  it("uploadAttachmentUrl rejects a non-200 status", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await uploadAttachmentUrl(
      c,
      cfg,
      { source_url: "https://cdn.example.com/pic.png" },
      mockFetch(() => new Response("nope", { status: 404 })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("fetch_failed");
  });

  it("uploadAttachmentUrl rejects http and IP-literal source URLs", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const never = mockFetch(() => {
      throw new Error("fetch should not be called");
    });
    const insecure = await uploadAttachmentUrl(c, cfg, { source_url: "http://cdn.example.com/a.png" }, never);
    expect(insecure.ok).toBe(false);
    if (!insecure.ok) expect(insecure.reason).toBe("insecure_url");
    const ip = await uploadAttachmentUrl(c, cfg, { source_url: "https://127.0.0.1/a.png" }, never);
    expect(ip.ok).toBe(false);
    if (!ip.ok) expect(ip.reason).toBe("disallowed_host");
  });

  it("uploadAttachmentUrl synthesizes a filename from Content-Type when the URL has none", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await uploadAttachmentUrl(
      c,
      cfg,
      { source_url: "https://cdn.example.com/download" },
      mockFetch(() => imageResponse()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.path).toMatch(/^files\/attachment-\d+\.png$/);
  });

  it("uploadAttachmentUrl fails when no extension can be inferred", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await uploadAttachmentUrl(
      c,
      cfg,
      { source_url: "https://cdn.example.com/download" },
      mockFetch(() => new Response(new Uint8Array(PNG_BYTES), { status: 200, headers: { "content-type": "application/octet-stream" } })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_extension_inferable");
  });
});
