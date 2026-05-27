import type { Props } from "../types";
import { renderConsent } from "./consent-page";
import { handleUpload } from "../upload/handler";
import { log } from "../log";
import { VERSION } from "../version";

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
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

    if (req.method === "GET") {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(req);
      const encoded = btoa(JSON.stringify(oauthReqInfo));
      const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
      return html(renderConsent({ clientName: client?.clientName ?? "MCP client", oauthReqInfo: encoded }));
    }

    if (req.method === "POST") {
      const form = await req.formData();
      const password = form.get("password");
      const encoded = form.get("oauthReqInfo");
      if (typeof password !== "string" || typeof encoded !== "string") {
        log.info("auth_form_invalid", {
          missing_password: typeof password !== "string",
          missing_req: typeof encoded !== "string",
        });
        return html(renderConsent({ clientName: "MCP client", oauthReqInfo: "", error: "Missing fields." }), 400);
      }
      const oauthReqInfo = JSON.parse(atob(encoded));
      if (password !== env.AUTH_PASSWORD) {
        log.warn("auth_failed", {
          clientId: oauthReqInfo.clientId,
          ip: req.headers.get("cf-connecting-ip"),
        });
        return html(renderConsent({ clientName: "MCP client", oauthReqInfo: encoded, error: "Wrong password." }), 401);
      }
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
