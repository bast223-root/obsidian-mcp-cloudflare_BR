import type { R2Client } from "../../vault/r2-client";
import { type ToolResult, type VaultConfig, err, ok } from "../../types";
import {
  MalformedFrontmatterError,
  buildPermalink,
  ensureIdInFrontmatter,
  extractIdFromFrontmatter,
  generateNoteId,
  parseNote,
} from "../../vault/markdown";
import {
  BlockValueError,
  editFrontmatter,
  type FrontmatterScalar,
} from "../../vault/frontmatter-edit";

export async function parseFrontmatter(
  c: R2Client,
  cfg: VaultConfig,
  args: { path: string },
): Promise<
  ToolResult<{ frontmatter: Record<string, unknown>; etag: string; permalink: string | null }>
> {
  const obj = await c.getWithEtag(args.path);
  if (obj === null) return err("not_found", { path: args.path });
  const id = extractIdFromFrontmatter(obj.body);
  const permalink = buildPermalink(cfg.permalinkBaseUrl, args.path, id);
  return ok({ frontmatter: parseNote(obj.body).frontmatter, etag: obj.etag, permalink });
}

/**
 * Set and/or unset top-level YAML frontmatter fields on a note, editing at the
 * line level so untouched lines, key order, and comments survive byte-for-byte.
 * The note's `id:` is immutable here (rejected up front) and an id is ensured on
 * the way out, so this can never strip or rewrite the resolver-critical id.
 * Refuses (without modifying the note) to touch a key whose value is a
 * multi-line / block-style structure.
 */
export async function patchFrontmatter(
  c: R2Client,
  cfg: VaultConfig,
  args: {
    path: string;
    set?: Record<string, FrontmatterScalar | FrontmatterScalar[]>;
    unset?: string[];
    if_match?: string;
  },
): Promise<
  ToolResult<{
    path: string;
    etag: string;
    id: string;
    permalink: string | null;
    changed_keys: string[];
    removed_keys: string[];
    content: string;
  }>
> {
  const set = args.set ?? {};
  const unset = args.unset ?? [];
  const setKeys = Object.keys(set);
  if (setKeys.length === 0 && unset.length === 0) return err("no_op", { path: args.path });
  if (setKeys.includes("id") || unset.includes("id")) {
    return err("id_immutable", { path: args.path });
  }

  const body = await c.get(args.path);
  if (body === null) return err("not_found", { path: args.path });

  let edited;
  try {
    edited = editFrontmatter(body, { set, unset });
  } catch (e) {
    if (e instanceof BlockValueError) {
      return err("unsupported_block_value", { path: args.path, key: e.key });
    }
    // editFrontmatter → splitFrontmatterRaw throws on an unterminated `---`.
    // Mirror createNote/replaceNote/replaceBody: surface it as a typed failure,
    // not a boundary throw (which would increment the DO RPC-error counter).
    if (e instanceof MalformedFrontmatterError) {
      return err("malformed_frontmatter", { path: args.path });
    }
    throw e;
  }

  // Guarantee the note still carries an id (mint if it had none). Never changes
  // an existing id — editFrontmatter cannot touch the id line (id is rejected
  // above), and ensureIdInFrontmatter only mints when absent.
  const { content, id } = ensureIdInFrontmatter(edited.content, generateNoteId);
  const etag =
    args.if_match === undefined
      ? await c.put(args.path, content)
      : await c.putIfMatch(args.path, content, args.if_match);
  if (etag === null) return err("precondition_failed", { path: args.path });
  const permalink = buildPermalink(cfg.permalinkBaseUrl, args.path, id);
  return ok({
    path: args.path,
    etag,
    id,
    permalink,
    changed_keys: edited.changedKeys,
    removed_keys: edited.removedKeys,
    content,
  });
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
