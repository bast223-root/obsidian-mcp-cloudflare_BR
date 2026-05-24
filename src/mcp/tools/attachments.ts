import { ObjectExistsError, type R2Client } from "../../vault/r2-client";
import { type ToolResult, type VaultConfig, err, ok } from "../../types";
import type { VaultIndex } from "../../vault/index-store";
import { buildPermalink, rewriteEmbedTargetForMove } from "../../vault/markdown";
import {
  DEFAULT_ATTACHMENT_EXTENSIONS,
  assertAllowedExtension,
  buildEmbedMarkdown,
  deriveFilenameFromUrl,
  isImageMime,
  mimeToExtension,
  parseExtensionAllowlist,
  relativeForEmbed,
  resolveAttachmentPath,
  validateAttachmentSourceUrl,
} from "../../vault/attachments";

/** Resolve the active extension allowlist, falling back to the built-in default. */
function allowlistFor(cfg: VaultConfig): Set<string> {
  const csv = cfg.attachmentAllowedExtensions.trim()
    ? cfg.attachmentAllowedExtensions
    : DEFAULT_ATTACHMENT_EXTENSIONS;
  return parseExtensionAllowlist(csv);
}

export interface UploadResult {
  path: string;
  embed_markdown: string;
  permalink: string | null;
  etag: string;
  size: number;
  content_type: string;
}

export async function finalizeUpload(
  c: R2Client,
  cfg: VaultConfig,
  args: { target_note?: string; subfolder?: string; dest_path?: string; overwrite?: boolean },
  filename: string,
  bytes: Buffer | Uint8Array,
  contentTypeHint: string | null,
): Promise<ToolResult<UploadResult>> {
  if (bytes.byteLength > cfg.attachmentMaxBytes) {
    return err("too_large", { size: bytes.byteLength, max: cfg.attachmentMaxBytes });
  }
  const pathR = resolveAttachmentPath(cfg, { ...args, filename });
  if (!pathR.ok) return pathR;
  const path = pathR.value;

  const extR = assertAllowedExtension(path, allowlistFor(cfg));
  if (!extR.ok) return extR;
  const contentType = contentTypeHint?.trim() ? contentTypeHint.trim() : extR.value.mime;

  try {
    const { etag, size } = await c.putBinary(path, bytes, contentType, {
      onlyIfNotExists: !args.overwrite,
    });
    return ok({
      path,
      embed_markdown: buildEmbedMarkdown(path, args.target_note ?? null, "wikilink"),
      permalink: buildPermalink(cfg.permalinkBaseUrl, path, null),
      etag,
      size,
      content_type: contentType,
    });
  } catch (e) {
    if (e instanceof ObjectExistsError) return err("exists", { path });
    throw e;
  }
}

export interface UploadUrlArgs {
  source_url: string;
  filename?: string;
  target_note?: string;
  subfolder?: string;
  overwrite?: boolean;
  dest_path?: string;
}

const MAX_REDIRECTS = 5;

/**
 * Fetch an HTTPS asset server-side and store it as an attachment. SSRF guards:
 * HTTPS only, no IP-literal/loopback host, validated on every redirect hop
 * (manual redirect handling, capped at MAX_REDIRECTS). HTML responses and
 * oversize bodies (Content-Length or actual) are rejected. `fetchFn` is
 * injectable for testing. Filename precedence: explicit arg → URL basename →
 * `attachment-<ts>.<ext>` derived from the response Content-Type.
 */
