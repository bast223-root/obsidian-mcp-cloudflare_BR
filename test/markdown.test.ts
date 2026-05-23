import { describe, expect, it } from "vitest";
import {
  MalformedFrontmatterError,
  buildPermalink,
  ensureIdInFrontmatter,
  extractIdFromFrontmatter,
  extractTags,
  extractWikilinks,
  generateNoteId,
  parseNote,
  rewriteWikilinksForMove,
  splitFrontmatterRaw,
} from "../src/vault/markdown";

describe("parseNote", () => {
  it("returns body and empty frontmatter when no --- block exists", () => {
    const out = parseNote("# Hello\nbody");
    expect(out.frontmatter).toEqual({});
    expect(out.body).toBe("# Hello\nbody");
  });

  it("parses YAML frontmatter", () => {
    const src = "---\ntitle: Foo\ntags: [a, b]\n---\nbody";
    const out = parseNote(src);
    expect(out.frontmatter).toEqual({ title: "Foo", tags: ["a", "b"] });
    expect(out.body).toBe("body");
  });
});

describe("extractTags", () => {
  it("merges frontmatter tags and inline #tags, dedupes, strips #", () => {
    const src = "---\ntags: [alpha, beta]\n---\n#beta #gamma in body";
    expect(extractTags(src).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("ignores # inside code fences", () => {
    const src = "text #real\n```\n#fake\n```\n";
    expect(extractTags(src)).toEqual(["real"]);
  });

  it("supports nested tags like #project/work", () => {
    expect(extractTags("see #project/work here")).toEqual(["project/work"]);
  });
});

describe("splitFrontmatterRaw", () => {
  it("returns null frontmatter when the file does not start with ---", () => {
    expect(splitFrontmatterRaw("hello")).toEqual({ frontmatter: null, body: "hello" });
  });

  it("returns null frontmatter when --- is not on the first line", () => {
    expect(splitFrontmatterRaw("\n---\nx\n---\n")).toEqual({ frontmatter: null, body: "\n---\nx\n---\n" });
  });

  it("splits well-formed frontmatter, preserving frontmatter bytes verbatim", () => {
    const src = "---\ntitle: Foo\n---\nbody\n";
    const out = splitFrontmatterRaw(src);
    expect(out.frontmatter).toBe("---\ntitle: Foo\n---\n");
    expect(out.body).toBe("body\n");
  });

  it("throws MalformedFrontmatterError when opening --- has no closing fence", () => {
    expect(() => splitFrontmatterRaw("---\ntitle: Foo\n")).toThrow(MalformedFrontmatterError);
  });

  it("handles CRLF line endings", () => {
    const src = "---\r\ntitle: x\r\n---\r\nbody";
    const out = splitFrontmatterRaw(src);
    expect(out.frontmatter).toBe("---\r\ntitle: x\r\n---\r\n");
    expect(out.body).toBe("body");
  });

  it("detects closing fence by line equality, not substring (--- inside a value is OK)", () => {
    const src = "---\nquote: \"-----\"\ndescription: see ---below\n---\nbody";
    const out = splitFrontmatterRaw(src);
    expect(out.frontmatter).toBe("---\nquote: \"-----\"\ndescription: see ---below\n---\n");
    expect(out.body).toBe("body");
  });

  it("treats entire content as frontmatter when no body follows the closing fence", () => {
    const out = splitFrontmatterRaw("---\nk: v\n---\n");
    expect(out.frontmatter).toBe("---\nk: v\n---\n");
    expect(out.body).toBe("");
  });
});

describe("extractWikilinks", () => {
  it("extracts [[Target]] links", () => {
    expect(extractWikilinks("see [[Foo]] and [[Bar|alias]]")).toEqual(["Foo", "Bar"]);
  });

  it("ignores links inside code blocks", () => {
    expect(extractWikilinks("```\n[[fake]]\n```\n[[real]]")).toEqual(["real"]);
  });
});

describe("rewriteWikilinksForMove", () => {
  const from = "Folder/old.md";
  const to = "OtherFolder/new.md";

  it("returns unchanged when no links match", () => {
    const out = rewriteWikilinksForMove("plain text [[unrelated]] more", from, to);
    expect(out).toEqual({ changed: false, content: "plain text [[unrelated]] more", count: 0 });
  });

  it("rewrites bare-basename references", () => {
    const out = rewriteWikilinksForMove("see [[old]] here", from, to);
    expect(out.changed).toBe(true);
    expect(out.content).toBe("see [[OtherFolder/new]] here");
    expect(out.count).toBe(1);
  });

  it("preserves alias text", () => {
    const out = rewriteWikilinksForMove("see [[old|the old thing]] here", from, to);
    expect(out.content).toBe("see [[OtherFolder/new|the old thing]] here");
  });

  it("preserves heading anchors", () => {
    const out = rewriteWikilinksForMove("see [[old#Section A]] here", from, to);
    expect(out.content).toBe("see [[OtherFolder/new#Section A]] here");
  });

  it("preserves block references", () => {
    const out = rewriteWikilinksForMove("see [[old#^abc123]] here", from, to);
    expect(out.content).toBe("see [[OtherFolder/new#^abc123]] here");
  });

  it("preserves embed (!) markers", () => {
    const out = rewriteWikilinksForMove("![[old]]", from, to);
    expect(out.content).toBe("![[OtherFolder/new]]");
  });

  it("rewrites full-path references", () => {
    const out = rewriteWikilinksForMove("see [[Folder/old]] here", from, to);
    expect(out.content).toBe("see [[OtherFolder/new]] here");
  });

  it("rewrites bare-basename and full-path forms together", () => {
    const out = rewriteWikilinksForMove("[[old]] vs [[Folder/old|alias]]", from, to);
    expect(out.changed).toBe(true);
    expect(out.count).toBe(2);
    expect(out.content).toBe("[[OtherFolder/new]] vs [[OtherFolder/new|alias]]");
  });

  it("does NOT rewrite wikilinks inside fenced code blocks", () => {
    const src = "before [[old]] then\n```\n[[old]] inside\n```\nafter [[old]]";
    const out = rewriteWikilinksForMove(src, from, to);
    expect(out.content).toBe(
      "before [[OtherFolder/new]] then\n```\n[[old]] inside\n```\nafter [[OtherFolder/new]]",
    );
    expect(out.count).toBe(2);
  });

  it("does NOT rewrite wikilinks inside inline code spans", () => {
    const src = "use `[[old]]` literally but [[old]] should change";
    const out = rewriteWikilinksForMove(src, from, to);
    expect(out.content).toBe("use `[[old]]` literally but [[OtherFolder/new]] should change");
    expect(out.count).toBe(1);
  });

  it("ignores wikilinks that resolve to other notes", () => {
    const out = rewriteWikilinksForMove("[[older]] [[old]]", from, to);
    expect(out.content).toBe("[[older]] [[OtherFolder/new]]");
    expect(out.count).toBe(1);
  });
});

describe("generateNoteId", () => {
  it("produces 21-char nanoid in the URL-safe alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateNoteId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    }
  });

  it("does not repeat across many calls", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(generateNoteId());
    expect(set.size).toBe(1000);
  });
});

describe("extractIdFromFrontmatter", () => {
  it("returns null when no frontmatter", () => {
    expect(extractIdFromFrontmatter("# Hello\nbody")).toBeNull();
  });

  it("returns null when frontmatter has no id", () => {
    expect(extractIdFromFrontmatter("---\ntitle: Foo\n---\nbody")).toBeNull();
  });

  it("returns the id when present (unquoted nanoid shape)", () => {
    const src = "---\nid: abc123ABC_-defGHI_-xyz\ntitle: Foo\n---\nbody";
    expect(extractIdFromFrontmatter(src)).toBe("abc123ABC_-defGHI_-xyz");
  });

  it("returns the id when present (quoted)", () => {
    const src = '---\nid: "abc123ABC_-defGHI_-xyz"\n---\n';
    expect(extractIdFromFrontmatter(src)).toBe("abc123ABC_-defGHI_-xyz");
  });

  it("returns the id when present (single-quoted)", () => {
    const src = "---\nid: 'abc123ABC_-defGHI_-xyz'\n---\n";
    expect(extractIdFromFrontmatter(src)).toBe("abc123ABC_-defGHI_-xyz");
  });

  it("accepts legacy id schemes (UUID, etc) without overwriting", () => {
    const src = "---\nid: dd076fe9-261c-4d7b-b55f-ec7ee02c1873\n---\n";
    expect(extractIdFromFrontmatter(src)).toBe("dd076fe9-261c-4d7b-b55f-ec7ee02c1873");
  });

  it("ignores body lines that look like id:", () => {
    const src = "---\ntitle: Foo\n---\nid: notreal\nbody";
    expect(extractIdFromFrontmatter(src)).toBeNull();
  });

  it("returns null for malformed frontmatter", () => {
    expect(extractIdFromFrontmatter("---\nid: foo\n")).toBeNull();
  });
});

describe("ensureIdInFrontmatter", () => {
  const fixed = () => "MINTED-ID-VALUE-12345";

  it("no frontmatter at all → prepends new frontmatter block", () => {
    const out = ensureIdInFrontmatter("# Hello\nbody\n", fixed);
    expect(out.minted).toBe(true);
    expect(out.id).toBe("MINTED-ID-VALUE-12345");
    expect(out.content).toBe("---\nid: MINTED-ID-VALUE-12345\n---\n\n# Hello\nbody\n");
  });

  it("no frontmatter, empty source → still prepends block", () => {
    const out = ensureIdInFrontmatter("", fixed);
    expect(out.minted).toBe(true);
    expect(out.content).toBe("---\nid: MINTED-ID-VALUE-12345\n---\n\n");
  });

  it("frontmatter without id → injects id as first field", () => {
    const src = "---\ntitle: Foo\ntags: [a, b]\n---\nbody\n";
    const out = ensureIdInFrontmatter(src, fixed);
    expect(out.minted).toBe(true);
    expect(out.content).toBe(
      "---\nid: MINTED-ID-VALUE-12345\ntitle: Foo\ntags: [a, b]\n---\nbody\n",
    );
  });

  it("frontmatter with existing id → returns src unchanged", () => {
    const src = "---\nid: keep-this-id-please-22\ntitle: Foo\n---\nbody";
    const out = ensureIdInFrontmatter(src, fixed);
    expect(out.minted).toBe(false);
    expect(out.id).toBe("keep-this-id-please-22");
    expect(out.content).toBe(src);
  });

  it("preserves field ordering when injecting", () => {
    const src = "---\ntitle: a\nfoo: b\nbar: c\n---\n";
    const out = ensureIdInFrontmatter(src, fixed);
    expect(out.content).toBe(
      "---\nid: MINTED-ID-VALUE-12345\ntitle: a\nfoo: b\nbar: c\n---\n",
    );
  });

  it("handles CRLF frontmatter line endings on injection", () => {
    const src = "---\r\ntitle: Foo\r\n---\r\nbody";
    const out = ensureIdInFrontmatter(src, fixed);
    expect(out.content).toBe(
      "---\r\nid: MINTED-ID-VALUE-12345\r\ntitle: Foo\r\n---\r\nbody",
    );
  });

  it("is idempotent", () => {
    const original = "# Heading\nbody\n";
    let counter = 0;
    const mint = () => `id-call-${++counter}`;
    const first = ensureIdInFrontmatter(original, mint);
    const second = ensureIdInFrontmatter(first.content, mint);
    expect(second.content).toBe(first.content);
    expect(second.minted).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("does NOT match an `id:` inside the body", () => {
    const src = "---\ntitle: Foo\n---\nid: in-body-line\n";
    const out = ensureIdInFrontmatter(src, fixed);
    expect(out.minted).toBe(true);
    expect(out.content).toBe(
      "---\nid: MINTED-ID-VALUE-12345\ntitle: Foo\n---\nid: in-body-line\n",
    );
  });

  it("throws MalformedFrontmatterError on opening fence without close", () => {
    expect(() => ensureIdInFrontmatter("---\ntitle: Foo\n", fixed)).toThrow(
      MalformedFrontmatterError,
    );
  });
});

describe("buildPermalink", () => {
  const BASE = "https://o.example.test";

  it("returns null when baseUrl is empty", () => {
    expect(buildPermalink("", "n.md", "abc")).toBeNull();
    expect(buildPermalink(undefined, "n.md", "abc")).toBeNull();
  });

  it("builds /n/<id>?f=<slug> when an id is present", () => {
    expect(buildPermalink(BASE, "Knowledge/foo.md", "ID123")).toBe(
      `${BASE}/n/ID123?f=foo`,
    );
  });

  it("uses just the basename (no path segments) for the f= slug", () => {
    expect(buildPermalink(BASE, "Knowledge/Sub/notes-2026.md", "abc")).toBe(
      `${BASE}/n/abc?f=notes-2026`,
    );
  });

  it("falls back to /p/?path=<encoded full path> when id is null", () => {
    expect(buildPermalink(BASE, "Knowledge/foo.md", null)).toBe(
      `${BASE}/p/?path=Knowledge%2Ffoo.md`,
    );
  });

  it("falls back to /p/?path= when id is an empty string", () => {
    expect(buildPermalink(BASE, "foo.md", "")).toBe(`${BASE}/p/?path=foo.md`);
  });

  it("strips trailing slash on baseUrl so we never emit //n/...", () => {
    expect(buildPermalink(`${BASE}/`, "foo.md", "abc")).toBe(`${BASE}/n/abc?f=foo`);
    expect(buildPermalink(`${BASE}//`, "foo.md", "abc")).toBe(`${BASE}/n/abc?f=foo`);
  });

  it("URL-encodes the id (defensive — if an exotic id ever slips through)", () => {
    expect(buildPermalink(BASE, "n.md", "with space")).toBe(
      `${BASE}/n/with%20space?f=n`,
    );
  });

  it("URL-encodes the path so `&`, `?`, `#` in filenames can't smuggle params", () => {
    expect(buildPermalink(BASE, "weird & name.md", null)).toBe(
      `${BASE}/p/?path=weird%20%26%20name.md`,
    );
  });

  it("URL-encodes the slug so a basename with unsafe chars stays decorative", () => {
    expect(buildPermalink(BASE, "weird & name.md", "abc")).toBe(
      `${BASE}/n/abc?f=weird%20%26%20name`,
    );
  });
});
