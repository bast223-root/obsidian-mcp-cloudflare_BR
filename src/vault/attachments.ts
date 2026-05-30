import { type ToolResult, type VaultConfig, err, ok } from "../types";

// Pure helpers for attachment handling — no I/O. Mirrors `markdown.ts` in style.
// All filesystem-ish reasoning (MIME, extensions, path policy, embed markdown)
// lives here so the tool implementations in `mcp/tools/attachments.ts` stay thin
// and these rules are unit-testable without R2.

/** Default extension allowlist when ATTACHMENT_ALLOWED_EXTENSIONS is unset/empty. */
export const DEFAULT_ATTACHMENT_EXTENSIONS = "png,jpg,jpeg,gif,webp,svg,pdf";

// Extension → MIME. Covers the default allowlist plus the documented "broaden"
// set. Anything not listed falls back to application/octet-stream.
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
};

// MIME → canonical extension. Used by the URL-fetch path when the URL carries no
// usable extension but the response Content-Type does. jpeg → jpg is canonical.
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/zip": "zip",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
};

/** Normalize an extension: lowercased, leading dot stripped. */
function normalizeExt(ext: string): string {
  return ext.toLowerCase().replace(/^\.+/, "");
}

/** True for ASCII control characters (0x00–0x1f) and DEL (0x7f). */
function isControlChar(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    if (!isControlChar(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (isControlChar(s.charCodeAt(i))) return true;
  }
  return false;
}

/** Extension of a filename without the dot, lowercased. "" when none or leading-dot only. */
export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return ""; // no dot, or a leading-dot "hidden" name with no real ext
  return filename.slice(dot + 1).toLowerCase();
}

export function extensionToMime(ext: string): string {
  return EXT_TO_MIME[normalizeExt(ext)] ?? "application/octet-stream";
}

export function mimeToExtension(mime: string): string | null {
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[base] ?? null;
}

export function isImageMime(mime: string): boolean {
  return mime.split(";")[0].trim().toLowerCase().startsWith("image/");
}

/** Parse a CSV allowlist into a Set of lowercased, dot-stripped extensions. */
export function parseExtensionAllowlist(csv: string): Set<string> {
  const out = new Set<string>();
  for (const raw of csv.split(",")) {
    const e = normalizeExt(raw.trim());
    if (e) out.add(e);
  }
  return out;
}

/**
 * Resolve the *effective* attachment allowlist: the configured CSV, or the
 * built-in default when that CSV is empty. The upload POST handler, the
 * embed-co-move path, and the upload page's file-picker hint must all agree on
 * what is allowed, so they all go through here rather than re-inlining the
 * trim/default rule (which is exactly how the picker drifted out of sync).
 */
export function resolveAttachmentAllowlist(configuredCsv: string): Set<string> {
  return parseExtensionAllowlist(
    configuredCsv.trim() ? configuredCsv : DEFAULT_ATTACHMENT_EXTENSIONS,
  );
}

/**
 * Build a file-input `accept` value from an extension allowlist. Emits both the
 * dotted extension (`.pptx`) and, where the MIME is known, the MIME type:
 * Android Chrome filters the picker on extension, iOS Safari on MIME type, so
 * listing both is what lets every allowed file through on mobile. Extensions
 * with no MIME mapping still get their dotted token. The `accept` attribute is
 * only a picker hint — the server's allowlist remains the authoritative gate —
 * so a too-broad value is harmless, but a too-narrow one silently blocks
 * legitimate files on mobile, which is the bug this prevents.
 */
export function buildAcceptAttribute(allowlist: Set<string>): string {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    if (!seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  };
  for (const ext of allowlist) {
    add(`.${ext}`);
    const mime = EXT_TO_MIME[ext];
    if (mime) add(mime);
  }
  return tokens.join(",");
}

/**
 * Assert a filename's extension is in the allowlist. On success returns the
 * resolved extension and its MIME type; on rejection returns a typed error
 * carrying the offending extension and the sorted allowed set so the AI caller
 * can self-correct.
 */
export function assertAllowedExtension(
  filename: string,
  allowlist: Set<string>,
): ToolResult<{ ext: string; mime: string }> {
  const ext = getExtension(filename);
  if (!ext || !allowlist.has(ext)) {
    return err("disallowed_extension", { ext, allowed: [...allowlist].sort() });
  }
  return ok({ ext, mime: extensionToMime(ext) });
}

