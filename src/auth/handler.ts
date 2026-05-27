import type { Props } from "../types";
import { renderConsent } from "./consent-page";
import { handleUpload } from "../upload/handler";
import { signValue, timingSafeEqual, verifyValue } from "../upload/tokens";
import { MIN_SECRET_LEN } from "../config";
import { clearAuthFailures, isRateLimited, recordAuthFailure } from "./rate-limit";
import { log } from "../log";
import { VERSION } from "../version";

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The consent page has no scripts and only an inline <style>; lock the page
      // down to that, disallow framing, and pin form submission to this origin.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Unauthenticated liveness/version probe. Runs in the main Worker, so it
    // reflects the *deployed* version immediately (independent of the Durable
    // Object's tool-registry cache). Handy for `curl …/health` deploy checks.
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "obsidian-mcp", version: VERSION }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // The binary upload endpoint shares this public (non-OAuth) handler. It
    // returns null for any path other than /upload, so /authorize below is
    // unaffected.
    const upload = await handleUpload(req, env);
    if (upload) return upload;

    if (url.pathname !== "/authorize") {
      log.debug("non_oauth_path", { method: req.method, path: url.pathname });
      return new Response("not found", { status: 404 });
    }

    // Fail closed if the deployed AUTH_PASSWORD is missing or too weak, rather
    // than letting a short/empty secret gate the vault. AUTH_PASSWORD is also the
    // key that signs the oauthReqInfo blob below, so this guard must run for both
    // GET and POST. Push-time validation in scripts/push-secrets.sh is the first
    // line; this is the backstop.
    if (!env.AUTH_PASSWORD || env.AUTH_PASSWORD.length < MIN_SECRET_LEN) {
      log.error("auth_misconfigured", { reason: "AUTH_PASSWORD unset or below minimum length" });
      return html(
        renderConsent({
          clientName: "MCP client",
          oauthReqInfo: "",
          error: "Server authentication is misconfigured. Contact the operator.",
        }),
        503,
      );
    }

    if (req.method === "GET") {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(req);
      // HMAC-sign the blob so the POST handler can detect tampering. The key
      // never leaves the server; the client only round-trips the opaque
      // `payload.sig` string in the hidden form field.
      const signed = await signValue(env.AUTH_PASSWORD, btoa(JSON.stringify(oauthReqInfo)));
      const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
      return html(renderConsent({ clientName: client?.clientName ?? "MCP client", oauthReqInfo: signed }));
    }

    if (req.method === "POST") {
      const form = await req.formData();
      const password = form.get("password");
      const signed = form.get("oauthReqInfo");
      if (typeof password !== "string" || typeof signed !== "string") {
        log.info("auth_form_invalid", {
          missing_password: typeof password !== "string",
          missing_req: typeof signed !== "string",
        });
        return html(renderConsent({ clientName: "MCP client", oauthReqInfo: "", error: "Missing fields." }), 400);
      }

      // Reject a tampered or unsigned oauthReqInfo blob before trusting any field
      // inside it (clientId, scope, redirectUri).
      const payload = await verifyValue(env.AUTH_PASSWORD, signed);
      if (payload === null) {
        log.warn("auth_state_tampered", { ip: req.headers.get("cf-connecting-ip") });
        return html(
          renderConsent({
            clientName: "MCP client",
            oauthReqInfo: "",
            error: "Invalid or expired request. Please reconnect and try again.",
          }),
          400,
        );
      }
      const oauthReqInfo = JSON.parse(atob(payload));

      const ip = req.headers.get("cf-connecting-ip") ?? "";

      // Soft brute-force throttle: KV-backed per-IP failed-attempt counter over a
      // sliding window. KV is eventually consistent so this is a cost-raiser, not
      // a hard gate — pair it with a Cloudflare WAF rate-limiting rule on
      // /authorize for production (see SECURITY notes in README).
      if (await isRateLimited(env.OAUTH_KV, ip)) {
        log.warn("auth_rate_limited", { ip });
        return html(
          renderConsent({
            clientName: "MCP client",
            oauthReqInfo: signed,
            error: "Too many failed attempts. Try again later.",
          }),
          429,
        );
      }

      if (!timingSafeEqual(password, env.AUTH_PASSWORD)) {
        await recordAuthFailure(env.OAUTH_KV, ip);
        log.warn("auth_failed", {
          clientId: oauthReqInfo.clientId,
          ip,
        });
        return html(renderConsent({ clientName: "MCP client", oauthReqInfo: signed, error: "Wrong password." }), 401);
      }
      await clearAuthFailures(env.OAUTH_KV, ip);
      const props: Props = { user: "owner" };
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: "owner",
        metadata: { label: "owner" },
        scope: oauthReqInfo.scope,
        props,
      });
      return Response.redirect(redirectTo, 302);
    }

    log.debug("auth_method_not_allowed", { method: req.method });
    return new Response("method not allowed", { status: 405 });
  },
};