export async function uploadAttachmentUrl(
  c: R2Client,
  cfg: VaultConfig,
  args: UploadUrlArgs,
  fetchFn: typeof fetch = fetch,
): Promise<ToolResult<UploadResult>> {
  const urlR = validateAttachmentSourceUrl(args.source_url);
  if (!urlR.ok) return urlR;

  let url = urlR.value;
  let resp: Response;
  for (let hop = 0; ; hop++) {
    resp = await fetchFn(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(cfg.attachmentUrlTimeoutMs),
    });
    if (resp.status < 300 || resp.status >= 400) break;
    const location = resp.headers.get("location");
    if (!location) return err("bad_redirect", { status: resp.status });
    if (hop >= MAX_REDIRECTS) return err("too_many_redirects");
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return err("invalid_url", { url: location });
    }
    const reval = validateAttachmentSourceUrl(next.toString());
    if (!reval.ok) return reval;
    url = next;
  }

  if (resp.status !== 200) return err("fetch_failed", { status: resp.status });

  const rawCt = resp.headers.get("content-type") ?? "";
  const ctBase = rawCt.split(";")[0].trim().toLowerCase();
  if (ctBase === "text/html") return err("html_response", { content_type: rawCt });

  const contentLength = resp.headers.get("content-length");
  if (contentLength && Number(contentLength) > cfg.attachmentMaxBytes) {
    return err("too_large", { size: Number(contentLength), max: cfg.attachmentMaxBytes });
  }

  const buf = await resp.arrayBuffer();
  if (buf.byteLength > cfg.attachmentMaxBytes) {
    return err("too_large", { size: buf.byteLength, max: cfg.attachmentMaxBytes });
  }

  let filename = args.filename ?? deriveFilenameFromUrl(url) ?? undefined;
  if (!filename) {
    const ext = mimeToExtension(rawCt);
    if (!ext) return err("no_extension_inferable", { content_type: rawCt });
    filename = `attachment-${Date.now()}.${ext}`;
  }

  // A meaningful Content-Type wins; octet-stream / empty defers to the
  // extension-derived MIME inside finalizeUpload.
  const contentTypeHint = ctBase && ctBase !== "application/octet-stream" ? ctBase : null;
  return finalizeUpload(c, cfg, args, filename, new Uint8Array(buf), contentTypeHint);
}

export interface ReadAttachmentResult {
  path: string;
  size: number;
  content_type: string;
  etag: string;
  is_image: boolean;
  data_base64: string;
}

export async function readAttachment(
  c: R2Client,
  cfg: VaultConfig,
  args: { path: string },
): Promise<ToolResult<ReadAttachmentResult>> {
  // Guard against serving arbitrary synced objects (e.g. a `.env` someone
  // dropped in the vault) — only allowlisted extensions are readable.
  const extR = assertAllowedExtension(args.path, allowlistFor(cfg));
  if (!extR.ok) return extR;
  const obj = await c.getBinary(args.path);
  if (!obj) return err("not_found", { path: args.path });
  return ok({
    path: args.path,
    size: obj.size,
    content_type: obj.contentType,
    etag: obj.etag,
    is_image: isImageMime(obj.contentType),
    data_base64: Buffer.from(obj.body).toString("base64"),
  });
}

export interface HeadAttachmentResult {
  path: string;
  size: number;
  content_type: string;
  etag: string;
  uploaded: string;
}

export async function headAttachment(
  c: R2Client,
  _cfg: VaultConfig,
  args: { path: string },
): Promise<ToolResult<HeadAttachmentResult>> {
  const meta = await c.headBinary(args.path);
  if (!meta) return err("not_found", { path: args.path });
  return ok({
    path: args.path,
    size: meta.size,
    content_type: meta.contentType,
    etag: meta.etag,
    uploaded: meta.uploaded.toISOString(),
  });
}

export interface AttachmentListItem {
  path: string;
  size: number;
  content_type: string;
  etag: string;
  uploaded: string;
}

export async function listAttachments(
  c: R2Client,
  _cfg: VaultConfig,
  args: { prefix?: string; limit?: number; cursor?: string },
): Promise<{ items: AttachmentListItem[]; cursor: string | null }> {
  const { items, cursor } = await c.listBinaries(args.prefix, {
    limit: args.limit,
    cursor: args.cursor,
  });
  return {
    items: items.map((i) => ({
      path: i.path,
      size: i.size,
      content_type: i.contentType,
      etag: i.etag,
      uploaded: i.uploaded.toISOString(),
    })),
    cursor,
  };
}

