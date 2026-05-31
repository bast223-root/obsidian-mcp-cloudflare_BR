import { describe, expect, test } from "vitest";
import { editFrontmatter, BlockValueError } from "../src/vault/frontmatter-edit";

describe("editFrontmatter - set", () => {
  test("overwrites an existing inline scalar, preserving other lines and order", () => {
    const src = "---\nid: abc\nstatus: in-progress\ntags: [a, b]\n---\nBody\n";
    const r = editFrontmatter(src, { set: { status: "done" } });
    expect(r.content).toBe("---\nid: abc\nstatus: done\ntags: [a, b]\n---\nBody\n");
    expect(r.changedKeys).toEqual(["status"]);
    expect(r.removedKeys).toEqual([]);
  });

  test("injects a new key just before the closing fence", () => {
    const src = "---\nid: abc\n---\nBody\n";
    const r = editFrontmatter(src, { set: { status: "done" } });
    expect(r.content).toBe("---\nid: abc\nstatus: done\n---\nBody\n");
    expect(r.changedKeys).toEqual(["status"]);
  });

  test("serializes an inline scalar array", () => {
    const src = "---\nid: abc\n---\nBody\n";
    const r = editFrontmatter(src, { set: { tags: ["x", "y"] } });
    expect(r.content).toBe("---\nid: abc\ntags: [x, y]\n---\nBody\n");
  });

  test("serializes numbers and booleans without quotes", () => {
    const src = "---\nid: abc\n---\nB\n";
    const r = editFrontmatter(src, { set: { count: 3, done: true } });
    expect(r.content).toContain("count: 3\n");
    expect(r.content).toContain("done: true\n");
  });

  test("quotes strings that would be misread as non-strings or contain YAML specials", () => {
    const src = "---\nid: abc\n---\nB\n";
    const r = editFrontmatter(src, { set: { a: "true", b: "12:30", c: "has: colon" } });
    expect(r.content).toContain('a: "true"');
    expect(r.content).toContain('b: "12:30"');
    expect(r.content).toContain('c: "has: colon"');
  });

  test("creates a frontmatter block when the note has none", () => {
    const src = "Just a body\n";
    const r = editFrontmatter(src, { set: { status: "new" } });
    expect(r.content).toBe("---\nstatus: new\n---\nJust a body\n");
  });

  test("preserves CRLF line endings", () => {
    const src = "---\r\nid: abc\r\n---\r\nBody\r\n";
    const r = editFrontmatter(src, { set: { status: "done" } });
    expect(r.content).toBe("---\r\nid: abc\r\nstatus: done\r\n---\r\nBody\r\n");
  });

  test("preserves comments on untouched lines", () => {
    const src = "---\nid: abc # keep me\nstatus: a\n---\nBody\n";
    const r = editFrontmatter(src, { set: { status: "b" } });
    expect(r.content).toBe("---\nid: abc # keep me\nstatus: b\n---\nBody\n");
  });
});

describe("editFrontmatter - unset", () => {
  test("removes an existing key line", () => {
    const src = "---\nid: abc\nstatus: done\n---\nBody\n";
    const r = editFrontmatter(src, { unset: ["status"] });
    expect(r.content).toBe("---\nid: abc\n---\nBody\n");
    expect(r.removedKeys).toEqual(["status"]);
  });

  test("unset of an absent key is a no-op", () => {
    const src = "---\nid: abc\n---\nBody\n";
    const r = editFrontmatter(src, { unset: ["missing"] });
    expect(r.content).toBe(src);
    expect(r.removedKeys).toEqual([]);
  });
});

describe("editFrontmatter - block-value refusal", () => {
  test("throws when overwriting a key that holds a block-style value", () => {
    const src = "---\nid: abc\ntags:\n  - a\n  - b\n---\nBody\n";
    expect(() => editFrontmatter(src, { set: { tags: ["x"] } })).toThrow(BlockValueError);
  });

  test("throws when unsetting a key that holds a block-style value", () => {
    const src = "---\nid: abc\nmeta:\n  nested: 1\n---\nBody\n";
    expect(() => editFrontmatter(src, { unset: ["meta"] })).toThrow(BlockValueError);
  });

  test("throws when overwriting a key whose value is a multi-line quoted scalar", () => {
    // The opening quote is never closed on the key line — the value continues on
    // the next line. Overwriting only the first line would orphan the remainder.
    const src = '---\nid: abc\ndesc: "line one\n  line two"\nstatus: a\n---\nBody\n';
    expect(() => editFrontmatter(src, { set: { desc: "x" } })).toThrow(BlockValueError);
  });

  test("does NOT treat a closed quoted value (even with a # or trailing comment) as a block", () => {
    const src = '---\nid: abc\ndesc: "has # hash"\n---\nBody\n';
    const r = editFrontmatter(src, { set: { desc: "new" } });
    expect(r.content).toBe("---\nid: abc\ndesc: new\n---\nBody\n");
  });

  test("the thrown error names the offending key", () => {
    const src = "---\ntags:\n  - a\n---\nBody\n";
    try {
      editFrontmatter(src, { set: { tags: ["x"] } });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BlockValueError);
      expect((e as BlockValueError).key).toBe("tags");
    }
  });
});
