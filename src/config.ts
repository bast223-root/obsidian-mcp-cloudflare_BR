import type { AttachmentsMoveWithNote, AttachmentsPathMode, VaultConfig } from "./types";

/**
 * Minimum length for the AUTH_PASSWORD and UPLOAD_TOKEN secrets. Both gate the
 * whole service (and UPLOAD_TOKEN is also the HMAC key for signed upload links),
 * so a short value is a brute-force liability. Enforced at runtime (the handlers
 * fail closed if a configured secret is shorter) AND at push time in
 * `scripts/push-secrets.sh` — keep the two in sync. 32+ chars is recommended.
 */
export const MIN_SECRET_LEN = 16;

const PATH_MODES: AttachmentsPathMode[] = [
  "per_note_subfolder",
  "vault_default",
  "caller_specified",
];

export function parsePathMode(v: string | undefined): AttachmentsPathMode {
  return (PATH_MODES as string[]).includes(v ?? "")
    ? (v as AttachmentsPathMode)
    : "per_note_subfolder";
}

export function parseMoveWithNote(v: string | undefined): AttachmentsMoveWithNote {
  return v === "never" ? "never" : "unique_refs";
}

export function parsePositiveInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Build the runtime VaultConfig from the Worker env. Shared by the MCP agent
 * (per-request, in the Durable Object) and the HTTP upload handler, so both
 * apply identical attachment policy. Pure given `env`.
 */
export function buildVaultConfig(env: Env): VaultConfig {
  return {
    prefix: env.VAULT_PREFIX,
    dailyNotePathTemplate: env.DAILY_NOTE_PATH_TEMPLATE,
    permalinkBaseUrl: env.PERMALINK_BASE_URL ?? "",
    attachmentsPathMode: parsePathMode(env.ATTACHMENTS_PATH_MODE),
    attachmentsSubfolder: env.ATTACHMENTS_SUBFOLDER || "files",
    attachmentAllowedExtensions: env.ATTACHMENT_ALLOWED_EXTENSIONS ?? "",
    attachmentFetchHostAllowlist: env.ATTACHMENT_FETCH_HOST_ALLOWLIST ?? "",
    attachmentMaxBytes: parsePositiveInt(env.ATTACHMENT_MAX_BYTES, 26214400),
    attachmentsMoveWithNote: parseMoveWithNote(env.ATTACHMENTS_MOVE_WITH_NOTE),
    attachmentUrlTimeoutMs: parsePositiveInt(env.ATTACHMENT_URL_TIMEOUT_MS, 20000),
  };
}
