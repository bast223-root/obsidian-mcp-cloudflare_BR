import { env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import { R2Client } from "../src/vault/r2-client";
import { backfillIds } from "../src/mcp/tools/admin";
import { extractIdFromFrontmatter } from "../src/vault/markdown";
import { makeCfg } from "./_helpers";

const cfg = makeCfg();

const NANOID_RE = /^[A-Za-z0-9_-]{21}$/;

async function reset() {
  const list = await env.VAULT.list();
  if (list.objects.length) await env.VAULT.delete(list.objects.map((o) => o.key));
}

describe("backfillIds", () => {
  beforeEach(reset);

  it("dry-run reports counts without writing", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("a.md", "no fm\n");
    await c.put("b.md", "---\ntitle: x\n---\nbody\n");
    await c.put("c.md", "---\nid: keep-me-please-12345\n---\n");

    const before = {
      a: await c.get("a.md"),
      b: await c.get("b.md"),
      c: await c.get("c.md"),
    };

    const r = await backfillIds(c, cfg, { dryRun: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.dryRun).toBe(true);
      expect(r.value.scanned).toBe(3);
      expect(r.value.alreadyHadId).toBe(1);
      expect(r.value.minted).toBe(2);
      expect(r.value.malformed).toBe(0);
      expect(r.value.examples).toHaveLength(2);
      for (const ex of r.value.examples) {
        expect(ex.id).toMatch(NANOID_RE);
        expect(ex.etag).toBe("(dry-run)");
      }
    }

    expect(await c.get("a.md")).toBe(before.a);
    expect(await c.get("b.md")).toBe(before.b);
    expect(await c.get("c.md")).toBe(before.c);
  });

  it("real run writes ids to notes that lack them and leaves others byte-identical", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("a.md", "plain body\n");
    const bOriginal = "---\nid: keep-this-id-stable-22\ntitle: B\n---\nbody of B\n";
    await c.put("b.md", bOriginal);

    const r = await backfillIds(c, cfg, { dryRun: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scanned).toBe(2);
      expect(r.value.minted).toBe(1);
      expect(r.value.alreadyHadId).toBe(1);
    }

    expect(await c.get("b.md")).toBe(bOriginal);

    const aAfter = await c.get("a.md");
    expect(aAfter).not.toBeNull();
    expect(extractIdFromFrontmatter(aAfter!)).toMatch(NANOID_RE);
    expect(aAfter).toContain("plain body");
  });

  it("is idempotent", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("a.md", "body\n");
    await backfillIds(c, cfg, { dryRun: false });
    const afterFirst = await c.get("a.md");

    const second = await backfillIds(c, cfg, { dryRun: false });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.minted).toBe(0);
      expect(second.value.alreadyHadId).toBe(1);
    }
    expect(await c.get("a.md")).toBe(afterFirst);
  });

  it("prefix filter restricts the scan", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("Daily Notes/2026-05-11.md", "x\n");
    await c.put("Daily Notes/2026-05-12.md", "y\n");
    await c.put("Knowledge/foo.md", "z\n");

    const r = await backfillIds(c, cfg, { dryRun: true, prefix: "Daily Notes/" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scanned).toBe(2);
      expect(r.value.minted).toBe(2);
    }
  });

  it("limit caps how many notes get minted/inspected after considering existing-id notes", async () => {
    const c = new R2Client(env.VAULT, cfg);
    for (let i = 0; i < 5; i++) await c.put(`n${i}.md`, "body\n");
    const r = await backfillIds(c, cfg, { dryRun: true, limit: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.minted).toBe(3);
      expect(r.value.scanned).toBe(3);
    }
  });

  it("records malformed-frontmatter notes without aborting", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("bad.md", "---\ntitle: opening without close\n");
    await c.put("good.md", "body\n");
    const r = await backfillIds(c, cfg, { dryRun: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.malformed).toBe(1);
      expect(r.value.malformedPaths).toContain("bad.md");
      expect(r.value.minted).toBe(1);
    }
    expect(extractIdFromFrontmatter((await c.get("good.md"))!)).toMatch(NANOID_RE);
  });

  it("invokes onWrite for each minted note (index integration hook)", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("a.md", "x\n");
    await c.put("b.md", "y\n");
    const seen: string[] = [];
    await backfillIds(c, cfg, { dryRun: false }, (path) => {
      seen.push(path);
    });
    expect(seen.sort()).toEqual(["a.md", "b.md"]);
  });
});
