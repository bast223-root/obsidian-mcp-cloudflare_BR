import { MIN_SECRET_LEN, buildVaultConfig } from "../config";
import { log } from "../log";
import { R2Client } from "../vault/r2-client";
import {
  DEFAULT_ATTACHMENT_EXTENSIONS,
  dirOf,
  parseExtensionAllowlist,
  resolveAttachmentPath,
  sanitizeFilename,
} from "../vault/attachments";
import { finalizeUpload } from "../mcp/tools/attachments";
import { reconcileUploadType } from "./sniff";
import { renderUploadPage } from "./page";
import { type UploadTokenScope, consumeUploadToken, timingSafeEqual, verifyUploadToken } from "./tokens";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * Validate and store a single uploaded file. Bytes are authoritative: the type
 * is sniffed and a spoofed file rejected. With `dest_path` the file lands at the
 * exact baked path (its name/extension preserved, content-type from the sniff);
 * otherwise it lands in the target folder under its (corrected) own name.
 */
async function storeOneFile(
  c: R2Client,
  cfg: ReturnType<typeof buildVaultConfig>,
  allow: Set<string>,
  file: File,
  opts: { dest_path?: string; target_note?: string; subfolder?: string; overwrite: boolean },
): Promise<ReturnType<typeof finalizeUpload>> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) return { ok: false, reason: "empty_file" };
  if (bytes.byteLength > cfg.attachmentMaxBytes) {
    return { ok: false, reason: "too_large", size: bytes.byteLength, max: cfg.attachmentMaxBytes };
  }
  const intendedName = opts.dest_path ? basename(opts.dest_path) : file.name || "upload";
  const clean = sanitizeFilename(intendedName);
  if (!clean.ok) return clean;
  const reconciled = reconcileUploadType(clean.value, bytes, allow);
  if (!reconciled.ok) return reconciled;

  if (opts.dest_path) {
    // Honor the exact link path; store with the true (sniffed) content-type.
    return finalizeUpload(c, cfg, { dest_path: opts.dest_path, overwrite: opts.overwrite }, basename(opts.dest_path), bytes, reconciled.value.mime);
  }
  return finalizeUpload(
    c,
    cfg,
    { target_note: opts.target_note, subfolder: opts.subfolder, overwrite: opts.overwrite },
    reconciled.value.filename,
    bytes,
    reconciled.value.mime,
  );
}

// Map a typed failure reason to an HTTP status.
function statusForReason(reason: string): number {
  switch (reason) {
    case "exists":
      return 409;
    case "too_large":
      return 413;
    case "disallowed_extension":
    case "content_mismatch":
      return 415;
    default:
      return 400;
  }
}

/**
 * Handle the direct binary upload endpoint. Returns a Response for `/upload`
 * (GET serves the page, POST stores a file), or null for any other path so the
 * caller's normal routing continues. The endpoint is publicly reachable (it
 * lives on the OAuth defaultHandler), so every POST must present either the
 * long-lived UPLOAD_TOKEN bearer or a valid single-use signed link token.
 */
/**
 * Render the GET /upload page. For a signed `?t=` link we verify it server-side
 * (the token is opaque to the browser) and show the destination the file will
 * land at, plus an "invalid/used/expired" notice when the link is no longer
 * good. The bare bookmarked/bearer page has no scope yet, so it shows the
 * editable form.
 */
async function renderGetPage(req: Request, env: Env, url: URL): Promise<string> {
  const linkToken = url.searchParams.get("t");
  if (!linkToken) return renderUploadPage();

  const verified = await verifyUploadToken(env, linkToken);
  if (!verified.ok) return renderUploadPage({ linkError: verified.reason });

  const scope = verified.value;
  let destination: string;
  if (scope.dest_path) {
    destination = scope.dest_path;
  } else {
    const cfg = buildVaultConfig(env);
    const probe = resolveAttachmentPath(cfg, {
      target_note: scope.target_note,
      subfolder: scope.subfolder,
      filename: "probe.bin",
    });
    const dir = probe.ok ? dirOf(probe.value) : "";
    destination = `${dir || "(vault root)"}/`;
  }
  return renderUploadPage({ destination, targetNote: scope.target_note });
}

