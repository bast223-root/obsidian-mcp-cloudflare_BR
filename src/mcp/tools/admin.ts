import type { R2Client } from "../../vault/r2-client";
import { type ToolResult, type VaultConfig, err, ok } from "../../types";
import {
  MalformedFrontmatterError,
  ensureIdInFrontmatter,
  extractIdFromFrontmatter,
  generateNoteId,
} from "../../vault/markdown";

export interface BackfillExample {
  path: string;
  id: string;
  etag: string;
}

export interface BackfillStats {
  scanned: number;
  alreadyHadId: number;
  minted: number;
  malformed: number;
  errors: number;
  dryRun: boolean;
  examples: BackfillExample[];
  malformedPaths: string[];
}

export async function backfillIds(
  c: R2Client,
  _cfg: VaultConfig,
  args: { dryRun?: boolean; limit?: number; prefix?: string },
  onWrite?: (path: string, content: string, etag: string) => void,
): Promise<ToolResult<BackfillStats>> {
  const dryRun = args.dryRun !== false;
  const limit = args.limit ?? Number.POSITIVE_INFINITY;
  const filterPrefix = args.prefix ?? "";

  const stats: BackfillStats = {
    scanned: 0,
    alreadyHadId: 0,
    minted: 0,
    malformed: 0,
    errors: 0,
    dryRun,
    examples: [],
    malformedPaths: [],
  };

  const all = await c.listMarkdown();
  const targets = filterPrefix ? all.filter((p) => p.startsWith(filterPrefix)) : all;

  for (const path of targets) {
    if (stats.minted + stats.alreadyHadId >= limit) break;
    stats.scanned++;

    const body = await c.get(path);
    if (body === null) {
      stats.errors++;
      continue;
    }

    const existing = extractIdFromFrontmatter(body);
    if (existing !== null) {
      stats.alreadyHadId++;
      continue;
    }

    let prepared;
    try {
      prepared = ensureIdInFrontmatter(body, generateNoteId);
    } catch (e) {
      if (e instanceof MalformedFrontmatterError) {
        stats.malformed++;
        if (stats.malformedPaths.length < 20) stats.malformedPaths.push(path);
        continue;
      }
      throw e;
    }

    if (dryRun) {
      stats.minted++;
      if (stats.examples.length < 10) {
        stats.examples.push({ path, id: prepared.id, etag: "(dry-run)" });
      }
      continue;
    }

    const etag = await c.put(path, prepared.content);
    onWrite?.(path, prepared.content, etag);
    stats.minted++;
    if (stats.examples.length < 10) {
      stats.examples.push({ path, id: prepared.id, etag });
    }
  }

  if (stats.errors > 0 && stats.scanned === stats.errors) {
    return err("read_failed", { scanned: stats.scanned });
  }
  return ok(stats);
}
