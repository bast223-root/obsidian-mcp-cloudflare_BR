import { splitFrontmatterRaw } from "./markdown";

export type FrontmatterScalar = string | number | boolean;

export interface EditFrontmatterArgs {
  set?: Record<string, FrontmatterScalar | FrontmatterScalar[]>;
  unset?: string[];
}

export interface EditFrontmatterResult {
  content: string;
  changedKeys: string[];
  removedKeys: string[];
}

/**
 * Raised when a targeted key holds a multi-line / block-style YAML value
 * (nested map, block list, or block scalar) that the line-level editor refuses
 * to touch rather than risk corrupting. The note is left unmodified.
 */
export class BlockValueError extends Error {
  constructor(public readonly key: string) {
    super("unsupported_block_value");
    this.name = "BlockValueError";
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Serialize a scalar to a single-line YAML value. Numbers and booleans are
 * emitted bare; strings are emitted plain only when unambiguously safe and are
 * otherwise double-quoted (JSON quoting is valid YAML double-quoted form). The
 * bias is to over-quote — a quoted string is always correct, an under-quoted one
 * can be misparsed.
 */
function serializeScalar(v: FrontmatterScalar): string {
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = v;
  const plainSafe =
    /^[A-Za-z0-9][A-Za-z0-9 _./-]*$/.test(s) &&
    s === s.trimEnd() &&
    !/^(true|false|null|yes|no|on|off)$/i.test(s) &&
    !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s);
  return plainSafe ? s : JSON.stringify(s);
}

function serializeValue(v: FrontmatterScalar | FrontmatterScalar[]): string {
  if (Array.isArray(v)) return "[" + v.map(serializeScalar).join(", ") + "]";
  return serializeScalar(v);
}

/** Index of the top-level `key:` line within `lines`, or -1. Only matches a key
 * at column 0 (no indentation), so nested sub-keys are never matched. */
function keyLineIndex(lines: string[], key: string, from: number, to: number): number {
  const re = new RegExp("^" + escapeRegExp(key) + ":(?:\\s|$)");
  for (let i = from; i < to; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

/** True when the top-level key at `lines[i]` carries a multi-line / block-style
 * value the line-level editor must not touch: a blank value or block-scalar
 * indicator (`|`, `>`, `|2`, …) whose value continues on indented/list lines, OR
 * an inline value that opens a quote it never closes on the key line (a
 * multi-line quoted scalar). */
function keyValueIsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  const after = line.slice(line.indexOf(":") + 1);
  const trimmed = after.trim();
  if (trimmed === "" || /^[|>][+-]?\d*$/.test(trimmed)) {
    const next = lines[i + 1];
    if (next === undefined) return false;
    if (next.trim() === "---") return false; // closing fence: key is a null scalar
    return /^\s+\S/.test(next) || /^\s*-(\s|$)/.test(next);
  }
  // Inline value present: safe to overwrite unless it's an unterminated quote
  // (the scalar spills onto following lines).
  return hasUnterminatedQuote(trimmed);
}

/** Whether `s` begins with a quote that is not closed within `s` itself. */
function hasUnterminatedQuote(s: string): boolean {
  const q = s[0];
  if (q !== '"' && q !== "'") return false;
  for (let j = 1; j < s.length; j++) {
    if (q === '"' && s[j] === "\\") {
      j++; // skip the escaped char
      continue;
    }
    if (s[j] === q) {
      // In single-quoted YAML, '' is an escaped quote, not a close.
      if (q === "'" && s[j + 1] === "'") {
        j++;
        continue;
      }
      return false; // closing quote found
    }
  }
  return true;
}

/**
 * Apply `set` / `unset` to a note's YAML frontmatter at the line level, leaving
 * every untouched line (and the body) byte-for-byte intact. Creates a
 * frontmatter block if the note has none. Throws {@link BlockValueError} if a
 * targeted key holds a block-style value (the note is not modified). The caller
 * is responsible for rejecting `id` and for ensuring an id afterward.
 */
export function editFrontmatter(src: string, args: EditFrontmatterArgs): EditFrontmatterResult {
  const set = args.set ?? {};
  const unset = args.unset ?? [];
  const setKeys = Object.keys(set);

  const split = splitFrontmatterRaw(src);

  // No frontmatter yet: build a fresh block from the set keys. unset is a no-op.
  if (split.frontmatter === null) {
    if (setKeys.length === 0) {
      return { content: src, changedKeys: [], removedKeys: [] };
    }
    const block = setKeys.map((k) => `${k}: ${serializeValue(set[k])}`).join("\n");
    return {
      content: `---\n${block}\n---\n${src}`,
      changedKeys: setKeys,
      removedKeys: [],
    };
  }

  const fm = split.frontmatter;
  const eol = fm.startsWith("---\r\n") ? "\r\n" : "\n";
  // fm ends with eol, so split() yields a trailing "" element we keep and rejoin.
  const lines = fm.split(eol);
  const closeIdx = lines.findIndex((l, idx) => idx > 0 && l.trimEnd() === "---");

  // Pre-validate every targeted key before mutating anything.
  for (const key of [...new Set([...setKeys, ...unset])]) {
    const i = keyLineIndex(lines, key, 1, closeIdx);
    if (i !== -1 && keyValueIsBlock(lines, i)) throw new BlockValueError(key);
  }

  const removedKeys: string[] = [];
  for (const key of unset) {
    const close = lines.findIndex((l, idx) => idx > 0 && l.trimEnd() === "---");
    const i = keyLineIndex(lines, key, 1, close);
    if (i !== -1) {
      lines.splice(i, 1);
      removedKeys.push(key);
    }
  }

  const changedKeys: string[] = [];
  for (const key of setKeys) {
    const close = lines.findIndex((l, idx) => idx > 0 && l.trimEnd() === "---");
    const newLine = `${key}: ${serializeValue(set[key])}`;
    const i = keyLineIndex(lines, key, 1, close);
    if (i !== -1) {
      lines[i] = newLine;
    } else {
      lines.splice(close, 0, newLine);
    }
    changedKeys.push(key);
  }

  return { content: lines.join(eol) + split.body, changedKeys, removedKeys };
}
