import matter from "gray-matter";
import { customAlphabet } from "nanoid";

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

// 21-char URL-safe nanoid. Alphabet matches the resolver's `/n/` allowlist:
// ^[A-Za-z0-9_-]{21}$
const NANOID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const _nanoid = customAlphabet(NANOID_ALPHABET, 21);
export function generateNoteId(): string {
  return _nanoid();
}

// Extract id from a frontmatter block. Accepts any non-whitespace scalar value
// so we don't overwrite ids minted under a different scheme (manual UUIDs etc).
// Matched against the raw frontmatter, so body lines starting with `id:` are
// ignored.
const FRONTMATTER_ID_RE = /^id:\s*['"]?([^\s'"#]+?)['"]?\s*$/m;

export function extractIdFromFrontmatter(src: string): string | null {
  let split: FrontmatterSplit;
  try {
    split = splitFrontmatterRaw(src);
  } catch {
    return null;
  }
  if (split.frontmatter === null) return null;
  const m = split.frontmatter.match(FRONTMATTER_ID_RE);
  return m ? m[1] : null;
}

export interface EnsureIdResult {
  content: string;
  id: string;
  minted: boolean;
}

/**
 * Ensure the note has an `id:` field in its frontmatter. Byte-preserving for
 * any existing content:
 *   - Existing `id:` → return src unchanged, report the existing id.
 *   - Frontmatter present but no `id:` → inject `id: <newId>\n` immediately
 *     after the opening `---` fence, ahead of any other fields.
 *   - No frontmatter → prepend a minimal `---\nid: <newId>\n---\n\n` block.
 * `mintId` is a closure (not a direct generateNoteId call) so tests can supply
 * a deterministic id, and so callers like `replaceNote` can preserve an id
 * read from the existing file.
 */
export function ensureIdInFrontmatter(src: string, mintId: () => string): EnsureIdResult {
  const split = splitFrontmatterRaw(src);

  if (split.frontmatter !== null) {
    const existing = split.frontmatter.match(FRONTMATTER_ID_RE);
    if (existing) {
      return { content: src, id: existing[1], minted: false };
    }
    const fm = split.frontmatter;
    const usesCrLf = fm.startsWith("---\r\n");
    const openLen = usesCrLf ? 5 : 4;
    const eol = usesCrLf ? "\r\n" : "\n";
    const id = mintId();
    const newFm = fm.slice(0, openLen) + `id: ${id}${eol}` + fm.slice(openLen);
    return { content: newFm + split.body, id, minted: true };
  }

  const id = mintId();
  const fm = `---\nid: ${id}\n---\n\n`;
  return { content: fm + src, id, minted: true };
}

/**
 * Force-set `id:` in the frontmatter to `id`, replacing any existing value.
 * Used by `replaceNote` to make id-stripping (or id-changing) impossible from
 * the caller side: the existing id is read, then locked in here.
 *   - Existing id line matched → its value is rewritten to `id`.
 *   - Frontmatter exists, no id line → injected as the first field.
 *   - No frontmatter → fresh `---\nid: <id>\n---\n\n` block prepended.
 */
export function setIdInFrontmatter(src: string, id: string): string {
  const split = splitFrontmatterRaw(src);
  if (split.frontmatter !== null) {
    const fm = split.frontmatter;
    if (FRONTMATTER_ID_RE.test(fm)) {
      const usesCrLf = fm.startsWith("---\r\n");
      const eol = usesCrLf ? "\r\n" : "\n";
      const newFm = fm.replace(FRONTMATTER_ID_RE, `id: ${id}`);
      // FRONTMATTER_ID_RE matched a whole line, so the surrounding line endings
      // are preserved by replace(). No further handling needed beyond the eol
      // already in the source.
      void eol;
      return newFm + split.body;
    }
    const usesCrLf = fm.startsWith("---\r\n");
    const openLen = usesCrLf ? 5 : 4;
    const eol = usesCrLf ? "\r\n" : "\n";
    const newFm = fm.slice(0, openLen) + `id: ${id}${eol}` + fm.slice(openLen);
    return newFm + split.body;
  }
  return `---\nid: ${id}\n---\n\n${src}`;
}

export function parseNote(src: string): ParsedNote {
  const { data, content } = matter(src);
  return { frontmatter: data ?? {}, body: content };
}

/**
 * Build a short HTTP permalink for a note. Strategy:
 *   - `id` present       → `${baseUrl}/n/${id}?f=${slug}` (resolver looks up by
 *                          frontmatter id via Advanced URI; `f` is decorative
 *                          and ignored by the resolver — purely for human
 *                          readability when pasted into emails/tickets).
 *   - `id` null/empty    → `${baseUrl}/p/?path=${encoded path}` fallback. Works,
 *                          but breaks if the note is renamed; the caller is
 *                          encouraged to backfill an id.
 *   - `baseUrl` empty    → null (feature disabled).
 *
 * `path` is the vault-relative path WITH the `.md` extension. The slug derived
 * for `?f=` is `basename(path)` with `.md` stripped — directory segments are
 * dropped so the visible URL stays short.
 */