/**
 * Sanitize a caller-supplied filename to a safe single path segment. Drops any
 * smuggled directory components, control characters, and leading dots (no hidden
 * files, no `..`); replaces other non-ASCII-friendly characters with `_`.
 * Rejects names that reduce to empty.
 */
export function sanitizeFilename(name: string): ToolResult<string> {
  if (typeof name !== "string") return err("invalid_filename", { name: String(name) });
  // Keep only the last path segment — a caller passing "a/b/evil.png" gets "evil.png".
  let base = name.split(/[/\\]/).pop() ?? "";
  base = stripControlChars(base);
  base = base.trim();
  base = base.replace(/^\.+/, ""); // strip leading dots (rejects ".", "..", ".env")
  if (base === "") return err("invalid_filename", { name });
  // ASCII-friendly fallback: allow letters, digits, dot, space, hyphen, underscore,
  // parentheses (common in screenshot names); collapse everything else to "_".
  base = base.replace(/[^A-Za-z0-9._ \-()]/g, "_");
  base = base.trim();
  if (base === "" || base === "..") return err("invalid_filename", { name });
  return ok(base);
}

/** Last path segment of a URL if it carries a file extension, else null. */
export function deriveFilenameFromUrl(url: URL): string | null {
  const seg = url.pathname.split("/").filter(Boolean).pop();
  if (!seg) return null;
  let decoded = seg;
  try {
    decoded = decodeURIComponent(seg);
  } catch {
    // leave as-is if not valid percent-encoding
  }
  return getExtension(decoded) ? decoded : null;
}

/** Directory portion of a vault path ("" when the path is at the root). */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Join path segments with "/", dropping empties and collapsing slashes. */
export function joinPath(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/^\/+|\/+$/g, ""))
    .filter((s) => s.length > 0)
    .join("/");
}

/** True when `path` lives inside `dir` (dir === "" means the vault root). */
export function isUnderDir(path: string, dir: string): boolean {
  return dir === "" ? true : path.startsWith(dir + "/");
}

/**
 * Validate an assembled or caller-supplied vault path. Mirrors the AttachmentPath
 * Zod schema and `R2Client.toKey` defenses, but returns a typed result so the
 * tool can surface a clean reason. Rejects `..`, leading `/`, backslashes,
 * control chars, empty, and over-long paths.
 */
function validateAttachmentPath(path: string): ToolResult<string> {
  if (path.length === 0 || path.length > 1024) {
    return err("invalid_path", { path });
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes("..") || hasControlChar(path)) {
    return err("invalid_path", { path });
  }
  return ok(path);
}

export interface ResolveAttachmentPathArgs {
  target_note?: string;
  subfolder?: string;
  filename: string;
  dest_path?: string;
}

/**
 * Central path-policy logic. Encodes the three ATTACHMENTS_PATH_MODE modes.
 * A non-empty `dest_path` overrides everything (still validated). Otherwise the
 * filename is sanitized and combined with a subfolder per the active mode:
 *   - per_note_subfolder: <target_note's folder>/<subfolder>/<filename>
 *     (falls back to <subfolder>/<filename> at the vault root when no target_note)
 *   - vault_default:       <subfolder>/<filename>  (vault-rooted, target_note ignored)
 *   - caller_specified:    <subfolder>/<filename>  where subfolder is the caller's
 *     `subfolder` arg verbatim (cfg subfolder ignored); vault root when omitted.
 */
export function resolveAttachmentPath(
  cfg: VaultConfig,
  args: ResolveAttachmentPathArgs,
): ToolResult<string> {
  if (args.dest_path && args.dest_path.trim() !== "") {
    return validateAttachmentPath(args.dest_path.trim());
  }

  const fn = sanitizeFilename(args.filename);
  if (!fn.ok) return fn;
  const filename = fn.value;

  let assembled: string;
  switch (cfg.attachmentsPathMode) {
    case "vault_default": {
      const subfolder = args.subfolder ?? cfg.attachmentsSubfolder;
      assembled = joinPath(subfolder, filename);
      break;
    }
    case "caller_specified": {
      // Caller owns the folder; the configured default subfolder does not apply.
      assembled = joinPath(args.subfolder ?? "", filename);
      break;
    }
    case "per_note_subfolder":
    default: {
      const subfolder = args.subfolder ?? cfg.attachmentsSubfolder;
      const baseDir = args.target_note ? dirOf(args.target_note) : "";
      assembled = joinPath(baseDir, subfolder, filename);
      break;
    }
  }
  return validateAttachmentPath(assembled);
}