export async function deleteAttachment(
  c: R2Client,
  cfg: VaultConfig,
  args: { path: string },
): Promise<ToolResult<{ path: string; deleted: true }>> {
  // Extra guard: refuse to delete anything outside the allowlist so a stray
  // `delete_attachment("Daily Notes/2026-05-23.md")` can't nuke a note.
  const extR = assertAllowedExtension(args.path, allowlistFor(cfg));
  if (!extR.ok) return extR;
  await c.delete(args.path);
  return ok({ path: args.path, deleted: true });
}

export interface MoveAttachmentResult {
  from: string;
  to: string;
  embed_markdown: string;
  etag: string;
  size: number;
  content_type: string;
  /** Notes whose embeds were rewritten to the new path. */
  notes_modified: { path: string; etag: string; content: string }[];
}

/**
 * Move or rename an attachment entirely server-side (R2 copy-then-delete) — the
 * way to relocate a large file without round-tripping its bytes through a tool
 * call. Both paths must be allowlisted (so a note can't be moved via this tool).
 * Non-clobber unless `overwrite`. By default it also rewrites embeds in notes
 * that referenced the old path (relative or vault-rooted form → the new path's
 * note-relative form), using the wikilink index — pass `update_embeds: false` to
 * move bytes only. Fails with reason='same_path', 'not_found', 'exists', or
 * 'disallowed_extension'.
 */
export async function moveAttachment(
  c: R2Client,
  cfg: VaultConfig,
  index: VaultIndex,
  args: { from_path: string; to_path: string; overwrite?: boolean; update_embeds?: boolean },
): Promise<ToolResult<MoveAttachmentResult>> {
  if (args.from_path === args.to_path) return err("same_path", { path: args.from_path });
  const allow = allowlistFor(cfg);
  const fromExt = assertAllowedExtension(args.from_path, allow);
  if (!fromExt.ok) return fromExt;
  const toExt = assertAllowedExtension(args.to_path, allow);
  if (!toExt.ok) return toExt;

  const obj = await c.getBinary(args.from_path);
  if (!obj) return err("not_found", { path: args.from_path });

  let etag: string;
  let size: number;
  try {
    const put = await c.putBinary(args.to_path, obj.body, obj.contentType, {
      onlyIfNotExists: !args.overwrite,
    });
    etag = put.etag;
    size = put.size;
    await c.delete(args.from_path);
  } catch (e) {
    if (e instanceof ObjectExistsError) return err("exists", { path: args.to_path });
    throw e;
  }

  // Rewrite embeds in any note that referenced the old path so the link follows
  // the file. Bytes are already moved; an unrewritten note simply keeps pointing
  // at the now-missing path (best-effort, same as move_note).
  const notes_modified: { path: string; etag: string; content: string }[] = [];
  if (args.update_embeds !== false) {
    const referrers = await index.findReferrersFor(args.from_path);
    for (const notePath of referrers) {
      const body = await c.get(notePath);
      if (body === null) continue;
      const newRel = relativeForEmbed(args.to_path, notePath);
      // Rewrite both the note-relative and vault-rooted forms of the old target.
      let updated = body;
      for (const oldForm of new Set([relativeForEmbed(args.from_path, notePath), args.from_path])) {
        if (oldForm === newRel) continue;
        updated = rewriteEmbedTargetForMove(updated, oldForm, newRel).content;
      }
      if (updated !== body) {
        const noteEtag = await c.put(notePath, updated);
        notes_modified.push({ path: notePath, etag: noteEtag, content: updated });
      }
    }
  }

  return ok({
    from: args.from_path,
    to: args.to_path,
    embed_markdown: buildEmbedMarkdown(args.to_path, null, "wikilink"),
    etag,
    size,
    content_type: obj.contentType,
    notes_modified,
  });
}