export function buildPermalink(
  baseUrl: string | undefined,
  path: string,
  id: string | null | undefined,
): string | null {
  if (!baseUrl) return null;
  const base = baseUrl.replace(/\/+$/, "");
  if (id) {
    const slash = path.lastIndexOf("/");
    const basename = slash === -1 ? path : path.slice(slash + 1);
    const slug = basename.replace(/\.md$/i, "");
    return `${base}/n/${encodeURIComponent(id)}?f=${encodeURIComponent(slug)}`;
  }
  return `${base}/p/?path=${encodeURIComponent(path)}`;
}

export interface FrontmatterSplit {
  frontmatter: string | null;
  body: string;
}

export class MalformedFrontmatterError extends Error {
  constructor() {
    super("malformed_frontmatter");
    this.name = "MalformedFrontmatterError";
  }
}

// String-level frontmatter boundary detection. Does NOT parse YAML.
// `frontmatter` (when present) includes the opening ---, the YAML body, the closing ---,
// and the newline that follows the closing fence. `body` is everything after that newline.
// Throws MalformedFrontmatterError when an opening --- has no closing ---.
export function splitFrontmatterRaw(src: string): FrontmatterSplit {
  if (!(src.startsWith("---\n") || src.startsWith("---\r\n"))) {
    return { frontmatter: null, body: src };
  }
  // Walk line-by-line preserving line endings.
  let i = src.indexOf("\n") + 1; // start of line 2 (after the opening --- line)
  while (i < src.length) {
    const nl = src.indexOf("\n", i);
    const end = nl === -1 ? src.length : nl;
    let lineEnd = end;
    if (end > i && src[end - 1] === "\r") lineEnd = end - 1;
    const line = src.slice(i, lineEnd);
    if (line.trimEnd() === "---") {
      // Frontmatter ends at the newline after this line (inclusive). If at EOF with no
      // trailing newline, the body is empty.
      const fmEnd = nl === -1 ? src.length : nl + 1;
      return { frontmatter: src.slice(0, fmEnd), body: src.slice(fmEnd) };
    }
    if (nl === -1) break;
    i = nl + 1;
  }
  throw new MalformedFrontmatterError();
}

function stripCodeFences(src: string): string {
  return src.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

export function extractTags(src: string): string[] {
  const { frontmatter, body } = parseNote(src);
  const tags = new Set<string>();
  const fm = frontmatter.tags;
  if (Array.isArray(fm)) {
    for (const t of fm) {
      if (typeof t === "string") tags.add(t.replace(/^#/, ""));
    }
  } else if (typeof fm === "string") {
    tags.add(fm.replace(/^#/, ""));
  }
  const stripped = stripCodeFences(body);
  for (const m of stripped.matchAll(/(?:^|\s)#([A-Za-z0-9_\-/]+)/g)) {
    tags.add(m[1]);
  }
  return [...tags];
}

export function extractWikilinks(src: string): string[] {
  const stripped = stripCodeFences(src);
  const out: string[] = [];
  for (const m of stripped.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    out.push(m[1].trim());
  }
  return out;
}

export interface MoveRewriteResult {
  changed: boolean;
  content: string;
  count: number;
}

/** Half-open [start, end) character ranges that should be excluded from rewriting. */
function maskedRanges(src: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  // Fenced code blocks (lazy match, must allow nested newlines).
  for (const m of src.matchAll(/```[\s\S]*?```/g)) {
    ranges.push({ start: m.index!, end: m.index! + m[0].length });
  }
  // Inline code spans (single-line backticks).
  for (const m of src.matchAll(/`[^`\n]*`/g)) {
    ranges.push({ start: m.index!, end: m.index! + m[0].length });
  }
  return ranges;
}

function offsetMasked(offset: number, ranges: { start: number; end: number }[]): boolean {
  for (const r of ranges) {
    if (offset >= r.start && offset < r.end) return true;
  }
  return false;
}

/**
 * Rewrite every wikilink in `src` whose target resolves to `fromPath` so that
 * it points at `toPath` instead. Preserves aliases, heading anchors, block
 * references, and embed (`!`) markers. Skips wikilinks inside fenced code
 * blocks and inline code spans. Apply replacements at known offsets — does
 * not reformat surrounding whitespace.
 */
export function rewriteWikilinksForMove(
  src: string,
  fromPath: string,
  toPath: string,
): MoveRewriteResult {
  const fromPathNoExt = fromPath.replace(/\.md$/i, "");
  const toPathNoExt = toPath.replace(/\.md$/i, "");
  const slash = fromPathNoExt.lastIndexOf("/");
  const fromBasename = slash === -1 ? fromPathNoExt : fromPathNoExt.slice(slash + 1);
  const masked = maskedRanges(src);

  const re = /\[\[([^\]|#]+)((?:[|#][^\]]*)?)\]\]/g;
  let result = "";
  let lastEnd = 0;
  let count = 0;
  for (const m of src.matchAll(re)) {
    const matchStart = m.index!;
    if (offsetMasked(matchStart, masked)) continue;
    const target = m[1].trim();
    const suffix = m[2] ?? "";
    const resolves =
      target === fromBasename || target === fromPathNoExt || target === fromPath;
    if (!resolves) continue;
    const newLink = "[[" + toPathNoExt + suffix + "]]";
    result += src.slice(lastEnd, matchStart) + newLink;
    lastEnd = matchStart + m[0].length;
    count++;
  }
  if (count === 0) return { changed: false, content: src, count: 0 };
  result += src.slice(lastEnd);
  return { changed: true, content: result, count };
}
