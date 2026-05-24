import { type ToolResult, err, ok } from "../types";
import { buildVaultConfig } from "../config";
import { dirOf, resolveAttachmentPath } from "../vault/attachments";

// Short-lived, single-use upload tokens for Claude-minted upload links.
//
// A token is `base64url(JSON payload) + "." + base64url(HMAC-SHA256)`, signed
// with the UPLOAD_TOKEN secret. The payload carries a random `jti`, an `exp`
// timestamp, and the optional target note/subfolder so the link pre-scopes the
// upload's destination. The `jti` is also written to OAUTH_KV with a matching
// TTL on mint and deleted on first successful use — so a leaked link can be used
// at most once and only within its window. The long-lived UPLOAD_TOKEN bearer
// (for the bookmarked page / iOS Shortcut) does not use this module.

const KV_PREFIX = "upload_jti:";
const DEFAULT_TTL_SECONDS = 15 * 60;
export const MAX_TTL_SECONDS = 30 * 60;

const encoder = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncodeString(s: string): string {
  return b64urlEncode(encoder.encode(s));
}

function b64urlDecodeToString(s: string): string | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    return decodeURIComponent(
      atob(padded)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
  } catch {
    return null;
  }
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

/** Constant-time string comparison (avoids leaking match position via timing). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface UploadTokenScope {
  target_note?: string;
  subfolder?: string;
  /** Exact destination path (deterministic single-file links). When set, the
   * upload lands here regardless of the chosen file's name and only one file is
   * accepted. */
  dest_path?: string;
  /** Max number of files a batch link accepts (ignored when dest_path is set). */
  max_files?: number;
}

export interface UploadTokenPayload extends UploadTokenScope {
  jti: string;
  exp: number; // epoch seconds
}

export interface SignedUploadToken {
  token: string;
  expiresAt: string; // ISO
}

/**
 * Mint a single-use upload token and register its jti in KV with a matching TTL.
 * `ttlSeconds` is clamped to [60, MAX_TTL_SECONDS].
 */
export async function signUploadToken(
  env: Env,
  scope: UploadTokenScope,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<SignedUploadToken> {
  const ttl = Math.min(Math.max(Math.floor(ttlSeconds), 60), MAX_TTL_SECONDS);
  const jti = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload: UploadTokenPayload = { jti, exp, ...scope };
  const body = b64urlEncodeString(JSON.stringify(payload));
  const sig = b64urlEncode(await hmac(env.UPLOAD_TOKEN, body));
  await env.OAUTH_KV.put(KV_PREFIX + jti, "1", { expirationTtl: ttl });
  return { token: `${body}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Verify a token's signature, expiry, and that its jti is still live in KV
 * (i.e. minted and not yet consumed). Does NOT consume — call
 * `consumeUploadToken` after the upload succeeds.
 */
export async function verifyUploadToken(
  env: Env,
  token: string,
): Promise<ToolResult<UploadTokenPayload>> {
  const dot = token.indexOf(".");
  if (dot <= 0) return err("invalid_token");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = b64urlEncode(await hmac(env.UPLOAD_TOKEN, body));
  if (!timingSafeEqual(sig, expectedSig)) return err("invalid_token");

  const json = b64urlDecodeToString(body);
  if (!json) return err("invalid_token");
  let payload: UploadTokenPayload;
  try {
    payload = JSON.parse(json);
  } catch {
    return err("invalid_token");
  }
  if (!payload.jti || typeof payload.exp !== "number") return err("invalid_token");
  if (payload.exp * 1000 < Date.now()) return err("expired_token");

  const live = await env.OAUTH_KV.get(KV_PREFIX + payload.jti);
  if (live === null) return err("token_used"); // consumed or expired in KV
  return ok(payload);
}

/** Mark a token's jti consumed so the link cannot be replayed. */
export async function consumeUploadToken(env: Env, jti: string): Promise<void> {
  await env.OAUTH_KV.delete(KV_PREFIX + jti);
}

export interface UploadLink {
  upload_url: string;
  expires_at: string;
  /** Set for a deterministic single-file link — the exact path the file lands at. */
  dest_path?: string;
  /** The vault folder uploads land in (so a batch upload can be found with
   * list_attachments scoped to this prefix instead of scanning the whole vault).
   * "" means the vault root. */
  landing_dir: string;
  target_note?: string;
  subfolder?: string;
  /** Whether the link accepts multiple files (batch mode). */
  multiple: boolean;
}

/**
 * Mint a tappable, single-use upload link for an MCP client to present in chat.
 *   - `filename` set → deterministic single-file link: the destination path is
 *     resolved now and baked into the token, so the caller knows exactly where
 *     the file will land (and can poll it).
 *   - no `filename` → batch link: the page lets the user pick up to `max_files`
 *     files, which land in the resolved folder; the caller finds them via
 *     list_attachments.
 * Returns `upload_disabled` when the feature isn't configured.
 */
export async function createUploadLink(
  env: Env,
  args: {
    target_note?: string;
    subfolder?: string;
    filename?: string;
    max_files?: number;
    ttl_minutes?: number;
  },
): Promise<ToolResult<UploadLink>> {
  if (!env.UPLOAD_TOKEN) return err("upload_disabled", { detail: "UPLOAD_TOKEN secret is not set" });
  const base = (env.SERVICE_BASE_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/i.test(base)) {
    return err("upload_disabled", { detail: "SERVICE_BASE_URL is not a valid absolute URL" });
  }

  const cfg = buildVaultConfig(env);
  const scope: UploadTokenScope = { target_note: args.target_note, subfolder: args.subfolder };
  if (args.filename) {
    const resolved = resolveAttachmentPath(cfg, {
      target_note: args.target_note,
      subfolder: args.subfolder,
      filename: args.filename,
    });
    if (!resolved.ok) return resolved;
    scope.dest_path = resolved.value;
  } else {
    scope.max_files = Math.min(Math.max(args.max_files ?? 10, 1), 50);
  }

  // The folder uploads land in — same for every file, so it's known up front
  // even in batch mode. Lets the caller scope its follow-up list_attachments.
  let landing_dir = "";
  if (scope.dest_path) {
    landing_dir = dirOf(scope.dest_path);
  } else {
    const probe = resolveAttachmentPath(cfg, {
      target_note: args.target_note,
      subfolder: args.subfolder,
      filename: "probe.bin",
    });
    if (probe.ok) landing_dir = dirOf(probe.value);
  }

  const ttlSeconds = args.ttl_minutes ? args.ttl_minutes * 60 : undefined;
  const { token, expiresAt } = await signUploadToken(env, scope, ttlSeconds);
  const multiple = !scope.dest_path;
  const url = `${base}/upload?t=${encodeURIComponent(token)}${multiple ? "&multi=1" : ""}`;
  return ok({
    upload_url: url,
    expires_at: expiresAt,
    dest_path: scope.dest_path,
    landing_dir,
    target_note: args.target_note,
    subfolder: args.subfolder,
    multiple,
  });
}
