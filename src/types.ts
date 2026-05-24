import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  interface Env {
    AUTH_PASSWORD: string;
    OAUTH_PROVIDER: OAuthHelpers;
  }
}

export interface Props extends Record<string, unknown> {
  user: string;
}

export type AttachmentsPathMode = "per_note_subfolder" | "vault_default" | "caller_specified";
export type AttachmentsMoveWithNote = "unique_refs" | "never";

export interface VaultConfig {
  prefix: string;
  dailyNotePathTemplate: string;
  permalinkBaseUrl: string;
  // Attachment handling (see wrangler vars ATTACHMENTS_*/ATTACHMENT_*).
  attachmentsPathMode: AttachmentsPathMode;
  attachmentsSubfolder: string;
  /** CSV of allowed extensions (lowercase). Empty falls back to the built-in default list. */
  attachmentAllowedExtensions: string;
  /** Hard cap on upload size in bytes (post-decode / fetched body). */
  attachmentMaxBytes: number;
  attachmentsMoveWithNote: AttachmentsMoveWithNote;
  /** Timeout for the URL-fetch upload path, in milliseconds. */
  attachmentUrlTimeoutMs: number;
}

export type ToolOk<T> = { ok: true; value: T };
export type ToolErr = { ok: false; reason: string; [k: string]: unknown };
export type ToolResult<T> = ToolOk<T> | ToolErr;

export const ok = <T>(value: T): ToolOk<T> => ({ ok: true, value });
export const err = (reason: string, extra: Record<string, unknown> = {}): ToolErr => ({
  ok: false,
  reason,
  ...extra,
});

export {};
