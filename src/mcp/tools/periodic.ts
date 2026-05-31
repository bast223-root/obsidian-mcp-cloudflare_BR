import type { R2Client } from "../../vault/r2-client";
import type { ToolResult, VaultConfig } from "../../types";
import { ok, err } from "../../types";
import {
  ensureIdInFrontmatter,
  extractIdFromFrontmatter,
  generateNoteId,
} from "../../vault/markdown";
import { formatPeriodicPath, periodicLabel, type Period } from "../../vault/periodic";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Look up the periodic note for `period` covering `date` (default today),
 * creating it from the cadence's H1 label + a fresh id if it does not exist.
 * Returns `period_not_configured` when no template is set for the cadence.
 *
 * On an existing note the byte content is left untouched — its id is read back
 * rather than re-minted (so an externally-created note keeps whatever id it has,
 * which may be null if it has none). `content`/`etag` are null unless a note was
 * created (the agent only needs the content to seed the index on creation).
 */
export async function getOrCreatePeriodicNote(
  c: R2Client,
  cfg: VaultConfig,
  args: { period: Period; date?: string },
): Promise<
  ToolResult<{
    path: string;
    created: boolean;
    id: string | null;
    etag: string | null;
    content: string | null;
  }>
> {
  const template = cfg.periodicNoteTemplates[args.period];
  if (!template) return err("period_not_configured", { period: args.period });
  const date = args.date ?? todayISO();
  const path = formatPeriodicPath(template, date);

  const existing = await c.get(path);
  if (existing !== null) {
    return ok({
      path,
      created: false,
      id: extractIdFromFrontmatter(existing),
      etag: null,
      content: null,
    });
  }

  const { content, id } = ensureIdInFrontmatter(
    `# ${periodicLabel(args.period, date)}\n\n`,
    generateNoteId,
  );
  const etag = await c.put(path, content);
  return ok({ path, created: true, id, etag, content });
}

/**
 * Append a block of text to the periodic note for `period` covering `date`,
 * creating the note (bare, no frontmatter) if it does not exist — mirroring the
 * prior daily-note append behavior. A newline boundary is inserted if needed.
 * Returns `period_not_configured` when no template is set for the cadence. `id`
 * is the note's existing frontmatter id, or null if it has no frontmatter.
 */
export async function appendToPeriodicNote(
  c: R2Client,
  cfg: VaultConfig,
  args: { period: Period; date?: string; content: string },
): Promise<ToolResult<{ path: string; id: string | null; etag: string; content: string }>> {
  const template = cfg.periodicNoteTemplates[args.period];
  if (!template) return err("period_not_configured", { period: args.period });
  const date = args.date ?? todayISO();
  const path = formatPeriodicPath(template, date);

  const existing = (await c.get(path)) ?? "";
  const sep = existing.length && !existing.endsWith("\n") ? "\n" : "";
  const content = existing + sep + args.content + "\n";
  const etag = await c.put(path, content);
  return ok({ path, id: extractIdFromFrontmatter(content), etag, content });
}
