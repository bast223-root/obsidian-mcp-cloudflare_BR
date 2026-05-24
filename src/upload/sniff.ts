import { type ToolResult, err, ok } from "../types";
import { extensionToMime, getExtension, mimeToExtension } from "../vault/attachments";

// Content-type detection from the leading bytes of an uploaded file. Only the
// types this server is meant to store as binary are recognized; anything else
// returns null and the caller falls back to the (sanitized) filename extension.
// Pure — no I/O.

/** Extensions whose content we can verify by magic bytes. */
const SNIFFABLE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "pdf"]);

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** Detect a supported MIME type from leading bytes, or null if unrecognized. */
export function sniffMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"; // GIF8(7|9)a
  // WEBP: "RIFF" .... "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  return null;
}

/** Replace (or append) a filename's extension with `ext`. */
function withExtension(filename: string, ext: string): string {
  const dot = filename.lastIndexOf(".");
  const base = dot <= 0 ? filename : filename.slice(0, dot);
  return `${base}.${ext}`;
}

/**
 * Reconcile an uploaded file's claimed name against its actual bytes and the
 * extension allowlist. The bytes are authoritative:
 *   - Recognized bytes → store with the sniffed type; if the claimed extension
 *     disagrees, the stored filename's extension is corrected (e.g. a JPEG named
 *     `.png` becomes `.jpg`).
 *   - Unrecognized bytes whose claimed extension is one we *could* have sniffed
 *     (png/jpg/gif/webp/pdf) → reject as `content_mismatch` (a file claiming to
 *     be an image/PDF that isn't — blocks e.g. an `.exe` renamed `.png`).
 *   - Unrecognized bytes with a non-sniffable allowed extension (svg/txt/…) →
 *     trust the extension (can't verify these cheaply).
 * The allowlist is always enforced against the final extension.
 */
export function reconcileUploadType(
  filename: string,
  bytes: Uint8Array,
  allowlist: Set<string>,
): ToolResult<{ filename: string; mime: string; ext: string }> {
  const claimedExt = getExtension(filename);
  const sniffed = sniffMime(bytes);

  if (sniffed) {
    const sniffedExt = mimeToExtension(sniffed) ?? claimedExt;
    const claimMatches = claimedExt !== "" && extensionToMime(claimedExt) === sniffed;
    const finalExt = claimMatches ? claimedExt : sniffedExt;
    const finalFilename = claimMatches ? filename : withExtension(filename, sniffedExt);
    if (!finalExt || !allowlist.has(finalExt)) {
      return err("disallowed_extension", { ext: finalExt, allowed: [...allowlist].sort() });
    }
    return ok({ filename: finalFilename, mime: sniffed, ext: finalExt });
  }

  // Bytes not recognized.
  if (SNIFFABLE_EXTENSIONS.has(claimedExt)) {
    return err("content_mismatch", { claimed_ext: claimedExt });
  }
  if (!claimedExt || !allowlist.has(claimedExt)) {
    return err("disallowed_extension", { ext: claimedExt, allowed: [...allowlist].sort() });
  }
  return ok({ filename, mime: extensionToMime(claimedExt), ext: claimedExt });
}
