import type { R2Client } from "../../vault/r2-client";
import { type ToolResult, type VaultConfig, err, ok } from "../../types";
import type { VaultIndex } from "../../vault/index-store";
import { log } from "../../log";
import {
  MalformedFrontmatterError,
  buildPermalink,
  ensureIdInFrontmatter,
  extractIdFromFrontmatter,
  extractWikilinks,
  generateNoteId,
  rewriteEmbedTargetForMove,
  rewriteWikilinksForMove,
  setIdInFrontmatter,
  splitFrontmatterRaw,
} from "../../vault/markdown";
import {
  DEFAULT_ATTACHMENT_EXTENSIONS,
  attachmentResolutionCandidates,
  dirOf,
  getExtension,
  isUnderDir,
  joinPath,
  parseExtensionAllowlist,
  relativeForEmbed,
} from "../../vault/attachments";

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
  attachments_moved: { from: string; to: string }[];
}

export async function moveNote(
  c: R2Client,
  cfg: VaultConfig,
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

  // Co-move attachments uniquely embedded by this note (opt-in). Bytes are moved
  // BEFORE the note commit; an embed is only rewritten for an attachment whose
  // byte-move succeeded, so a skipped move leaves the embed pointing at the
  // still-present original (no broken link). The note commit below is the last,
  // best-effort-atomic step.
  const attachments_moved = await comoveAttachments(c, cfg, index, from, to, sourceBody);

  // Rewrite self-references inside the moved file (.md wikilinks) and any
  // attachment embeds whose target changed after the co-move.
  const movedRewrite = rewriteWikilinksForMove(sourceBody, from, to);
  let movedContent = movedRewrite.changed ? movedRewrite.content : sourceBody;
  for (const a of attachments_moved) {
    const newTarget = relativeForEmbed(a.to, to);
    movedContent = rewriteEmbedTargetForMove(movedContent, a.oldTarget, newTarget).content;
  }

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
      attachments_moved: attachments_moved.map((a) => ({ from: a.from, to: a.to })),
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

interface ComovedAttachment {
  from: string;
  to: string;
  /** The exact embed target text in the source note, for the body rewrite. */
  oldTarget: string;
}

/**
 * Find attachments uniquely embedded by the moving note and relocate their bytes
 * under the destination note's folder. Bounded: only the moving note's body is
 * scanned for candidate targets; each candidate costs a few `headBinary` calls
 * plus one `findReferrersFor` index query. Honors `ATTACHMENTS_MOVE_WITH_NOTE`.
 * Constraints that keep it safe:
 *   - only allowlisted (non-`.md`) targets,
 *   - only attachments nested under the from-note's folder (re-rooted under the
 *     to-note's folder, preserving any subfolder structure),
 *   - only attachments referenced by no other note (uniquely owned),
 *   - per-attachment errors are logged and skipped, never failing the move.
 */
async function comoveAttachments(
  c: R2Client,
  cfg: VaultConfig,
  index: VaultIndex,
  from: string,
  to: string,
  sourceBody: string,
): Promise<ComovedAttachment[]> {
  if (cfg.attachmentsMoveWithNote === "never") return [];
  const allow = parseExtensionAllowlist(
    cfg.attachmentAllowedExtensions.trim()
      ? cfg.attachmentAllowedExtensions
      : DEFAULT_ATTACHMENT_EXTENSIONS,
  );
  const fromDir = dirOf(from);
  const toDir = dirOf(to);
  const moved: ComovedAttachment[] = [];
  const seen = new Set<string>();

  for (const target of extractWikilinks(sourceBody)) {
    if (seen.has(target)) continue;
    seen.add(target);
    const ext = getExtension(target);
    if (!ext || !allow.has(ext)) continue; // notes & non-allowlisted targets

    // Resolve the embed target to a real object (first existing candidate wins).
    let realOld: string | null = null;
    for (const cand of attachmentResolutionCandidates(target, fromDir, cfg.attachmentsSubfolder)) {
      if (await c.headBinary(cand)) {
        realOld = cand;
        break;
      }
    }
    if (!realOld) continue;
    if (!isUnderDir(realOld, fromDir)) continue; // only co-move nested attachments

    // Uniquely owned? Any other referring note means leave it in place.
    const referrers = await index.findReferrersFor(realOld);
    if (referrers.some((p) => p !== from)) continue;

    const rel = fromDir ? realOld.slice(fromDir.length + 1) : realOld;
    const newPath = joinPath(toDir, rel);
    if (newPath === realOld) continue; // root-to-root rename; nothing to move

    try {
      const obj = await c.getBinary(realOld);
      if (!obj) continue;
      await c.putBinary(newPath, obj.body, obj.contentType, { onlyIfNotExists: true });
      await c.delete(realOld);
      moved.push({ from: realOld, to: newPath, oldTarget: target });
    } catch (e) {
      log.warn("attachment_comove_skipped", {
        from: realOld,
        to: newPath,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return moved;
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
