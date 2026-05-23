import type { VaultConfig } from "../types";
import { log } from "../log";

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

  async put(path: string, body: string): Promise<string> {
    const obj = await this.bucket.put(this.toKey(path), body, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    return obj.etag;
  }

  async delete(path: string): Promise<void> {
    await this.bucket.delete(this.toKey(path));
  }

  async head(path: string): Promise<R2Object | null> {
    return await this.bucket.head(this.toKey(path));
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
