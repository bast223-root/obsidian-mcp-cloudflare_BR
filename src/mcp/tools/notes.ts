import type { R2Client } from "../../vault/r2-client";
import { type ToolResult, type VaultConfig, err, ok } from "../../types";
import type { VaultIndex } from "../../vault/index-store";
import {
  MalformedFrontmatterError,
  buildPermalink,
  ensureIdInFrontmatter,
  extractIdFromFrontmatter,
  generateNoteId,
  rewriteWikilinksForMove,
  setIdInFrontmatter,
  splitFrontmatterRaw,
} from "../../vault/markdown";

export async function listNotes(c: R2Client, _cfg: VaultConfig): Promise<string[]> {
  return c.listMarkdown();
}

export async function readNote(
  c: R2Client,
  cfg: VaultConfig,
  args: { path: string },
): Promise<ToolResult<{ path: string; content: string; permalink: string | null }>> {
  const body = await c.get(args.path);
  if (body === null) return err("not_found", { path: args.path });
  const id = extractIdFromFrontmatter(body);
  const permalink = buildPermalink(cfg.permalinkBaseUrl, args.path, id);
  return ok({ path: args.path, content: body, permalink });
}

export async function createNote(
  c: R2Client,
  cfg: VaultConfig,
  args: { path: string; content: string },
): Promise<ToolResult<{ path: string; etag: string; content: string; permalink: string | null }>> {
  if (await c.head(args.path)) return err("exists", { path: args.path });
  let prepared;
  try {
    prepared = ensureIdInFrontmatter(args.content, generateNoteId);
  } catch (e) {
    if (e instanceof MalformedFrontmatterError) {
      return err("malformed_frontmatter", { path: args.path });
    }
    throw e;
  }
  const etag = await c.put(args.path, prepared.content);
  const permalink = buildPermalink(cfg.permalinkBaseUrl, args.path, prepared.id);
  return ok({ path: args.path, etag, content: prepared.content, permalink });
}

export async function replaceNote(
  c: R2Client,
  cfg: VaultConfig,
  args: { path: string; content: string },
): Promise<ToolResult<{ path: string; etag: string; content: string; permalink: string | null }>> {
  const existing = await c.get(args.path);
  if (existing === null) return err("not_found", { path: args.path });
  // Preserve the existing id if there is one; otherwise mint or accept the
  // caller's id. This makes id-stripping or id-changing impossible from a
  // replaceNote call — external links keyed on the id remain stable.
  const preservedId = extractIdFromFrontmatter(existing);
  let content: string;
  let finalId: string | null;
  try {
    if (preservedId !== null) {
      content = setIdInFrontmatter(args.content, preservedId);
      finalId = preservedId;
    } else {
      const prepared = ensureIdInFrontmatter(args.content, generateNoteId);
      content = prepared.content;
      finalId = prepared.id;
    }
  } catch (e) {
    if (e instanceof MalformedFrontmatterError) {
      return err("malformed_frontmatter", { path: args.path });
    }
    throw e;
  }
  const etag = await c.put(args.path, content);
  const permalink = buildPermalink(cfg.permalinkBaseUrl, args.path, finalId);
  return ok({ path: args.path, etag, content, permalink });
}

export async function replaceBody(
  c: R2Client,
  cfg: VaultConfig,
  args: { path: string; body: string },
): Promise<ToolResult<{ path: string; etag: string; content: string; permalink: string | null }>> {
  const existing = await c.get(args.path);
  if (existing === null) return err("not_found", { path: args.path });
  let split;
  try {
    split = splitFrontmatterRaw(existing);
  } catch (e) {
    if (e instanceof MalformedFrontmatterError) {
      return err("malformed_frontmatter", { path: args.path });
    }
    throw e;
  }
  const content = split.frontmatter === null ? args.body : split.frontmatter + args.body;
  const etag = await c.put(args.path, content);
  const id = extractIdFromFrontmatter(content);
  const permalink = buildPermalink(cfg.permalinkBaseUrl, args.path, id);
  return ok({ path: args.path, etag, content, permalink });
}

export async function deleteNote(
  c: R2Client,
  _cfg: VaultConfig,
  args: { path: string },
): Promise<void> {
  await c.delete(args.path);
}