export async function handleUpload(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/upload") return null;

  if (!env.UPLOAD_TOKEN) {
    return req.method === "GET"
      ? html("<h1>Upload disabled</h1><p>Set the UPLOAD_TOKEN secret to enable.</p>", 503)
      : json({ ok: false, reason: "upload_disabled" }, 503);
  }

  // Fail closed on a configured-but-weak token: it's also the HMAC key for signed
  // links, so a short value undermines both auth and link integrity.
  if (env.UPLOAD_TOKEN.length < MIN_SECRET_LEN) {
    log.error("upload_misconfigured", { reason: "UPLOAD_TOKEN below minimum length" });
    return req.method === "GET"
      ? html("<h1>Upload misconfigured</h1><p>UPLOAD_TOKEN is too short; contact the operator.</p>", 503)
      : json({ ok: false, reason: "upload_misconfigured" }, 503);
  }

  if (req.method === "GET") return html(await renderGetPage(req, env, url));
  if (req.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);

  // CSRF hardening: only accept multipart form posts (browser fetch with
  // FormData / curl -F / Shortcuts), never urlencoded form submissions, and
  // never cookie-based auth.
  const contentType = req.headers.get("content-type")?.trimStart().toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return json({ ok: false, reason: "unsupported_content_type" }, 415);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ ok: false, reason: "invalid_form" }, 400);
  }

  // ── Authenticate ──────────────────────────────────────────────────────
  let scope: UploadTokenScope = {};
  let consumeJti: string | null = null;

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const linkToken = (form.get("t") as string | null) ?? url.searchParams.get("t");

  if (bearer && timingSafeEqual(bearer, env.UPLOAD_TOKEN)) {
    // Long-lived bearer: trusted, no pre-set scope.
  } else if (linkToken) {
    const verified = await verifyUploadToken(env, linkToken);
    if (!verified.ok) {
      log.info("upload_auth_failed", { reason: verified.reason });
      return json({ ok: false, reason: verified.reason }, 401);
    }
    scope = {
      target_note: verified.value.target_note,
      subfolder: verified.value.subfolder,
      dest_path: verified.value.dest_path,
      max_files: verified.value.max_files,
    };
    consumeJti = verified.value.jti;
  } else {
    log.info("upload_auth_failed", { reason: "missing_credentials" });
    return json({ ok: false, reason: "unauthorized" }, 401);
  }

  // ── Extract file(s) ───────────────────────────────────────────────────
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) return json({ ok: false, reason: "no_file" }, 400);

  const cfg = buildVaultConfig(env);
  const c = new R2Client(env.VAULT, cfg);
  const allow = parseExtensionAllowlist(
    cfg.attachmentAllowedExtensions.trim() ? cfg.attachmentAllowedExtensions : DEFAULT_ATTACHMENT_EXTENSIONS,
  );
  const overwrite = form.get("overwrite") === "true";

  if (scope.dest_path) {
    // Deterministic single-file link: exactly one file, lands at the baked path.
    if (files.length > 1) return json({ ok: false, reason: "single_file_link" }, 400);
    const stored = await storeOneFile(c, cfg, allow, files[0], { dest_path: scope.dest_path, overwrite });
    if (!stored.ok) {
      const { ok: _ok, reason, ...rest } = stored;
      return json({ ok: false, reason, ...rest }, statusForReason(reason));
    }
    if (consumeJti) await consumeUploadToken(env, consumeJti);
    log.info("upload_ok", { path: stored.value.path, count: 1, via: consumeJti ? "link" : "bearer" });
    return json({ ok: true, files: [stored.value] });
  }

  // Folder/batch mode: token scope (or, for the bearer, form fields) sets the
  // destination folder; filenames come from the uploads.
  const maxFiles = scope.max_files ?? 50;
  if (files.length > maxFiles) return json({ ok: false, reason: "too_many_files", max: maxFiles }, 400);
  const target_note = scope.target_note ?? (form.get("target_note") as string | null) ?? undefined;
  const subfolder = scope.subfolder ?? (form.get("subfolder") as string | null) ?? undefined;

  const results = [];
  for (const f of files) {
    const stored = await storeOneFile(c, cfg, allow, f, { target_note, subfolder, overwrite });
    if (!stored.ok) {
      // Stop at the first failure; files already stored remain (best-effort).
      const { ok: _ok, reason, ...rest } = stored;
      return json({ ok: false, reason, ...rest, stored: results }, statusForReason(reason));
    }
    results.push(stored.value);
  }
  if (consumeJti) await consumeUploadToken(env, consumeJti);
  log.info("upload_ok", { count: results.length, via: consumeJti ? "link" : "bearer" });
  return json({ ok: true, files: results });
}
