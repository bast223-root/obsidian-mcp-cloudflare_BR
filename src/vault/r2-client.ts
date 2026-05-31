import type { VaultConfig } from "../types";
import { log } from "../log";

/** Thrown by `putBinary` when `onlyIfNotExists` is set and the object exists. */
export class ObjectExistsError extends Error {
  constructor(public path: string) {
    super(`object exists: ${path}`);
    this.name = "ObjectExistsError";
  }
}

export interface BinaryObjectMeta {
  contentType: string;
  size: number;
  etag: string;
  uploaded: Date;
}

export class R2Client {
  constructor(private bucket: R2Bucket, private cfg: VaultConfig) {}

  private toKey(path: string): string {
    if (path.includes("..") || path.startsWith("/")) {
      log.warn("invalid_path_rejected", { path });
      throw new Error(`invalid path: ${path}`);
    }
    return this.cfg.prefix ? `${this.cfg.prefix.replace(/\/$/, "")}/${path}` : path;
  }

  private fromKey(key: string): string {
    if (!this.cfg.prefix) return key;
    const p = `${this.cfg.prefix.replace(/\/$/, "")}/`;
    return key.startsWith(p) ? key.slice(p.length) : key;
  }

  async get(path: string): Promise<string | null> {
    const obj = await this.bucket.get(this.toKey(path));
    return obj ? await obj.text() : null;
  }

  /**
   * Read body + current etag in one call. Used by read paths that surface the
   * etag so callers can pass it back as an `if_match` precondition on a later
   * write (optimistic concurrency).
   */
  async getWithEtag(path: string): Promise<{ body: string; etag: string } | null> {
    const obj = await this.bucket.get(this.toKey(path));
    if (!obj) return null;
    return { body: await obj.text(), etag: obj.etag };
  }

  async put(path: string, body: string): Promise<string> {
    const obj = await this.bucket.put(this.toKey(path), body, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    return obj.etag;
  }

  /**
   * Conditional write: only commits if the object's current etag equals
   * `ifMatch`. Returns the new etag on success, or `null` if the precondition
   * failed (another writer changed or created the object since `ifMatch`). R2
   * evaluates `onlyIf` at write time, so this is an atomic optimistic-concurrency
   * guard with no read-then-write TOCTOU window — the fix for silent
   * last-write-wins clobbering between concurrent editors.
   */
  async putIfMatch(path: string, body: string, ifMatch: string): Promise<string | null> {
    const obj = await this.bucket.put(this.toKey(path), body, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      onlyIf: { etagMatches: ifMatch },
    });
    return obj ? obj.etag : null;
  }

  async delete(path: string): Promise<void> {
    await this.bucket.delete(this.toKey(path));
  }

  async head(path: string): Promise<R2Object | null> {
    return await this.bucket.head(this.toKey(path));
  }

  // ─── Binary object methods ──────────────────────────────────────────────
  // Attachments (images, PDFs, …) are stored as raw bytes with their own
  // Content-Type. These intentionally do NOT share code with get/put/delete,
  // which stay text/markdown-typed. Path safety (toKey/fromKey) is reused.

  /**
   * Write binary bytes with an explicit Content-Type. When `onlyIfNotExists` is
   * set, a `head` precheck guards against clobbering an existing object and
   * throws `ObjectExistsError` if one is present (same TOCTOU caveat as the
   * head-then-put in `createNote` — R2 has no native create-if-absent
   * conditional in the Workers binding).
   */
  async putBinary(
    path: string,
    body: ArrayBuffer | Uint8Array,
    contentType: string,
    opts?: { onlyIfNotExists?: boolean },
  ): Promise<{ etag: string; size: number }> {
    const key = this.toKey(path);
    if (opts?.onlyIfNotExists && (await this.bucket.head(key))) {
      throw new ObjectExistsError(path);
    }
    const obj = await this.bucket.put(key, body, { httpMetadata: { contentType } });
    return { etag: obj.etag, size: obj.size };
  }

  async getBinary(
    path: string,
  ): Promise<{ body: ArrayBuffer; contentType: string; size: number; etag: string } | null> {
    const obj = await this.bucket.get(this.toKey(path));
    if (!obj) return null;
    return {
      body: await obj.arrayBuffer(),
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      size: obj.size,
      etag: obj.etag,
    };
  }

  async headBinary(path: string): Promise<BinaryObjectMeta | null> {
    const obj = await this.bucket.head(this.toKey(path));
    if (!obj) return null;
    return {
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      size: obj.size,
      etag: obj.etag,
      uploaded: obj.uploaded,
    };
  }

  /**
   * List objects under an optional vault-relative prefix. Filters OUT `.md` by
   * default (the inverse of `listMarkdownWithMeta`) so attachment tools don't
   * surface notes. Returns one R2 page plus a cursor for the caller to paginate.
   */
  async listBinaries(
    prefix?: string,
    opts?: { limit?: number; cursor?: string; excludeMarkdown?: boolean },
  ): Promise<{ items: Array<{ path: string } & BinaryObjectMeta>; cursor: string | null }> {
    const base = this.cfg.prefix ? `${this.cfg.prefix.replace(/\/$/, "")}/` : "";
    const fullPrefix = base + (prefix ?? "");
    const excludeMarkdown = opts?.excludeMarkdown ?? true;
    const page = await this.bucket.list({
      prefix: fullPrefix || undefined,
      cursor: opts?.cursor,
      limit: opts?.limit ?? 1000,
      include: ["httpMetadata"],
    });
    const items: Array<{ path: string } & BinaryObjectMeta> = [];
    for (const o of page.objects) {
      const p = this.fromKey(o.key);
      if (excludeMarkdown && p.endsWith(".md")) continue;
      items.push({
        path: p,
        contentType: o.httpMetadata?.contentType ?? "application/octet-stream",
        size: o.size,
        etag: o.etag,
        uploaded: o.uploaded,
      });
    }
    return { items, cursor: page.truncated ? page.cursor : null };
  }

  async listMarkdown(): Promise<string[]> {
    return (await this.listMarkdownWithMeta()).map((o) => o.path);
  }

  async listMarkdownWithMeta(): Promise<{ path: string; etag: string }[]> {
    const started = Date.now();
    const out: { path: string; etag: string }[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await this.bucket.list({
        prefix: this.cfg.prefix ? `${this.cfg.prefix.replace(/\/$/, "")}/` : undefined,
        cursor,
        limit: 1000,
      });
      pages++;
      for (const o of page.objects) {
        const p = this.fromKey(o.key);
        if (p.endsWith(".md")) out.push({ path: p, etag: o.etag });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    log.debug("vault_list", { count: out.length, pages, durationMs: Date.now() - started });
    return out;
  }
}
