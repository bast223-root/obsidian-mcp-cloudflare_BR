import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Period } from "./vault/periodic";

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

/** Per-cadence periodic-note path templates. A `null` value means that cadence
 * has no configured template; its tools return `period_not_configured`. */
export type PeriodicNoteTemplates = Record<Period, string | null>;

export interface VaultConfig {
  prefix: string;
  periodicNoteTemplates: PeriodicNoteTemplates;
  permalinkBaseUrl: string;
  // Attachment handling (see wrangler vars ATTACHMENTS_*/ATTACHMENT_*).
  attachmentsPathMode: AttachmentsPathMode;
  attachmentsSubfolder: string;
  /** CSV of allowed extensions (lowercase). Empty falls back to the built-in default list. */
  attachmentAllowedExtensions: string;
  /** CSV of hostnames the server-side URL-fetch path may download from. Default-closed:
   * empty means no host is allowed (upload_attachment_url is effectively disabled). */
  attachmentFetchHostAllowlist: string;
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