/**
 * Build embed markdown for an attachment so the AI can paste it into a note.
 *   - wikilink (default): `![[files/diagram.png]]`
 *   - markdown:           `![diagram](files/diagram.png)`
 * When `fromNotePath` is supplied and the attachment lives under the note's
 * folder, the link is shortened to the path relative to that folder — the form
 * Obsidian renders cleanly. Otherwise the full vault-relative path is used.
 */
export function buildEmbedMarkdown(
  attachmentPath: string,
  fromNotePath: string | null,
  style: "wikilink" | "markdown",
): string {
  const rel = relativeForEmbed(attachmentPath, fromNotePath);
  if (style === "markdown") {
    const slash = rel.lastIndexOf("/");
    const basename = slash === -1 ? rel : rel.slice(slash + 1);
    const display = basename.replace(/\.[^.]+$/, "");
    const href = rel.split("/").map(encodeURIComponent).join("/");
    return `![${display}](${href})`;
  }
  return `![[${rel}]]`;
}

/**
 * The embed target text Obsidian renders cleanly for an attachment referenced
 * from a given note: the path relative to the note's folder when the attachment
 * is nested under it, otherwise the full vault-relative path.
 */
export function relativeForEmbed(attachmentPath: string, fromNotePath: string | null): string {
  if (!fromNotePath) return attachmentPath;
  const fromDir = dirOf(fromNotePath);
  if (fromDir && attachmentPath.startsWith(fromDir + "/")) {
    return attachmentPath.slice(fromDir.length + 1);
  }
  return attachmentPath;
}

/**
 * Candidate vault paths a wikilink/embed `target` could resolve to, given the
 * referring note's folder and the configured attachments subfolder. The caller
 * tries each (cheap `headBinary`) and takes the first that exists. Order:
 *   - target with a slash: note-relative, then vault-rooted.
 *   - bare basename: note's subfolder, then note's folder, then vault root
 *     (covers Obsidian's name-only resolution into a `files/` subfolder).
 * Invalid (traversal/leading-slash) candidates are dropped.
 */
export function attachmentResolutionCandidates(
  target: string,
  fromDir: string,
  subfolder: string,
): string[] {
  const raw = target.includes("/")
    ? [joinPath(fromDir, target), target]
    : [joinPath(fromDir, subfolder, target), joinPath(fromDir, target), target];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (validateAttachmentPath(p).ok) out.push(p);
  }
  return out;
}

/** True if a host should never be fetched (loopback, link-local, IP literals). */
export function isDisallowedAttachmentHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "" || h === "localhost") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  // IPv6 literal — URL.hostname keeps brackets, and any colon implies IPv6.
  if (h.startsWith("[") || h.includes(":")) return true;
  // Dotted-decimal IPv4.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  // Integer- or hex-form IPv4 (e.g. 2130706433, 0x7f000001).
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) return true;
  return false;
}

/**
 * Validate a URL for the server-side fetch path: HTTPS only, no IP-literal or
 * loopback/link-local host (SSRF denylist), AND the host must appear in
 * `hostAllowlist`. The allowlist is **default-closed**: an empty set rejects
 * every host (`host_not_allowed`), so the URL-fetch path does nothing until an
 * operator opts specific hosts in via ATTACHMENT_FETCH_HOST_ALLOWLIST. The SSRF
 * denylist takes precedence over the allowlist, so an IP literal still reports
 * `disallowed_host` even if someone lists it. This is run on the initial URL AND
 * on every redirect target (the fetch loop uses `redirect: "manual"`), so both
 * guards cover the whole chain rather than just the first hop.
 */
export function validateAttachmentSourceUrl(
  raw: string,
  hostAllowlist: Set<string>,
): ToolResult<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err("invalid_url", { url: raw });
  }
  if (url.protocol !== "https:") return err("insecure_url", { protocol: url.protocol });
  if (isDisallowedAttachmentHost(url.hostname)) return err("disallowed_host", { host: url.hostname });
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostAllowlist.has(host)) {
    return err("host_not_allowed", { host: url.hostname, allowed: [...hostAllowlist].sort() });
  }
  return ok(url);
}

/** Parse a CSV host allowlist into a Set of lowercased, trailing-dot-stripped hostnames. */
export function parseHostAllowlist(csv: string): Set<string> {
  const out = new Set<string>();
  for (const raw of csv.split(",")) {
    const h = raw.trim().toLowerCase().replace(/\.$/, "");
    if (h) out.add(h);
  }
  return out;
}
