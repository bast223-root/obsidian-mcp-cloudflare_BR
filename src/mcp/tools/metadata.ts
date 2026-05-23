import type { R2Client } from "../../vault/r2-client";
import { type ToolResult, type VaultConfig, err, ok } from "../../types";
import {
  buildPermalink,
  extractIdFromFrontmatter,
  parseNote,
} from "../../vault/markdown";

export async function parseFrontmatter(
  c: R2Client,
  cfg: VaultConfig,
  args: { path: string },
): Promise<
  ToolResult<{ frontmatter: Record<string, unknown>; permalink: string | null }>
> {
  const body = await c.get(args.path);
  if (body === null) return err("not_found", { path: args.path });
  const id = extractIdFromFrontmatter(body);
  const permalink = buildPermalink(cfg.permalinkBaseUrl, args.path, id);
  return ok({ frontmatter: parseNote(body).frontmatter, permalink });
}

/**
 * Generate a short HTTP permalink for a note. Returns:
 *   - `permalink_disabled` if `PERMALINK_BASE_URL` is unset.
 *   - `not_found` if the note does not exist.
 *   - On success, the URL plus a `kind` discriminator: `"id"` when the note
 *     has an `id:` (preferred, rename-stable), `"path"` for the fragile
 *     `/p/?path=...` fallback so the AI can encourage backfilling.
 */
export async function generatePermalink(
  c: R2Client,
  cfg: VaultConfig,
  args: { path: string },
): Promise<ToolResult<{ path: string; permalink: string; kind: "id" | "path" }>> {
  if (!cfg.permalinkBaseUrl) return err("permalink_disabled", { path: args.path });
  const body = await c.get(args.path);
  if (body === null) return err("not_found", { path: args.path });
  const id = extractIdFromFrontmatter(body);
  const permalink = buildPermalink(cfg.permalinkBaseUrl, args.path, id);
  // `permalink` cannot be null here — we just guarded permalinkBaseUrl above.
  return ok({ path: args.path, permalink: permalink!, kind: id ? "id" : "path" });
}
