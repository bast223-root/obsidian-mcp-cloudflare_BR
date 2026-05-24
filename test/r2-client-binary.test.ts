import { env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import { ObjectExistsError, R2Client } from "../src/vault/r2-client";
import { makeCfg } from "./_helpers";

const cfg = makeCfg();

async function reset() {
  const list = await env.VAULT.list();
  if (list.objects.length) await env.VAULT.delete(list.objects.map((o) => o.key));
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("R2Client binary methods", () => {
  beforeEach(reset);

  it("putBinary + getBinary round-trips bytes and content type", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const { etag, size } = await c.putBinary("files/a.png", PNG, "image/png");
    expect(size).toBe(PNG.byteLength);
    expect(etag).toBeTruthy();

    const got = await c.getBinary("files/a.png");
    expect(got).not.toBeNull();
    expect(got!.contentType).toBe("image/png");
    expect(got!.size).toBe(PNG.byteLength);
    expect(new Uint8Array(got!.body)).toEqual(PNG);
  });

  it("getBinary returns null for missing keys", async () => {
    const c = new R2Client(env.VAULT, cfg);
    expect(await c.getBinary("files/missing.png")).toBeNull();
  });

  it("headBinary returns metadata without the body", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.putBinary("files/a.pdf", PNG, "application/pdf");
    const meta = await c.headBinary("files/a.pdf");
    expect(meta).not.toBeNull();
    expect(meta!.contentType).toBe("application/pdf");
    expect(meta!.size).toBe(PNG.byteLength);
    expect(meta!.uploaded).toBeInstanceOf(Date);
    expect(await c.headBinary("files/none.pdf")).toBeNull();
  });

  it("putBinary with onlyIfNotExists throws when the object exists", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.putBinary("files/a.png", PNG, "image/png");
    await expect(
      c.putBinary("files/a.png", PNG, "image/png", { onlyIfNotExists: true }),
    ).rejects.toBeInstanceOf(ObjectExistsError);
  });

  it("putBinary with onlyIfNotExists succeeds when absent", async () => {
    const c = new R2Client(env.VAULT, cfg);
    const r = await c.putBinary("files/fresh.png", PNG, "image/png", { onlyIfNotExists: true });
    expect(r.etag).toBeTruthy();
  });

  it("listBinaries excludes .md by default and includes attachments", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("note.md", "# hi");
    await c.putBinary("files/a.png", PNG, "image/png");
    await c.putBinary("files/b.pdf", PNG, "application/pdf");

    const { items } = await c.listBinaries();
    const paths = items.map((i) => i.path).sort();
    expect(paths).toEqual(["files/a.png", "files/b.pdf"]);
    const png = items.find((i) => i.path === "files/a.png")!;
    expect(png.contentType).toBe("image/png");
    expect(png.size).toBe(PNG.byteLength);
  });

  it("listBinaries can include markdown when asked", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.put("note.md", "# hi");
    await c.putBinary("files/a.png", PNG, "image/png");
    const { items } = await c.listBinaries(undefined, { excludeMarkdown: false });
    expect(items.map((i) => i.path).sort()).toEqual(["files/a.png", "note.md"]);
  });

  it("listBinaries scopes to a vault-relative prefix", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await c.putBinary("Daily Notes/files/x.png", PNG, "image/png");
    await c.putBinary("Other/y.png", PNG, "image/png");
    const { items } = await c.listBinaries("Daily Notes/");
    expect(items.map((i) => i.path)).toEqual(["Daily Notes/files/x.png"]);
  });

  it("honors VAULT_PREFIX for binary read/write/list", async () => {
    const c = new R2Client(env.VAULT, makeCfg({ prefix: "vaults/main" }));
    await c.putBinary("files/a.png", PNG, "image/png");
    const raw = await env.VAULT.get("vaults/main/files/a.png");
    expect(raw).not.toBeNull();
    const got = await c.getBinary("files/a.png");
    expect(new Uint8Array(got!.body)).toEqual(PNG);
    const { items } = await c.listBinaries();
    expect(items.map((i) => i.path)).toEqual(["files/a.png"]);
  });

  it("rejects path traversal on binary writes and reads", async () => {
    const c = new R2Client(env.VAULT, cfg);
    await expect(c.putBinary("../escape.png", PNG, "image/png")).rejects.toThrow(/invalid path/i);
    await expect(c.getBinary("/leading.png")).rejects.toThrow(/invalid path/i);
  });
});
