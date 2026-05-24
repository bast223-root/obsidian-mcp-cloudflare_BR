import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// Secrets / provider bindings not present in wrangler.jsonc `vars`, so they are
// not in the generated `worker-configuration.d.ts`. Augment both the global Env
// (used by the Worker code) and `Cloudflare.Env` (what `cloudflare:test` returns
// in the vitest pool) so the two stay assignable.
interface ManualBindings {
  /** Secret. Long-lived bearer token for the direct HTTP upload endpoint and the
   * HMAC signing key for short-lived upload links. Set via
   * `wrangler secret put UPLOAD_TOKEN`. Empty/unset disables the endpoint. */
  UPLOAD_TOKEN: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

declare global {
  // AUTH_PASSWORD comes from the generated `__BaseEnv_Env`; only the manual
  // bindings need adding here.
  interface Env extends ManualBindings {}
  namespace Cloudflare {
    interface Env extends ManualBindings {}
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
