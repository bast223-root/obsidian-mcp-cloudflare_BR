import type { R2Client } from "../../vault/r2-client";
import type { VaultConfig } from "../../types";
import { ensureIdInFrontmatter, generateNoteId } from "../../vault/markdown";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function templatePath(cfg: VaultConfig, date: string): string {
  return cfg.dailyNotePathTemplate.replace("{{YYYY-MM-DD}}", date);
}

export async function getOrCreateDailyNote(
  c: R2Client,
  cfg: VaultConfig,
  args: { date?: string },
): Promise<{ path: string; created: boolean; etag: string | null; content: string | null }> {
  const date = args.date ?? todayISO();
  const path = templatePath(cfg, date);
  if (await c.head(path)) return { path, created: false, etag: null, content: null };
  const { content } = ensureIdInFrontmatter(`# ${date}\n\n`, generateNoteId);
  const etag = await c.put(path, content);
  return { path, created: true, etag, content };
}

export async function appendToDailyNote(
  c: R2Client,
  cfg: VaultConfig,
  args: { date?: string; content: string },
): Promise<{ path: string; etag: string; content: string }> {
  const date = args.date ?? todayISO();
  const path = templatePath(cfg, date);
  const existing = (await c.get(path)) ?? "";
  const sep = existing.length && !existing.endsWith("\n") ? "\n" : "";
  const content = existing + sep + args.content + "\n";
  const etag = await c.put(path, content);
  return { path, etag, content };
}