export interface MoveNoteSuccess {
  from: string;
  to: string;
  links_updated: number;
  notes_modified: { path: string; etag: string; content: string }[];
  moved: { path: string; etag: string; content: string };
}

export async function moveNote(
  c: R2Client,
  _cfg: VaultConfig,
  index: VaultIndex,
  args: { from_path: string; to_path: string },
): Promise<ToolResult<MoveNoteSuccess>> {
  const from = args.from_path;
  const to = args.to_path;
  if (from === to) return err("same_path", { path: from });
  const sourceBody = await c.get(from);
  if (sourceBody === null) return err("not_found", { from_path: from });
  if (await c.head(to)) return err("exists", { to_path: to });

  const candidates = await index.findReferrersFor(from);
  // Plan rewrites for every referring note (excluding the moved note itself —
  // its self-references are handled in the moved body below).
  const planned: { path: string; oldContent: string; newContent: string; count: number }[] = [];
  for (const path of candidates) {
    if (path === from) continue;
    const body = await c.get(path);
    if (body === null) continue;
    const result = rewriteWikilinksForMove(body, from, to);
    if (result.changed) {
      planned.push({ path, oldContent: body, newContent: result.content, count: result.count });
    }
  }

  // Rewrite self-references inside the moved file.
  const movedRewrite = rewriteWikilinksForMove(sourceBody, from, to);
  const movedContent = movedRewrite.changed ? movedRewrite.content : sourceBody;

  // Commit with best-effort rollback. R2 has no transactional API, so a crash
  // after some writes have landed will leave partial state — we track every
  // successful write and revert in reverse order on failure.
  const written: { path: string; previousContent: string | null }[] = [];
  try {
    await c.put(to, movedContent);
    written.push({ path: to, previousContent: null });
    const notes_modified: { path: string; etag: string; content: string }[] = [];
    for (const p of planned) {
      const etag = await c.put(p.path, p.newContent);
      written.push({ path: p.path, previousContent: p.oldContent });
      notes_modified.push({ path: p.path, etag, content: p.newContent });
    }
    await c.delete(from);
    // Re-stat `to` to get the etag for the moved file (we discarded the first put's etag).
    // Cheap: the put just happened so the head is in R2's strongly-consistent path.
    const head = await c.head(to);
    const movedEtag = head?.etag ?? "";
    const links_updated =
      (movedRewrite.changed ? movedRewrite.count : 0) +
      planned.reduce((acc, p) => acc + p.count, 0);
    return ok({
      from,
      to,
      links_updated,
      notes_modified,
      moved: { path: to, etag: movedEtag, content: movedContent },
    });
  } catch (e) {
    for (let i = written.length - 1; i >= 0; i--) {
      const w = written[i];
      try {
        if (w.previousContent === null) {
          await c.delete(w.path);
        } else {
          await c.put(w.path, w.previousContent);
        }
      } catch {
        // Rollback is best-effort; nothing further we can do here.
      }
    }
    throw e;
  }
}

export async function patchNote(
  c: R2Client,
  cfg: VaultConfig,
  args: { path: string; old_str: string; new_str: string; replace_all?: boolean },
): Promise<
  ToolResult<{
    path: string;
    count: number;
    etag: string;
    content: string;
    permalink: string | null;
  }>
> {
  if (args.old_str === args.new_str) return err("no_op", { path: args.path });

  const body = await c.get(args.path);
  if (body === null) return err("not_found", { path: args.path });

  const parts = body.split(args.old_str);
  const count = parts.length - 1;
  if (count === 0) {
    return err("anchor_not_found", {
      path: args.path,
      old_str_prefix: args.old_str.slice(0, 80),
    });
  }
  if (count > 1 && !args.replace_all) {
    return err("ambiguous", { path: args.path, count });
  }

  // Always go through parts.join — String.prototype.replace(string, string)
  // interprets $`, $', $&, $$, and $n in the replacement, which would corrupt
  // any new_str containing those sequences. Array.join concatenates literally
  // with no substitution layer. Single-replace case (count === 1) gives
  // parts[0] + new_str + parts[1], identical to a non-metacharacter replace.
  const next = parts.join(args.new_str);
  const etag = await c.put(args.path, next);
  const id = extractIdFromFrontmatter(next);
  const permalink = buildPermalink(cfg.permalinkBaseUrl, args.path, id);
  return ok({ path: args.path, count, etag, content: next, permalink });
}
