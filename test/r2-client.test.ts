import { env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import { R2Client } from "../src/vault/r2-client";

const cfg = { prefix: "", dailyNotePathTemplate: "", permalinkBaseUrl: "" };

async function reset() {
  const list = await env.VAULT.list();
  if (list.objects.length) {
    await env.VAULT.delete(list.objects.map((o) => o.key));
  }
}

describe("R2Client", () => {
  beforeEach(reset);

  it("write+read round-trips a note at a vault-relative path", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("notes/foo.md", "# Hello");
    const body = await c.get("notes/foo.md");
    expect(body).toBe("# Hello");
  });

  it("returns null for missing keys", async () => {
    const c = new R2Client(env.VAULT, cfg);
    expect(await c.get("missing.md")).toBeNull();
  });

  it("listMarkdown lists only .md keys without the prefix", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("a.md", "x");
    await c.put("sub/b.md", "y");
    await c.put("image.png", "z");
    const paths = await c.listMarkdown();
    expect(paths.sort()).toEqual(["a.md", "sub/b.md"]);
  });

  it("respects a non-empty VAULT_PREFIX", async () => {
    const c = new R2Client(env.VAULT, { prefix: "vaults/main", dailyNotePathTemplate: "", permalinkBaseUrl: "" });
    await c.put("note.md", "hi");
    const raw = await env.VAULT.get("vaults/main/note.md");
    expect(raw).not.toBeNull();
    expect(await c.get("note.md")).toBe("hi");
    expect(await c.listMarkdown()).toEqual(["note.md"]);
  });

  it("rejects path traversal", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await expect(c.get("../escape.md")).rejects.toThrow(/invalid path/i);
    await expect(c.put("a/../../escape.md", "x")).rejects.toThrow(/invalid path/i);
  });
});
